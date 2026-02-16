/******************************************************************************
 * Copyright 2024 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { AbstractElement, Assignment, ParserRule, TerminalRule } from '../languages/generated/ast.js';
import {
    isAction,
    isAlternatives,
    isAssignment,
    isCrossReference,
    isGroup,
    isKeyword,
    isParserRule,
    isRuleCall,
    isTerminalRule,
    isUnorderedGroup
} from '../languages/generated/ast.js';
import { isDataTypeRule } from '../utils/grammar-utils.js';
import type { AstNode, AstReflection } from '../syntax-tree.js';
import { isReference } from '../syntax-tree.js';
import type { NameProvider } from '../references/name-provider.js';
import type { LangiumCoreServices } from '../services.js';
import type { ToStringValueConverterService } from './to-string-converter.js';
import type { GrammarInfo } from './grammar-info.js';
import { buildGrammarInfo, getRulesForType } from './grammar-info.js';
import type { Doc } from './doc.js';
import { text, concat, render } from './doc.js';

/**
 * Options for text serialization.
 */
export interface TextSerializeOptions {
    /**
     * Whether to use $refText for cross-references.
     * If true (default), uses the stored reference text.
     * If false, computes the name using NameProvider.
     */
    useRefText?: boolean;
    /**
     * Hook to customize serialization of values.
     * Allows users to provide custom serialization for specific properties.
     */
    serializeValue?: (ctx: SerializeValueContext) => string;
}

/**
 * Context passed to the serializeValue hook.
 */
export interface SerializeValueContext {
    /** The AST node being serialized */
    node: AstNode;
    /** The property name being serialized */
    property: string;
    /** The value to serialize */
    value: unknown;
    /** The name of the rule used for this value */
    ruleName: string;
    /** The language ID */
    languageId: string;
}

/**
 * Error thrown when serialization fails.
 */
export class SerializationError extends Error {
    readonly node?: AstNode;
    readonly element?: AbstractElement;
    readonly rule?: ParserRule | TerminalRule;
    readonly path: string[];

    constructor(
        message: string,
        node?: AstNode | undefined,
        element?: AbstractElement | undefined,
        rule?: ParserRule | TerminalRule | undefined,
        path: string[] = []
    ) {
        super(message);
        this.name = 'SerializationError';
        this.node = node;
        this.element = element;
        this.rule = rule;
        this.path = path;
    }

    override toString(): string {
        let msg = `SerializationError: ${this.message}`;
        if (this.path.length > 0) {
            msg += ` (path: ${this.path.join(' > ')})`;
        }
        if (this.node?.$type) {
            msg += ` [node type: ${this.node.$type}]`;
        }
        if (this.element) {
            msg += ` [element type: ${(this.element as AbstractElement).$type}]`;
        }
        return msg;
    }
}

/**
 * Serializes an AST node back to text.
 */
export interface TextSerializer {
    /**
     * Serialize an AST node to its text representation.
     * @param node The AST node to serialize.
     * @param options Serialization options.
     * @returns The text representation of the AST node.
     */
    serialize(node: AstNode, options?: TextSerializeOptions): string;
}

/**
 * Default implementation of TextSerializer.
 */
export class DefaultTextSerializer implements TextSerializer {
    protected readonly nameProvider: NameProvider;
    protected readonly astReflection: AstReflection;
    protected readonly toStringConverter: ToStringValueConverterService;
    protected readonly grammarInfo: GrammarInfo;
    protected readonly languageId: string;

    constructor(services: LangiumCoreServices) {
        this.nameProvider = services.references.NameProvider;
        this.astReflection = services.shared.AstReflection;
        this.toStringConverter = services.serializer.ToStringValueConverter;
        this.grammarInfo = buildGrammarInfo(services.Grammar);
        this.languageId = services.LanguageMetaData?.languageId ?? 'unknown';
    }

    serialize(node: AstNode, options?: TextSerializeOptions): string {
        const context = new SerializationContext(
            this.nameProvider,
            this.toStringConverter,
            this.grammarInfo,
            this.languageId,
            options
        );
        const typeName = node.$type;
        const rules = getRulesForType(this.grammarInfo, typeName);
        if (rules.size === 0) {
            throw new SerializationError(
                `No parser rule found for type '${typeName}'`,
                node,
                undefined,
                undefined,
                [typeName]
            );
        }
        const rule = rules.values().next().value;
        if (!rule) {
            throw new SerializationError(
                `No parser rule found for type '${typeName}'`,
                node,
                undefined,
                undefined,
                [typeName]
            );
        }
        context.serializeNode(node, rule.definition, [typeName]);
        return context.getResult();
    }
}

/**
 * Internal context for serialization.
 */
class SerializationContext {
    private readonly parts: Doc[] = [];
    private readonly options: TextSerializeOptions;
    private readonly languageId: string;

    constructor(
        private readonly nameProvider: NameProvider,
        private readonly toStringConverter: ToStringValueConverterService,
        private readonly grammarInfo: GrammarInfo,
        languageId: string,
        options?: TextSerializeOptions
    ) {
        this.options = options ?? {};
        this.languageId = languageId;
    }

    getResult(): string {
        return render(concat(this.parts)).trim();
    }

    emit(doc: Doc): void {
        this.parts.push(doc);
    }

    serializeValue(value: unknown, ruleName: string, node: AstNode, property: string): string {
        if (this.options.serializeValue) {
            const context: SerializeValueContext = {
                node,
                property,
                value,
                ruleName,
                languageId: this.languageId
            };
            return this.options.serializeValue(context);
        }
        return String(value);
    }

    serializeNode(node: AstNode, element: AbstractElement | undefined, path: string[]): void {
        if (!element) {
            return;
        }
        if (isKeyword(element)) {
            this.serializeKeyword(element);
        } else if (isAssignment(element)) {
            this.serializeAssignment(node, element, path);
        } else if (isGroup(element)) {
            this.serializeGroup(node, element, path);
        } else if (isAlternatives(element)) {
            this.serializeAlternatives(node, element, path);
        } else if (isUnorderedGroup(element)) {
            this.serializeUnorderedGroup(node, element, path);
        } else if (isRuleCall(element)) {
            this.serializeRuleCall(node, element, path);
        } else if (isCrossReference(element)) {
            this.serializeCrossReference(node, element, path);
        } else if (isAction(element)) {
            // Actions don't produce output directly
        }
    }

    serializeKeyword(keyword: AbstractElement & { value: string }): void {
        this.emit(text(keyword.value));
    }

    serializeAssignment(node: AstNode, assignment: Assignment, path: string[]): void {
        const feature = assignment.feature;
        const operator = assignment.operator;
        const value = this.getPropertyValue(node, feature);
        const currentPath = [...path, feature];

        if (value === undefined || value === null) {
            if (operator === '?=') {
                // Boolean optional - no value means false, don't emit keyword
                return;
            }
            if (assignment.cardinality === '?' || assignment.cardinality === '*') {
                return;
            }
            throw new SerializationError(
                `Missing required property '${feature}' on node of type '${node.$type}'`,
                node,
                assignment,
                undefined,
                currentPath
            );
        }

        if (operator === '?=') {
            // Boolean assignment - emit terminal for any truthy value OR explicit false
            // This handles cases like: value ?= 'true' | 'false'
            // When value is false (explicit), we still need to emit the keyword
            this.serializeNode(node, assignment.terminal, currentPath);
        } else if (operator === '+=') {
            // List assignment - serialize ALL values from the AST property
            if (Array.isArray(value)) {
                const cardinality = assignment.cardinality;
                if (cardinality === '+' && value.length === 0) {
                    throw new SerializationError(
                        `Property '${feature}' requires at least one value`,
                        node,
                        assignment,
                        undefined,
                        currentPath
                    );
                }
                // Find separator between list elements (e.g., ',' in (',' value)*)
                const separator = this.findListSeparator(assignment);
                for (let i = 0; i < value.length; i++) {
                    if (i > 0) {
                        if (separator) {
                            // Add space before separator, then separator, then space after
                            this.emit(text(' '));
                            this.emit(text(separator));
                            this.emit(text(' '));
                        } else {
                            this.emit(text(' '));
                        }
                    }
                    this.serializeAssignmentValue(node, assignment, value[i], currentPath);
                }
            }
        } else {
            // Regular single-value assignment
            this.serializeAssignmentValue(node, assignment, value, currentPath);
        }
    }

    private findListSeparator(assignment: Assignment): string | undefined {
        const container = assignment.$container;
        if (!container || !isGroup(container)) {
            return undefined;
        }

        const elements = container.elements;
        const index = elements.indexOf(assignment);
        if (index < 0) {
            return undefined;
        }

        // Look for the next element after this assignment
        // If it's a keyword, that might be the separator
        for (let i = index + 1; i < elements.length; i++) {
            const next = elements[i];
            if (isKeyword(next)) {
                // Check if this keyword appears multiple times (potential separator pattern)
                // For simple case: ',' between elements
                if (next.value === ',') {
                    return ',';
                }
                // Could be other separators
                return next.value;
            }
            if (isAssignment(next)) {
                // Found next assignment directly, no separator between these two
                return undefined;
            }
            if (isGroup(next)) {
                // Check inside the group for a keyword separator
                const sep = this.findSeparatorInGroup(next);
                if (sep) {
                    return sep;
                }
            }
        }
        return undefined;
    }

    private findSeparatorInGroup(group: AbstractElement & { elements: AbstractElement[] }): string | undefined {
        for (const elem of group.elements) {
            if (isKeyword(elem)) {
                return elem.value;
            }
        }
        return undefined;
    }

    private getPropertyValue(node: AstNode, property: string): unknown {
        return (node as unknown as Record<string, unknown>)[property];
    }

    serializeAssignmentValue(
        node: AstNode,
        assignment: Assignment,
        value: unknown,
        path: string[]
    ): void {
        const terminal = assignment.terminal;
        if (!terminal) {
            return;
        }

        if (isKeyword(terminal)) {
            this.emit(text(terminal.value));
        } else if (isCrossReference(terminal)) {
            this.serializeCrossReferenceValue(value, terminal, path);
        } else if (isRuleCall(terminal)) {
            const ref = terminal.rule.ref;
            if (isTerminalRule(ref)) {
                const converted = this.toStringConverter.getConverter(ref.name)(value, ref);
                const serialized = this.serializeValue(converted, ref.name, node, assignment.feature);
                this.emit(text(serialized));
            } else if (isParserRule(ref) && isDataTypeRule(ref)) {
                const converter = this.toStringConverter.getConverterForRule(ref);
                const converted = converter(value, ref);
                const serialized = this.serializeValue(converted, ref.name, node, assignment.feature);
                this.emit(text(serialized));
            } else if (isParserRule(ref)) {
                if (typeof value === 'object' && value !== null && '$type' in value) {
                    const valueNode = value as AstNode;
                    const valueType = valueNode.$type;
                    const valueRules = getRulesForType(this.grammarInfo, valueType);
                    if (valueRules.size > 0) {
                        const valueRule = valueRules.values().next().value;
                        if (valueRule) {
                            this.serializeNode(valueNode, valueRule.definition, path);
                            return;
                        }
                    }
                    this.serializeNode(valueNode, ref.definition, path);
                } else {
                    throw new SerializationError(
                        `Expected AstNode for rule '${ref.name}'`,
                        node,
                        assignment,
                        ref,
                        path
                    );
                }
            }
        } else if (isAlternatives(terminal) || isGroup(terminal)) {
            this.serializeComplexTerminal(node, terminal, value, path);
        }
    }

    serializeComplexTerminal(
        node: AstNode,
        element: AbstractElement,
        value: unknown,
        path: string[]
    ): void {
        if (isKeyword(element)) {
            this.emit(text(element.value));
        } else if (isRuleCall(element)) {
            const ref = element.rule.ref;
            if (isTerminalRule(ref)) {
                const converted = this.toStringConverter.getConverter(ref.name)(value, ref);
                const serialized = this.serializeValue(converted, ref.name, node, '');
                this.emit(text(serialized));
            } else if (isParserRule(ref) && isDataTypeRule(ref)) {
                const converter = this.toStringConverter.getConverterForRule(ref);
                const converted = converter(value, ref);
                const serialized = this.serializeValue(converted, ref.name, node, '');
                this.emit(text(serialized));
            }
        } else if (isAlternatives(element)) {
            for (const alt of element.elements) {
                if (this.matchesAlternative(alt, value)) {
                    this.serializeComplexTerminal(node, alt, value, path);
                    return;
                }
            }
        } else if (isGroup(element)) {
            for (const child of element.elements) {
                this.serializeComplexTerminal(node, child, value, path);
            }
        }
    }

    matchesAlternative(element: AbstractElement, value: unknown): boolean {
        if (isKeyword(element)) {
            // For boolean literals like value ?= 'true' | 'false',
            // check if the value matches the keyword
            return String(value) === element.value;
        }
        if (isRuleCall(element)) {
            return true;
        }
        return false;
    }

    serializeCrossReference(
        _node: AstNode,
        crossRef: AbstractElement,
        path: string[]
    ): void {
        this.serializeCrossReferenceValue(undefined, crossRef, path);
    }

    serializeCrossReferenceValue(
        ref: unknown,
        crossRef: AbstractElement,
        path: string[]
    ): void {
        if (isReference(ref)) {
            if (ref.$refText && this.options.useRefText !== false) {
                this.emit(text(ref.$refText));
                return;
            }
            const target = ref.ref;
            if (target) {
                const name = this.nameProvider.getName(target);
                if (name) {
                    this.emit(text(name));
                    return;
                }
            }
            throw new SerializationError(
                'Cannot resolve cross-reference: no $refText and cannot determine name',
                undefined,
                crossRef,
                undefined,
                path
            );
        }
        if (typeof ref === 'string') {
            this.emit(text(ref));
            return;
        }
        if (ref !== undefined) {
            throw new SerializationError(
                'Cannot serialize cross-reference: expected Reference or string',
                undefined,
                crossRef,
                undefined,
                path
            );
        }
    }

    serializeGroup(node: AstNode, group: AbstractElement & { elements: AbstractElement[]; cardinality?: string }, path: string[]): void {
        const cardinality = group.cardinality;
        if (cardinality === '?' || cardinality === '*') {
            if (!this.hasValueInGroup(node, group)) {
                return;
            }
        }
        if (cardinality === '*' || cardinality === '+') {
            this.serializeRepeatedGroup(node, group, cardinality, path);
            return;
        }
        const processedFeatures = new Set<string>();
        let first = true;
        for (const element of group.elements) {
            // Skip list assignments that have already been processed
            if (isAssignment(element) && element.operator === '+=') {
                if (processedFeatures.has(element.feature)) {
                    continue;
                }
                processedFeatures.add(element.feature);
            }
            // Check if this element would produce any output
            if (!this.wouldProduceOutput(node, element)) {
                continue;
            }
            if (!first) {
                this.emit(text(' '));
            }
            first = false;
            this.serializeNode(node, element, path);
        }
    }

    private wouldProduceOutput(node: AstNode, element: AbstractElement): boolean {
        if (isKeyword(element)) {
            return true;
        }
        if (isAssignment(element)) {
            const value = this.getPropertyValue(node, element.feature);
            if (value === undefined || value === null) {
                return false;
            }
            if (Array.isArray(value) && value.length === 0) {
                return false;
            }
            return true;
        }
        if (isGroup(element)) {
            return this.hasValueInGroup(node, element);
        }
        if (isAlternatives(element)) {
            return this.findMatchingAlternative(node, element) !== undefined;
        }
        if (isUnorderedGroup(element)) {
            return this.hasValueInUnorderedGroup(node, element);
        }
        return true;
    }

    private hasValueInUnorderedGroup(node: AstNode, group: AbstractElement & { elements: AbstractElement[] }): boolean {
        for (const element of group.elements) {
            if (isAssignment(element)) {
                const value = this.getPropertyValue(node, element.feature);
                if (value !== undefined && value !== null) {
                    if (Array.isArray(value) && value.length > 0) {
                        return true;
                    }
                    if (!Array.isArray(value)) {
                        return true;
                    }
                }
            } else if (isGroup(element)) {
                if (this.hasValueInGroup(node, element)) {
                    return true;
                }
            }
        }
        return false;
    }

    hasValueInGroup(node: AstNode, group: AbstractElement & { elements: AbstractElement[] }): boolean {
        for (const element of group.elements) {
            if (isAssignment(element)) {
                const value = this.getPropertyValue(node, element.feature);
                if (value !== undefined && value !== null) {
                    if (Array.isArray(value) && value.length > 0) {
                        return true;
                    }
                    if (!Array.isArray(value)) {
                        return true;
                    }
                }
            } else if (isGroup(element)) {
                if (this.hasValueInGroup(node, element)) {
                    return true;
                }
            }
        }
        return false;
    }

    serializeAlternatives(
        node: AstNode,
        alternatives: AbstractElement & { elements: AbstractElement[] },
        path: string[]
    ): void {
        const matchingAlt = this.findMatchingAlternative(node, alternatives);
        if (matchingAlt) {
            this.serializeNode(node, matchingAlt, path);
        } else {
            throw new SerializationError(
                `No matching alternative found for node of type '${node.$type}'`,
                node,
                alternatives,
                undefined,
                path
            );
        }
    }

    findMatchingAlternative(node: AstNode, alternatives: AbstractElement & { elements: AbstractElement[] }): AbstractElement | undefined {
        for (const element of alternatives.elements) {
            if (this.alternativeMatches(node, element)) {
                return element;
            }
        }
        return undefined;
    }

    alternativeMatches(node: AstNode, element: AbstractElement): boolean {
        if (isAssignment(element)) {
            const feature = element.feature;
            const value = this.getPropertyValue(node, feature);
            return value !== undefined && value !== null;
        }
        if (isRuleCall(element)) {
            const ref = element.rule.ref;
            if (isParserRule(ref)) {
                return this.ruleAcceptsNode(ref, node, new Set());
            }
            return false;
        }
        if (isGroup(element)) {
            for (const child of element.elements) {
                if (isAssignment(child) && !child.cardinality) {
                    const value = this.getPropertyValue(node, child.feature);
                    if (value === undefined || value === null) {
                        return false;
                    }
                }
            }
            return true;
        }
        if (isAction(element)) {
            const actionType = element.type?.$refText ?? element.inferredType?.name;
            if (actionType && node.$type === actionType) {
                return true;
            }
        }
        return false;
    }

    private ruleAcceptsNode(rule: ParserRule, node: AstNode, visited: Set<ParserRule>): boolean {
        if (visited.has(rule)) {
            return false;
        }
        visited.add(rule);
        const typeName = node.$type;
        const rules = this.grammarInfo.typeToRule.get(typeName);
        if (rules?.has(rule)) {
            return true;
        }
        if (rule.returnType?.$refText === typeName) {
            return true;
        }
        if (rule.inferredType?.name === typeName) {
            return true;
        }
        return this.elementAcceptsNode(rule.definition, node, visited);
    }

    private elementAcceptsNode(element: AbstractElement | undefined, node: AstNode, visited: Set<ParserRule>): boolean {
        if (!element) {
            return false;
        }
        if (isRuleCall(element)) {
            const ref = element.rule.ref;
            if (isParserRule(ref)) {
                return this.ruleAcceptsNode(ref, node, visited);
            }
            return false;
        }
        if (isAlternatives(element) || isGroup(element) || isUnorderedGroup(element)) {
            return element.elements.some(child => this.elementAcceptsNode(child, node, visited));
        }
        if (isAction(element)) {
            const actionType = element.type?.$refText ?? element.inferredType?.name;
            if (actionType) {
                return node.$type === actionType;
            }
        }
        return false;
    }

    serializeUnorderedGroup(node: AstNode, group: AbstractElement & { elements: AbstractElement[] }, path: string[]): void {
        // For unordered groups, serialize elements in grammar order
        // The serializer doesn't need to care about the order, just serialize what's present
        let first = true;
        for (const element of group.elements) {
            // Check if this element has a value before emitting
            if (isAssignment(element)) {
                const value = this.getPropertyValue(node, element.feature);
                if (value === undefined || value === null) {
                    continue;
                }
                if (Array.isArray(value) && value.length === 0) {
                    continue;
                }
            }
            if (!first) {
                this.emit(text(' '));
            }
            first = false;
            this.serializeNode(node, element, path);
        }
    }

    serializeRuleCall(node: AstNode, ruleCall: AbstractElement, path: string[]): void {
        if (!isRuleCall(ruleCall)) {
            return;
        }
        const ref = ruleCall.rule.ref;
        if (isTerminalRule(ref)) {
            throw new SerializationError(
                `Unassigned terminal rule call '${ref.name}' requires a serializeUnassignedTerminal callback`,
                node,
                ruleCall,
                ref,
                path
            );
        } else if (isParserRule(ref)) {
            if (isDataTypeRule(ref)) {
                // Datatype rules should be handled in assignments
            } else if (ref.fragment) {
                // Inline fragment definition
                this.serializeNode(node, ref.definition, path);
            } else {
                // For unassigned parser rule calls like 'wrap' Item
                // Look up the child node by property name (lowercase rule name)
                const childProperty = ref.name.charAt(0).toLowerCase() + ref.name.slice(1);
                const childNode = this.getPropertyValue(node, childProperty);
                if (childNode && typeof childNode === 'object' && '$type' in childNode) {
                    this.serializeNode(childNode as AstNode, ref.definition, path);
                } else {
                    // Fallback: serialize the rule's definition
                    this.serializeNode(node, ref.definition, path);
                }
            }
        }
    }

    private serializeRepeatedGroup(
        node: AstNode,
        group: AbstractElement & { elements: AbstractElement[]; cardinality?: string },
        cardinality: string,
        path: string[]
    ): void {
        // For repeated groups, we don't want to process list assignments here
        // because they are handled by the parent serializeGroup/serializeAssignment
        // which gets all values from the AST property directly
        // 
        // This handles cases like: refs+=[Item] (',' refs+=[Item])*
        // where both assignment elements write to the same 'refs' property
        
        const hasListAssignment = group.elements.some(e => 
            isAssignment(e) && e.operator === '+='
        );
        
        if (hasListAssignment) {
            // Skip serialization here - list values will be serialized by the parent
            return;
        }

        // For non-list repeated groups, process normally
        const arrayLengths = this.collectArrayLengths(node, group);
        const maxLength = arrayLengths.length > 0 ? Math.max(...arrayLengths) : 0;
        const iterations = maxLength > 0 ? maxLength : (cardinality === '+' ? 1 : 0);

        for (let i = 0; i < iterations; i++) {
            let isFirstInIteration = true;
            for (const element of group.elements) {
                if (!isFirstInIteration) {
                    this.emit(text(' '));
                }
                isFirstInIteration = false;
                this.serializeNode(node, element, path);
            }
        }
    }

    private collectArrayLengths(node: AstNode, group: AbstractElement & { elements: AbstractElement[] }): number[] {
        const lengths: number[] = [];
        for (const element of group.elements) {
            if (isAssignment(element) && element.operator === '+=') {
                const value = this.getPropertyValue(node, element.feature);
                if (Array.isArray(value)) {
                    lengths.push(value.length);
                }
            } else if (isGroup(element)) {
                lengths.push(...this.collectArrayLengths(node, element));
            }
        }
        return lengths;
    }
}
