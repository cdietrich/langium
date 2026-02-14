/******************************************************************************
 * Copyright 2024 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { AstNode, Reference, AstReflection } from '../syntax-tree.js';
import type { Grammar, AbstractParserRule, ParserRule, AbstractElement, Assignment, Keyword, RuleCall, CrossReference } from '../languages/generated/ast.js';
import { isParserRule, isAssignment, isKeyword, isRuleCall, isCrossReference, isGroup, isAlternatives, isAction, isTerminalRule, isUnorderedGroup } from '../languages/generated/ast.js';
import type { TextSerializer, TextSerializeOptions, SerializationContext, AmbiguityResolver, SerializationChoice, ArrayIterationState, SerializeValueContext } from './text-serializer.js';
import { createSerializationError } from './text-serializer.js';
import { GrammarAnalyzer } from './grammar-analyzer.js';
import { DefaultConcreteSyntaxValidator, type ConcreteSyntaxValidator } from './concrete-syntax-validator.js';
import { DefaultContextResolver, type ContextResolver } from './context-resolver.js';
import { getTypeName, isDataTypeRule, isOptionalCardinality, isArrayCardinality, isArrayOperator } from '../utils/grammar-utils.js';
import type { LangiumCoreServices } from '../services.js';
import type { ToStringConverter } from './to-string-converter.js';

export interface SerializationState {
    id: string;
    transitions: SerializationTransition[];
    isEnd: boolean;
}

export interface SerializationTransition {
    element: AbstractElement;
    target: SerializationState;
    constraint?: TransitionConstraint;
}

export interface TransitionConstraint {
    type: 'property-present' | 'property-absent' | 'type-match' | 'value-match' | 'group-present' | 'group-absent' | 'array-has-more' | 'array-exhausted';
    property?: string;
    properties?: string[];
    value?: unknown;
    arrayProperty?: string;
}

export interface StateMachineInfo {
    startState: SerializationState;
    states: Map<string, SerializationState>;
}

export class StateMachineSerializer implements TextSerializer {
    protected readonly grammar: Grammar;
    protected readonly astReflection: AstReflection;
    protected readonly validator: ConcreteSyntaxValidator;
    protected readonly contextResolver: ContextResolver;
    protected readonly grammarAnalyzer: GrammarAnalyzer;
    protected readonly stateMachines: Map<string, StateMachineInfo>;
    protected readonly nameProvider: { getName(node: AstNode): string | undefined };
    protected readonly toStringConverter: ToStringConverter;

    constructor(services: LangiumCoreServices) {
        this.grammar = services.Grammar;
        this.astReflection = services.shared.AstReflection;
        this.validator = new DefaultConcreteSyntaxValidator(this.grammar, this.astReflection);
        this.contextResolver = new DefaultContextResolver(this.grammar);
        this.grammarAnalyzer = new GrammarAnalyzer(this.grammar);
        this.stateMachines = new Map();
        this.nameProvider = services.references.NameProvider;
        this.toStringConverter = services.serializer.ToStringConverter;

        this.buildStateMachines();
    }

    serialize(node: AstNode, options?: TextSerializeOptions): string {
        const validationResult = this.validator.validate(node, { allowPartial: options?.preserveComments === false });
        if (!validationResult.valid) {
            const errors = validationResult.issues.filter((i: { severity: string }) => i.severity === 'error');
            throw createSerializationError(
                `Cannot serialize node: ${errors.map((e: { message: string }) => e.message).join(', ')}`,
                node,
                errors
            );
        }

        const context = this.contextResolver.findContext(node);
        if (!context) {
            throw createSerializationError(
                `No serialization context found for type '${node.$type}'`,
                node
            );
        }

        return this.serializeNode(node, context, options);
    }

    serializeFragment(node: AstNode, context?: SerializationContext): string {
        const serializeContext = context ?? this.contextResolver.findContext(node);
        if (!serializeContext) {
            throw createSerializationError(
                `No serialization context found for fragment of type '${node.$type}'`,
                node
            );
        }

        return this.serializeNode(node, serializeContext, { format: false });
    }

    protected serializeNode(
        node: AstNode,
        context: SerializationContext,
        options?: TextSerializeOptions
    ): string {
        const rule = context.rule;
        if (!isParserRule(rule)) {
            throw createSerializationError(
                `Expected a parser rule, got '${rule.$type}'`,
                node
            );
        }

        const smKey = this.getStateMachineKey(rule, node.$type);
        let stateMachine = this.stateMachines.get(smKey);
        if (!stateMachine) {
            stateMachine = this.buildStateMachine(rule, node.$type);
            this.stateMachines.set(smKey, stateMachine);
        }

        const arrayStates = this.initializeArrayStates(node);

        const output: string[] = [];
        let state = stateMachine.startState;
        const resolver = this.getAmbiguityResolver(options);
        const spaceChar = options?.space ?? ' ';

        while (!state.isEnd) {
            const matchingTransitions = this.findMatchingTransitions(state, node, arrayStates);
            if (matchingTransitions.length === 0) {
                throw createSerializationError(
                    `No valid transition found at state '${state.id}'`,
                    node,
                    [],
                    context
                );
            }

            const transition = this.resolveTransition(matchingTransitions, resolver, node);
            const text = this.serializeTransition(transition, node, options, arrayStates);
            if (text.length > 0) {
                output.push(text);
            }
            state = transition.target;
        }

        let result = output.join(spaceChar);
        if (options?.format) {
            result = this.formatOutput(result, options);
        }

        return result;
    }

protected initializeArrayStates(node: AstNode): Map<string, ArrayIterationState> {
        const states = new Map<string, ArrayIterationState>();
        for (const [key, value] of Object.entries(node)) {
            if (key.startsWith('$')) continue;
            if (Array.isArray(value)) {
                states.set(key, {
                    property: key,
                    values: value,
                    currentIndex: 0,
                    totalElements: value.length,
                    separator: ',',
                    exhausted: value.length === 0
                });
            }
        }
        return states;
    }

    protected buildStateMachines(): void {
        const analysis = this.grammarAnalyzer.analyze();
        for (const [rule, info] of analysis.ruleInfo) {
            if (isParserRule(rule) && !isDataTypeRule(rule)) {
                const sm = this.buildStateMachine(rule, info.typeName);
                this.stateMachines.set(this.getStateMachineKey(rule, info.typeName), sm);
            }
        }
    }

    protected getStateMachineKey(rule: AbstractParserRule, typeName: string): string {
        return `${rule.name}:${typeName}`;
    }

    protected buildStateMachine(rule: ParserRule, typeName: string): StateMachineInfo {
        const states = new Map<string, SerializationState>();
        let stateCounter = 0;

        const createState = (isEnd: boolean = false): SerializationState => {
            const id = `${rule.name}_${stateCounter++}`;
            const state: SerializationState = { id, transitions: [], isEnd };
            states.set(id, state);
            return state;
        };

        const startState = createState();
        const endState = createState(true);

        this.buildStateMachineFromElement(rule.definition, startState, endState, states, createState, typeName);

        return { startState, states };
    }

    protected buildStateMachineFromElement(
        element: AbstractElement,
        currentState: SerializationState,
        endState: SerializationState,
        states: Map<string, SerializationState>,
        createState: (isEnd?: boolean) => SerializationState,
        currentTypeName: string
    ): void {
        if (isKeyword(element)) {
            currentState.transitions.push({
                element,
                target: endState
            });
        } else if (isAssignment(element)) {
            const isArray = isArrayCardinality(element.cardinality) || isArrayOperator(element.operator);
            
            if (isArray && isArrayCardinality(element.cardinality)) {
                currentState.transitions.push({
                    element: { $type: 'Keyword', value: '' } as Keyword,
                    target: endState,
                    constraint: {
                        type: 'array-exhausted',
                        arrayProperty: element.feature
                    }
                });

                const loopBodyStart = createState();
                currentState.transitions.push({
                    element: { $type: 'Keyword', value: '' } as Keyword,
                    target: loopBodyStart,
                    constraint: {
                        type: 'array-has-more',
                        arrayProperty: element.feature
                    }
                });

                loopBodyStart.transitions.push({
                    element,
                    target: currentState,
                    constraint: {
                        type: 'property-present',
                        property: element.feature
                    }
                });
            } else {
                currentState.transitions.push({
                    element,
                    target: endState,
                    constraint: {
                        type: 'property-present',
                        property: element.feature
                    }
                });

                if (isOptionalCardinality(element.cardinality, element) || element.operator === '?=') {
                    const parent = element.$container;
                    const hasFalseKeywordAlternative = isAlternatives(parent) && parent.elements.some(e =>
                        isKeyword(e) && e.value === 'false');
                    
                    if (element.operator === '?=' && hasFalseKeywordAlternative) {
                    } else if (element.operator === '?=') {
                        currentState.transitions.push({
                            element: { $type: 'Keyword', value: '' } as Keyword,
                            target: endState,
                            constraint: {
                                type: 'property-absent',
                                property: element.feature
                            }
                        });
                    } else {
                        currentState.transitions.push({
                            element: { $type: 'Keyword', value: '' } as Keyword,
                            target: endState
                        });
                    }
                }
            }
        } else if (isRuleCall(element)) {
            const calledRule = element.rule.ref;
            if (calledRule && isParserRule(calledRule) && !isDataTypeRule(calledRule)) {
                currentState.transitions.push({
                    element,
                    target: endState
                });
            } else if (calledRule && (isTerminalRule(calledRule) || isDataTypeRule(calledRule as ParserRule))) {
                currentState.transitions.push({
                    element,
                    target: endState
                });
            }
        } else if (isCrossReference(element)) {
            currentState.transitions.push({
                element,
                target: endState,
                constraint: {
                    type: 'property-present'
                }
            });
        } else if (isAction(element)) {
            const actionTypeName = element.inferredType?.name ??
                (element.type?.ref ? getTypeName(element.type.ref) : currentTypeName);
            currentState.transitions.push({
                element,
                target: endState,
                constraint: {
                    type: 'type-match',
                    value: actionTypeName
                }
            });
        } else if (isGroup(element)) {
            let state = currentState;
            const childElements = [...element.elements];

            const groupAssignments = this.collectGroupAssignments(element);
            const groupProperty = this.findFirstArrayProperty(element) ?? (groupAssignments.length > 0 ? groupAssignments[0] : undefined);

            if (isOptionalCardinality(element.cardinality)) {
                currentState.transitions.push({
                    element: { $type: 'Keyword', value: '' } as Keyword,
                    target: endState,
                    constraint: {
                        type: 'group-absent',
                        properties: groupAssignments
                    }
                });
            }

            if (isArrayCardinality(element.cardinality) && groupProperty) {
                const loopBodyStart = createState();

                currentState.transitions.push({
                    element: { $type: 'Keyword', value: '' } as Keyword,
                    target: endState,
                    constraint: {
                        type: 'array-exhausted',
                        arrayProperty: groupProperty
                    }
                });

                currentState.transitions.push({
                    element: { $type: 'Keyword', value: '' } as Keyword,
                    target: loopBodyStart,
                    constraint: {
                        type: 'array-has-more',
                        arrayProperty: groupProperty
                    }
                });

                let loopState = loopBodyStart;
                for (let i = 0; i < childElements.length; i++) {
                    const child = childElements[i];
                    const isLast = i === childElements.length - 1;
                    const targetState = isLast ? currentState : createState();

                    this.buildStateMachineFromElement(child, loopState, targetState, states, createState, currentTypeName);

                    if (!isLast) {
                        loopState = targetState;
                    }
                }
            } else {
                for (let i = 0; i < childElements.length; i++) {
                    const child = childElements[i];
                    const isLast = i === childElements.length - 1;
                    const targetState = isLast ? endState : createState();

                    this.buildStateMachineFromElement(child, state, targetState, states, createState, currentTypeName);

                    if (!isLast) {
                        state = targetState;
                    }
                }
            }
        } else if (isAlternatives(element)) {
            for (const alt of element.elements) {
                if (isGroup(alt)) {
                    const altAssignments = this.collectGroupAssignments(alt);
                    const groupBodyStart = createState();
                    currentState.transitions.push({
                        element: { $type: 'Keyword', value: '' } as Keyword,
                        target: groupBodyStart,
                        constraint: {
                            type: 'group-present',
                            properties: altAssignments
                        }
                    });
                    this.buildStateMachineFromElement(alt, groupBodyStart, endState, states, createState, currentTypeName);
                } else if (isKeyword(alt)) {
                    const hasBooleanAssignment = element.elements.some(e =>
                        isAssignment(e) && e.operator === '?=');
                    if (hasBooleanAssignment && alt.value === 'false') {
                        const boolAssign = element.elements.find(e =>
                            isAssignment(e) && e.operator === '?=') as Assignment;
                        currentState.transitions.push({
                            element: alt,
                            target: endState,
                            constraint: {
                                type: 'value-match',
                                property: boolAssign.feature,
                                value: false
                            }
                        });
                    } else {
                        this.buildStateMachineFromElement(alt, currentState, endState, states, createState, currentTypeName);
                    }
                } else {
                    this.buildStateMachineFromElement(alt, currentState, endState, states, createState, currentTypeName);
                }
            }
        } else if (isUnorderedGroup(element)) {
            let state = currentState;
            const childElements = [...element.elements];
            for (let i = 0; i < childElements.length; i++) {
                const child = childElements[i];
                const isLast = i === childElements.length - 1;
                const targetState = isLast ? endState : createState();

                this.buildStateMachineFromElement(child, state, targetState, states, createState, currentTypeName);

                if (!isLast) {
                    state = targetState;
                }
            }
        }
    }

    protected findMatchingTransitions(state: SerializationState, node: AstNode, arrayStates?: Map<string, ArrayIterationState>): SerializationTransition[] {
        return state.transitions.filter(t => this.matchesConstraint(t, node, arrayStates));
    }

    protected matchesConstraint(transition: SerializationTransition, node: AstNode, arrayStates?: Map<string, ArrayIterationState>): boolean {
        const constraint = transition.constraint;
        const element = transition.element;

        if (isKeyword(element)) {
            const parent = element.$container;
            if (parent && 'elements' in parent && Array.isArray((parent as { elements: unknown[] }).elements)) {
                const altParent = parent as { elements: AbstractElement[] };
                for (const sibling of altParent.elements) {
                    if (isAssignment(sibling) && sibling.operator === '?=') {
                        const property = sibling.feature;
                        const value = (node as unknown as Record<string, unknown>)[property];
                        if (value === false && element.value === 'false') {
                            return true;
                        }
                        if (value === false && element.value !== 'false') {
                            return false;
                        }
                    }
                }
            }
        }

        if (!constraint) {
            return true;
        }

        if (isAssignment(element)) {
            const property = element.feature;
            const value = (node as unknown as Record<string, unknown>)[property];

            if (constraint.type === 'property-present') {
                if (value === undefined || value === null) {
                    return false;
                }
                if (Array.isArray(value) && value.length === 0 && !isOptionalCardinality(element.cardinality, element)) {
                    return false;
                }
                if (element.operator === '?=') {
                    return value === true;
                }
            }
        }

        if (isAction(element) && constraint.type === 'type-match') {
            return node.$type === constraint.value;
        }

        if (constraint.type === 'group-present') {
            const properties = constraint.properties ?? [];
            for (const prop of properties) {
                const value = (node as unknown as Record<string, unknown>)[prop];
                if (value !== undefined && value !== null) {
                    if (Array.isArray(value)) {
                        if (value.length > 0) return true;
                    } else {
                        return true;
                    }
                }
            }
            return false;
        }

        if (constraint.type === 'group-absent') {
            const properties = constraint.properties ?? [];
            for (const prop of properties) {
                const value = (node as unknown as Record<string, unknown>)[prop];
                if (value !== undefined && value !== null) {
                    if (Array.isArray(value)) {
                        if (value.length > 0) return false;
                    } else {
                        return false;
                    }
                }
            }
            return true;
        }

        if (constraint.type === 'array-has-more') {
            const prop = constraint.arrayProperty ?? constraint.property;
            if (!prop || !arrayStates) return false;
            const state = arrayStates.get(prop);
            return state !== undefined && !state.exhausted && state.currentIndex < state.totalElements;
        }

        if (constraint.type === 'array-exhausted') {
            const prop = constraint.arrayProperty ?? constraint.property;
            if (!prop || !arrayStates) return true;
            const state = arrayStates.get(prop);
            return state === undefined || state.exhausted || state.currentIndex >= state.totalElements;
        }

        if (constraint.type === 'value-match' && constraint.property) {
            const value = (node as unknown as Record<string, unknown>)[constraint.property];
            if (constraint.value === undefined) {
                return value === undefined || value === null;
            }
            return value === constraint.value;
        }

        if (constraint.type === 'property-absent' && constraint.property) {
            const value = (node as unknown as Record<string, unknown>)[constraint.property];
            if (value === false) {
                const parent = transition.element.$container;
                const hasFalseKeywordAlternative = isAlternatives(parent) && parent.elements.some((e: AbstractElement) =>
                    isKeyword(e) && e.value === 'false');
                return !hasFalseKeywordAlternative;
            }
            return value === undefined || value === null;
        }

        return true;
    }

    protected collectGroupAssignments(group: AbstractElement): string[] {
        const assignments: string[] = [];
        this.collectAssignmentsFromElement(group, assignments);
        return assignments;
    }

    protected collectAssignmentsFromElement(element: AbstractElement, assignments: string[]): void {
        if (isAssignment(element)) {
            assignments.push(element.feature);
        } else if (isGroup(element) || isAlternatives(element)) {
            for (const child of element.elements) {
                this.collectAssignmentsFromElement(child, assignments);
            }
        }
    }

    protected findFirstArrayProperty(element: AbstractElement): string | undefined {
        if (isAssignment(element) && (isArrayCardinality(element.cardinality) || element.operator === '+=')) {
            return element.feature;
        }
        if (isGroup(element) || isAlternatives(element)) {
            for (const child of element.elements) {
                const prop = this.findFirstArrayProperty(child);
                if (prop) return prop;
            }
        }
        return undefined;
    }

    protected resolveTransition(
        transitions: SerializationTransition[],
        resolver: AmbiguityResolver,
        node: AstNode
    ): SerializationTransition {
        if (transitions.length === 1) {
            return transitions[0];
        }

        const choices: SerializationChoice[] = transitions.map((t, i) => ({
            index: i,
            element: t.element,
            description: this.describeTransition(t)
        }));

        const selected = typeof resolver === 'function'
            ? resolver(choices)
            : choices[0];

        return transitions[selected.index];
    }

    protected describeTransition(transition: SerializationTransition): string {
        const element = transition.element;
        if (isKeyword(element)) {
            return `keyword '${element.value}'`;
        } else if (isAssignment(element)) {
            return `assignment '${element.feature}'`;
        } else if (isRuleCall(element)) {
            return `rule call to '${element.rule.ref?.name ?? 'unknown'}'`;
        } else if (isCrossReference(element)) {
            return `cross reference to '${element.type.ref?.name ?? 'unknown'}'`;
        } else if (isAction(element)) {
            return 'action';
        }
        return 'unknown element';
    }

    protected serializeTransition(
        transition: SerializationTransition,
        node: AstNode,
        options?: TextSerializeOptions,
        arrayStates?: Map<string, ArrayIterationState>
    ): string {
        const element = transition.element;

        if (isKeyword(element)) {
            return element.value;
        }

        if (isAssignment(element)) {
            return this.serializeAssignment(element, node, options, arrayStates);
        }

        if (isRuleCall(element)) {
            return this.serializeRuleCall(element, node, options);
        }

        if (isCrossReference(element)) {
            return this.serializeCrossReference(element, node, options);
        }

        if (isAction(element)) {
            return '';
        }

        return '';
    }

    protected serializeAssignment(
        assignment: Assignment,
        node: AstNode,
        options?: TextSerializeOptions,
        arrayStates?: Map<string, ArrayIterationState>
    ): string {
        const property = assignment.feature;
        const value = (node as unknown as Record<string, unknown>)[property];

        if (assignment.operator === '?=') {
            if (value === true) {
                if (isKeyword(assignment.terminal)) {
                    return assignment.terminal.value;
                }
                return '';
            }
            return '';
        }

        if (value === undefined || value === null) {
            return '';
        }

        const isArray = isArrayCardinality(assignment.cardinality) || isArrayOperator(assignment.operator);
        if (isArray && Array.isArray(value)) {
            if (arrayStates) {
                const state = arrayStates.get(property);
                if (state && state.currentIndex < state.totalElements) {
                    const element = state.values[state.currentIndex];
                    state.currentIndex++;
                    state.exhausted = state.currentIndex >= state.totalElements;
                    return this.serializeValue(element, assignment.terminal, options, node, property);
                }
                return '';
            }
            return this.serializeArrayValue(assignment, value, options, node);
        }

        return this.serializeValue(value, assignment.terminal, options, node, property);
    }

    protected serializeArrayValue(
        assignment: Assignment,
        values: unknown[],
        options?: TextSerializeOptions,
        node?: AstNode
    ): string {
        const parts: string[] = [];

        for (let i = 0; i < values.length; i++) {
            if (i > 0) {
                parts.push(',');
            }
            parts.push(this.serializeValue(values[i], assignment.terminal, options, node, assignment.feature));
        }

        return parts.join('');
    }

    protected serializeValue(value: unknown, terminal: AbstractElement, options?: TextSerializeOptions, node?: AstNode, property?: string): string {
        if (options?.serializeValue && node && property) {
            const ruleName = this.getRuleName(terminal);
            const ctx: SerializeValueContext = {
                node,
                property,
                value,
                ruleName,
                languageId: this.grammar.name ?? 'unknown'
            };
            const hookResult = options.serializeValue(ctx);
            if (hookResult !== undefined) {
                return hookResult;
            }
        }
        if (this.isAstNode(value)) {
            const context = this.contextResolver.findContext(value);
            return context ? this.serializeNode(value, context, options) : '';
        }
        if (this.isReference(value)) {
            let refText = value.$refText;
            if (!refText || options?.useRefText === false) {
                if (value.ref) {
                    refText = this.nameProvider.getName(value.ref) ?? '';
                }
            }
            if (refText) {
                if (isRuleCall(terminal) && terminal.rule.ref) {
                    return this.toStringConverter.convertWithRule(refText, terminal.rule.ref);
                }
                return refText;
            }
            return '';
        }
        if (isRuleCall(terminal)) {
            const rule = terminal.rule.ref;
            if (rule) {
                return this.toStringConverter.convertWithRule(value as string | number | boolean | bigint | Date, rule);
            }
        }
        if (typeof value === 'string') {
            return value;
        }
        if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
            return String(value);
        }
        if (value instanceof Date) {
            return value.toISOString();
        }
        return String(value);
    }

    protected getRuleName(terminal: AbstractElement): string {
        if (isRuleCall(terminal) && terminal.rule.ref) {
            return terminal.rule.ref.name;
        }
        return '';
    }

    protected serializeRuleCall(
        ruleCall: RuleCall,
        node: AstNode,
        options?: TextSerializeOptions
    ): string {
        const rule = ruleCall.rule.ref;
        if (!rule) {
            return '';
        }

        if (isTerminalRule(rule)) {
            return this.toStringConverter.convertWithRule(node.$type as unknown as string | number | boolean | bigint | Date, rule);
        }

        if (isParserRule(rule) && !isDataTypeRule(rule)) {
            const context: SerializationContext = {
                rule,
                container: undefined,
                containerProperty: undefined
            };
            return this.serializeNode(node, context, options);
        }

        if (isParserRule(rule) && isDataTypeRule(rule)) {
            return this.toStringConverter.convertWithRule(node.$type as unknown as string | number | boolean | bigint | Date, rule);
        }

        return '';
    }

    protected serializeCrossReference(
        crossRef: CrossReference,
        node: AstNode,
        options?: TextSerializeOptions
    ): string {
        const nodeValue = this.getPropertyValue(node, crossRef);
        let refText: string | undefined;

        if (this.isReference(nodeValue)) {
            refText = nodeValue.$refText;
            const refNode = nodeValue.ref;
            if (refNode && !refText) {
                refText = this.nameProvider.getName(refNode) ?? '';
            }
        }

        if (!refText) {
            return '';
        }

        const terminal = crossRef.terminal;
        if (terminal && isRuleCall(terminal) && terminal.rule.ref) {
            return this.toStringConverter.convertWithRule(refText, terminal.rule.ref);
        }
        if (terminal && isTerminalRule(terminal)) {
            return this.toStringConverter.convertWithRule(refText, terminal);
        }

        return refText;
    }

    protected findNameAssignmentForType(typeName: string): Assignment | undefined {
        const rules = this.grammarAnalyzer.getRulesForType(typeName);
        for (const rule of rules) {
            const info = this.grammarAnalyzer.getRuleInfo(rule);
            if (info) {
                const nameAssignment = info.assignments.find(
                    a => a.property.toLowerCase() === 'name'
                );
                if (nameAssignment) {
                    return nameAssignment.assignment;
                }
            }
        }
        return undefined;
    }

    protected getPropertyValue(node: AstNode, element: AbstractElement): unknown {
        const assignment = this.findContainingAssignment(element);
        if (assignment) {
            return (node as unknown as Record<string, unknown>)[assignment.feature];
        }
        return undefined;
    }

    protected findContainingAssignment(element: AbstractElement): Assignment | undefined {
        let current: AstNode | undefined = element;
        while (current) {
            if (isAssignment(current)) {
                return current;
            }
            current = current.$container;
        }
        return undefined;
    }

    protected getAmbiguityResolver(options?: TextSerializeOptions): AmbiguityResolver {
        return options?.ambiguityResolver ?? 'first';
    }

    protected formatOutput(text: string, options?: TextSerializeOptions): string {
        if (typeof options?.format === 'object') {
            return this.applyFormatting(text, options.format);
        }
        return text;
    }

    protected applyFormatting(text: string, options: { newLine?: string }): string {
        return text;
    }

    protected isReference(value: unknown): value is Reference {
        return typeof value === 'object' && value !== null &&
            'ref' in value && '$refText' in value;
    }

    protected isAstNode(value: unknown): value is AstNode {
        return typeof value === 'object' && value !== null &&
            '$type' in value;
    }
}
