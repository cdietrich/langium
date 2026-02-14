/******************************************************************************
 * Copyright 2024 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { AstNode } from '../syntax-tree.js';
import type { Grammar, AbstractParserRule, ParserRule, Assignment, AbstractElement, Action } from '../languages/generated/ast.js';
import { isParserRule, isAssignment, isAlternatives, isGroup, isRuleCall, isInfixRule, isAction } from '../languages/generated/ast.js';
import type { SerializationContext } from './text-serializer.js';
import { getTypeName, isDataTypeRule } from '../utils/grammar-utils.js';
import { streamAllContents } from '../utils/ast-utils.js';

export interface ContextResolver {
    findContext(node: AstNode, hint?: AbstractParserRule): SerializationContext | undefined;
    findRuleForType(type: string): AbstractParserRule | undefined;
    findAssignmentForProperty(rule: AbstractParserRule, property: string): Assignment | undefined;
    getAllRulesForType(type: string): AbstractParserRule[];
    getAssignments(rule: AbstractParserRule): Assignment[];
}

export class DefaultContextResolver implements ContextResolver {
    protected readonly grammar: Grammar;
    protected readonly typeToRules: Map<string, AbstractParserRule[]>;
    protected readonly ruleToAssignments: Map<AbstractParserRule, Assignment[]>;

    constructor(grammar: Grammar) {
        this.grammar = grammar;
        this.typeToRules = this.buildTypeToRulesMap();
        this.ruleToAssignments = this.buildRuleToAssignmentsMap();
    }

    findContext(node: AstNode, hint?: AbstractParserRule): SerializationContext | undefined {
        const rules = this.typeToRules.get(node.$type);
        if (!rules || rules.length === 0) {
            return undefined;
        }

        let rule: AbstractParserRule;
        if (hint && rules.includes(hint)) {
            rule = hint;
        } else {
            rule = rules[0];
        }

        return {
            rule,
            container: undefined,
            containerProperty: undefined,
            containerIndex: undefined
        };
    }

    findRuleForType(type: string): AbstractParserRule | undefined {
        const rules = this.typeToRules.get(type);
        return rules?.[0];
    }

    findAssignmentForProperty(rule: AbstractParserRule, property: string): Assignment | undefined {
        const assignments = this.ruleToAssignments.get(rule);
        return assignments?.find(a => a.feature === property);
    }

    protected buildTypeToRulesMap(): Map<string, AbstractParserRule[]> {
        const map = new Map<string, AbstractParserRule[]>();

        for (const rule of this.grammar.rules) {
            if (isParserRule(rule) || isInfixRule(rule)) {
                const type = this.getRuleTypeName(rule);
                if (type) {
                    const existing = map.get(type) ?? [];
                    if (!existing.includes(rule)) {
                        existing.push(rule);
                    }
                    map.set(type, existing);
                }

                if (isParserRule(rule) && !isDataTypeRule(rule)) {
                    this.collectActionTypes(rule, map);
                }
            }
        }

        return map;
    }

    protected getRuleTypeName(rule: AbstractParserRule): string | undefined {
        if (isParserRule(rule)) {
            if (rule.inferredType) {
                return rule.inferredType.name;
            }
            if (rule.returnType?.ref) {
                return getTypeName(rule.returnType.ref);
            }
            if (isDataTypeRule(rule)) {
                return rule.dataType ?? rule.name;
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
        return undefined;
    }

    protected collectActionTypes(rule: ParserRule, map: Map<string, AbstractParserRule[]>): void {
        for (const node of streamAllContents(rule)) {
            if (isAction(node)) {
                const actionType = this.getActionTypeName(node);
                if (actionType) {
                    const existing = map.get(actionType) ?? [];
                    if (!existing.includes(rule)) {
                        existing.push(rule);
                    }
                    map.set(actionType, existing);
                }
            }
        }
    }

    protected getActionTypeName(action: Action): string | undefined {
        if (action.inferredType) {
            return action.inferredType.name;
        }
        if (action.type?.ref) {
            return getTypeName(action.type.ref);
        }
        return undefined;
    }

    protected buildRuleToAssignmentsMap(): Map<AbstractParserRule, Assignment[]> {
        const map = new Map<AbstractParserRule, Assignment[]>();

        for (const rule of this.grammar.rules) {
            if (isParserRule(rule) || isInfixRule(rule)) {
                const assignments: Assignment[] = [];
                const visited = new Set<ParserRule>();
                if (isParserRule(rule)) {
                    this.collectAssignments(rule.definition, assignments, visited);
                } else if (isInfixRule(rule)) {
                    this.collectAssignments(rule.call, assignments, visited);
                }
                map.set(rule, assignments);
            }
        }

        return map;
    }

    protected collectAssignments(element: AbstractElement, assignments: Assignment[], visited: Set<ParserRule>): void {
        if (isAssignment(element)) {
            assignments.push(element);
        } else if (isAlternatives(element)) {
            for (const alt of element.elements) {
                this.collectAssignments(alt, assignments, visited);
            }
        } else if (isGroup(element)) {
            for (const child of element.elements) {
                this.collectAssignments(child, assignments, visited);
            }
        } else if (isRuleCall(element) && isParserRule(element.rule.ref) && !visited.has(element.rule.ref)) {
            visited.add(element.rule.ref);
            this.collectAssignments(element.rule.ref.definition, assignments, visited);
        }
    }

    getAllRulesForType(type: string): AbstractParserRule[] {
        return this.typeToRules.get(type) ?? [];
    }

    getAssignments(rule: AbstractParserRule): Assignment[] {
        return this.ruleToAssignments.get(rule) ?? [];
    }
}