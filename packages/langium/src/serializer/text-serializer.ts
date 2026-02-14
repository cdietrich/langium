/******************************************************************************
 * Copyright 2024 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { AbstractElement, ParserRule } from '../languages/generated/ast.js';
import { isAction, isAlternatives, isAssignment, isCrossReference, isEndOfFile, isGroup, isKeyword, isParserRule, isRuleCall, isTerminalRule, isUnorderedGroup } from '../languages/generated/ast.js';
import { getRuleTypeName, isDataTypeRule } from '../utils/grammar-utils.js';
import type { AstNode, AstReflection } from '../syntax-tree.js';
import { isReference } from '../syntax-tree.js';
import type { NameProvider } from '../references/name-provider.js';
import type { LangiumCoreServices } from '../services.js';
import type { ToStringConverterService } from './to-string-converter.js';
import type { GrammarInfo } from './grammar-info.js';
import { buildGrammarInfo, getRulesForType } from './grammar-info.js';

/**
 * Options for serialization.
 */
export interface TextSerializeOptions {
    /**
     * Whether to format the output with indentation.
     * Default: false
     */
    format?: boolean;
    /**
     * The indentation string to use when formatting.
     * Default: '  ' (two spaces)
     */
    indent?: string;
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
 * Error thrown when serialization fails.
 */
export class SerializationError extends Error {
    readonly node?: AstNode | undefined;
    readonly element?: AbstractElement | undefined;

    constructor(message: string, node?: AstNode | undefined, element?: AbstractElement | undefined) {
        super(message);
        this.node = node;
        this.element = element;
        this.name = 'SerializationError';
    }
}

/**
 * Default implementation of TextSerializer.
 */
export class DefaultTextSerializer implements TextSerializer {
    protected readonly nameProvider: NameProvider;
    protected readonly astReflection: AstReflection;
    protected readonly toStringConverter: ToStringConverterService;
    protected readonly grammarInfo: GrammarInfo;

    constructor(services: LangiumCoreServices) {
        this.nameProvider = services.references.NameProvider;
        this.astReflection = services.shared.AstReflection;
        this.toStringConverter = services.serializer.ToStringConverter;
        this.grammarInfo = buildGrammarInfo(services.Grammar);
    }

    serialize(node: AstNode, options?: TextSerializeOptions): string {
        const context = new SerializationContext(this.nameProvider, this.toStringConverter, this.grammarInfo);
        const typeName = node.$type;
        const rules = getRulesForType(this.grammarInfo, typeName);
        if (rules.size === 0) {
            throw new SerializationError(`No parser rule found for type '${typeName}'`, node);
        }
        const rule = rules.values().next().value;
        if (!rule) {
            throw new SerializationError(`No parser rule found for type '${typeName}'`, node);
        }
        context.serializeNode(node, rule.definition);
        return context.getResult();
    }
}

/**
 * Internal context for serialization.
 */
class SerializationContext {
    private readonly parts: string[] = [];
    private readonly listOffsets = new Map<string, number>();
    private lastChar: string | undefined;

    constructor(
        private readonly nameProvider: NameProvider,
        private readonly toStringConverter: ToStringConverterService,
        private readonly grammarInfo: GrammarInfo
    ) {}

    getResult(): string {
        return this.parts.join('');
    }

    emit(text: string): void {
        if (text.length === 0) {
            return;
        }
        const firstChar = text[0];
        if (this.lastChar && needsSeparator(this.lastChar, firstChar)) {
            this.parts.push(' ');
        }
        this.parts.push(text);
        this.lastChar = text[text.length - 1];
    }

    serializeNode(node: AstNode, element: AbstractElement | undefined): void {
        if (!element) {
            return;
        }
        if (isKeyword(element)) {
            this.serializeKeyword(element);
        } else if (isAssignment(element)) {
            this.serializeAssignment(node, element);
        } else if (isGroup(element)) {
            this.serializeGroup(node, element);
        } else if (isAlternatives(element)) {
            this.serializeAlternatives(node, element);
        } else if (isUnorderedGroup(element)) {
            this.serializeUnorderedGroup(node, element);
        } else if (isRuleCall(element)) {
            this.serializeRuleCall(node, element);
        } else if (isCrossReference(element)) {
            this.serializeCrossReference(node, element);
        } else if (isAction(element)) {
            // Actions don't produce output directly
        } else if (isEndOfFile(element)) {
            // EOF produces no output
        }
    }

    serializeKeyword(keyword: AbstractElement & { value: string }): void {
        this.emit(keyword.value);
    }

    serializeAssignment(node: AstNode, assignment: AbstractElement & { feature: string; operator: string; terminal: AbstractElement; cardinality?: string }): void {
        const feature = assignment.feature;
        const operator = assignment.operator;
        const value = getPropertyValue(node, feature);
        if (value === undefined || value === null) {
            if (assignment.cardinality === '?' || assignment.cardinality === '*') {
                return;
            }
            throw new SerializationError(`Missing required property '${feature}' on node of type '${node.$type}'`, node, assignment);
        }

        if (operator === '?=') {
            if (value === true) {
                this.serializeNode(node, assignment.terminal);
            }
        } else if (operator === '+=') {
            if (Array.isArray(value)) {
                const cardinality = assignment.cardinality;
                if (cardinality === '+' && value.length === 0) {
                    throw new SerializationError(`Property '${feature}' requires at least one value`, node, assignment);
                }
                const listContinuation = this.hasListContinuation(node, assignment);
                if (listContinuation && value.length > 0) {
                    this.serializeAssignmentValue(node, assignment, value[0]);
                    this.listOffsets.set(feature, 1);
                    return;
                }
                for (let i = 0; i < value.length; i++) {
                    this.serializeAssignmentValue(node, assignment, value[i]);
                }
            }
        } else {
            this.serializeAssignmentValue(node, assignment, value);
        }
    }

    serializeAssignmentValue(node: AstNode, assignment: AbstractElement & { terminal: AbstractElement }, value: unknown): void {
        const terminal = assignment.terminal;
        if (isKeyword(terminal)) {
            this.emit(terminal.value);
        } else if (isCrossReference(terminal)) {
            this.serializeCrossReferenceValue(value, terminal);
        } else if (isRuleCall(terminal)) {
            const ref = terminal.rule.ref;
            if (isTerminalRule(ref)) {
                const converter = this.toStringConverter.getConverter(ref.name);
                this.emit(converter(value));
            } else if (isParserRule(ref) && isDataTypeRule(ref)) {
                const converter = this.toStringConverter.getConverter(ref.name);
                this.emit(converter(value));
            } else if (isParserRule(ref)) {
                if (typeof value === 'object' && value !== null && '$type' in value) {
                    this.serializeNode(value as AstNode, ref.definition);
                } else {
                    throw new SerializationError(`Expected AstNode for rule '${ref.name}'`, node, assignment);
                }
            }
        } else if (isAlternatives(terminal) || isGroup(terminal)) {
            this.serializeComplexTerminal(node, terminal, value);
        }
    }

    serializeComplexTerminal(node: AstNode, element: AbstractElement, value: unknown): void {
        if (isKeyword(element)) {
            this.emit(element.value);
        } else if (isRuleCall(element)) {
            const ref = element.rule.ref;
            if (isTerminalRule(ref)) {
                const converter = this.toStringConverter.getConverter(ref.name);
                this.emit(converter(value));
            } else if (isParserRule(ref) && isDataTypeRule(ref)) {
                const converter = this.toStringConverter.getConverter(ref.name);
                this.emit(converter(value));
            }
        } else if (isAlternatives(element)) {
            for (const alt of element.elements) {
                if (this.matchesAlternative(alt, value)) {
                    this.serializeComplexTerminal(node, alt, value);
                    return;
                }
            }
        } else if (isGroup(element)) {
            for (const child of element.elements) {
                this.serializeComplexTerminal(node, child, value);
            }
        }
    }

    matchesAlternative(element: AbstractElement, _value: unknown): boolean {
        if (isKeyword(element)) {
            return false;
        }
        if (isRuleCall(element)) {
            return true;
        }
        return false;
    }

    serializeCrossReference(_node: AstNode, crossRef: AbstractElement): void {
        this.serializeCrossReferenceValue(undefined, crossRef);
    }

    serializeCrossReferenceValue(ref: unknown, crossRef: AbstractElement): void {
        if (isReference(ref)) {
            if (ref.$refText) {
                this.emit(ref.$refText);
                return;
            }
            const target = ref.ref;
            if (target) {
                const name = this.nameProvider.getName(target);
                if (name) {
                    this.emit(name);
                    return;
                }
            }
            throw new SerializationError('Cannot resolve cross-reference: no $refText and cannot determine name', undefined, crossRef);
        }
        if (typeof ref === 'string') {
            this.emit(ref);
            return;
        }
        if (ref !== undefined) {
            throw new SerializationError('Cannot serialize cross-reference: expected Reference or string', undefined, crossRef);
        }
    }

    serializeGroup(node: AstNode, group: AbstractElement & { elements: AbstractElement[]; cardinality?: string }): void {
        const cardinality = group.cardinality;
        if (cardinality === '?' || cardinality === '*') {
            if (!this.hasValueInGroup(node, group)) {
                return;
            }
        }
        if (cardinality === '*' || cardinality === '+') {
            this.serializeRepeatedGroup(node, group, cardinality);
            return;
        }
        for (const element of group.elements) {
            this.serializeNode(node, element);
        }
    }

    hasValueInGroup(node: AstNode, group: AbstractElement & { elements: AbstractElement[] }): boolean {
        for (const element of group.elements) {
            if (isAssignment(element)) {
                const value = getPropertyValue(node, element.feature);
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

    serializeAlternatives(node: AstNode, alternatives: AbstractElement & { elements: AbstractElement[] }): void {
        const matchingAlt = this.findMatchingAlternative(node, alternatives);
        if (matchingAlt) {
            this.serializeNode(node, matchingAlt);
        } else {
            throw new SerializationError(`No matching alternative found for node of type '${node.$type}'`, node, alternatives);
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
            const value = getPropertyValue(node, feature);
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
                    const value = getPropertyValue(node, child.feature);
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
        const expectedType = getRuleTypeName(rule);
        if (expectedType === typeName) {
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

    serializeUnorderedGroup(node: AstNode, group: AbstractElement & { elements: AbstractElement[] }): void {
        for (const element of group.elements) {
            this.serializeNode(node, element);
        }
    }

    serializeRuleCall(node: AstNode, ruleCall: AbstractElement): void {
        if (!isRuleCall(ruleCall)) {
            return;
        }
        const ref = ruleCall.rule.ref;
        if (isTerminalRule(ref)) {
            // Terminal rules are handled in assignments
        } else if (isParserRule(ref)) {
            if (isDataTypeRule(ref)) {
                // Datatype rules should be handled in assignments
            } else {
                this.serializeNode(node, ref.definition);
            }
        }
    }

    private serializeRepeatedGroup(node: AstNode, group: AbstractElement & { elements: AbstractElement[]; cardinality?: string }, cardinality: string): void {
        const arrayLengths = this.collectArrayLengths(node, group);
        const maxLength = arrayLengths.length > 0 ? Math.max(...arrayLengths) : 0;
        const iterations = maxLength > 0 ? maxLength : (cardinality === '+' ? 1 : 0);

        const offsetFeatures = new Set(this.collectAssignmentFeatures(group));
        for (let i = 0; i < iterations; i++) {
            for (const element of group.elements) {
                if (isAssignment(element) && element.operator === '+=') {
                    const value = getPropertyValue(node, element.feature);
                    if (Array.isArray(value)) {
                        const offset = this.listOffsets.get(element.feature) ?? 0;
                        const index = offset + i;
                        if (index < value.length) {
                            this.serializeAssignmentValue(node, element, value[index]);
                        } else if (element.cardinality === '+') {
                            throw new SerializationError(`Property '${element.feature}' requires at least one value`, node, element);
                        }
                        continue;
                    }
                }
                this.serializeNode(node, element);
            }
        }
        for (const feature of offsetFeatures) {
            this.listOffsets.delete(feature);
        }
    }

    private collectArrayLengths(node: AstNode, group: AbstractElement & { elements: AbstractElement[] }): number[] {
        const lengths: number[] = [];
        for (const element of group.elements) {
            if (isAssignment(element) && element.operator === '+=') {
                const value = getPropertyValue(node, element.feature);
                if (Array.isArray(value)) {
                    const offset = this.listOffsets.get(element.feature) ?? 0;
                    lengths.push(Math.max(0, value.length - offset));
                }
            } else if (isGroup(element)) {
                lengths.push(...this.collectArrayLengths(node, element));
            }
        }
        return lengths;
    }

    private collectAssignmentFeatures(group: AbstractElement & { elements: AbstractElement[] }): string[] {
        const features: string[] = [];
        for (const element of group.elements) {
            if (isAssignment(element)) {
                features.push(element.feature);
            } else if (isGroup(element) || isAlternatives(element) || isUnorderedGroup(element)) {
                features.push(...this.collectAssignmentFeatures(element));
            }
        }
        return features;
    }

    private hasListContinuation(node: AstNode, assignment: AbstractElement & { feature: string; operator: string }): boolean {
        const container = assignment.$container;
        if (!container || !isGroup(container)) {
            return false;
        }
        const elements = container.elements;
        const index = elements.indexOf(assignment as AbstractElement);
        if (index < 0 || index >= elements.length - 1) {
            return false;
        }
        const next = elements[index + 1];
        if (!next || !('cardinality' in next)) {
            return false;
        }
        const cardinality = (next as { cardinality?: string }).cardinality;
        if (cardinality !== '*' && cardinality !== '+') {
            return false;
        }
        return this.groupContainsAssignment(next, assignment.feature);
    }

    private groupContainsAssignment(element: AbstractElement, feature: string): boolean {
        if (isAssignment(element)) {
            return element.feature === feature && element.operator === '+=';
        }
        if (isGroup(element) || isAlternatives(element) || isUnorderedGroup(element)) {
            return element.elements.some(child => this.groupContainsAssignment(child, feature));
        }
        return false;
    }

}

/**
 * Helper function to safely get a property value from an AST node.
 */
function getPropertyValue(node: AstNode, property: string): unknown {
    return (node as unknown as Record<string, unknown>)[property];
}

function needsSeparator(prev: string, next: string): boolean {
    return isWordChar(prev) && isWordChar(next);
}

function isWordChar(char: string): boolean {
    return /[A-Za-z0-9_]/.test(char);
}
