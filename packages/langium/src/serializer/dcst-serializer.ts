/******************************************************************************
 * Copyright 2024 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { AstNode, Reference, AstReflection } from '../syntax-tree.js';
import type { Grammar, AbstractParserRule, ParserRule, AbstractElement, Assignment, RuleCall, CrossReference, Alternatives, Group } from '../languages/generated/ast.js';
import { isParserRule, isAssignment, isKeyword, isRuleCall, isCrossReference, isGroup, isAlternatives, isAction, isTerminalRule } from '../languages/generated/ast.js';
import type { TextSerializer, TextSerializeOptions, SerializationContext, AmbiguityResolver } from './text-serializer.js';
import { createSerializationError } from './text-serializer.js';
import { GrammarAnalyzer } from './grammar-analyzer.js';
import { DefaultConcreteSyntaxValidator, type ConcreteSyntaxValidator } from './concrete-syntax-validator.js';
import { DefaultContextResolver, type ContextResolver } from './context-resolver.js';
import { isDataTypeRule, isArrayCardinality } from '../utils/grammar-utils.js';
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

        const dcst = this.describe(node, rule);
        const resolver = this.getAmbiguityResolver(options);
        const cst = this.settle(dcst, resolver);
        let result = this.format(cst);

        if (options?.format) {
            result = this.applyFormatting(result, options);
        }

        return result;
    }

    describe(node: AstNode, rule: ParserRule): DCSTNode {
        const children = this.describeElement(rule.definition, node);
        return {
            kind: 'nonterminal',
            ruleName: rule.name,
            children,
            grammarElement: rule
        };
    }

    protected describeElement(element: AbstractElement, node: AstNode): DCSTNode[] {
        const result: DCSTNode[] = [];

        if (isKeyword(element)) {
            result.push({
                kind: 'terminal',
                text: element.value,
                grammarElement: element
            });
        } else if (isAssignment(element)) {
            const assignmentNodes = this.describeAssignment(element, node);
            result.push(...assignmentNodes);
        } else if (isRuleCall(element)) {
            const ruleCallNodes = this.describeRuleCall(element, node);
            result.push(...ruleCallNodes);
        } else if (isCrossReference(element)) {
            const crossRefNodes = this.describeCrossReference(element, node);
            result.push(...crossRefNodes);
        } else if (isAction(element)) {
            // Actions don't produce output directly
        } else if (isGroup(element)) {
            const groupNodes = this.describeGroup(element, node);
            result.push(...groupNodes);
        } else if (isAlternatives(element)) {
            const altNodes = this.describeAlternatives(element, node);
            result.push(...altNodes);
        }

        return result;
    }

    protected describeAssignment(assignment: Assignment, node: AstNode): DCSTNode[] {
        const property = assignment.feature;
        const value = (node as unknown as Record<string, unknown>)[property];
        const nodes: DCSTNode[] = [];

        if (value === undefined || value === null) {
            return nodes;
        }

        if (isArrayCardinality(assignment.cardinality) && Array.isArray(value)) {
            for (let i = 0; i < value.length; i++) {
                if (i > 0) {
                    // Add separator if needed
                }
                const terminalNodes = this.describeTerminal(assignment.terminal, value[i], node);
                nodes.push(...terminalNodes);
            }
        } else {
            const terminalNodes = this.describeTerminal(assignment.terminal, value, node);
            nodes.push(...terminalNodes);
        }

        return nodes;
    }

    protected describeTerminal(terminal: AbstractElement, value: unknown, _node: AstNode): DCSTNode[] {
        if (isKeyword(terminal)) {
            return [{
                kind: 'terminal',
                text: terminal.value,
                grammarElement: terminal
            }];
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
                        const dcst = this.describe(value, rule);
                        return [dcst];
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
                return this.describeTerminal(innerTerminal, refText, _node);
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

    protected describeRuleCall(ruleCall: RuleCall, node: AstNode): DCSTNode[] {
        const rule = ruleCall.rule.ref;
        if (!rule) {
            return [];
        }

        if (isParserRule(rule) && !isDataTypeRule(rule)) {
            const dcst = this.describe(node, rule);
            return [dcst];
        }

        return [];
    }

    protected describeCrossReference(crossRef: CrossReference, node: AstNode): DCSTNode[] {
        const assignment = this.findContainingAssignment(crossRef);
        if (!assignment) {
            return [];
        }

        const value = (node as unknown as Record<string, unknown>)[assignment.feature];
        let refText: string;

        if (this.isReference(value)) {
            refText = value.$refText;
            const refNode = value.ref;
            if (refNode && !refText) {
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
            return this.describeTerminal(crossRef.terminal, refText, node);
        }

        return [{
            kind: 'terminal',
            text: refText,
            grammarElement: crossRef
        }];
    }

    protected describeGroup(group: Group, node: AstNode): DCSTNode[] {
        const children: DCSTNode[] = [];

        for (const element of group.elements) {
            const elementNodes = this.describeElement(element, node);
            children.push(...elementNodes);
        }

        if (group.cardinality === '*' || group.cardinality === '+') {
            // Handle repeated groups
        }

        return children;
    }

    protected describeAlternatives(alternatives: Alternatives, node: AstNode): DCSTNode[] {
        if (alternatives.elements.length === 0) {
            return [];
        }

        if (alternatives.elements.length === 1) {
            return this.describeElement(alternatives.elements[0], node);
        }

        const first = this.describeElement(alternatives.elements[0], node);
        const second = this.describeElement(alternatives.elements[1], node);
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
            const next = this.describeElement(alternatives.elements[i], node);
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

    settle(dcst: DCSTNode, resolver: AmbiguityResolver): CSTNode {
        const memo = new Map<DCSTNode, CSTNode | null>();

        const settleNode = (d: DCSTNode): CSTNode | null => {
            if (memo.has(d)) {
                return memo.get(d) ?? null;
            }

            // Mark as in-progress to prevent infinite recursion
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
        // Basic viability check - can be extended with FOLLOW set analysis
        return true;
    }

    format(cst: CSTNode): string {
        switch (cst.kind) {
            case 'terminal':
                return cst.text;
            case 'nonterminal':
                return cst.children.map(child => this.format(child)).join('');
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