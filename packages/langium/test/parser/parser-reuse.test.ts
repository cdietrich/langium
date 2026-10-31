/******************************************************************************
 * Copyright 2026 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { AstNode, Grammar, LangiumCoreServices, ParseResult, ParserAnalysis, Reference } from 'langium';
import { createParserCacheModule, EmptyFileSystem, isReference, LangiumParserCache, URI } from 'langium';
import { createLangiumGrammarServices, createServicesForGrammar } from 'langium/grammar';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const langiumGrammarText = readFileSync(new URL('../../src/grammar/langium-grammar.langium', import.meta.url), 'utf8');
const langiumTypesText = readFileSync(new URL('../../src/grammar/langium-types.langium', import.meta.url), 'utf8');

function summarize(result: ParseResult): unknown {
    return {
        ast: JSON.stringify(result.value, (key, value) => {
            if (key === '$container' || key === '$document') return undefined;
            if (key === '$cstNode') return value ? `${value.offset}:${value.length}` : undefined;
            if (isReference(value)) return `ref:${value.$refText}`;
            return value;
        }),
        lexerErrors: result.lexerErrors.map(e => e.message),
        parserErrors: result.parserErrors.map(e => `${e.message}@${e.token.startOffset}`)
    };
}

describe('Precomputed parser analysis', () => {

    const inputs = [
        langiumGrammarText,
        langiumTypesText,
        // erroneous inputs exercise error recovery, which relies on the follow sets
        'grammar X entry Model: name=ID terminal ID: /[a-z]+/',
        'grammar X\nentry Model: (a+=A | b+=B)*;\nA: "a" name=;\nB: "b" ref=[A:ID] ) ;\nterminal ID: /x/;'
    ];

    test('round-trips through JSON without changes', () => {
        const regular = createLangiumGrammarServices(EmptyFileSystem).grammar;
        const analysis: ParserAnalysis = JSON.parse(JSON.stringify(regular.parser.LangiumParser.serializeAnalysis()));
        const precomputed = createLangiumGrammarServices(EmptyFileSystem, undefined, {
            parser: { ParserAnalysis: () => analysis }
        }).grammar;
        expect(precomputed.parser.LangiumParser.serializeAnalysis()).toEqual(analysis);
    });

    test('parses like a parser that records the grammar', () => {
        const regular = createLangiumGrammarServices(EmptyFileSystem).grammar;
        const analysis = regular.parser.LangiumParser.serializeAnalysis();
        const precomputed = createLangiumGrammarServices(EmptyFileSystem, undefined, {
            parser: { ParserAnalysis: () => analysis }
        }).grammar;
        for (const input of inputs) {
            expect(summarize(precomputed.parser.LangiumParser.parse(input)))
                .toEqual(summarize(regular.parser.LangiumParser.parse(input)));
        }
    });

    test('is ignored when it does not match the grammar', async () => {
        const otherAnalysis = createLangiumGrammarServices(EmptyFileSystem).grammar.parser.LangiumParser.serializeAnalysis();
        const services = await createServicesForGrammar({
            grammar: 'grammar Test entry Model: "model" name=ID; terminal ID: /[a-z]+/; hidden terminal WS: /\\s+/;',
            module: { parser: { ParserAnalysis: () => otherAnalysis } }
        });
        const result = services.parser.LangiumParser.parse('model abc');
        expect(result.parserErrors).toHaveLength(0);
        expect((result.value as AstNode & { name: string }).name).toBe('abc');
    });
});

describe('LangiumParserCache', () => {

    const grammarText = `
        grammar Test
        entry Model: (elements+=Element)*;
        Element: 'element' name=ID ('ref' ref=[Element:ID])?;
        terminal ID: /[_a-zA-Z][\\w_]*/;
        hidden terminal WS: /\\s+/;
    `;

    async function createContainers(count: number): Promise<LangiumCoreServices[]> {
        const cache = new LangiumParserCache();
        const first = await createServicesForGrammar({ grammar: grammarText, module: createParserCacheModule(cache) });
        const result = [first];
        for (let i = 1; i < count; i++) {
            // reuse the grammar object, the cache is keyed by it
            result.push(await createServicesForGrammar({ grammar: first.Grammar as Grammar, module: createParserCacheModule(cache) }));
        }
        return result;
    }

    test('shares one lexer and parser between containers', async () => {
        const [a, b] = await createContainers(2);
        expect(a.parser.Lexer).toBe(b.parser.Lexer);
        expect(a.parser.LangiumParser).not.toBe(b.parser.LangiumParser);
        // the views share the underlying Chevrotain parser
        const wrapper = (services: LangiumCoreServices) => (services.parser.LangiumParser as unknown as { wrapper: object }).wrapper;
        expect(wrapper(a)).toBe(wrapper(b));
    });

    test('resolves references in the workspace of the container that parsed the document', async () => {
        const [a, b] = await createContainers(2);
        const docA = a.shared.workspace.LangiumDocumentFactory.fromString('element x ref y', URI.parse('memory:/a.txt'));
        const targetA = a.shared.workspace.LangiumDocumentFactory.fromString('element y', URI.parse('memory:/a2.txt'));
        // parse in b between the two documents of a, which rebinds the shared parser to b
        const docB = b.shared.workspace.LangiumDocumentFactory.fromString('element x ref z', URI.parse('memory:/b.txt'));
        a.shared.workspace.LangiumDocuments.addDocument(docA);
        a.shared.workspace.LangiumDocuments.addDocument(targetA);
        b.shared.workspace.LangiumDocuments.addDocument(docB);
        await a.shared.workspace.DocumentBuilder.build([docA, targetA]);
        await b.shared.workspace.DocumentBuilder.build([docB]);

        type Element = AstNode & { name: string, ref?: Reference<Element> };
        const refA = (docA.parseResult.value as AstNode & { elements: Element[] }).elements[0].ref!;
        const refB = (docB.parseResult.value as AstNode & { elements: Element[] }).elements[0].ref!;
        expect(refA.ref?.name).toBe('y');
        expect(refB.ref).toBeUndefined();
        expect(refB.error?.message).toContain('z');
    });
});
