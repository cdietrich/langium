/******************************************************************************
 * Copyright 2024 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { LangiumCoreServices } from '../services.js';
import type { Grammar, AbstractElement, ParserRule, Assignment, RuleCall, TerminalRuleCall, CrossReference } from '../languages/generated/ast.js';
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

/**
 * Context passed to the serializeValue hook for customizing primitive value serialization.
 */
export interface SerializeValueContext {
    /** The AST node containing this value */
    node: AstNode;
    /** The property name on the AST node */
    property: string;
    /** The raw value to serialize */
    value: unknown;
    /** The grammar rule name being applied (e.g., 'STRING', 'ID', 'INT') */
    ruleName: string;
    /** The language ID from services.LanguageMetaData */
    languageId: string;
}

export interface TextSerializeOptions {
    /** The token separator to use between emitted tokens. */
    space?: string;
    /** Prefer using $refText when serializing references. */
    useRefText?: boolean;
    /** Custom hook to format primitive values from terminal/datatype rules. */
    serializeValue?: (context: SerializeValueContext) => string;
}

/**
 * Internal resolved options type with required defaults but optional hook.
 */
interface ResolvedTextSerializeOptions {
    space: string;
    useRefText: boolean;
    serializeValue?: (context: SerializeValueContext) => string;
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

/**
 * The DefaultTextSerializer converts an AST back into text by walking the grammar
 * rules and emitting tokens that match the AST structure.
 *
 * ## Architecture Overview
 *
 * The serializer traverses grammar rule definitions and matches them against AST
 * node properties. It produces an array of tokens joined with a separator (default: space).
 *
 * ### Key Concepts
 *
 * **EmitContext**: Tracks serialization state (root node, current node, array index usage).
 *
 * **IterationContext**: Tracks array indices within repeated groups (`*` or `+` cardinality).
 *
 * **ruleProducibleTypes**: Cache mapping each parser rule to the set of AST types it can
 * produce (including via actions and nested rule calls). Built once during construction.
 *
 * ### Method Hierarchy
 *
 * ```
 * serialize() → emitNode() → emitElement()
 *                              ├─ emitAssignment() → emitTerminal()
 *                              ├─ emitUnassignedRuleCall()
 *                              ├─ emitAlternativesWithPriority()
 *                              └─ emitGroup() → emitGroupOnce() / emitGroupRepeated()
 * ```
 *
 * ### Return Value Convention
 *
 * All emit methods return `string[] | undefined`:
 * - `string[]`: Successfully emitted tokens (may be empty for optional elements)
 * - `undefined`: Element could not be matched (allows backtracking in alternatives)
 *
 * The `optionalResult()` helper handles the common pattern of returning `[]` for
 * optional cardinality or `undefined` otherwise.
 */
export class DefaultTextSerializer implements TextSerializer {

    protected readonly grammar: Grammar;
    protected readonly nameProvider: NameProvider;
    protected readonly astReflection: AstReflection;
    protected readonly languageId: string;
    protected readonly ruleTargets = new Map<string, RuleTarget>();
    /** Cache of types each parser rule can produce, built once during construction. */
    protected readonly ruleProducibleTypes = new Map<ParserRule, Set<string>>();

    constructor(services: LangiumCoreServices) {
        this.grammar = services.Grammar;
        this.nameProvider = services.references.NameProvider;
        this.astReflection = services.shared.AstReflection;
        this.languageId = services.LanguageMetaData.languageId;
        this.collectRuleTargets();
        this.buildRuleProducibleTypes();
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

    protected emitNode(node: AstNode, context: EmitContext, options: ResolvedTextSerializeOptions, rule?: ParserRule): string[] {
        const targetRule = rule ?? this.ruleTargets.get(node.$type)?.rule;
        if (!targetRule) {
            throw new Error(`No grammar rule found for AST type '${node.$type}'.`);
        }
        const updatedContext: EmitContext = {
            ...context,
            node
        };
        const tokens = this.emitElement(targetRule.definition, updatedContext, options);
        if (!tokens) {
            throw new Error(`Failed to serialize AST node of type '${node.$type}'.`);
        }
        return tokens;
    }

    protected emitElement(element: AbstractElement, context: EmitContext, options: ResolvedTextSerializeOptions, iteration?: IterationContext): string[] | undefined {
        if (isKeyword(element)) {
            return [element.value];
        }
        if (isAssignment(element)) {
            return this.emitAssignment(element, context, options, iteration) ?? this.optionalResult(element);
        }
        if (isRuleCall(element) || isTerminalRuleCall(element)) {
            return this.emitUnassignedRuleCall(element, context, options, iteration) ?? this.optionalResult(element);
        }
        if (isCrossReference(element)) {
            // Unassigned cross-reference - property name is empty
            return this.emitCrossReference(element, undefined, context, options, '', iteration) ?? this.optionalResult(element);
        }
        if (isAlternatives(element)) {
            return this.emitAlternativesWithPriority(
                element.elements,
                alt => this.emitElement(alt, context, options, iteration),
                context.node.$type
            );
        }
        if (isGroup(element) || isUnorderedGroup(element)) {
            return this.emitGroup(element.elements, element.cardinality, context, options, iteration) ?? this.optionalResult(element);
        }
        if (isAction(element)) {
            return [];
        }
        return [];
    }

    protected emitGroup(elements: AbstractElement[], cardinality: AbstractElement['cardinality'], context: EmitContext, options: ResolvedTextSerializeOptions, iteration?: IterationContext): string[] | undefined {
        const repetitionCount = this.getGroupRepetitionCount(elements, cardinality, context, iteration);
        if (repetitionCount === 0) {
            return cardinality === '+' ? undefined : [];
        }
        if (!isArrayCardinality(cardinality)) {
            return this.emitGroupOnce(elements, context, options, iteration);
        }
        return this.emitGroupRepeated(elements, repetitionCount, context, options, iteration);
    }

    /**
     * Emits a group once (non-array cardinality).
     * Special handling for `+=` operators that appear multiple times in the same group.
     */
    protected emitGroupOnce(elements: AbstractElement[], context: EmitContext, options: ResolvedTextSerializeOptions, iteration?: IterationContext): string[] | undefined {
        const tokens: string[] = [];
        const assignmentCounts = this.collectAssignmentCounts(elements);
        for (const child of elements) {
            // Handle multiple += assignments to the same feature within a non-repeated group
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
            const childTokens = this.emitGroupChild(child, context, options, iteration);
            if (childTokens === undefined) {
                return undefined;
            }
            tokens.push(...childTokens);
        }
        return tokens;
    }

    /**
     * Emits a group multiple times (array cardinality `*` or `+`).
     */
    protected emitGroupRepeated(elements: AbstractElement[], repetitionCount: number, context: EmitContext, options: ResolvedTextSerializeOptions, iteration?: IterationContext): string[] | undefined {
        const tokens: string[] = [];
        const arrayAssignments = this.collectArrayAssignments(elements, context.node, iteration);
        const baseUsage = new Map<string, number>();
        for (const { feature } of arrayAssignments) {
            baseUsage.set(feature, this.getUsage(context, context.node, feature));
        }
        for (let index = 0; index < repetitionCount; index++) {
            const iterationContext = new Map<string, number>(iteration ?? []);
            for (const { feature } of arrayAssignments) {
                iterationContext.set(feature, (baseUsage.get(feature) ?? 0) + index);
            }
            for (const child of elements) {
                const childTokens = this.emitGroupChild(child, context, options, iterationContext);
                if (childTokens === undefined) {
                    return undefined;
                }
                tokens.push(...childTokens);
            }
        }
        return tokens;
    }

    /**
     * Emits a single child element within a group, treating `?=` assignments as optional.
     */
    protected emitGroupChild(child: AbstractElement, context: EmitContext, options: ResolvedTextSerializeOptions, iteration?: IterationContext): string[] | undefined {
        const tokens = this.emitElement(child, context, options, iteration);
        if (tokens === undefined && isAssignment(child) && child.operator === '?=') {
            return []; // ?= assignments are optional in groups
        }
        return tokens;
    }

    protected emitAssignment(assignment: Assignment, context: EmitContext, options: ResolvedTextSerializeOptions, iteration?: IterationContext): string[] | undefined {
        const feature = assignment.feature;
        const value = (context.node as GenericAstNode)[feature];
        if (assignment.operator === '?=') {
            if (value === true) {
                return this.emitTerminal(assignment.terminal, value, context, options, feature, iteration);
            }
            // Return undefined to allow alternatives to try other branches (e.g., `value?='true' | 'false'`)
            return undefined;
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
                const itemTokens = this.emitAssignmentValue(assignment.terminal, item, context, options, feature, iteration);
                if (itemTokens === undefined) {
                    return undefined;
                }
                tokens.push(...itemTokens);
                this.updateUsage(context, context.node, feature, index + 1);
                return tokens;
            }
            for (let index = this.getUsage(context, context.node, feature); index < value.length; index++) {
                const itemTokens = this.emitAssignmentValue(assignment.terminal, value[index], context, options, feature, iteration);
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
        const tokens = this.emitAssignmentValue(assignment.terminal, value, context, options, feature, iteration);
        if (tokens !== undefined) {
            this.updateUsage(context, context.node, feature, 1);
        }
        return tokens;
    }

    protected emitAssignmentValue(terminal: AbstractElement, value: unknown, context: EmitContext, options: ResolvedTextSerializeOptions, property: string, iteration?: IterationContext): string[] | undefined {
        if (isCrossReference(terminal)) {
            return this.emitCrossReference(terminal, value, context, options, property, iteration);
        }
        return this.emitTerminal(terminal, value, context, options, property, iteration);
    }

    protected emitTerminal(element: AbstractElement, value: unknown, context: EmitContext, options: ResolvedTextSerializeOptions, property: string, iteration?: IterationContext): string[] | undefined {
        if (isKeyword(element)) {
            return (value === true || value === element.value) ? [element.value] : undefined;
        }
        if (isAlternatives(element)) {
            return this.emitAlternativesWithPriority(
                element.elements,
                alt => this.emitTerminal(alt, value, context, options, property, iteration),
                isAstNode(value) ? value.$type : undefined
            );
        }
        if (isGroup(element) || isUnorderedGroup(element)) {
            return this.emitTerminalGroup(element.elements, value, context, options, property, iteration);
        }
        if (isRuleCall(element) || isTerminalRuleCall(element)) {
            return this.emitTerminalRuleCall(element, value, context, options, property);
        }
        if (isAction(element)) {
            return [];
        }
        return undefined;
    }

    /**
     * Emits a group of elements as a terminal value (all children must succeed).
     */
    protected emitTerminalGroup(elements: readonly AbstractElement[], value: unknown, context: EmitContext, options: ResolvedTextSerializeOptions, property: string, iteration?: IterationContext): string[] | undefined {
        const tokens: string[] = [];
        for (const child of elements) {
            const childTokens = this.emitTerminal(child, value, context, options, property, iteration);
            if (childTokens === undefined) {
                return undefined;
            }
            tokens.push(...childTokens);
        }
        return tokens;
    }

    /**
     * Emits a rule call within a terminal context (with a value).
     */
    protected emitTerminalRuleCall(element: RuleCall | TerminalRuleCall, value: unknown, context: EmitContext, options: ResolvedTextSerializeOptions, property: string): string[] | undefined {
        const rule = element.rule.ref;
        if (!rule) {
            return undefined;
        }
        if (isParserRule(rule)) {
            if (isAstNode(value)) {
                // Only emit through this rule if it can produce the value's type
                if (!this.ruleProducesType(rule, value.$type)) {
                    return undefined;
                }
                return this.emitNode(value, context, options, rule);
            }
            if (isDataTypeRule(rule)) {
                return [this.serializeValue(value, rule, context.node, property, options)];
            }
            return undefined;
        }
        if (isTerminalRule(rule)) {
            return [this.serializeValue(value, rule, context.node, property, options)];
        }
        return undefined;
    }

    /**
     * Handles unassigned rule calls - rule references that don't assign to a property.
     *
     * This occurs in three main scenarios:
     *
     * 1. **Fragment rules**: The fragment's definition is inlined at the call site.
     *    Example: `fragment Visibility: visibility=('public'|'private');`
     *
     * 2. **Union/alias rules**: Rules whose definition is alternatives of other rules.
     *    Example: `Child: ChildA | ChildB;`
     *    When processing such a rule, we check if the current node's type matches
     *    the called rule's type. This handles the case where we're emitting a ChildA
     *    node through a Child rule - the ChildA rule call should match and emit.
     *
     * 3. **Wrapper patterns**: A rule that embeds another rule's node without assignment.
     *    Example: `Wrapper: 'wrap' Item;`
     *    Here we search for a property whose type matches the called rule.
     */
    protected emitUnassignedRuleCall(element: RuleCall | TerminalRuleCall, context: EmitContext, options: ResolvedTextSerializeOptions, iteration?: IterationContext): string[] | undefined {
        const rule = element.rule.ref;
        if (!rule) {
            return undefined;
        }
        if (isParserRule(rule)) {
            // Handle fragment rules by inlining their definition
            if (rule.fragment) {
                return this.emitElement(rule.definition, context, options, iteration);
            }
            const ruleType = getRuleTypeName(rule);
            // Handle union/alias rules: check if current node's type can be produced by this rule.
            // This occurs when processing alternatives like `Child: ChildA | ChildB`
            // where we're emitting a ChildA node through the Child rule.
            // We use ruleProducesType to handle cases where the type relationship is implied
            // by grammar structure (e.g., `ApiComplexType returns ApiType: ... | ApiUnionType`)
            // rather than explicit interface inheritance.
            if (this.ruleProducesType(rule, context.node.$type)) {
                return this.emitNode(context.node, context, options, rule);
            }
            // Look for a property whose value matches this rule's type
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
            return [this.serializeValue(value, rule, context.node, feature, options)];
        }
        return undefined;
    }

    protected emitCrossReference(crossRef: CrossReference, value: unknown, context: EmitContext, options: ResolvedTextSerializeOptions, property: string, iteration?: IterationContext): string[] | undefined {
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
            const itemTokens = this.emitTerminal(targetTerminal, item, context, options, property, iteration);
            if (itemTokens === undefined) {
                return undefined;
            }
            tokens.push(...itemTokens);
        }
        return tokens;
    }

    protected resolveReferenceValues(value: unknown, options: ResolvedTextSerializeOptions): string | string[] | undefined {
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

    protected resolveReferenceValue(reference: Reference, options: ResolvedTextSerializeOptions): string {
        if (options.useRefText && reference.$refText) {
            return reference.$refText;
        }
        if (reference.ref) {
            return this.nameProvider.getName(reference.ref) ?? reference.$refText;
        }
        return reference.$refText;
    }

    protected serializeValue(value: unknown, rule: { name: string }, node: AstNode, property: string, options: ResolvedTextSerializeOptions): string {
        // If a custom serializeValue hook is provided, use it
        if (options.serializeValue) {
            return options.serializeValue({
                node,
                property,
                value,
                ruleName: rule.name,
                languageId: this.languageId
            });
        }
        // Default formatting logic
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

    /**
     * Helper for emitting alternatives with priority given to exact type matches.
     * Uses a two-pass approach: first tries alternatives where the rule produces
     * exactly the target type, then falls back to trying all alternatives.
     *
     * @param alternatives The alternative elements to try
     * @param emitFn Function to emit a single alternative, returns tokens or undefined
     * @param targetType Optional type to prioritize (for exact matches first)
     */
    protected emitAlternativesWithPriority(
        alternatives: readonly AbstractElement[],
        emitFn: (element: AbstractElement) => string[] | undefined,
        targetType?: string
    ): string[] | undefined {
        // First pass: prioritize exact type matches
        if (targetType) {
            for (const alternative of alternatives) {
                if (isRuleCall(alternative)) {
                    const rule = alternative.rule.ref;
                    if (isParserRule(rule) && this.ruleProducesType(rule, targetType)) {
                        const tokens = emitFn(alternative);
                        if (tokens !== undefined) {
                            return tokens;
                        }
                    }
                }
            }
        }
        // Second pass: try all alternatives
        for (const alternative of alternatives) {
            const tokens = emitFn(alternative);
            if (tokens !== undefined) {
                return tokens;
            }
        }
        return undefined;
    }

    /**
     * Returns empty array for optional elements, undefined otherwise.
     * Used to signal that optional content is validly absent vs. matching failed.
     */
    protected optionalResult(element: AbstractElement): string[] | undefined {
        return isOptionalCardinality(element.cardinality, element) ? [] : undefined;
    }

    /**
     * Checks if a parser rule can produce an AST node of the given type.
     * Results are cached in `ruleProducibleTypes` for performance.
     */
    protected ruleProducesType(rule: ParserRule, nodeType: string): boolean {
        return this.ruleProducibleTypes.get(rule)?.has(nodeType) ?? false;
    }

    /**
     * Builds the cache of producible types for each parser rule.
     * Called once during construction after collectRuleTargets().
     */
    protected buildRuleProducibleTypes(): void {
        const parserRules = this.grammar.rules.filter(isParserRule);
        for (const rule of parserRules) {
            const types = new Set<string>();
            this.collectProducibleTypes(rule.definition, types, new Set());
            // Add the rule's own declared type
            types.add(getRuleTypeName(rule));
            this.ruleProducibleTypes.set(rule, types);
        }
    }

    /**
     * Recursively collects all types that can be produced by a grammar element.
     */
    protected collectProducibleTypes(element: AbstractElement, types: Set<string>, visited: Set<ParserRule>): void {
        if (isAction(element)) {
            const actionType = getActionType(element);
            if (actionType) {
                types.add(actionType);
            }
        }
        if (isRuleCall(element)) {
            const rule = element.rule.ref;
            if (isParserRule(rule) && !visited.has(rule)) {
                visited.add(rule);
                types.add(getRuleTypeName(rule));
                this.collectProducibleTypes(rule.definition, types, visited);
            }
        }
        if (isAlternatives(element) || isGroup(element) || isUnorderedGroup(element)) {
            for (const child of element.elements) {
                this.collectProducibleTypes(child, types, visited);
            }
        }
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
