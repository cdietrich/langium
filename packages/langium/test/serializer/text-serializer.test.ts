/******************************************************************************
 * Copyright 2024 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { AstNode } from 'langium';
import { createServicesForGrammar } from 'langium/grammar';
import { expandToStringLF } from 'langium/generate';
import { beforeEach, describe, expect, test } from 'vitest';
import { clearDocuments, parseHelper } from 'langium/test';

describe('TextSerializer', async () => {

    const grammar = expandToStringLF`
        grammar TextSerializerTest

        entry Model: items+=Item (',' items+=Item)*;

        Item: 'item' name=ID ('ref' ref=[Item])?;

        Flagged: 'flagged' flag?='flag' name=ID;

        Alt: 'alt' (name=ID | value=INT);

        DataRule: 'number' value=NumberRule;
        NumberRule returns number: INT;

        StringData: 'string' value=STRING;

        TerminalEcho: 'term' value=INT INT;

        Wrapper: 'wrap' Item;

        MultiRef: 'multiref' refs+=[Item] (',' refs+=[Item])*;

        NumberList: 'numbers' values+=INT (',' values+=INT)*;

        Pair: 'pair' values+=ID values+=ID;

        Unordered: 'unordered' (name=ID & value=INT);

        OptionalGroup: 'optional' ('extra' value=ID)?;

        Nested: 'nested' ('left' left=ID ('inner' inner=INT)?)? 'right' right=ID;

        AltGroup: 'altgroup' ('alpha' name=ID | 'beta' value=INT);

        UnorderedOptional: 'unorderedOpt' (name=ID & flag?='flag');

        Repeated: 'repeat' (values+=ID)*;

        hidden terminal WS: /\s+/;
        terminal ID: /[_a-zA-Z][\w]*/;
        terminal INT returns number: /[0-9]+/;
        terminal STRING: /"[^"]*"/;
    `;

    const services = await createServicesForGrammar({ grammar });
    const serializer = services.serializer.TextSerializer;

    beforeEach(() => {
        clearDocuments(services);
    });

    test('Serialize canonical token stream', () => {
        const itemA = { $type: 'Item', name: 'a' };
        const itemB = { $type: 'Item', name: 'b', ref: { $refText: 'a', ref: itemA } };
        const model = { $type: 'Model', items: [itemA, itemB] };

        const text = serializer.serialize(model as AstNode);

        expect(text).toBe('item a , item b ref a');
    });

    test('Serialize reference with name provider', () => {
        const itemA = { $type: 'Item', name: 'a' };
        const itemB = { $type: 'Item', name: 'b', ref: { $refText: 'fallback', ref: itemA } };
        const model = { $type: 'Model', items: [itemA, itemB] };

        const text = serializer.serialize(model as AstNode, { useRefText: false });

        expect(text).toBe('item a , item b ref a');
    });

    test('Serialize optional boolean assignments', () => {
        const flagged = { $type: 'Flagged', flag: true, name: 'a' };
        const unflagged = { $type: 'Flagged', name: 'b' };

        expect(serializer.serialize(flagged as AstNode)).toBe('flagged flag a');
        expect(serializer.serialize(unflagged as AstNode)).toBe('flagged b');
    });

    test('Serialize alternatives with primitive values', () => {
        const named = { $type: 'Alt', name: 'a' };
        const valued = { $type: 'Alt', value: 42 };

        expect(serializer.serialize(named as AstNode)).toBe('alt a');
        expect(serializer.serialize(valued as AstNode)).toBe('alt 42');
    });

    test('Serialize data type rules and strings', () => {
        const numeric = { $type: 'DataRule', value: 7 };
        const stringData = { $type: 'StringData', value: 'hello' };

        expect(serializer.serialize(numeric as AstNode)).toBe('number 7');
        expect(serializer.serialize(stringData as AstNode)).toBe('string "hello"');
    });

    test('Serialize unassigned terminal rule calls', () => {
        const echo = { $type: 'TerminalEcho', value: 3 };

        expect(serializer.serialize(echo as AstNode)).toBe('term 3 3');
    });

    test('Serialize unassigned rule calls', () => {
        const item = { $type: 'Item', name: 'a' };
        const wrapper = { $type: 'Wrapper', item };

        const text = serializer.serialize(wrapper as AstNode);

        expect(text).toBe('wrap item a');
    });

    test('Serialize multiple references with separators', () => {
        const itemA = { $type: 'Item', name: 'a' };
        const itemB = { $type: 'Item', name: 'b' };
        const itemC = { $type: 'Item', name: 'c' };
        const multiRef = {
            $type: 'MultiRef',
            refs: [
                { $refText: 'a', ref: itemA },
                { $refText: 'b', ref: itemB },
                { $refText: 'c', ref: itemC }
            ]
        };

        const text = serializer.serialize(multiRef as AstNode);

        expect(text).toBe('multiref a , b , c');
    });

    test('Serialize primitive lists with separators', () => {
        const numbers = { $type: 'NumberList', values: [1, 2, 3] };

        const text = serializer.serialize(numbers as AstNode);

        expect(text).toBe('numbers 1 , 2 , 3');
    });

    test('Serialize repeated assignments in a group', () => {
        const pair = { $type: 'Pair', values: ['first', 'second'] };

        const text = serializer.serialize(pair as AstNode);

        expect(text).toBe('pair first second');
    });

    test('Serialize unordered group assignments', () => {
        const unordered = { $type: 'Unordered', name: 'alpha', value: 5 };

        const text = serializer.serialize(unordered as AstNode);

        expect(text).toBe('unordered alpha 5');
    });

    test('Serialize optional groups', () => {
        const missing = { $type: 'OptionalGroup' };
        const present = { $type: 'OptionalGroup', value: 'x' };

        expect(serializer.serialize(missing as AstNode)).toBe('optional');
        expect(serializer.serialize(present as AstNode)).toBe('optional extra x');
    });

    test('Serialize nested optional groups', () => {
        const nested = { $type: 'Nested', left: 'alpha', inner: 3, right: 'omega' };
        const noLeft = { $type: 'Nested', right: 'omega' };

        expect(serializer.serialize(nested as AstNode)).toBe('nested left alpha inner 3 right omega');
        expect(serializer.serialize(noLeft as AstNode)).toBe('nested right omega');
    });

    test('Serialize alternatives containing groups', () => {
        const alpha = { $type: 'AltGroup', name: 'x' };
        const beta = { $type: 'AltGroup', value: 9 };

        expect(serializer.serialize(alpha as AstNode)).toBe('altgroup alpha x');
        expect(serializer.serialize(beta as AstNode)).toBe('altgroup beta 9');
    });

    test('Serialize unordered optional assignments', () => {
        const flagged = { $type: 'UnorderedOptional', name: 'n', flag: true };
        const unflagged = { $type: 'UnorderedOptional', name: 'n' };

        expect(serializer.serialize(flagged as AstNode)).toBe('unorderedOpt n flag');
        expect(serializer.serialize(unflagged as AstNode)).toBe('unorderedOpt n');
    });

    test('Serialize repeated group assignments', () => {
        const repeated = { $type: 'Repeated', values: ['a', 'b'] };
        const empty = { $type: 'Repeated', values: [] };

        expect(serializer.serialize(repeated as AstNode)).toBe('repeat a b');
        expect(serializer.serialize(empty as AstNode)).toBe('repeat');
    });
});

describe('TextSerializer Roundtrip Tests', async () => {

    const grammar = expandToStringLF`
        grammar TextSerializerTest

        entry Model: items+=Item (',' items+=Item)*;

        Item: 'item' name=ID ('ref' ref=[Item])?;

        hidden terminal WS: /\\s+/;
        terminal ID: /[_a-zA-Z][\\w]*/;
        terminal INT returns number: /[0-9]+/;
        terminal STRING: /"[^"]*"/;
    `;

    const services = await createServicesForGrammar({ grammar });
    const serializer = services.serializer.TextSerializer;
    const jsonSerializer = services.serializer.JsonSerializer;
    const parse = parseHelper<AstNode>(services);

    beforeEach(() => {
        clearDocuments(services);
    });

    /**
     * Roundtrip test helper: Parse text, serialize to text, parse again, compare ASTs via JSON
     */
    async function expectRoundtrip(input: string, options?: { space?: string; useRefText?: boolean }) {
        // Parse original text
        const doc1 = await parse(input);
        await services.shared.workspace.DocumentBuilder.build([doc1]);
        expect(doc1.parseResult.lexerErrors).toHaveLength(0);
        expect(doc1.parseResult.parserErrors).toHaveLength(0);
        const ast1 = doc1.parseResult.value;

        // Serialize to text
        const serialized = serializer.serialize(ast1, options);

        // Parse serialized text
        const doc2 = await parse(serialized);
        await services.shared.workspace.DocumentBuilder.build([doc2]);
        expect(doc2.parseResult.lexerErrors).toHaveLength(0);
        expect(doc2.parseResult.parserErrors).toHaveLength(0);
        const ast2 = doc2.parseResult.value;

        // Compare ASTs via JSON (ignoring $cstNode and other internal properties)
        const json1 = jsonSerializer.serialize(ast1);
        const json2 = jsonSerializer.serialize(ast2);
        expect(json1).toBe(json2);
    }

    test('Roundtrip: Basic model with items', async () => {
        await expectRoundtrip('item a , item b , item c');
    });

    test('Roundtrip: Model with cross-references', async () => {
        await expectRoundtrip('item a , item b ref a , item c ref b');
    });

    test('Roundtrip: Single item', async () => {
        await expectRoundtrip('item single');
    });

    test('Roundtrip: Item with reference', async () => {
        await expectRoundtrip('item first , item second ref first');
    });

    test('Roundtrip: Multiple items with chained references', async () => {
        await expectRoundtrip('item a , item b ref a , item c ref b , item d ref c');
    });

    test('Roundtrip: Many items', async () => {
        await expectRoundtrip('item one , item two , item three , item four , item five');
    });

    test('Roundtrip: Complex reference pattern', async () => {
        await expectRoundtrip('item x , item y ref x , item z , item w ref y');
    });

    test('Roundtrip: With custom space separator', async () => {
        await expectRoundtrip('item a , item b', { space: '  ' });
    });

    test('Roundtrip: With newline separator', async () => {
        await expectRoundtrip('item a , item b , item c', { space: '\n' });
    });
});
