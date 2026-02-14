/******************************************************************************
 * Copyright 2024 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { AstNode, Reference, AstReflection } from '../syntax-tree.js';
import type { Grammar, AbstractParserRule, ParserRule, AbstractElement, Assignment, RuleCall, CrossReference, Alternatives, Group } from '../languages/generated/ast.js';
import { isParserRule, isAssignment, isKeyword, isRuleCall, isCrossReference, isGroup, isAlternatives, isAction, isTerminalRule, isUnorderedGroup } from '../languages/generated/ast.js';
import type { TextSerializer, TextSerializeOptions, SerializationContext, AmbiguityResolver, ArrayIterationState, SerializeValueContext } from './text-serializer.js';
import { createSerializationError } from './text-serializer.js';
import { GrammarAnalyzer } from './grammar-analyzer.js';
import { DefaultConcreteSyntaxValidator, type ConcreteSyntaxValidator } from './concrete-syntax-validator.js';
import { DefaultContextResolver, type ContextResolver } from './context-resolver.js';
import { isDataTypeRule, isArrayCardinality, isOptionalCardinality, isArrayOperator, getTypeName } from '../utils/grammar-utils.js';
import type { LangiumCoreServices } from '../services.js';
import type { ToStringConverter } from './to-string-converter.js';

export type DCSTNode = TerminalNode | NonTerminalNode | DisjunctionNode;

export interface TerminalNode {
    kind: 'terminal';
    text: string;
    grammarElement: AbstractElement;
}

export interface NonTerminalNode {
    kind: 'nonterminal';
    ruleName: string;
    children: DCSTNode[];
    grammarElement: AbstractParserRule;
}

export interface DisjunctionNode {
    kind: 'disjunction';
    alternatives: [DCSTNode, DCSTNode];
    headSymbol: string;
}

export type CSTNode = CSTTerminalNode | CSTNonTerminalNode;

export interface CSTTerminalNode {
    kind: 'terminal';
    text: string;
    grammarElement: AbstractElement;
}

export interface CSTNonTerminalNode {
    kind: 'nonterminal';
    ruleName: string;
    children: CSTNode[];
    grammarElement: AbstractParserRule;
}

export class DCSTSerializer implements TextSerializer {
    protected readonly grammar: Grammar;
    protected readonly astReflection: AstReflection;
    protected readonly validator: ConcreteSyntaxValidator;
    protected readonly contextResolver: ContextResolver;
    protected readonly grammarAnalyzer: GrammarAnalyzer;
    protected readonly nameProvider: { getName(node: AstNode): string | undefined };
    protected readonly toStringConverter: ToStringConverter;

    constructor(services: LangiumCoreServices) {
        this.grammar = services.Grammar;
        this.astReflection = services.shared.AstReflection;
        this.validator = new DefaultConcreteSyntaxValidator(this.grammar, this.astReflection);
        this.contextResolver = new DefaultContextResolver(this.grammar);
        this.grammarAnalyzer = new GrammarAnalyzer(this.grammar);
        this.nameProvider = services.references.NameProvider;
        this.toStringConverter = services.serializer.ToStringConverter;
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
        if (!isParserRule(rule) || isDataTypeRule(rule)) {
            throw createSerializationError(
                `Expected a non-data-type parser rule, got '${rule.$type}'`,
                node
            );
        }

        const arrayStates = this.initializeArrayStates(node);
        const dcst = this.describe(node, rule, arrayStates, options);
        const resolver = this.getAmbiguityResolver(options);
        const cst = this.settle(dcst, resolver);
        const spaceChar = options?.space ?? ' ';
        let result = this.format(cst, spaceChar);

        if (options?.format) {
            result = this.applyFormatting(result, options);
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

    describe(node: AstNode, rule: ParserRule, arrayStates?: Map<string, ArrayIterationState>, options?: TextSerializeOptions): DCSTNode {
        if (!arrayStates) {
            arrayStates = this.initializeArrayStates(node);
        }
        const children = this.describeElement(rule.definition, node, arrayStates, options);
        return {
            kind: 'nonterminal',
            ruleName: rule.name,
            children,
            grammarElement: rule
        };
    }

    protected describeElement(element: AbstractElement, node: AstNode, arrayStates?: Map<string, ArrayIterationState>, options?: TextSerializeOptions): DCSTNode[] {
        const result: DCSTNode[] = [];

        if (isKeyword(element)) {
            result.push({
                kind: 'terminal',
                text: element.value,
                grammarElement: element
            });
        } else if (isAssignment(element)) {
            if (isArrayCardinality(element.cardinality)) {
                while (true) {
                    if (arrayStates) {
                        const property = element.feature;
                        const state = arrayStates.get(property);
                        if (!state || state.exhausted || state.currentIndex >= state.totalElements) {
                            break;
                        }
                    } else {
                        break;
                    }
                    const assignmentNodes = this.describeAssignment(element, node, arrayStates, options);
                    result.push(...assignmentNodes);
                }
            } else {
                const assignmentNodes = this.describeAssignment(element, node, arrayStates, options);
                result.push(...assignmentNodes);
            }
        } else if (isRuleCall(element)) {
            const ruleCallNodes = this.describeRuleCall(element, node, options);
            result.push(...ruleCallNodes);
        } else if (isCrossReference(element)) {
            const crossRefNodes = this.describeCrossReference(element, node, options);
            result.push(...crossRefNodes);
        } else if (isAction(element)) {
        } else if (isUnorderedGroup(element)) {
            const groupNodes = this.describeUnorderedGroup(element, node, arrayStates, options);
            result.push(...groupNodes);
        } else if (isGroup(element)) {
            const groupNodes = this.describeGroup(element, node, arrayStates, options);
            result.push(...groupNodes);
        } else if (isAlternatives(element)) {
            const altNodes = this.describeAlternatives(element, node, arrayStates, options);
            result.push(...altNodes);
        }

        return result;
    }

    protected describeAssignment(assignment: Assignment, node: AstNode, arrayStates?: Map<string, ArrayIterationState>, options?: TextSerializeOptions): DCSTNode[] {
        const property = assignment.feature;
        const value = (node as unknown as Record<string, unknown>)[property];
        const nodes: DCSTNode[] = [];

        if (assignment.operator === '?=') {
            if (value === true && isKeyword(assignment.terminal)) {
                nodes.push({
                    kind: 'terminal',
                    text: assignment.terminal.value,
                    grammarElement: assignment.terminal
                });
            }
            return nodes;
        }

        if (value === undefined || value === null) {
            return nodes;
        }

        const isArray = isArrayCardinality(assignment.cardinality) || isArrayOperator(assignment.operator);
        if (isArray && Array.isArray(value)) {
            let localArrayStates = arrayStates;
            if (!arrayStates || !arrayStates.has(property)) {
                localArrayStates = this.initializeArrayStates(node);
            }
            if (localArrayStates) {
                const state = localArrayStates.get(property);
                if (state && state.currentIndex < state.totalElements) {
                    const element = state.values[state.currentIndex];
                    state.currentIndex++;
                    state.exhausted = state.currentIndex >= state.totalElements;
                    const terminalNodes = this.describeTerminal(assignment.terminal, element, node, property, options, localArrayStates);
                    nodes.push(...terminalNodes);
                }
            }
        } else {
            const terminalNodes = this.describeTerminal(assignment.terminal, value, node, property, options);
            nodes.push(...terminalNodes);
        }

        return nodes;
    }

    protected describeTerminal(terminal: AbstractElement, value: unknown, _node: AstNode, property?: string, options?: TextSerializeOptions, arrayStates?: Map<string, ArrayIterationState>): DCSTNode[] {
        if (isKeyword(terminal)) {
            return [{
                kind: 'terminal',
                text: terminal.value,
                grammarElement: terminal
            }];
        }

        const ruleName = this.getRuleName(terminal);
        if (options?.serializeValue && property && ruleName) {
            const ctx: SerializeValueContext = {
                node: _node,
                property,
                value,
                ruleName,
                languageId: this.grammar.name ?? 'unknown'
            };
            const hookResult = options.serializeValue(ctx);
            if (hookResult !== undefined) {
                return [{
                    kind: 'terminal',
                    text: hookResult,
                    grammarElement: terminal
                }];
            }
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
                    const text = this.toStringConverter.convertWithRule(refText, terminal.rule.ref);
                    return [{
                        kind: 'terminal',
                        text,
                        grammarElement: terminal
                    }];
                }
                return [{
                    kind: 'terminal',
                    text: refText,
                    grammarElement: terminal
                }];
            }
            return [];
        }

        if (isRuleCall(terminal) && terminal.rule.ref) {
            const rule = terminal.rule.ref;
            if (isParserRule(rule)) {
                if (isDataTypeRule(rule)) {
                    const text = this.toStringConverter.convertWithRule(value as string | number | boolean | bigint | Date, rule);
                    return [{
                        kind: 'terminal',
                        text,
                        grammarElement: terminal
                    }];
                } else {
                    if (this.isAstNode(value)) {
                        const context = this.contextResolver.findContext(value);
                        if (context && isParserRule(context.rule)) {
                            const dcst = this.describe(value, context.rule, undefined, options);
                            return [dcst];
                        }
                    }
                }
            } else if (isTerminalRule(rule)) {
                const text = this.toStringConverter.convertWithRule(value as string | number | boolean | bigint | Date, rule);
                return [{
                    kind: 'terminal',
                    text,
                    grammarElement: terminal
                }];
            }
        }

        if (isCrossReference(terminal)) {
            const refText = this.isReference(value) ? value.$refText : String(value);
            const innerTerminal = terminal.terminal;
            if (innerTerminal) {
                return this.describeTerminal(innerTerminal, refText, _node, property, options, arrayStates);
            }
            return [{
                kind: 'terminal',
                text: refText,
                grammarElement: terminal
            }];
        }

        return [{
            kind: 'terminal',
            text: String(value),
            grammarElement: terminal
        }];
    }

    protected getRuleName(terminal: AbstractElement): string {
        if (isRuleCall(terminal) && terminal.rule.ref) {
            return terminal.rule.ref.name;
        }
        return '';
    }

    protected describeRuleCall(ruleCall: RuleCall, node: AstNode, options?: TextSerializeOptions): DCSTNode[] {
        const rule = ruleCall.rule.ref;
        if (!rule) {
            return [];
        }

        if (isParserRule(rule) && !isDataTypeRule(rule)) {
            const dcst = this.describe(node, rule, undefined, options);
            return [dcst];
        }

        return [];
    }

    protected describeCrossReference(crossRef: CrossReference, node: AstNode, options?: TextSerializeOptions): DCSTNode[] {
        const assignment = this.findContainingAssignment(crossRef);
        if (!assignment) {
            return [];
        }

        const value = (node as unknown as Record<string, unknown>)[assignment.feature];
        let refText: string;

        if (this.isReference(value)) {
            refText = value.$refText;
            const refNode = value.ref;
            if (refNode && (!refText || options?.useRefText === false)) {
                refText = this.nameProvider.getName(refNode) ?? '';
            }
        } else {
            refText = '';
        }

        if (crossRef.terminal) {
            if (isRuleCall(crossRef.terminal) && crossRef.terminal.rule.ref) {
                const text = this.toStringConverter.convertWithRule(refText, crossRef.terminal.rule.ref);
                return [{
                    kind: 'terminal',
                    text,
                    grammarElement: crossRef
                }];
            }
            if (isTerminalRule(crossRef.terminal)) {
                const text = this.toStringConverter.convertWithRule(refText, crossRef.terminal);
                return [{
                    kind: 'terminal',
                    text,
                    grammarElement: crossRef
                }];
            }
            return this.describeTerminal(crossRef.terminal, refText, node, assignment.feature, options);
        }

        return [{
            kind: 'terminal',
            text: refText,
            grammarElement: crossRef
        }];
    }

    protected describeGroup(group: Group, node: AstNode, arrayStates?: Map<string, ArrayIterationState>, options?: TextSerializeOptions): DCSTNode[] {
        const isOptional = isOptionalCardinality(group.cardinality);
        const isMany = isArrayCardinality(group.cardinality);

        if (isOptional && !isMany) {
            const hasValue = this.groupHasAssignedValue(group, node);
            if (!hasValue) {
                return [];
            }
        }

        if (isMany) {
            const groupProperty = this.findFirstArrayProperty(group);
            let localArrayStates = arrayStates;
            if (groupProperty && (!arrayStates || !arrayStates.has(groupProperty))) {
                localArrayStates = this.initializeArrayStates(node);
            }
            if (groupProperty && localArrayStates) {
                const state = localArrayStates.get(groupProperty);
                if (!state || state.exhausted || state.currentIndex >= state.totalElements) {
                    return [];
                }
            }
            const children: DCSTNode[] = [];
            while (true) {
                const groupProperty = this.findFirstArrayProperty(group);
                if (groupProperty && localArrayStates) {
                    const state = localArrayStates.get(groupProperty);
                    if (!state || state.exhausted || state.currentIndex >= state.totalElements) {
                        break;
                    }
                } else {
                    break;
                }
                for (const element of group.elements) {
                    const elementNodes = this.describeElement(element, node, localArrayStates, options);
                    children.push(...elementNodes);
                }
            }
            return children;
        }

        const children: DCSTNode[] = [];

        for (const element of group.elements) {
            const elementNodes = this.describeElement(element, node, arrayStates, options);
            children.push(...elementNodes);
        }

        return children;
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

    protected describeUnorderedGroup(unorderedGroup: AbstractElement & { elements: AbstractElement[]; cardinality?: '?' | '*' | '+' }, node: AstNode, arrayStates?: Map<string, ArrayIterationState>, options?: TextSerializeOptions): DCSTNode[] {
        const children: DCSTNode[] = [];

        for (const element of unorderedGroup.elements) {
            const elementNodes = this.describeElement(element, node, arrayStates, options);
            children.push(...elementNodes);
        }

        return children;
    }

    protected groupHasAssignedValue(group: Group, node: AstNode): boolean {
        for (const element of group.elements) {
            if (isAssignment(element)) {
                const property = element.feature;
                const value = (node as unknown as Record<string, unknown>)[property];
                if (value !== undefined && value !== null) {
                    if (Array.isArray(value)) {
                        if (value.length > 0) return true;
                    } else {
                        return true;
                    }
                }
            } else if (isGroup(element)) {
                if (this.groupHasAssignedValue(element, node)) {
                    return true;
                }
            } else if (isAlternatives(element)) {
                for (const alt of element.elements) {
                    if (isGroup(alt) && this.groupHasAssignedValue(alt, node)) {
                        return true;
                    } else if (isAssignment(alt)) {
                        const property = alt.feature;
                        const value = (node as unknown as Record<string, unknown>)[property];
                        if (value !== undefined && value !== null) {
                            return true;
                        }
                    }
                }
            }
        }
        return false;
    }

    protected describeAlternatives(alternatives: Alternatives, node: AstNode, arrayStates?: Map<string, ArrayIterationState>, options?: TextSerializeOptions): DCSTNode[] {
        if (alternatives.elements.length === 0) {
            return [];
        }

        if (alternatives.elements.length === 1) {
            return this.describeElement(alternatives.elements[0], node, arrayStates, options);
        }

        for (const alt of alternatives.elements) {
            if (this.alternativeMatchesByType(alt, node)) {
                return this.describeElement(alt, node, arrayStates, options);
            }
        }

        for (const alt of alternatives.elements) {
            if (this.alternativeMatchesNode(alt, node)) {
                return this.describeElement(alt, node, arrayStates, options);
            }
        }

        const first = this.describeElement(alternatives.elements[0], node, arrayStates, options);
        const second = this.describeElement(alternatives.elements[1], node, arrayStates, options);
        const disjunction: DisjunctionNode = {
            kind: 'disjunction',
            alternatives: [
                { kind: 'nonterminal', ruleName: '', children: first, grammarElement: alternatives.elements[0] as unknown as AbstractParserRule },
                { kind: 'nonterminal', ruleName: '', children: second, grammarElement: alternatives.elements[1] as unknown as AbstractParserRule }
            ],
            headSymbol: ''
        };

        let result: DCSTNode = disjunction;
        for (let i = 2; i < alternatives.elements.length; i++) {
            const next = this.describeElement(alternatives.elements[i], node, arrayStates, options);
            result = {
                kind: 'disjunction',
                alternatives: [
                    result,
                    { kind: 'nonterminal', ruleName: '', children: next, grammarElement: alternatives.elements[i] as unknown as AbstractParserRule }
                ],
                headSymbol: ''
            };
        }

        return [result];
    }

    protected alternativeMatchesByType(alt: AbstractElement, node: AstNode): boolean {
        if (isRuleCall(alt) && alt.rule.ref) {
            const rule = alt.rule.ref;
            if (isParserRule(rule)) {
                const ruleType = this.getRuleType(rule);
                return node.$type === ruleType;
            }
        }
        if (isGroup(alt)) {
            const groupType = this.inferGroupType(alt);
            if (groupType) {
                return node.$type === groupType;
            }
        }
        return false;
    }

    protected alternativeMatchesNode(alt: AbstractElement, node: AstNode): boolean {
        if (isGroup(alt)) {
            const groupType = this.inferGroupType(alt);
            if (groupType) {
                return node.$type === groupType;
            }
            return this.groupMatchesNode(alt, node);
        }
        if (isAssignment(alt)) {
            const property = alt.feature;
            const value = (node as unknown as Record<string, unknown>)[property];
            if (alt.operator === '?=') {
                return value === true;
            }
            return value !== undefined && value !== null;
        }
        if (isKeyword(alt)) {
            const parent = alt.$container;
            if (parent && 'elements' in parent && Array.isArray((parent as { elements: unknown[] }).elements)) {
                const altParent = parent as { elements: AbstractElement[] };
                for (const sibling of altParent.elements) {
                    if (isAssignment(sibling) && sibling.operator === '?=') {
                        const property = sibling.feature;
                        const value = (node as unknown as Record<string, unknown>)[property];
                        if (value === false && alt.value === 'false') {
                            return true;
                        }
                    }
                }
            }
            return false;
        }
        return false;
    }

    protected inferGroupType(group: Group): string | undefined {
        for (const element of group.elements) {
            if (isAction(element)) {
                if (element.inferredType) {
                    return element.inferredType.name;
                }
                if (element.type?.ref) {
                    return getTypeName(element.type.ref);
                }
            }
        }
        return undefined;
    }

    protected getRuleType(rule: AbstractParserRule): string {
        if (rule.inferredType) {
            return rule.inferredType.name;
        }
        if ('returnType' in rule && rule.returnType?.ref) {
            return getTypeName(rule.returnType.ref);
        }
        return rule.name;
    }

    protected groupMatchesNode(group: Group, node: AstNode): boolean {
        for (const element of group.elements) {
            if (isAssignment(element)) {
                const property = element.feature;
                const value = (node as unknown as Record<string, unknown>)[property];
                if (value !== undefined && value !== null) {
                    return true;
                }
            }
        }
        return false;
    }

    settle(dcst: DCSTNode, resolver: AmbiguityResolver): CSTNode {
        const memo = new Map<DCSTNode, CSTNode | null>();

        const settleNode = (d: DCSTNode): CSTNode | null => {
            if (memo.has(d)) {
                return memo.get(d) ?? null;
            }

            memo.set(d, null);

            let result: CSTNode | null = null;

            switch (d.kind) {
                case 'terminal':
                    result = {
                        kind: 'terminal',
                        text: d.text,
                        grammarElement: d.grammarElement
                    };
                    break;

                case 'nonterminal': {
                    const children: CSTNode[] = [];
                    for (const child of d.children) {
                        const settled = settleNode(child);
                        if (settled) {
                            children.push(settled);
                        }
                    }
                    result = {
                        kind: 'nonterminal',
                        ruleName: d.ruleName,
                        children,
                        grammarElement: d.grammarElement
                    };
                    break;
                }

                case 'disjunction': {
                    const first = settleNode(d.alternatives[0]);
                    const second = settleNode(d.alternatives[1]);

                    if (first && this.isViable(first)) {
                        result = first;
                    } else if (second && this.isViable(second)) {
                        result = second;
                    } else {
                        result = first ?? second;
                    }
                    break;
                }
            }

            memo.set(d, result);
            return result;
        };

        const result = settleNode(dcst);
        if (!result) {
            throw new Error('Settlement failed: no viable CST produced');
        }
        return result;
    }

    protected isViable(cst: CSTNode): boolean {
        if (cst.kind === 'terminal') {
            return cst.text.length > 0;
        }
        if (cst.kind === 'nonterminal') {
            return cst.children.length > 0;
        }
        return true;
    }

    format(cst: CSTNode, separator: string = ' '): string {
        switch (cst.kind) {
            case 'terminal':
                return cst.text;
            case 'nonterminal':
                return cst.children
                    .map(child => this.format(child, separator))
                    .filter(text => text.length > 0)
                    .join(separator);
        }
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

    protected applyFormatting(text: string, options?: TextSerializeOptions): string {
        if (typeof options?.format === 'object') {
            return text;
        }
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
