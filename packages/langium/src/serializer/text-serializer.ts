/******************************************************************************
 * Copyright 2024 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { LangiumCoreServices } from '../services.js';
import type { Grammar, AbstractElement, ParserRule } from '../languages/generated/ast.js';
import { isAction, isAlternatives, isAssignment, isCrossReference, isGroup, isKeyword, isParserRule, isRuleCall, isTerminalRule, isTerminalRuleCall, isUnorderedGroup } from '../languages/generated/ast.js';
import type { AstNode, AstReflection, GenericAstNode, Reference } from '../syntax-tree.js';
import { isAstNode, isMultiReference, isReference } from '../syntax-tree.js';
import type { NameProvider } from '../references/name-provider.js';
import {
    getActionType,
    getCrossReferenceTerminal,
    getRuleTypeName,
    isArrayCardinality,
    isArrayOperator,
    isOptionalCardinality,
    isDataTypeRule
} from '../utils/grammar-utils.js';

export interface TextSerializeOptions {
    /** The token separator to use between emitted tokens. */
    space?: string;
    /** Prefer using $refText when serializing references. */
    useRefText?: boolean;
}

export interface TextSerializer {
    serialize(node: AstNode, options?: TextSerializeOptions): string;
}

interface EmitContext {
    root: AstNode;
    node: AstNode;
    usage: WeakMap<AstNode, Map<string, number>>;
}

type RuleTarget = {
    rule: ParserRule;
};

type IterationContext = Map<string, number>;

export class DefaultTextSerializer implements TextSerializer {

    protected readonly grammar: Grammar;
    protected readonly nameProvider: NameProvider;
    protected readonly astReflection: AstReflection;
    protected readonly ruleTargets = new Map<string, RuleTarget>();

    constructor(services: LangiumCoreServices) {
        this.grammar = services.Grammar;
        this.nameProvider = services.references.NameProvider;
        this.astReflection = services.shared.AstReflection;
        this.collectRuleTargets();
    }

    serialize(node: AstNode, options?: TextSerializeOptions): string {
        const resolvedOptions = {
            space: ' ',
            useRefText: true,
            ...options
        };
        const tokens = this.emitNode(node, {
            root: node,
            node,
            usage: new WeakMap()
        }, resolvedOptions);
        return tokens.join(resolvedOptions.space).trim();
    }

    protected emitNode(node: AstNode, context: EmitContext, options: Required<TextSerializeOptions>): string[] {
        const target = this.ruleTargets.get(node.$type);
        if (!target) {
            throw new Error(`No grammar rule found for AST type '${node.$type}'.`);
        }
        const updatedContext: EmitContext = {
            ...context,
            node
        };
        const tokens = this.emitElement(target.rule.definition, updatedContext, options);
        if (!tokens) {
            throw new Error(`Failed to serialize AST node of type '${node.$type}'.`);
        }
        return tokens;
    }

    protected emitElement(element: AbstractElement, context: EmitContext, options: Required<TextSerializeOptions>, iteration?: IterationContext): string[] | undefined {
        if (isKeyword(element)) {
            return [element.value];
        }
        if (isAssignment(element)) {
            const tokens = this.emitAssignment(element, context, options, iteration);
            if (tokens !== undefined) {
                return tokens;
            }
            return isOptionalCardinality(element.cardinality, element) ? [] : undefined;
        }
        if (isRuleCall(element) || isTerminalRuleCall(element)) {
            const tokens = this.emitUnassignedRuleCall(element, context, options, iteration);
            if (tokens !== undefined) {
                return tokens;
            }
            return isOptionalCardinality(element.cardinality, element) ? [] : undefined;
        }
        if (isCrossReference(element)) {
            const tokens = this.emitCrossReference(element, undefined, context, options, iteration);
            if (tokens !== undefined) {
                return tokens;
            }
            return isOptionalCardinality(element.cardinality, element) ? [] : undefined;
        }
        if (isAlternatives(element)) {
            for (const alternative of element.elements) {
                const tokens = this.emitElement(alternative, context, options, iteration);
                if (tokens !== undefined) {
                    return tokens;
                }
            }
            return undefined;
        }
        if (isGroup(element) || isUnorderedGroup(element)) {
            const tokens = this.emitGroup(element.elements, element.cardinality, context, options, iteration);
            if (tokens !== undefined) {
                return tokens;
            }
            return isOptionalCardinality(element.cardinality, element) ? [] : undefined;
        }
        if (isAction(element)) {
            return [];
        }
        return [];
    }

    protected emitGroup(elements: AbstractElement[], cardinality: AbstractElement['cardinality'], context: EmitContext, options: Required<TextSerializeOptions>, iteration?: IterationContext): string[] | undefined {
        const repetitionCount = this.getGroupRepetitionCount(elements, cardinality, context, iteration);
        if (repetitionCount === 0) {
            return cardinality === '+' ? undefined : [];
        }
        const tokens: string[] = [];
        if (!isArrayCardinality(cardinality)) {
            const assignmentCounts = this.collectAssignmentCounts(elements);
            for (const child of elements) {
                if (!iteration && isAssignment(child) && child.operator === '+=' && (assignmentCounts.get(child.feature) ?? 0) > 1) {
                    const value = (context.node as GenericAstNode)[child.feature];
                    if (Array.isArray(value)) {
                        const index = this.getUsage(context, context.node, child.feature);
                        const iterationContext = new Map<string, number>(iteration ?? []);
                        iterationContext.set(child.feature, index);
                        const childTokens = this.emitElement(child, context, options, iterationContext);
                        if (childTokens === undefined) {
                            return undefined;
                        }
                        tokens.push(...childTokens);
                        continue;
                    }
                }
                const childTokens = this.emitElement(child, context, options, iteration);
                if (childTokens === undefined) {
                    return undefined;
                }
                tokens.push(...childTokens);
            }
            return tokens;
        }
        const arrayAssignments = this.collectArrayAssignments(elements, context.node, iteration);
        const baseUsage = new Map<string, number>();
        for (const { feature } of arrayAssignments) {
            baseUsage.set(feature, this.getUsage(context, context.node, feature));
        }
        for (let index = 0; index < repetitionCount; index++) {
            const iterationContext = new Map<string, number>(iteration ?? []);
            for (const { feature } of arrayAssignments) {
                const base = baseUsage.get(feature) ?? 0;
                iterationContext.set(feature, base + index);
            }
            for (const child of elements) {
                const childTokens = this.emitElement(child, context, options, iterationContext);
                if (childTokens === undefined) {
                    return undefined;
                }
                tokens.push(...childTokens);
            }
        }
        return tokens;
    }

    protected emitAssignment(assignment: import('../languages/generated/ast.js').Assignment, context: EmitContext, options: Required<TextSerializeOptions>, iteration?: IterationContext): string[] | undefined {
        const feature = assignment.feature;
        const value = (context.node as GenericAstNode)[feature];
        if (assignment.operator === '?=') {
            if (value === true) {
                return this.emitTerminal(assignment.terminal, value, context, options, iteration);
            }
            return [];
        }
        if (value === undefined || value === null) {
            return isOptionalCardinality(assignment.cardinality, assignment) ? [] : undefined;
        }
        if (Array.isArray(value)) {
            const tokens: string[] = [];
            if (iteration && iteration.has(feature)) {
                const index = iteration.get(feature) ?? 0;
                const item = value[index];
                if (item === undefined) {
                    return undefined;
                }
                const itemTokens = this.emitAssignmentValue(assignment.terminal, item, context, options, iteration);
                if (itemTokens === undefined) {
                    return undefined;
                }
                tokens.push(...itemTokens);
                this.updateUsage(context, context.node, feature, index + 1);
                return tokens;
            }
            for (let index = this.getUsage(context, context.node, feature); index < value.length; index++) {
                const itemTokens = this.emitAssignmentValue(assignment.terminal, value[index], context, options, iteration);
                if (itemTokens === undefined) {
                    return undefined;
                }
                tokens.push(...itemTokens);
                this.updateUsage(context, context.node, feature, index + 1);
                if (!(isArrayOperator(assignment.operator) || isArrayCardinality(assignment.cardinality))) {
                    break;
                }
            }
            return tokens;
        }
        const tokens = this.emitAssignmentValue(assignment.terminal, value, context, options, iteration);
        if (tokens !== undefined) {
            this.updateUsage(context, context.node, feature, 1);
        }
        return tokens;
    }

    protected emitAssignmentValue(terminal: AbstractElement, value: unknown, context: EmitContext, options: Required<TextSerializeOptions>, iteration?: IterationContext): string[] | undefined {
        if (isCrossReference(terminal)) {
            return this.emitCrossReference(terminal, value, context, options, iteration);
        }
        return this.emitTerminal(terminal, value, context, options, iteration);
    }

    protected emitTerminal(element: AbstractElement, value: unknown, context: EmitContext, options: Required<TextSerializeOptions>, iteration?: IterationContext): string[] | undefined {
        if (isKeyword(element)) {
            if (value === true || value === element.value) {
                return [element.value];
            }
            return undefined;
        }
        if (isAlternatives(element)) {
            for (const alternative of element.elements) {
                const tokens = this.emitTerminal(alternative, value, context, options, iteration);
                if (tokens !== undefined) {
                    return tokens;
                }
            }
            return undefined;
        }
        if (isGroup(element) || isUnorderedGroup(element)) {
            const tokens: string[] = [];
            for (const child of element.elements) {
                const childTokens = this.emitTerminal(child, value, context, options, iteration);
                if (childTokens === undefined) {
                    return undefined;
                }
                tokens.push(...childTokens);
            }
            return tokens;
        }
        if (isRuleCall(element) || isTerminalRuleCall(element)) {
            const rule = element.rule.ref;
            if (!rule) {
                return undefined;
            }
            if (isParserRule(rule)) {
                if (isAstNode(value)) {
                    return this.emitNode(value, context, options);
                }
                if (isDataTypeRule(rule)) {
                    return [this.formatPrimitive(value, rule)];
                }
                return undefined;
            }
            if (isTerminalRule(rule)) {
                return [this.formatPrimitive(value, rule)];
            }
        }
        if (isAction(element)) {
            return [];
        }
        return undefined;
    }

    protected emitUnassignedRuleCall(element: import('../languages/generated/ast.js').RuleCall | import('../languages/generated/ast.js').TerminalRuleCall, context: EmitContext, options: Required<TextSerializeOptions>, iteration?: IterationContext): string[] | undefined {
        const rule = element.rule.ref;
        if (!rule) {
            return undefined;
        }
        if (isParserRule(rule)) {
            const ruleType = getRuleTypeName(rule);
            const candidate = this.findAstProperty(context, context.node, ruleType, iteration);
            if (!candidate) {
                return undefined;
            }
            const { value, feature, index } = candidate;
            if (index !== undefined) {
                this.updateUsage(context, context.node, feature, index + 1);
            }
            return this.emitNode(value, context, options);
        }
        if (isTerminalRule(rule)) {
            const candidate = this.findPrimitiveProperty(context, context.node, iteration);
            if (!candidate) {
                return undefined;
            }
            const { value, feature, index } = candidate;
            if (index !== undefined) {
                this.updateUsage(context, context.node, feature, index + 1);
            }
            return [this.formatPrimitive(value, rule)];
        }
        return undefined;
    }

    protected emitCrossReference(crossRef: import('../languages/generated/ast.js').CrossReference, value: unknown, context: EmitContext, options: Required<TextSerializeOptions>, iteration?: IterationContext): string[] | undefined {
        const targetTerminal = getCrossReferenceTerminal(crossRef) ?? crossRef.terminal;
        if (!targetTerminal) {
            return undefined;
        }
        const referenceValues = this.resolveReferenceValues(value, options);
        if (referenceValues === undefined) {
            return undefined;
        }
        const valuesArray = Array.isArray(referenceValues) ? referenceValues : [referenceValues];
        const tokens: string[] = [];
        for (const item of valuesArray) {
            const itemTokens = this.emitTerminal(targetTerminal, item, context, options, iteration);
            if (itemTokens === undefined) {
                return undefined;
            }
            tokens.push(...itemTokens);
        }
        return tokens;
    }

    protected resolveReferenceValues(value: unknown, options: Required<TextSerializeOptions>): string | string[] | undefined {
        if (!value) {
            return undefined;
        }
        if (isReference(value)) {
            return this.resolveReferenceValue(value, options);
        }
        if (isMultiReference(value)) {
            return value.items.map(item => this.resolveReferenceValue({ ref: item.ref, $refText: this.nameProvider.getName(item.ref) ?? '' } as Reference, options));
        }
        return undefined;
    }

    protected resolveReferenceValue(reference: Reference, options: Required<TextSerializeOptions>): string {
        if (options.useRefText && reference.$refText) {
            return reference.$refText;
        }
        if (reference.ref) {
            return this.nameProvider.getName(reference.ref) ?? reference.$refText;
        }
        return reference.$refText;
    }

    protected formatPrimitive(value: unknown, rule: { name: string }): string {
        if (value instanceof Date) {
            return value.toISOString();
        }
        if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'bigint') {
            return String(value);
        }
        const text = value !== undefined ? String(value) : '';
        if (rule.name.toUpperCase() === 'STRING') {
            return JSON.stringify(text);
        }
        return text;
    }

    protected collectRuleTargets(): void {
        const parserRules = this.grammar.rules.filter(isParserRule);
        for (const rule of parserRules) {
            const type = getRuleTypeName(rule);
            if (!this.ruleTargets.has(type)) {
                this.ruleTargets.set(type, { rule });
            }
        }
        for (const rule of parserRules) {
            this.collectActions(rule, rule.definition);
        }
    }

    protected collectActions(rule: ParserRule, element: AbstractElement): void {
        if (isAction(element)) {
            const type = getActionType(element);
            if (type && !this.ruleTargets.has(type)) {
                this.ruleTargets.set(type, { rule });
            }
        }
        if (isAlternatives(element) || isGroup(element) || isUnorderedGroup(element)) {
            for (const child of element.elements) {
                this.collectActions(rule, child);
            }
        }
    }

    protected collectArrayAssignments(elements: AbstractElement[], node: AstNode, iteration?: IterationContext): Array<{ feature: string }> {
        const features = new Set<string>();
        const visit = (element: AbstractElement) => {
            if (isAssignment(element)) {
                const feature = element.feature;
                const value = (node as GenericAstNode)[feature];
                if (Array.isArray(value) && !iteration?.has(feature)) {
                    features.add(feature);
                }
            } else if (isAlternatives(element) || isGroup(element) || isUnorderedGroup(element)) {
                element.elements.forEach(visit);
            }
        };
        elements.forEach(visit);
        return Array.from(features).map(feature => ({ feature }));
    }

    protected collectAssignmentCounts(elements: AbstractElement[]): Map<string, number> {
        const counts = new Map<string, number>();
        const visit = (element: AbstractElement) => {
            if (isAssignment(element)) {
                counts.set(element.feature, (counts.get(element.feature) ?? 0) + 1);
            } else if (isAlternatives(element) || isGroup(element) || isUnorderedGroup(element)) {
                element.elements.forEach(visit);
            }
        };
        elements.forEach(visit);
        return counts;
    }

    protected getGroupRepetitionCount(elements: AbstractElement[], cardinality: AbstractElement['cardinality'], context: EmitContext, iteration?: IterationContext): number {
        if (!cardinality || iteration) {
            return 1;
        }
        const arrayAssignments = this.collectArrayAssignments(elements, context.node);
        if (arrayAssignments.length === 0) {
            return cardinality === '*' ? 0 : 1;
        }
        const remainingCounts = arrayAssignments.map(({ feature }) => {
            const value = (context.node as GenericAstNode)[feature];
            if (!Array.isArray(value)) {
                return 0;
            }
            const used = this.getUsage(context, context.node, feature);
            return Math.max(value.length - used, 0);
        });
        const max = Math.max(...remainingCounts);
        const min = Math.min(...remainingCounts);
        if (max !== min) {
            throw new Error('Cannot serialize group with mismatched array lengths.');
        }
        return max;
    }

    protected findAstProperty(context: EmitContext, node: AstNode, ruleType: string, iteration?: IterationContext): { feature: string; value: AstNode; index?: number } | undefined {
        for (const feature of this.getPropertyNames(node)) {
            const value = (node as GenericAstNode)[feature];
            if (isAstNode(value)) {
                if (this.matchesType(value.$type, ruleType)) {
                    return { feature, value };
                }
            } else if (Array.isArray(value)) {
                const index = iteration?.get(feature) ?? this.getUsage(context, node, feature);
                const item = value[index];
                if (isAstNode(item) && this.matchesType(item.$type, ruleType)) {
                    return { feature, value: item, index };
                }
            }
        }
        return undefined;
    }

    protected findPrimitiveProperty(context: EmitContext, node: AstNode, iteration?: IterationContext): { feature: string; value: unknown; index?: number } | undefined {
        for (const feature of this.getPropertyNames(node)) {
            const value = (node as GenericAstNode)[feature];
            if (value === undefined || value === null) {
                continue;
            }
            if (Array.isArray(value)) {
                const index = iteration?.get(feature) ?? this.getUsage(context, node, feature);
                const item = value[index];
                if (item !== undefined && item !== null && !isAstNode(item)) {
                    return { feature, value: item, index };
                }
            } else if (!isAstNode(value) && !isReference(value) && !isMultiReference(value)) {
                return { feature, value };
            }
        }
        return undefined;
    }

    protected matchesType(type: string, target: string): boolean {
        if (type === target) {
            return true;
        }
        return this.astReflection.isSubtype(type, target);
    }

    protected getPropertyNames(node: AstNode): string[] {
        const meta = this.astReflection.getTypeMetaData(node.$type);
        const names = Object.keys(meta.properties);
        if (names.length > 0) {
            return names;
        }
        return Object.keys(node).filter(key => !key.startsWith('$'));
    }

    protected getUsage(context: EmitContext, node: AstNode, feature: string): number {
        const usage = this.getUsageMap(context, node);
        return usage.get(feature) ?? 0;
    }

    protected updateUsage(context: EmitContext, node: AstNode, feature: string, value: number): void {
        const usage = this.getUsageMap(context, node);
        const current = usage.get(feature) ?? 0;
        if (value > current) {
            usage.set(feature, value);
        }
    }

    protected getUsageMap(context: EmitContext, node: AstNode): Map<string, number> {
        let usage = context.usage.get(node);
        if (!usage) {
            usage = new Map();
            context.usage.set(node, usage);
        }
        return usage;
    }
}
