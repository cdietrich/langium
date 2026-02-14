/******************************************************************************
 * Copyright 2024 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { AstNode, AstReflection, Reference } from '../syntax-tree.js';
import type { Grammar, AbstractParserRule, ParserRule, Assignment, AbstractElement } from '../languages/generated/ast.js';
import { isParserRule, isAssignment, isAlternatives, isGroup, isRuleCall, isInfixRule } from '../languages/generated/ast.js';
import type { ConcreteSyntaxValidationOptions, ValidationResult, ValidationIssue } from './text-serializer.js';
import { getRuleType, getTypeName, isDataTypeRule, isOptionalCardinality, isArrayCardinality } from '../utils/grammar-utils.js';

export interface ConcreteSyntaxValidator {
    validate(node: AstNode, options?: ConcreteSyntaxValidationOptions): ValidationResult;
}

export class DefaultConcreteSyntaxValidator implements ConcreteSyntaxValidator {
    protected readonly grammar: Grammar;
    protected readonly astReflection: AstReflection;

    constructor(grammar: Grammar, astReflection: AstReflection) {
        this.grammar = grammar;
        this.astReflection = astReflection;
    }

    validate(node: AstNode, options?: ConcreteSyntaxValidationOptions): ValidationResult {
        const issues: ValidationIssue[] = [];
        this.validateNode(node, issues, options);
        return {
            valid: issues.filter(i => i.severity === 'error').length === 0,
            issues
        };
    }

    protected validateNode(node: AstNode, issues: ValidationIssue[], options?: ConcreteSyntaxValidationOptions): void {
        const rule = this.findRuleForNode(node);
        if (!rule) {
            if (!options?.allowPartial) {
                issues.push({
                    message: `No grammar rule found for type '${node.$type}'`,
                    node,
                    severity: 'error',
                    constraint: 'type-mismatch'
                });
            }
            return;
        }

        if (isParserRule(rule) && !isDataTypeRule(rule)) {
            this.validateAgainstRule(node, rule, issues, options);
        }

        for (const [propertyName, value] of Object.entries(node)) {
            if (propertyName.startsWith('$')) continue;
            this.validateProperty(node, propertyName, value, issues, options);
        }
    }

    protected findRuleForNode(node: AstNode): AbstractParserRule | undefined {
        const nodeType = node.$type;
        for (const rule of this.grammar.rules) {
            if (isParserRule(rule) || isInfixRule(rule)) {
                const ruleType = getRuleType(rule);
                if (ruleType === nodeType) {
                    return rule;
                }
            }
        }
        return undefined;
    }

    protected validateAgainstRule(
        node: AstNode,
        rule: ParserRule,
        issues: ValidationIssue[],
        options?: ConcreteSyntaxValidationOptions
    ): void {
        const assignments = this.collectAssignments(rule);
        const typeInfo = this.getTypeInfo(rule);

        if (!this.isTypeCompatible(node.$type, typeInfo)) {
            issues.push({
                message: `Type '${node.$type}' is not compatible with rule '${rule.name}' which produces '${typeInfo}'`,
                node,
                severity: 'error',
                constraint: 'type-mismatch'
            });
            return;
        }

        for (const assignmentInfo of assignments) {
            const { assignment, optional, many } = assignmentInfo;
            const property = assignment.feature;
            const value = (node as unknown as Record<string, unknown>)[property];

            if (value === undefined || value === null) {
                if (!optional && !many) {
                    issues.push({
                        message: `Missing required property '${property}'`,
                        node,
                        property,
                        severity: 'error',
                        constraint: 'missing-required-property'
                    });
                }
            } else {
                if (many && !Array.isArray(value)) {
                    issues.push({
                        message: `Property '${property}' should be an array (cardinality '*' or '+')`,
                        node,
                        property,
                        severity: 'error',
                        constraint: 'invalid-cardinality'
                    });
                } else if (!many && Array.isArray(value)) {
                    issues.push({
                        message: `Property '${property}' should not be an array`,
                        node,
                        property,
                        severity: 'error',
                        constraint: 'invalid-cardinality'
                    });
                }

                if (assignment.operator === '?=' && value !== true && value !== false) {
                    issues.push({
                        message: `Property '${property}' with '?=' operator should be boolean`,
                        node,
                        property,
                        severity: 'error',
                        constraint: 'invalid-value'
                    });
                }
            }
        }

        const nodeProps = new Set(
            Object.keys(node).filter(k => !k.startsWith('$'))
        );
        for (const prop of nodeProps) {
            const assignment = assignments.find(a => a.assignment.feature === prop);
            if (!assignment) {
                const knownProperties = assignments.map(a => a.assignment.feature);
                issues.push({
                    message: `Unknown property '${prop}'. Known properties: ${knownProperties.join(', ')}`,
                    node,
                    property: prop,
                    severity: 'warning',
                    constraint: 'unknown-property'
                });
            }
        }
    }

    protected validateProperty(
        node: AstNode,
        propertyName: string,
        value: unknown,
        issues: ValidationIssue[],
        options?: ConcreteSyntaxValidationOptions
    ): void {
        if (this.isReference(value)) {
            this.validateReference(node, propertyName, value, issues, options);
        } else if (Array.isArray(value)) {
            value.forEach((item, index) => {
                if (this.isAstNode(item)) {
                    this.validateNode(item, issues, options);
                }
            });
        } else if (this.isAstNode(value)) {
            this.validateNode(value, issues, options);
        }
    }

    protected validateReference(
        node: AstNode,
        propertyName: string,
        ref: Reference,
        issues: ValidationIssue[],
        options?: ConcreteSyntaxValidationOptions
    ): void {
        if (!ref.ref && !options?.allowPartial) {
            issues.push({
                message: `Unresolved reference in property '${propertyName}'${ref.error ? `: ${ref.error.message}` : ''}`,
                node,
                property: propertyName,
                severity: 'error',
                constraint: 'unresolved-reference'
            });
        }
    }

    protected collectAssignments(rule: ParserRule): AssignmentValidationInfo[] {
        const assignments: AssignmentValidationInfo[] = [];
        const visited = new Set<ParserRule>();
        visited.add(rule);
        this.collectAssignmentsFromElement(rule.definition, assignments, visited);
        return assignments;
    }

    protected collectAssignmentsFromElement(
        element: AbstractElement,
        assignments: AssignmentValidationInfo[],
        visited: Set<ParserRule>
    ): void {
        if (isAssignment(element)) {
            assignments.push({
                assignment: element,
                optional: isOptionalCardinality(element.cardinality),
                many: isArrayCardinality(element.cardinality)
            });
        } else if (isAlternatives(element)) {
            for (const alt of element.elements) {
                this.collectAssignmentsFromElement(alt, assignments, visited);
            }
        } else if (isGroup(element)) {
            for (const child of element.elements) {
                this.collectAssignmentsFromElement(child, assignments, visited);
            }
        } else if (isRuleCall(element) && isParserRule(element.rule.ref)) {
            if (!isDataTypeRule(element.rule.ref) && !visited.has(element.rule.ref)) {
                visited.add(element.rule.ref);
                const calledAssignments = this.collectAssignmentsFromRule(element.rule.ref, visited);
                assignments.push(...calledAssignments);
            }
        }
    }

    protected collectAssignmentsFromRule(rule: ParserRule, visited: Set<ParserRule>): AssignmentValidationInfo[] {
        const assignments: AssignmentValidationInfo[] = [];
        this.collectAssignmentsFromElement(rule.definition, assignments, visited);
        return assignments;
    }

    protected getTypeInfo(rule: AbstractParserRule): string {
        if (isParserRule(rule)) {
            if (rule.inferredType) {
                return rule.inferredType.name;
            }
            if (rule.returnType?.ref) {
                return getTypeName(rule.returnType.ref);
            }
            return rule.name;
        } else if (isInfixRule(rule)) {
            if (rule.inferredType) {
                return rule.inferredType.name;
            }
            if (rule.returnType?.ref) {
                return getTypeName(rule.returnType.ref);
            }
            return rule.name;
        }
        return getRuleType(rule);
    }

    protected isTypeCompatible(nodeType: string, ruleType: string): boolean {
        if (nodeType === ruleType) {
            return true;
        }
        return this.astReflection.isSubtype(nodeType, ruleType);
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

interface AssignmentValidationInfo {
    assignment: Assignment;
    optional: boolean;
    many: boolean;
}