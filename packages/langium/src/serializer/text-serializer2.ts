/******************************************************************************
 * Copyright 2025 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { LangiumCoreServices } from '../services.js';
import type { AstNode, AstReflection, GenericAstNode } from '../syntax-tree.js';
import { isReference, isMultiReference, isAstNode } from '../syntax-tree.js';
import type { NameProvider } from '../references/name-provider.js';
import type { TextSerializer, TextSerializeOptions, SerializeValueContext } from './text-serializer.js';
import type { SemState, FeatureMap } from './nfa-types.js';
import type { BacktrackHandler } from './backtrack.js';
import { backtrack } from './backtrack.js';
import { NfaBuilder } from './nfa-builder.js';
import { SerializableObject } from './serializable-object.js';
import { TraceItem } from './trace-item.js';
import { isKeyword, isAssignment, isRuleCall, isTerminalRuleCall, isCrossReference, isParserRule, isTerminalRule } from '../languages/generated/ast.js';
import { getCrossReferenceTerminal, isDataTypeRule } from '../utils/grammar-utils.js';

/**
 * Internal resolved options type with required defaults but optional hook.
 */
interface ResolvedTextSerializeOptions {
    space: string;
    useRefText: boolean;
    serializeValue?: (context: SerializeValueContext) => string;
}

/**
 * NFA-based text serializer using backtracking search.
 *
 * This implements Xtext's approach to serialization:
 * 1. Build semantic NFA from grammar rules (via NfaBuilder)
 * 2. Wrap AST node in SerializableObject for efficient access
 * 3. Use backtracking search with BitSet pruning to find valid path
 * 4. Convert path to tokens and join
 *
 * Key advantages over DefaultTextSerializer:
 * - Formal NFA-based algorithm with provable correctness
 * - BitSet-based pruning reduces unnecessary backtracking
 * - Explicit state tracking instead of implicit call stack
 *
 * @see https://github.com/eclipse/xtext/blob/main/org.eclipse.xtext/src/org/eclipse/xtext/serializer/sequencer/BacktrackingSemanticSequencer.java
 */
export class TextSerializer2 implements TextSerializer {
    protected readonly nfaBuilder: NfaBuilder;
    protected readonly nameProvider: NameProvider;
    protected readonly astReflection: AstReflection;
    protected readonly languageId: string;

    constructor(services: LangiumCoreServices) {
        this.nfaBuilder = new NfaBuilder(services);
        this.nameProvider = services.references.NameProvider;
        this.astReflection = services.shared.AstReflection;
        this.languageId = services.LanguageMetaData.languageId;
    }

    serialize(node: AstNode, options?: TextSerializeOptions): string {
        const resolvedOptions: ResolvedTextSerializeOptions = {
            space: ' ',
            useRefText: true,
            ...options
        };

        const nfa = this.nfaBuilder.getNfa(node.$type);
        const featureMap = this.nfaBuilder.getFeatureMap(node.$type);
        const obj = new SerializableObject(node, featureMap);
        const initial = TraceItem.createInitial(obj);

        const handler = this.createBacktrackHandler(obj);
        const trace = backtrack(nfa, initial, handler);

        if (!trace) {
            throw new Error(`Failed to serialize AST node of type '${node.$type}'.`);
        }

        return this.emitTokens(trace, featureMap, resolvedOptions);
    }

    /**
     * Create the backtrack handler for serialization.
     */
    protected createBacktrackHandler(obj: SerializableObject): BacktrackHandler<SemState, TraceItem> {
        // Track visited (state, nextIndex) pairs to detect cycles within the same consumption context.
        // The key insight: we only need to detect cycles between consumptions, not globally.
        // After consuming a value, we've made progress and previous cycle detection state is irrelevant.
        const visited = new Set<string>();

        return {
            handle: (state, previous) => {
                // Check if we can enter this state (BitSet pruning)
                if (!previous.canEnter(state)) {
                    return undefined;
                }

                // START/STOP/EPSILON states don't consume values
                if (state.type === 'START' || state.type === 'STOP' || state.type === 'EPSILON') {
                    // Cycle detection for structural states
                    const key = `${state.orderID}:${previous.nextIndex.join(',')}`;
                    if (visited.has(key)) {
                        return undefined; // Cycle detected
                    }
                    visited.add(key);
                    return previous.clone(state);
                }

                // Assignment and Action states consume values
                if (state.type === 'ASSIGNMENT' || state.type === 'ACTION') {
                    if (state.featureIndex >= 0) {
                        const result = previous.cloneAndConsume(state);
                        if (result) {
                            // Clear visited on consumption (we made progress)
                            visited.clear();
                        }
                        return result;
                    }
                }

                // KEYWORD, RULE_CALL, CROSS_REFERENCE states don't consume
                // Cycle detection: reject if we've seen this (state, nextIndex) before
                const key = `${state.orderID}:${previous.nextIndex.join(',')}`;
                if (visited.has(key)) {
                    return undefined; // Cycle detected
                }
                visited.add(key);

                return previous.clone(state);
            },

            isSolution: (result) => result.isConsumed(),

            sortFollowers: (result, followers) =>
                this.sortFollowers([...followers], result.obj)
        };
    }

    /**
     * Sort followers to reduce backtracking.
     *
     * Priority order (from Xtext FollowerSorter):
     * 1. STOP state first when all values consumed (allows early termination)
     * 2. Assignment states with available values (make progress)
     * 3. Structural states (EPSILON, KEYWORD without feature)
     * 4. Grammar declaration order (orderID)
     */
    protected sortFollowers(followers: SemState[], obj: SerializableObject): SemState[] {
        return followers.sort((a, b) => {
            // Priority 1: STOP state - but only prioritize if we can accept it
            // (having STOP first when we still have values leads to unnecessary backtracking)
            const aIsStop = a.type === 'STOP';
            const bIsStop = b.type === 'STOP';
            if (aIsStop && !bIsStop) return 1;  // STOP last (try other paths first)
            if (bIsStop && !aIsStop) return -1;

            // Priority 2: Assignment states with available values (prefer making progress)
            const aHasValue = a.featureIndex >= 0 && obj.getValueCount(a.featureIndex) > 0;
            const bHasValue = b.featureIndex >= 0 && obj.getValueCount(b.featureIndex) > 0;
            if (aHasValue && !bHasValue) return -1;
            if (bHasValue && !aHasValue) return 1;

            // Priority 3: EPSILON states (structural, don't emit) after real states
            const aIsEpsilon = a.type === 'EPSILON';
            const bIsEpsilon = b.type === 'EPSILON';
            if (aIsEpsilon && !bIsEpsilon) return 1;
            if (bIsEpsilon && !aIsEpsilon) return -1;

            // Priority 4: Grammar declaration order
            return a.orderID - b.orderID;
        });
    }

    /**
     * Convert a trace of states to output tokens.
     */
    protected emitTokens(
        trace: TraceItem[],
        featureMap: FeatureMap,
        options: ResolvedTextSerializeOptions
    ): string {
        const tokens: string[] = [];
        const featureNames = this.buildFeatureNameMap(featureMap);

        for (const item of trace) {
            if (!item.state) continue;

            const state = item.state;

            // START, STOP, EPSILON, ACTION states don't emit tokens
            if (state.type === 'START' || state.type === 'STOP' || 
                state.type === 'EPSILON' || state.type === 'ACTION') {
                continue;
            }

            if (state.type === 'KEYWORD') {
                const keyword = this.emitKeyword(state);
                if (keyword) {
                    tokens.push(keyword);
                }
            } else if (state.type === 'ASSIGNMENT') {
                const token = this.emitAssignment(
                    state,
                    item,
                    featureNames,
                    options
                );
                if (token) {
                    tokens.push(token);
                }
            } else if (state.type === 'RULE_CALL') {
                const token = this.emitRuleCall(state, item, featureNames, options);
                if (token) {
                    tokens.push(token);
                }
            } else if (state.type === 'CROSS_REFERENCE') {
                const token = this.emitCrossReference(state, item, featureNames, options);
                if (token) {
                    tokens.push(token);
                }
            }
        }

        return tokens.join(options.space).trim();
    }

    /**
     * Build reverse map from feature index to name.
     */
    protected buildFeatureNameMap(featureMap: FeatureMap): Map<number, string> {
        const nameMap = new Map<number, string>();
        for (const [name, index] of featureMap) {
            nameMap.set(index, name);
        }
        return nameMap;
    }

    /**
     * Emit a keyword state.
     */
    protected emitKeyword(state: SemState): string | undefined {
        if (isKeyword(state.grammarElement)) {
            return state.grammarElement.value;
        }
        return undefined;
    }

    /**
     * Emit an assignment state.
     */
    protected emitAssignment(
        state: SemState,
        item: TraceItem,
        featureNames: Map<number, string>,
        options: ResolvedTextSerializeOptions
    ): string | undefined {
        const value = item.value;
        if (value === undefined) return undefined;

        const grammarElement = state.grammarElement;
        if (!isAssignment(grammarElement)) return undefined;

        const feature = featureNames.get(state.featureIndex) ?? state.feature ?? '';

        // Boolean assignment - the keyword itself is emitted
        if (state.isBooleanAssignment) {
            if (isKeyword(grammarElement.terminal)) {
                return grammarElement.terminal.value;
            }
            return undefined;
        }

        // Cross-reference
        if (isCrossReference(grammarElement.terminal)) {
            return this.formatReference(value, options);
        }

        // Rule call (terminal or parser rule)
        const terminal = grammarElement.terminal;
        if (isRuleCall(terminal) || isTerminalRuleCall(terminal)) {
            const rule = terminal.rule.ref;
            if (rule) {
                return this.formatValue(value, rule.name, item.obj.node, feature, options);
            }
        }

        // Keyword in assignment (value should equal keyword)
        if (isKeyword(terminal)) {
            return terminal.value;
        }

        // Fallback
        return this.formatValue(value, 'unknown', item.obj.node, feature, options);
    }

    /**
     * Emit an unassigned rule call state.
     *
     * Handles two scenarios:
     * 1. Unassigned parser rule calls (e.g., `Wrapper: 'wrap' Item`)
     *    - Search for an AST property matching the rule's type
     *    - Recursively serialize the found child node
     * 2. Unassigned terminal rule calls (e.g., `TerminalEcho: 'term' value=INT INT`)
     *    - Search for a primitive property on the node
     *    - Format and emit the found value
     */
    protected emitRuleCall(
        state: SemState,
        item: TraceItem,
        _featureNames: Map<number, string>,
        options: ResolvedTextSerializeOptions
    ): string | undefined {
        const grammarElement = state.grammarElement;
        if (!isRuleCall(grammarElement) && !isTerminalRuleCall(grammarElement)) {
            return undefined;
        }

        const rule = grammarElement.rule.ref;
        if (!rule) {
            return undefined;
        }

        // Data type rules emit their value directly
        if (isParserRule(rule) && isDataTypeRule(rule)) {
            return item.value !== undefined ? String(item.value) : undefined;
        }

        // Handle unassigned rule calls by searching for matching properties
        if (state.isUnassignedRuleCall) {
            const node = item.obj.node;

            // Unassigned parser rule: search for AST property matching rule type
            if (isParserRule(rule) && state.ruleType) {
                const candidate = this.findAstProperty(node, state.ruleType);
                if (candidate) {
                    return this.serialize(candidate.value, options);
                }
            }

            // Unassigned terminal rule: search for primitive property
            if (isTerminalRule(rule)) {
                const candidate = this.findPrimitiveProperty(node);
                if (candidate) {
                    return this.formatValue(candidate.value, rule.name, node, candidate.feature, options);
                }
            }
        }

        return undefined;
    }

    /**
     * Find an AST property on the node whose type matches the target type.
     * Used for unassigned parser rule calls.
     */
    protected findAstProperty(
        node: AstNode,
        targetType: string
    ): { feature: string; value: AstNode } | undefined {
        for (const feature of this.getPropertyNames(node)) {
            const value = (node as GenericAstNode)[feature];
            if (isAstNode(value)) {
                if (this.matchesType(value.$type, targetType)) {
                    return { feature, value };
                }
            } else if (Array.isArray(value)) {
                // For arrays, find the first matching item
                for (const item of value) {
                    if (isAstNode(item) && this.matchesType(item.$type, targetType)) {
                        return { feature, value: item };
                    }
                }
            }
        }
        return undefined;
    }

    /**
     * Find a primitive property on the node.
     * Used for unassigned terminal rule calls.
     */
    protected findPrimitiveProperty(
        node: AstNode
    ): { feature: string; value: unknown } | undefined {
        for (const feature of this.getPropertyNames(node)) {
            const value = (node as GenericAstNode)[feature];
            if (value === undefined || value === null) {
                continue;
            }
            if (Array.isArray(value)) {
                // For arrays, find the first primitive item
                for (const item of value) {
                    if (item !== undefined && item !== null && !isAstNode(item)) {
                        return { feature, value: item };
                    }
                }
            } else if (!isAstNode(value) && !isReference(value) && !isMultiReference(value)) {
                return { feature, value };
            }
        }
        return undefined;
    }

    /**
     * Check if a type matches or is a subtype of the target type.
     */
    protected matchesType(type: string, target: string): boolean {
        if (type === target) {
            return true;
        }
        return this.astReflection.isSubtype(type, target);
    }

    /**
     * Get property names for an AST node.
     */
    protected getPropertyNames(node: AstNode): string[] {
        const meta = this.astReflection.getTypeMetaData(node.$type);
        const names = Object.keys(meta.properties);
        if (names.length > 0) {
            return names;
        }
        // Fallback: use object keys excluding $ properties
        return Object.keys(node).filter(key => !key.startsWith('$'));
    }

    /**
     * Emit a cross-reference state.
     */
    protected emitCrossReference(
        state: SemState,
        item: TraceItem,
        _featureNames: Map<number, string>,
        options: ResolvedTextSerializeOptions
    ): string | undefined {
        if (!isCrossReference(state.grammarElement)) return undefined;

        const value = item.value;
        if (value === undefined) return undefined;

        const terminal = getCrossReferenceTerminal(state.grammarElement) ?? state.grammarElement.terminal;
        if (terminal && isKeyword(terminal)) {
            return terminal.value;
        }

        return this.formatReference(value, options);
    }

    /**
     * Format a reference value for output.
     */
    protected formatReference(value: unknown, options: ResolvedTextSerializeOptions): string | undefined {
        if (isReference(value)) {
            if (options.useRefText && value.$refText) {
                return value.$refText;
            }
            if (value.ref) {
                return this.nameProvider.getName(value.ref) ?? value.$refText;
            }
            return value.$refText;
        }
        if (isMultiReference(value)) {
            // Multi-references should be handled differently
            // For now, return undefined
            return undefined;
        }
        // If it's already a string (name), return it
        if (typeof value === 'string') {
            return value;
        }
        return undefined;
    }

    /**
     * Check if a value is an AST node (has $type property).
     */
    protected isAstNode(value: unknown): value is AstNode {
        return typeof value === 'object' && value !== null && '$type' in value;
    }

    /**
     * Format a primitive value for output.
     */
    protected formatValue(
        value: unknown,
        ruleName: string,
        node: AstNode,
        property: string,
        options: ResolvedTextSerializeOptions
    ): string {
        // Child AST nodes are recursively serialized
        if (this.isAstNode(value)) {
            return this.serialize(value, options);
        }

        // Custom hook
        if (options.serializeValue) {
            return options.serializeValue({
                node,
                property,
                value,
                ruleName,
                languageId: this.languageId
            });
        }

        // Default formatting
        if (value instanceof Date) {
            return value.toISOString();
        }
        if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'bigint') {
            return String(value);
        }
        const text = value !== undefined ? String(value) : '';
        if (ruleName.toUpperCase() === 'STRING') {
            return JSON.stringify(text);
        }
        return text;
    }
}
