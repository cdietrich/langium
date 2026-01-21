/******************************************************************************
 * Copyright 2025 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { LangiumCoreServices } from '../services.js';
import type {
    Grammar, AbstractElement, ParserRule, Assignment, RuleCall,
    Alternatives, Group, UnorderedGroup, CrossReference, Action, Keyword
} from '../languages/generated/ast.js';
import {
    isAction, isAlternatives, isAssignment, isCrossReference,
    isGroup, isKeyword, isParserRule, isRuleCall,
    isTerminalRule, isTerminalRuleCall, isUnorderedGroup
} from '../languages/generated/ast.js';
import { getActionType, getRuleTypeName, isDataTypeRule } from '../utils/grammar-utils.js';
import { BitSet } from './bitset.js';
import type { SemState, FeatureMap } from './nfa-types.js';
import { SemNfa, createSemState, createStartState, createStopState } from './nfa-types.js';

/**
 * Builds semantic NFAs directly from grammar rules for use in serialization.
 *
 * This is a simplified approach compared to Xtext's 5-phase PDA chain.
 * We build the NFA directly from grammar rules by:
 * 1. Creating states for assignments, keywords, actions
 * 2. Connecting states based on grammar structure
 * 3. Computing followerFeatures via backward analysis
 */
export class NfaBuilder {
    private readonly grammar: Grammar;
    private readonly ruleTargets = new Map<string, ParserRule>();
    private readonly nfaCache = new Map<string, SemNfa>();
    private readonly featureMapCache = new Map<string, FeatureMap>();
    private orderCounter = 0;

    constructor(services: LangiumCoreServices) {
        this.grammar = services.Grammar;
        this.collectRuleTargets();
    }

    /**
     * Build or retrieve cached NFA for a given AST type.
     */
    getNfa(type: string): SemNfa {
        let nfa = this.nfaCache.get(type);
        if (!nfa) {
            nfa = this.buildNfa(type);
            this.nfaCache.set(type, nfa);
        }
        return nfa;
    }

    /**
     * Get or build the feature map for a given AST type.
     */
    getFeatureMap(type: string): FeatureMap {
        let map = this.featureMapCache.get(type);
        if (!map) {
            map = this.buildFeatureMap(type);
            this.featureMapCache.set(type, map);
        }
        return map;
    }

    /**
     * Build NFA for a given AST type.
     */
    private buildNfa(type: string): SemNfa {
        const rule = this.ruleTargets.get(type);
        if (!rule) {
            throw new Error(`No grammar rule found for AST type '${type}'.`);
        }

        const featureMap = this.getFeatureMap(type);
        this.orderCounter = 0;

        // Create start and stop states
        const start = createStartState(rule.definition);
        const stop = createStopState(rule.definition);

        // Build the NFA by traversing the grammar
        const context: BuildContext = {
            rule,
            featureMap,
            stop
        };

        const entryStates = this.buildElement(rule.definition, context);

        // Connect start to entry states
        start.followers = entryStates;

        // Create NFA and compute follower features
        const nfa = new SemNfa(start, stop);
        this.initFollowerFeatures(nfa, featureMap.size);
        this.initOrderIDs(nfa);

        return nfa;
    }

    /**
     * Build feature map by collecting all assignments in the rule.
     */
    private buildFeatureMap(type: string): FeatureMap {
        const map = new Map<string, number>();
        const rule = this.ruleTargets.get(type);
        if (rule) {
            this.collectFeatures(rule.definition, map);
        }
        return map;
    }

    /**
     * Recursively collect all feature names from assignments.
     */
    private collectFeatures(element: AbstractElement, map: Map<string, number>, insideAssignment = false): void {
        if (isAssignment(element)) {
            if (!map.has(element.feature)) {
                map.set(element.feature, map.size);
            }
            this.collectFeatures(element.terminal, map, true);
        } else if (isAlternatives(element) || isGroup(element) || isUnorderedGroup(element)) {
            for (const child of element.elements) {
                this.collectFeatures(child, map, insideAssignment);
            }
        } else if (isAction(element) && element.feature) {
            if (!map.has(element.feature)) {
                map.set(element.feature, map.size);
            }
        } else if (isRuleCall(element)) {
            const rule = element.rule?.ref;
            if (rule && isParserRule(rule) && rule.definition) {
                // Fragment rules: always inline their features
                if (rule.fragment) {
                    this.collectFeatures(rule.definition, map, insideAssignment);
                }
                // Unassigned parser rule calls: inline features from called rule
                else if (!insideAssignment && !isDataTypeRule(rule)) {
                    this.collectFeatures(rule.definition, map, false);
                }
            }
        }
    }

    /**
     * Build states for a grammar element, returning the entry states.
     * The returned states should eventually connect to the stop state.
     */
    private buildElement(element: AbstractElement, context: BuildContext): SemState[] {
        if (isKeyword(element)) {
            return this.buildKeyword(element, context);
        }
        if (isAssignment(element)) {
            return this.buildAssignment(element, context);
        }
        if (isRuleCall(element) || isTerminalRuleCall(element)) {
            return this.buildRuleCall(element, context);
        }
        if (isCrossReference(element)) {
            return this.buildCrossReference(element, context);
        }
        if (isAlternatives(element)) {
            return this.buildAlternatives(element, context);
        }
        if (isGroup(element)) {
            return this.buildGroup(element, context);
        }
        if (isUnorderedGroup(element)) {
            return this.buildUnorderedGroup(element, context);
        }
        if (isAction(element)) {
            return this.buildAction(element, context);
        }
        // Unknown element - connect directly to stop
        return [context.stop];
    }

    private buildKeyword(element: Keyword, context: BuildContext): SemState[] {
        const state = createSemState(element, 'KEYWORD');
        state.orderID = this.orderCounter++;
        state.followers = [context.stop];
        return this.wrapWithCardinality([state], element, context);
    }

    private buildAssignment(element: Assignment, context: BuildContext): SemState[] {
        const featureIndex = context.featureMap.get(element.feature) ?? -1;
        const isBooleanAssignment = element.operator === '?=';

        const state = createSemState(element, 'ASSIGNMENT', {
            feature: element.feature,
            featureIndex,
            isBooleanAssignment
        });
        state.orderID = this.orderCounter++;
        state.followers = [context.stop];

        // Boolean assignments (?=) are inherently optional - can skip when value is false/undefined
        if (isBooleanAssignment) {
            return [state, context.stop]; // Can either enter the assignment or skip to stop
        }

        return this.wrapWithCardinality([state], element, context);
    }

    private buildRuleCall(element: RuleCall | { rule: { ref: unknown } }, context: BuildContext): SemState[] {
        const rule = (element as RuleCall).rule?.ref;

        // Fragment rules: inline the fragment's content
        // Important: apply wrapWithCardinality to respect cardinality from the RuleCall (e.g., Fragment?)
        if (rule && isParserRule(rule) && rule.fragment && rule.definition) {
            const states = this.buildElement(rule.definition, context);
            return this.wrapWithCardinality(states, element as AbstractElement, context);
        }

        // Unassigned parser rule calls: create a RULE_CALL state with ruleType
        // This handles patterns like `Wrapper: 'wrap' Item` where we need to
        // search for a property matching the rule's type during serialization
        if (rule && isParserRule(rule) && !isDataTypeRule(rule)) {
            if (!this.isInsideAssignment(element as AbstractElement)) {
                const ruleType = getRuleTypeName(rule);
                const state = createSemState(element as AbstractElement, 'RULE_CALL', {
                    ruleType,
                    isUnassignedRuleCall: true
                });
                state.orderID = this.orderCounter++;
                state.followers = [context.stop];
                return this.wrapWithCardinality([state], element as AbstractElement, context);
            }
        }

        // Unassigned terminal rule calls: also mark as unassigned so we search for primitive property
        if (rule && isTerminalRule(rule)) {
            if (!this.isInsideAssignment(element as AbstractElement)) {
                const state = createSemState(element as AbstractElement, 'RULE_CALL', {
                    isUnassignedRuleCall: true
                });
                state.orderID = this.orderCounter++;
                state.followers = [context.stop];
                return this.wrapWithCardinality([state], element as AbstractElement, context);
            }
        }

        // Data type rules and assigned rule calls: create a regular RULE_CALL state
        const state = createSemState(element as AbstractElement, 'RULE_CALL');
        state.orderID = this.orderCounter++;
        state.followers = [context.stop];
        return this.wrapWithCardinality([state], element as AbstractElement, context);
    }

    /**
     * Check if an element is inside an Assignment node.
     */
    private isInsideAssignment(element: AbstractElement): boolean {
        let current: unknown = element.$container;
        while (current && typeof current === 'object') {
            if (isAssignment(current as AbstractElement)) {
                return true;
            }
            current = (current as { $container?: unknown }).$container;
        }
        return false;
    }

    private buildCrossReference(element: CrossReference, context: BuildContext): SemState[] {
        const state = createSemState(element, 'CROSS_REFERENCE');
        state.orderID = this.orderCounter++;
        state.followers = [context.stop];
        return this.wrapWithCardinality([state], element, context);
    }

    private buildAction(element: Action, context: BuildContext): SemState[] {
        if (element.feature) {
            const featureIndex = context.featureMap.get(element.feature) ?? -1;
            const state = createSemState(element, 'ACTION', {
                feature: element.feature,
                featureIndex
            });
            state.orderID = this.orderCounter++;
            state.followers = [context.stop];
            return [state];
        }
        // Actions without features don't create states
        return [context.stop];
    }

    private buildAlternatives(element: Alternatives, context: BuildContext): SemState[] {
        // Alternatives create multiple entry points
        const entries: SemState[] = [];

        for (const alt of element.elements) {
            const altEntries = this.buildElement(alt, context);
            entries.push(...altEntries);
        }

        return this.wrapWithCardinality(entries, element, context);
    }

    private buildGroup(element: Group, context: BuildContext): SemState[] {
        if (element.elements.length === 0) {
            return [context.stop];
        }

        const cardinality = element.cardinality;

        // For repeating groups (* or +), we need a special loop structure
        if (cardinality === '*' || cardinality === '+') {
            return this.buildRepeatingGroup(element, context);
        }

        // For non-repeating groups, build sequentially from back to front
        let nextStates: SemState[] = [context.stop];

        for (let i = element.elements.length - 1; i >= 0; i--) {
            const child = element.elements[i];
            const subContext: BuildContext = {
                ...context,
                stop: this.createJoinState(nextStates, element)
            };
            nextStates = this.buildElement(child, subContext);
        }

        // Handle optional cardinality (?)
        if (cardinality === '?') {
            return [...nextStates, context.stop];
        }

        return nextStates;
    }

    /**
     * Build a repeating group with proper loop-back structure.
     * 
     * For `(A B)*` we create:
     *   loopEntry → A → B → loopEntry
     *            ↘ STOP
     * 
     * For `(A B)+` we create:
     *   A → B → loopEntry → A → B → loopEntry
     *                    ↘ STOP
     */
    private buildRepeatingGroup(element: Group, context: BuildContext): SemState[] {
        // Create a loop decision state - this is where we decide to loop again or exit
        const loopEntry = createSemState(element, 'EPSILON');
        loopEntry.orderID = this.orderCounter++;
        
        // Build the group body with loopEntry as the continuation point
        // The body will connect back to loopEntry when done
        let bodyEnd: SemState[] = [loopEntry];

        for (let i = element.elements.length - 1; i >= 0; i--) {
            const child = element.elements[i];
            const subContext: BuildContext = {
                ...context,
                stop: this.createJoinState(bodyEnd, element)
            };
            bodyEnd = this.buildElement(child, subContext);
        }

        // loopEntry can either:
        // 1. Re-enter the body (continue looping)
        // 2. Exit to context.stop (end the loop)
        loopEntry.followers = [...bodyEnd, context.stop];

        // For '*', we can skip the entire group
        // For '+', we must enter at least once
        if (element.cardinality === '*') {
            return [...bodyEnd, context.stop];
        } else {
            // '+': must enter the body at least once
            return bodyEnd;
        }
    }

    private buildUnorderedGroup(element: UnorderedGroup, context: BuildContext): SemState[] {
        const elements = element.elements;
        
        if (elements.length === 0) {
            return [context.stop];
        }
        
        if (elements.length === 1) {
            return this.buildElement(elements[0], context);
        }

        // For unordered groups, we need all permutations of the elements
        // This ensures any order of assignments can be serialized
        // Limit to small groups to avoid combinatorial explosion
        if (elements.length > 4) {
            console.warn(`Unordered group with ${elements.length} elements may cause performance issues`);
        }

        const entries: SemState[] = [];
        const permutations = this.generatePermutations(elements.length);

        for (const perm of permutations) {
            // Build a sequential chain for this permutation (back to front)
            let currentTarget: SemState[] = [context.stop];
            
            for (let i = perm.length - 1; i >= 0; i--) {
                const elemIndex = perm[i];
                const elem = elements[elemIndex];
                const subContext: BuildContext = {
                    ...context,
                    stop: this.createJoinState(currentTarget, element)
                };
                currentTarget = this.buildElement(elem, subContext);
            }
            
            entries.push(...currentTarget);
        }

        return this.wrapWithCardinality(entries, element, context);
    }

    /**
     * Generate all permutations of indices [0, 1, ..., n-1].
     */
    private generatePermutations(n: number): number[][] {
        if (n === 0) return [[]];
        if (n === 1) return [[0]];
        
        const result: number[][] = [];
        const arr = Array.from({ length: n }, (_, i) => i);
        
        const permute = (start: number) => {
            if (start === arr.length) {
                result.push([...arr]);
                return;
            }
            for (let i = start; i < arr.length; i++) {
                [arr[start], arr[i]] = [arr[i], arr[start]];
                permute(start + 1);
                [arr[start], arr[i]] = [arr[i], arr[start]];
            }
        };
        
        permute(0);
        return result;
    }

    /**
     * Create a join state that connects to multiple next states.
     * Uses EPSILON type for structural states that don't emit tokens.
     */
    private createJoinState(nextStates: SemState[], element: AbstractElement): SemState {
        if (nextStates.length === 1) {
            return nextStates[0];
        }
        // Create an epsilon/join state - structural, doesn't emit tokens
        const join = createSemState(element, 'EPSILON');
        join.orderID = this.orderCounter++;
        join.followers = nextStates;
        return join;
    }

    /**
     * Wrap states with cardinality handling (?, *, +).
     * 
     * Note: For Groups, cardinality is handled in buildGroup/buildRepeatingGroup.
     * This method handles cardinality for atomic elements (keywords, assignments, etc.)
     */
    private wrapWithCardinality(states: SemState[], element: AbstractElement, context: BuildContext): SemState[] {
        const cardinality = element.cardinality;

        if (!cardinality) {
            // Required, no wrapping needed
            return states;
        }

        if (cardinality === '?') {
            // Optional: can skip to stop
            return [...states, context.stop];
        }

        if (cardinality === '*' || cardinality === '+') {
            // For repeating atomic elements, create a proper loop structure
            // Create a loop entry point that can re-enter or exit
            const loopEntry = createSemState(element, 'EPSILON');
            loopEntry.orderID = this.orderCounter++;
            
            // Each state in the group should connect to the loop entry
            for (const state of states) {
                // Replace the connection to context.stop with loopEntry
                state.followers = state.followers.map(f => f === context.stop ? loopEntry : f);
                // Also keep connection to context.stop if it was there
                if (!state.followers.includes(loopEntry)) {
                    state.followers.push(loopEntry);
                }
            }
            
            // loopEntry can re-enter the states or exit to stop
            loopEntry.followers = [...states, context.stop];
            
            if (cardinality === '*') {
                // Zero or more: can skip entirely
                return [...states, context.stop];
            }
            // One or more: must enter at least once
            return states;
        }

        return states;
    }

    /**
     * Compute followerFeatures BitSets via backward analysis.
     */
    private initFollowerFeatures(nfa: SemNfa, featureCount: number): void {
        const allStates = this.collectAllStates(nfa);

        // Initialize BitSets
        for (const state of allStates) {
            state.followerFeatures = new BitSet(featureCount);
        }

        // Fixed-point iteration: propagate features backward
        let changed = true;
        while (changed) {
            changed = false;
            for (const state of allStates) {
                // Add this state's feature to its BitSet
                if (state.featureIndex >= 0) {
                    if (!state.followerFeatures!.get(state.featureIndex)) {
                        state.followerFeatures!.set(state.featureIndex);
                        changed = true;
                    }
                }

                // Propagate from followers
                for (const follower of state.followers) {
                    if (state.followerFeatures!.or(follower.followerFeatures!)) {
                        changed = true;
                    }
                }
            }
        }
    }

    /**
     * Assign orderIDs based on traversal order.
     */
    private initOrderIDs(nfa: SemNfa): void {
        const visited = new Set<SemState>();
        let order = 0;

        const visit = (state: SemState) => {
            if (visited.has(state)) return;
            visited.add(state);
            state.orderID = order++;
            for (const follower of state.followers) {
                visit(follower);
            }
        };

        visit(nfa.getStart());
    }

    /**
     * Collect all states reachable from the NFA.
     */
    private collectAllStates(nfa: SemNfa): SemState[] {
        const states: SemState[] = [];
        const visited = new Set<SemState>();

        const visit = (state: SemState) => {
            if (visited.has(state)) return;
            visited.add(state);
            states.push(state);
            for (const follower of state.followers) {
                visit(follower);
            }
        };

        visit(nfa.getStart());
        return states;
    }

    /**
     * Collect rule targets: map AST types to their grammar rules.
     * Includes both direct rule types and types produced by actions.
     */
    private collectRuleTargets(): void {
        for (const rule of this.grammar.rules) {
            if (isParserRule(rule) && !isDataTypeRule(rule)) {
                const typeName = getRuleTypeName(rule);
                if (!this.ruleTargets.has(typeName)) {
                    this.ruleTargets.set(typeName, rule);
                }
                // Also collect types produced by actions within this rule
                this.collectActionTypes(rule, rule.definition);
            }
        }
    }

    /**
     * Recursively collect action types from a grammar element.
     */
    private collectActionTypes(rule: ParserRule, element: AbstractElement): void {
        if (isAction(element)) {
            const actionType = getActionType(element);
            if (actionType && !this.ruleTargets.has(actionType)) {
                this.ruleTargets.set(actionType, rule);
            }
        }
        if (isAlternatives(element) || isGroup(element) || isUnorderedGroup(element)) {
            for (const child of element.elements) {
                this.collectActionTypes(rule, child);
            }
        }
    }
}

interface BuildContext {
    rule: ParserRule;
    featureMap: FeatureMap;
    stop: SemState;
}
