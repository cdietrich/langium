/******************************************************************************
 * Copyright 2024 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { Grammar, AbstractParserRule, AbstractElement } from '../languages/generated/ast.js';
import { isParserRule, isAssignment, isKeyword, isRuleCall, isCrossReference, isAction, isGroup, isAlternatives, isTerminalRuleCall, isInfixRule } from '../languages/generated/ast.js';
import type { AssignmentInfo, ActionInfo } from './text-serializer.js';
import { getRuleType, getTypeName, isDataTypeRule, isOptionalCardinality, isArrayCardinality } from '../utils/grammar-utils.js';
import { streamAllContents } from '../utils/ast-utils.js';

export interface GrammarAnalysisResult {
    typeToRule: Map<string, AbstractParserRule[]>;
    ruleInfo: Map<AbstractParserRule, RuleAnalysisInfo>;
    entryRule: AbstractParserRule | undefined;
}

export interface RuleAnalysisInfo {
    rule: AbstractParserRule;
    typeName: string;
    assignments: AssignmentInfo[];
    actions: ActionInfo[];
    elementSequence: GrammarElementInfo[];
    hasAmbiguities: boolean;
}

export interface GrammarElementInfo {
    element: AbstractElement;
    type: GrammarElementType;
    optional: boolean;
    many: boolean;
    property?: string;
    typeName?: string;
}

export type GrammarElementType =
    | 'keyword'
    | 'assignment'
    | 'rule-call'
    | 'cross-reference'
    | 'action'
    | 'group'
    | 'alternatives';

export class GrammarAnalyzer {
    protected readonly grammar: Grammar;
    protected analysisCache: Map<AbstractParserRule, RuleAnalysisInfo> | undefined;

    constructor(grammar: Grammar) {
        this.grammar = grammar;
    }

    analyze(): GrammarAnalysisResult {
        if (this.analysisCache) {
            return {
                typeToRule: this.buildTypeToRuleMap(),
                ruleInfo: this.analysisCache,
                entryRule: this.findEntryRule()
            };
        }

        const ruleInfo = new Map<AbstractParserRule, RuleAnalysisInfo>();
        const typeToRule = new Map<string, AbstractParserRule[]>();

        for (const rule of this.grammar.rules) {
            if (isParserRule(rule) || isInfixRule(rule)) {
                const info = this.analyzeRule(rule);
                ruleInfo.set(rule, info);

                const typeName = info.typeName;
                const existing = typeToRule.get(typeName) ?? [];
                if (!existing.includes(rule)) {
                    existing.push(rule);
                }
                typeToRule.set(typeName, existing);
            }
        }

        this.analysisCache = ruleInfo;

        return {
            typeToRule,
            ruleInfo,
            entryRule: this.findEntryRule()
        };
    }

    protected findEntryRule(): AbstractParserRule | undefined {
        for (const rule of this.grammar.rules) {
            if (isParserRule(rule) && rule.entry) {
                return rule;
            }
        }
        return undefined;
    }

    protected analyzeRule(rule: AbstractParserRule): RuleAnalysisInfo {
        const typeName = this.getTypeName(rule);
        const assignments = this.collectAssignments(rule);
        const actions = this.collectActions(rule);
        const elementSequence = isParserRule(rule)
            ? this.analyzeElementSequence(rule.definition)
            : this.analyzeElementSequence(rule.call);
        const hasAmbiguities = this.detectAmbiguities(elementSequence);

        return {
            rule,
            typeName,
            assignments,
            actions,
            elementSequence,
            hasAmbiguities
        };
    }

    protected getTypeName(rule: AbstractParserRule): string {
        if (isParserRule(rule)) {
            if (rule.inferredType) {
                return rule.inferredType.name;
            }
            if (rule.returnType?.ref) {
                return getTypeName(rule.returnType.ref);
            }
            return isDataTypeRule(rule) ? (rule.dataType ?? rule.name) : rule.name;
        } else {
            if (rule.inferredType) {
                return rule.inferredType.name;
            }
            if (rule.returnType?.ref) {
                return getTypeName(rule.returnType.ref);
            }
            return rule.name;
        }
    }

    protected collectAssignments(rule: AbstractParserRule): AssignmentInfo[] {
        const assignments: AssignmentInfo[] = [];
        const visited = new Set<AbstractParserRule>();
        const definition = isParserRule(rule) ? rule.definition : rule.call;
        const positionTracker = new Map<string, number>();
        this.collectAssignmentsFromElement(definition, assignments, visited, { inArrayLoop: false, separator: null, loopProperty: null }, positionTracker);
        return assignments;
    }

    protected collectAssignmentsFromElement(
        element: AbstractElement,
        assignments: AssignmentInfo[],
        visited: Set<AbstractParserRule>,
        arrayContext: { inArrayLoop: boolean; separator: string | null; loopProperty: string | null },
        positionTracker: Map<string, number>
    ): void {
        if (isAssignment(element)) {
            const many = isArrayCardinality(element.cardinality);
            const position = positionTracker.get(element.feature) ?? 0;
            positionTracker.set(element.feature, position + 1);

            assignments.push({
                assignment: element,
                property: element.feature,
                operator: element.operator,
                optional: isOptionalCardinality(element.cardinality, element),
                many,
                terminalType: this.getTerminalType(element.terminal),
                separator: arrayContext.separator ?? undefined,
                isLoopHead: !arrayContext.inArrayLoop && many,
                isLoopTail: arrayContext.inArrayLoop,
                position
            });
        } else if (isGroup(element)) {
            if (isArrayCardinality(element.cardinality)) {
                const pattern = this.analyzeArrayPattern(element);
                const loopProperty = this.findAssignmentProperty(element);

                if (pattern.separator && loopProperty) {
                    for (const child of element.elements) {
                        this.collectAssignmentsFromElement(child, assignments, visited, {
                            inArrayLoop: true,
                            separator: pattern.separator,
                            loopProperty
                        }, positionTracker);
                    }
                } else {
                    for (const child of element.elements) {
                        this.collectAssignmentsFromElement(child, assignments, visited, arrayContext, positionTracker);
                    }
                }
            } else {
                for (const child of element.elements) {
                    this.collectAssignmentsFromElement(child, assignments, visited, arrayContext, positionTracker);
                }
            }
        } else if (isAlternatives(element)) {
            for (const alt of element.elements) {
                this.collectAssignmentsFromElement(alt, assignments, visited, arrayContext, positionTracker);
            }
        } else if (isRuleCall(element)) {
            const calledRule = element.rule.ref;
            if (isParserRule(calledRule) && !isDataTypeRule(calledRule) && !visited.has(calledRule)) {
                visited.add(calledRule);
                this.collectAssignmentsFromElement(calledRule.definition, assignments, visited, arrayContext, positionTracker);
            }
        }
    }

    protected analyzeArrayPattern(group: { elements: AbstractElement[]; cardinality?: '?' | '*' | '+' }): { separator: string | null } {
        const elements = group.elements;

        for (let i = 0; i < elements.length; i++) {
            const el = elements[i];
            if (isKeyword(el)) {
                if (i + 1 < elements.length && isAssignment(elements[i + 1])) {
                    return { separator: el.value };
                }
            }
        }

        return { separator: null };
    }

    protected findAssignmentProperty(element: AbstractElement): string | null {
        if (isAssignment(element)) {
            return element.feature;
        }
        if (isGroup(element) || isAlternatives(element)) {
            for (const child of element.elements) {
                const prop = this.findAssignmentProperty(child);
                if (prop) return prop;
            }
        }
        return null;
    }

    protected getTerminalType(element: AbstractElement): string | undefined {
        if (isKeyword(element)) {
            return 'string';
        } else if (isRuleCall(element)) {
            const rule = element.rule.ref;
            if (rule) {
                return getRuleType(rule);
            }
        } else if (isCrossReference(element)) {
            return 'reference';
        } else if (isTerminalRuleCall(element)) {
            const rule = element.rule.ref;
            if (rule) {
                return rule.type?.name ?? 'string';
            }
        }
        return undefined;
    }

    protected collectActions(rule: AbstractParserRule): ActionInfo[] {
        const actions: ActionInfo[] = [];
        if (!isParserRule(rule)) {
            return actions;
        }

        let precedingElements = 0;
        for (const element of streamAllContents(rule)) {
            if (isAction(element)) {
                const typeName = element.inferredType?.name ??
                    (element.type?.ref ? getTypeName(element.type.ref) : undefined);
                if (typeName) {
                    actions.push({
                        typeName,
                        feature: element.feature,
                        operator: element.operator,
                        precedingElements
                    });
                }
            }
            precedingElements++;
        }

        return actions;
    }

    protected analyzeElementSequence(element: AbstractElement): GrammarElementInfo[] {
        const sequence: GrammarElementInfo[] = [];
        this.addElementToSequence(element, sequence);
        return sequence;
    }

    protected addElementToSequence(element: AbstractElement, sequence: GrammarElementInfo[]): void {
        if (isKeyword(element)) {
            sequence.push({
                element,
                type: 'keyword',
                optional: isOptionalCardinality(element.cardinality),
                many: isArrayCardinality(element.cardinality)
            });
        } else if (isAssignment(element)) {
            sequence.push({
                element,
                type: 'assignment',
                optional: isOptionalCardinality(element.cardinality, element),
                many: isArrayCardinality(element.cardinality),
                property: element.feature,
                typeName: this.getTerminalType(element.terminal)
            });
        } else if (isRuleCall(element)) {
            const calledRule = element.rule.ref;
            sequence.push({
                element,
                type: 'rule-call',
                optional: isOptionalCardinality(element.cardinality),
                many: isArrayCardinality(element.cardinality),
                typeName: calledRule ? getRuleType(calledRule) : undefined
            });
        } else if (isCrossReference(element)) {
            sequence.push({
                element,
                type: 'cross-reference',
                optional: isOptionalCardinality(element.cardinality),
                many: isArrayCardinality(element.cardinality),
                typeName: element.type.ref?.name
            });
        } else if (isAction(element)) {
            const typeName = element.inferredType?.name ??
                (element.type?.ref ? getTypeName(element.type.ref) : undefined);
            sequence.push({
                element,
                type: 'action',
                optional: false,
                many: false,
                typeName,
                property: element.feature
            });
        } else if (isGroup(element)) {
            if (element.cardinality) {
                sequence.push({
                    element,
                    type: 'group',
                    optional: isOptionalCardinality(element.cardinality),
                    many: isArrayCardinality(element.cardinality)
                });
            } else {
                for (const child of element.elements) {
                    this.addElementToSequence(child, sequence);
                }
            }
        } else if (isAlternatives(element)) {
            sequence.push({
                element,
                type: 'alternatives',
                optional: isOptionalCardinality(element.cardinality),
                many: isArrayCardinality(element.cardinality)
            });
        }
    }

    protected detectAmbiguities(sequence: GrammarElementInfo[]): boolean {
        const alternatives = sequence.filter(e => e.type === 'alternatives');
        return alternatives.length > 0;
    }

    protected buildTypeToRuleMap(): Map<string, AbstractParserRule[]> {
        const result = this.analyze();
        return result.typeToRule;
    }

    getRuleInfo(rule: AbstractParserRule): RuleAnalysisInfo | undefined {
        const result = this.analyze();
        return result.ruleInfo.get(rule);
    }

    getRulesForType(type: string): AbstractParserRule[] {
        const result = this.analyze();
        return result.typeToRule.get(type) ?? [];
    }
}