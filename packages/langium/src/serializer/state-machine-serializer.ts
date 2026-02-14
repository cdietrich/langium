/******************************************************************************
 * Copyright 2024 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { AstNode, Reference, AstReflection } from '../syntax-tree.js';
import type { Grammar, AbstractParserRule, ParserRule, AbstractElement, Assignment, Keyword, RuleCall, CrossReference } from '../languages/generated/ast.js';
import { isParserRule, isAssignment, isKeyword, isRuleCall, isCrossReference, isGroup, isAlternatives, isAction, isTerminalRule } from '../languages/generated/ast.js';
import type { TextSerializer, TextSerializeOptions, SerializationContext, AmbiguityResolver, SerializationChoice } from './text-serializer.js';
import { createSerializationError } from './text-serializer.js';
import { GrammarAnalyzer } from './grammar-analyzer.js';
import { DefaultConcreteSyntaxValidator, type ConcreteSyntaxValidator } from './concrete-syntax-validator.js';
import { DefaultContextResolver, type ContextResolver } from './context-resolver.js';
import { getTypeName, isDataTypeRule, isOptionalCardinality, isArrayCardinality } from '../utils/grammar-utils.js';
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
    type: 'property-present' | 'property-absent' | 'type-match' | 'value-match';
    property?: string;
    value?: unknown;
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

        const output: string[] = [];
        let state = stateMachine.startState;
        const resolver = this.getAmbiguityResolver(options);

        while (!state.isEnd) {
            const matchingTransitions = this.findMatchingTransitions(state, node);
            if (matchingTransitions.length === 0) {
                throw createSerializationError(
                    `No valid transition found at state '${state.id}'`,
                    node,
                    [],
                    context
                );
            }

            const transition = this.resolveTransition(matchingTransitions, resolver, node);
            const text = this.serializeTransition(transition, node, options);
            output.push(text);
            state = transition.target;
        }

        let result = output.join('');
        if (options?.format) {
            result = this.formatOutput(result, options);
        }

        return result;
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
            currentState.transitions.push({
                element,
                target: endState,
                constraint: {
                    type: 'property-present',
                    property: element.feature
                }
            });

            if (isOptionalCardinality(element.cardinality, element)) {
                currentState.transitions.push({
                    element: { $type: 'Keyword', value: '' } as Keyword,
                    target: endState
                });
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

            if (isOptionalCardinality(element.cardinality)) {
                const afterOptionalState = endState;
                currentState.transitions.push({
                    element: { $type: 'Keyword', value: '' } as Keyword,
                    target: afterOptionalState
                });
            }

            for (let i = 0; i < childElements.length; i++) {
                const child = childElements[i];
                const isLast = i === childElements.length - 1;
                const targetState = isLast ? endState : createState();

                this.buildStateMachineFromElement(child, state, targetState, states, createState, currentTypeName);

                if (!isLast) {
                    state = targetState;
                }
            }

            if (isArrayCardinality(element.cardinality)) {
                const loopState = currentState;
                endState.transitions.push({
                    element: { $type: 'Keyword', value: '' } as Keyword,
                    target: loopState
                });
            }
        } else if (isAlternatives(element)) {
            for (const alt of element.elements) {
                this.buildStateMachineFromElement(alt, currentState, endState, states, createState, currentTypeName);
            }
        }
    }

    protected findMatchingTransitions(state: SerializationState, node: AstNode): SerializationTransition[] {
        return state.transitions.filter(t => this.matchesConstraint(t, node));
    }

    protected matchesConstraint(transition: SerializationTransition, node: AstNode): boolean {
        const constraint = transition.constraint;
        if (!constraint) {
            return true;
        }

        const element = transition.element;
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
            }
        }

        if (isAction(element) && constraint.type === 'type-match') {
            return node.$type === constraint.value;
        }

        return true;
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
            return `action`;
        }
        return 'unknown element';
    }

    protected serializeTransition(
        transition: SerializationTransition,
        node: AstNode,
        options?: TextSerializeOptions
    ): string {
        const element = transition.element;

        if (isKeyword(element)) {
            return element.value;
        }

        if (isAssignment(element)) {
            return this.serializeAssignment(element, node, options);
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
        options?: TextSerializeOptions
    ): string {
        const property = assignment.feature;
        const value = (node as unknown as Record<string, unknown>)[property];

        if (value === undefined || value === null) {
            return '';
        }

        if (isArrayCardinality(assignment.cardinality) && Array.isArray(value)) {
            return this.serializeArrayValue(assignment, value, options);
        }

        return this.serializeValue(value, assignment.terminal, options);
    }

    protected serializeArrayValue(
        assignment: Assignment,
        values: unknown[],
        options?: TextSerializeOptions
    ): string {
        const parts: string[] = [];

        for (let i = 0; i < values.length; i++) {
            if (i > 0) {
                parts.push(',');
            }
            parts.push(this.serializeValue(values[i], assignment.terminal, options));
        }

        return parts.join('');
    }

    protected serializeValue(value: unknown, terminal: AbstractElement, options?: TextSerializeOptions): string {
        if (this.isAstNode(value)) {
            const context = this.contextResolver.findContext(value);
            return context ? this.serializeNode(value, context, options) : '';
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
                refText = this.nameProvider.getName(refNode);
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