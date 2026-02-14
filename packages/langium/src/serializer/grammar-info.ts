/******************************************************************************
 * Copyright 2024 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { Assignment, Grammar, ParserRule } from '../languages/generated/ast.js';
import { isAction, isAlternatives, isAssignment, isCrossReference, isGroup, isKeyword, isParserRule, isRuleCall, isTerminalRule, isUnorderedGroup } from '../languages/generated/ast.js';
import { isDataTypeRule } from '../utils/grammar-utils.js';

/**
 * Precomputed information about a grammar for efficient serialization.
 */
export interface GrammarInfo {
    /** AST type → ParserRule(s) that can produce it */
    readonly typeToRule: Map<string, Set<ParserRule>>;
    /** ParserRule → ordered list of assignments */
    readonly ruleAssignments: Map<ParserRule, Assignment[]>;
    /** Assignment → terminal/datatype rule name (if applicable) */
    readonly assignmentTerminal: Map<Assignment, string>;
}

/**
 * Analyzes a grammar and builds a GrammarInfo object for use during serialization.
 */
export function buildGrammarInfo(grammar: Grammar): GrammarInfo {
    const typeToRule = new Map<string, Set<ParserRule>>();
    const ruleAssignments = new Map<ParserRule, Assignment[]>();
    const assignmentTerminal = new Map<Assignment, string>();

    for (const rule of grammar.rules) {
        if (isParserRule(rule) && !isDataTypeRule(rule)) {
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
            collectAssignments(rule.definition, assignments, assignmentTerminal);
            ruleAssignments.set(rule, assignments);
        }
    }

    return {
        typeToRule,
        ruleAssignments,
        assignmentTerminal
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
    assignmentTerminal: Map<Assignment, string>
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
            collectAssignments(child, assignments, assignmentTerminal);
        }
    } else if (isAction(element)) {
        // Actions don't contain assignments directly, but their type affects rule selection
    } else if (isRuleCall(element)) {
        const ref = element.rule.ref;
        if (isParserRule(ref)) {
            collectAssignments(ref.definition, assignments, assignmentTerminal);
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
    if (isCrossReference(element)) {
        if (element.terminal) {
            return findTerminalRuleName(element.terminal);
        }
        return 'ID';
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
 * Gets all parser rules that could produce the given AST type.
 */
export function getRulesForType(grammarInfo: GrammarInfo, typeName: string): Set<ParserRule> {
    return grammarInfo.typeToRule.get(typeName) ?? new Set();
}
