/******************************************************************************
 * Copyright 2024 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { AbstractElement, Assignment, Grammar, ParserRule, TerminalRule } from '../languages/generated/ast.js';
import { isAlternatives, isAssignment, isGroup, isInfixRule, isKeyword, isParserRule, isRuleCall, isTerminalRule, isUnorderedGroup } from '../languages/generated/ast.js';
import { isDataTypeRule } from '../utils/grammar-utils.js';

export interface GrammarInfo {
    /** AST type → ParserRule(s) that can produce it */
    typeToRule: Map<string, Set<ParserRule>>;
    /** ParserRule → ordered list of assignments */
    ruleAssignments: Map<ParserRule, Assignment[]>;
    /** Assignment → terminal/datatype rule name (if applicable) */
    assignmentTerminal: Map<Assignment, string>;
    /** Terminal rules by name */
    terminalRules: Map<string, TerminalRule>;
    /** Datatype rules by name (ParserRule with dataType) */
    datatypeRules: Map<string, ParserRule>;
    /** Fragment rules that need to be inlined */
    fragmentRules: Map<string, ParserRule>;
}

export interface AssignmentInfo {
    assignment: Assignment;
    isArray: boolean;
    cardinality: string | undefined;
    separator: string | undefined;
}

/**
 * Builds a GrammarInfo object for use during serialization.
 * Collects terminal rules, datatype rules, fragments, and validates no infix rules.
 */
export function buildGrammarInfo(grammar: Grammar): GrammarInfo {
    const typeToRule = new Map<string, Set<ParserRule>>();
    const ruleAssignments = new Map<ParserRule, Assignment[]>();
    const assignmentTerminal = new Map<Assignment, string>();
    const terminalRules = new Map<string, TerminalRule>();
    const datatypeRules = new Map<string, ParserRule>();
    const fragmentRules = new Map<string, ParserRule>();

    for (const rule of grammar.rules) {
        // Collect terminal rules
        if (isTerminalRule(rule)) {
            terminalRules.set(rule.name, rule);
            continue;
        }

        // Check for infix rules - not supported
        if (isInfixRule(rule)) {
            throw new Error(`InfixRule '${rule.name}' is not supported in serializer`);
        }

        if (isParserRule(rule)) {
            // Collect datatype rules
            if (isDataTypeRule(rule)) {
                datatypeRules.set(rule.name, rule);
                continue;
            }

            // Collect fragment rules for inlining
            if (rule.fragment) {
                fragmentRules.set(rule.name, rule);
                continue;
            }

            const typeName = getTypeName(rule);
            if (typeName) {
                let rules = typeToRule.get(typeName);
                if (!rules) {
                    rules = new Set();
                    typeToRule.set(typeName, rules);
                }
                rules.add(rule);
            }
            const assignments: Assignment[] = [];
            collectAssignments(rule.definition, assignments, assignmentTerminal, typeToRule);
            ruleAssignments.set(rule, assignments);
        }
    }

    return {
        typeToRule,
        ruleAssignments,
        assignmentTerminal,
        terminalRules,
        datatypeRules,
        fragmentRules
    };
}

function getTypeName(rule: ParserRule): string | undefined {
    if (rule.returnType?.$refText) {
        return rule.returnType.$refText;
    }
    if (rule.inferredType?.name) {
        return rule.inferredType.name;
    }
    return rule.name;
}

function collectAssignments(
    element: ParserRule['definition'] | undefined,
    assignments: Assignment[],
    assignmentTerminal: Map<Assignment, string>,
    typeToRule: Map<string, Set<ParserRule>>
): void {
    if (!element) {
        return;
    }
    if (isAssignment(element)) {
        assignments.push(element);
        const terminalRuleName = findTerminalRuleName(element.terminal);
        if (terminalRuleName) {
            assignmentTerminal.set(element, terminalRuleName);
        }
    } else if (isGroup(element) || isAlternatives(element) || isUnorderedGroup(element)) {
        for (const child of element.elements) {
            collectAssignments(child as ParserRule['definition'], assignments, assignmentTerminal, typeToRule);
        }
    } else if (isRuleCall(element)) {
        const ref = element.rule.ref;
        if (isParserRule(ref)) {
            if (isDataTypeRule(ref) || ref.fragment) {
                // Skip datatype and fragment rules
            } else {
                collectAssignments(ref.definition, assignments, assignmentTerminal, typeToRule);
                // Register alternative types from the referenced rule
                const altTypeName = getTypeName(ref);
                if (altTypeName) {
                    let rules = typeToRule.get(altTypeName);
                    if (!rules) {
                        rules = new Set();
                        typeToRule.set(altTypeName, rules);
                    }
                    rules.add(ref);
                }
            }
        }
    }
}

function findTerminalRuleName(element: ParserRule['definition']): string | undefined {
    if (!element) {
        return undefined;
    }
    if (isKeyword(element)) {
        return undefined;
    }
    if (isRuleCall(element)) {
        const ref = element.rule.ref;
        if (isTerminalRule(ref)) {
            return ref.name;
        }
        if (isParserRule(ref) && isDataTypeRule(ref)) {
            return ref.name;
        }
    }
    if (isAlternatives(element) || isGroup(element)) {
        for (const child of element.elements) {
            const name = findTerminalRuleName(child);
            if (name) {
                return name;
            }
        }
    }
    return undefined;
}

/**
 * Determines if an assignment creates an array property.
 */
export function isArrayAssignment(assignment: Assignment): boolean {
    return assignment.operator === '+=';
}

/**
 * Gets the cardinality of an element.
 */
export function getCardinality(element: AbstractElement): string | undefined {
    return element.cardinality;
}

/**
 * Finds the separator between list elements in a group.
 * Looks for a Keyword between assignments in a Group.
 */
export function findSeparator(assignment: Assignment): string | undefined {
    const container = assignment.$container;
    if (!container || !isGroup(container)) {
        return undefined;
    }

    const elements = container.elements;
    const index = elements.indexOf(assignment);
    if (index < 0 || index >= elements.length - 1) {
        return undefined;
    }

    for (let i = index + 1; i < elements.length; i++) {
        const next = elements[i];
        if (isKeyword(next)) {
            return next.value;
        }
        if (!isAssignment(next)) {
            continue;
        }
        return undefined;
    }

    return undefined;
}

/**
 * Gets all assignment info for a parser rule.
 */
export function getAssignmentInfo(grammarInfo: GrammarInfo, rule: ParserRule): AssignmentInfo[] {
    const assignments = grammarInfo.ruleAssignments.get(rule) ?? [];
    return assignments.map((assignment) => ({
        assignment,
        isArray: isArrayAssignment(assignment),
        cardinality: getCardinality(assignment),
        separator: findSeparator(assignment)
    }));
}

/**
 * Gets all parser rules that could produce the given AST type.
 */
export function getRulesForType(grammarInfo: GrammarInfo, typeName: string): Set<ParserRule> {
    return grammarInfo.typeToRule.get(typeName) ?? new Set();
}
