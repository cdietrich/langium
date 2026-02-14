/******************************************************************************
 * Copyright 2024 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { AstNode } from '../syntax-tree.js';
import type { AbstractParserRule, Assignment } from '../languages/generated/ast.js';

export interface TextSerializeOptions {
    format?: boolean | TextFormattingOptions;
    preserveComments?: boolean;
    ambiguityResolver?: AmbiguityResolver;
    space?: string;
    useRefText?: boolean;
    serializeValue?: SerializeValueFunction;
}

export interface SerializeValueContext {
    node: AstNode;
    property: string;
    value: unknown;
    ruleName: string;
    languageId: string;
}

export type SerializeValueFunction = (context: SerializeValueContext) => string | undefined;

export interface TextFormattingOptions {
    tabSize?: number;
    insertSpaces?: boolean;
    newLine?: string;
    spaceAroundOperators?: boolean;
}

export interface SerializationContext {
    rule: AbstractParserRule;
    container?: SerializationContext;
    containerProperty?: string;
    containerIndex?: number;
}

export type AmbiguityResolver = 'first' | 'shortest' | AmbiguityResolverFunction;

export type AmbiguityResolverFunction = (choices: SerializationChoice[]) => SerializationChoice;

export interface SerializationChoice {
    index: number;
    element: unknown;
    description: string;
    estimatedLength?: number;
}

export interface SerializationResult {
    text: string;
    context: SerializationContext;
    regions?: SerializationRegion[];
}

export interface SerializationRegion {
    offset: number;
    length: number;
    node: AstNode;
    property?: string;
}

export interface TextSerializer {
    serialize(node: AstNode, options?: TextSerializeOptions): string;
    serializeFragment(node: AstNode, context?: SerializationContext): string;
}

export interface ConcreteSyntaxValidationOptions {
    strict?: boolean;
    allowPartial?: boolean;
}

export interface ValidationResult {
    valid: boolean;
    issues: ValidationIssue[];
}

export interface ValidationIssue {
    message: string;
    node: AstNode;
    property?: string;
    severity: 'error' | 'warning' | 'info';
    constraint: ConstraintType;
}

export type ConstraintType =
    | 'type-mismatch'
    | 'missing-required-property'
    | 'invalid-cardinality'
    | 'invalid-value'
    | 'unresolved-reference'
    | 'unknown-property';

export interface GrammarInfo {
    typeToRule: Map<string, AbstractParserRule[]>;
    ruleAssignments: Map<AbstractParserRule, AssignmentInfo[]>;
    ruleActions: Map<AbstractParserRule, ActionInfo[]>;
}

export interface AssignmentInfo {
    assignment: Assignment;
    property: string;
    operator: '=' | '+=' | '?=';
    optional: boolean;
    many: boolean;
    terminalType?: string;
    separator?: string;
    isLoopHead?: boolean;
    isLoopTail?: boolean;
    position?: number;
}

export interface ArrayIterationState {
    property: string;
    values: unknown[];
    currentIndex: number;
    totalElements: number;
    separator: string;
    exhausted: boolean;
}

export interface ActionInfo {
    typeName: string;
    feature?: string;
    operator?: '=' | '+=';
    precedingElements: number;
}

export interface SerializationError extends Error {
    node: AstNode;
    context?: SerializationContext;
    issues: ValidationIssue[];
}

export function isSerializationError(error: unknown): error is SerializationError {
    return typeof error === 'object' && error !== null &&
        'node' in error && 'issues' in error;
}

export function createSerializationError(
    message: string,
    node: AstNode,
    issues: ValidationIssue[] = [],
    context?: SerializationContext
): SerializationError {
    const error = new Error(message) as SerializationError;
    error.node = node;
    error.context = context;
    error.issues = issues;
    return error;
}