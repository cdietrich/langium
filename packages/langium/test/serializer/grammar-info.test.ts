/******************************************************************************
 * Copyright 2024 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import { describe, expect, test } from 'vitest';
import { createServicesForGrammar } from '../../src/grammar/internal-grammar-util.js';
import { expandToStringLF } from '../../src/generate/index.js';
import type { ParserRule } from '../../src/languages/generated/ast.js';
import { isParserRule } from '../../src/languages/generated/ast.js';
import { buildGrammarInfo } from '../../src/serializer/grammar-info.js';

describe('GrammarInfo', () => {
    test('collects rules and assignments', async () => {
        const grammar = expandToStringLF`
            grammar GrammarInfoTest

            entry Model: name=ID;

            terminal ID: /[_a-zA-Z][\w]*/;
        `;

        const services = await createServicesForGrammar({ grammar });
        const info = buildGrammarInfo(services.Grammar);

        const modelRule = services.Grammar.rules.find((rule): rule is ParserRule => isParserRule(rule) && rule.name === 'Model');
        expect(modelRule).toBeDefined();
        if (!modelRule) {
            return;
        }

        const rulesForType = info.typeToRule.get('Model');
        expect(rulesForType?.has(modelRule)).toBe(true);

        const assignments = info.ruleAssignments.get(modelRule);
        expect(assignments?.length).toBe(1);
        expect(assignments?.[0].feature).toBe('name');

        if (assignments?.[0]) {
            expect(info.assignmentTerminal.get(assignments[0])).toBe('ID');
        }
    });
});
