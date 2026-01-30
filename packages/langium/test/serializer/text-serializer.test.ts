/******************************************************************************
 * Copyright 2024 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { AstNode, CstNode, Grammar, LangiumCoreServices } from 'langium';
import type { AbstractRule } from '../../src/languages/generated/ast.js';
import type { SerializeValueContext } from '../../src/serializer/text-serializer.js';
import type { ValueType } from '../../src/parser/value-converter.js';
import { AstUtils, DefaultValueConverter, GrammarAST } from 'langium';
import { createServicesForGrammar } from 'langium/grammar';
import { expandToStringLF } from 'langium/generate';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
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

    test('Serialize ?= operator with false value in group', () => {
        // When flag is explicitly false, it should behave like undefined
        // and not emit the keyword, allowing the group to continue
        const falseFlag = { $type: 'UnorderedOptional', name: 'n', flag: false };
        const trueFlag = { $type: 'UnorderedOptional', name: 'n', flag: true };
        const undefinedFlag = { $type: 'UnorderedOptional', name: 'n' };

        expect(serializer.serialize(falseFlag as AstNode)).toBe('unorderedOpt n');
        expect(serializer.serialize(trueFlag as AstNode)).toBe('unorderedOpt n flag');
        expect(serializer.serialize(undefinedFlag as AstNode)).toBe('unorderedOpt n');
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

describe('TextSerializer Union Type Arrays', async () => {

    const grammar = expandToStringLF`
        grammar UnionTypeTest

        entry Container: 'model' name=ID '{' children+=Child* '}';
        Child: ChildA | ChildB;
        ChildA: 'a' name=ID;
        ChildB: 'b' name=ID;

        hidden terminal WS: /\\s+/;
        terminal ID: /[_a-zA-Z][\\w]*/;
    `;

    const services = await createServicesForGrammar({ grammar });
    const serializer = services.serializer.TextSerializer;

    test('Serialize array with union type children', () => {
        const childA = { $type: 'ChildA', name: 'first' };
        const childB = { $type: 'ChildB', name: 'second' };
        const container = { $type: 'Container', name: 'MyModel', children: [childA, childB] };

        const text = serializer.serialize(container as AstNode);

        expect(text).toBe('model MyModel { a first b second }');
    });
});

describe('TextSerializer Fragment Rules', async () => {

    const grammar = expandToStringLF`
        grammar FragmentTest

        entry Model: Visibility 'model' name=ID '{' children+=Child* '}';
        Child: Visibility 'element' name=ID;
        fragment Visibility: visibility=('public'|'private'|'protected')?;

        hidden terminal WS: /\\s+/;
        terminal ID: /[_a-zA-Z][\\w]*/;
    `;

    const services = await createServicesForGrammar({ grammar });
    const serializer = services.serializer.TextSerializer;

    test('Serialize model with visibility fragment', () => {
        const model = { $type: 'Model', visibility: 'public', name: 'MyModel', children: [] };
        expect(serializer.serialize(model as AstNode)).toBe('public model MyModel { }');
    });

    test('Serialize model without visibility', () => {
        const model = { $type: 'Model', name: 'MyModel', children: [] };
        expect(serializer.serialize(model as AstNode)).toBe('model MyModel { }');
    });

    test('Serialize children with visibility fragment', () => {
        const child1 = { $type: 'Child', visibility: 'private', name: 'First' };
        const child2 = { $type: 'Child', name: 'Second' };
        const model = { $type: 'Model', visibility: 'public', name: 'MyModel', children: [child1, child2] };
        expect(serializer.serialize(model as AstNode)).toBe('public model MyModel { private element First element Second }');
    });
});

/**
 * Issue 1: BooleanLiteral with `value ?= 'true' | 'false'` pattern
 *
 * The pattern `value ?= 'true' | 'false'` is common in grammars but doesn't roundtrip.
 * When 'true' is matched, value becomes `true` (boolean).
 * When 'false' is matched, value stays `undefined` (or falsy), so serializer emits nothing.
 */
describe('TextSerializer BooleanLiteral Pattern Issue', async () => {

    const grammar = expandToStringLF`
        grammar BooleanLiteralTest

        entry Model: 'model' items+=LiteralWrapper*;

        LiteralWrapper: 'lit' value=BooleanLiteral;

        // This is the problematic pattern from lotse-terminals.langium
        BooleanLiteral: value ?= 'true' | 'false';

        hidden terminal WS: /\\s+/;
    `;

    const services = await createServicesForGrammar({ grammar });
    const serializer = services.serializer.TextSerializer;
    const jsonSerializer = services.serializer.JsonSerializer;
    const parse = parseHelper<AstNode>(services);

    beforeEach(() => {
        clearDocuments(services);
    });

    test('Serialize BooleanLiteral with true - WORKS', () => {
        const boolTrue = { $type: 'BooleanLiteral', value: true };
        const wrapper = { $type: 'LiteralWrapper', value: boolTrue };
        const model = { $type: 'Model', items: [wrapper] };

        const text = serializer.serialize(model as AstNode);
        expect(text).toBe('model lit true');
    });

    test('Debug grammar structure', () => {
        // Check what the grammar structure looks like for BooleanLiteral
        const grammar = services.Grammar;
        const boolRule = grammar.rules.find(r => r.name === 'BooleanLiteral') as { definition?: unknown };
        console.log('BooleanLiteral rule definition:', JSON.stringify(boolRule?.definition, (k, v) => {
            if (k === '$container' || k === '$cstNode' || k === '$document') return undefined;
            return v;
        }, 2));
    });

    test('Serialize BooleanLiteral with false - WORKS', () => {
        const boolFalse = { $type: 'BooleanLiteral', value: false };
        const wrapper = { $type: 'LiteralWrapper', value: boolFalse };
        const model = { $type: 'Model', items: [wrapper] };

        console.log('Serializing model:', JSON.stringify(model, null, 2));
        const text = serializer.serialize(model as AstNode);
        console.log('Serialized text:', text);
        expect(text).toBe('model lit false');
    });

    test('Roundtrip BooleanLiteral false - WORKS', async () => {
        const input = 'model lit false';
        const doc1 = await parse(input);
        await services.shared.workspace.DocumentBuilder.build([doc1]);
        expect(doc1.parseResult.parserErrors).toHaveLength(0);

        const serialized = serializer.serialize(doc1.parseResult.value);

        const doc2 = await parse(serialized);
        await services.shared.workspace.DocumentBuilder.build([doc2]);
        expect(doc2.parseResult.parserErrors).toHaveLength(0);

        const json1 = jsonSerializer.serialize(doc1.parseResult.value);
        const json2 = jsonSerializer.serialize(doc2.parseResult.value);
        expect(json1).toBe(json2);
    });
});

/**
 * Issue 2: Parser rule with `infers` that shares AST type with another rule
 *
 * When two parser rules produce the same AST type but with different syntax,
 * the serializer uses the first matching rule, which may have wrong syntax.
 */
describe('TextSerializer Infers Type Collision Issue', async () => {

    const grammar = expandToStringLF`
        grammar InfersCollisionTest

        entry Model: 'model' items+=Item*;

        Item: 'item' name=ID type=ObjectType?;

        // Full object type with 'object<{...}>' syntax
        ObjectType: 'object' '<' '{' fields+=Field* '}' '>';

        // Simplified object type with just '{...}' syntax - infers same AST type
        // This pattern is used in DiagnosticCodeObjectType infers ApiObjectType
        SimplifiedObjectType infers ObjectType: '{' fields+=Field* '}';

        Field: name=ID ':' type=ID;

        hidden terminal WS: /\\s+/;
        terminal ID: /[_a-zA-Z][\\w]*/;
    `;

    const services = await createServicesForGrammar({ grammar });
    const serializer = services.serializer.TextSerializer;
    const jsonSerializer = services.serializer.JsonSerializer;
    const parse = parseHelper<AstNode>(services);

    beforeEach(() => {
        clearDocuments(services);
    });

    test('Serialize ObjectType with full syntax - WORKS', () => {
        const field = { $type: 'Field', name: 'foo', type: 'String' };
        const objType = { $type: 'ObjectType', fields: [field] };
        const item = { $type: 'Item', name: 'test', type: objType };
        const model = { $type: 'Model', items: [item] };

        const text = serializer.serialize(model as AstNode);
        expect(text).toBe('model item test object < { foo : String } >');
    });

    test('Roundtrip SimplifiedObjectType - WORKS', async () => {
        // Parse using simplified syntax '{...}'
        const input = 'model item test object<{ foo : String }>';
        const doc1 = await parse(input);
        await services.shared.workspace.DocumentBuilder.build([doc1]);
        expect(doc1.parseResult.parserErrors).toHaveLength(0);

        // Serialize - now correctly uses SimplifiedObjectType rule from grammar context
        const serialized = serializer.serialize(doc1.parseResult.value);

        const doc2 = await parse(serialized);
        await services.shared.workspace.DocumentBuilder.build([doc2]);
        expect(doc2.parseResult.parserErrors).toHaveLength(0);

        const json1 = jsonSerializer.serialize(doc1.parseResult.value);
        const json2 = jsonSerializer.serialize(doc2.parseResult.value);
        expect(json1).toBe(json2);
    });
});

/**
 * Tests for union/alias rules - parser rules whose definition is just
 * alternatives of rule calls, e.g., `Child: ChildA | ChildB`.
 */
describe('TextSerializer Union/Alias Rules', async () => {

    const grammar = expandToStringLF`
        grammar UnionRuleTest

        entry Root: content=Content;
        Content: TypeA | TypeB;
        TypeA: 'type-a' name=ID;
        TypeB: 'type-b' value=INT;

        hidden terminal WS: /\\s+/;
        terminal ID: /[_a-zA-Z][\\w]*/;
        terminal INT returns number: /[0-9]+/;
    `;

    const services = await createServicesForGrammar({ grammar });
    const serializer = services.serializer.TextSerializer;

    test('Serialize through union rule - TypeA', () => {
        const typeA = { $type: 'TypeA', name: 'test' };
        const root = { $type: 'Root', content: typeA };

        expect(serializer.serialize(root as AstNode)).toBe('type-a test');
    });

    test('Serialize through union rule - TypeB', () => {
        const typeB = { $type: 'TypeB', value: 42 };
        const root = { $type: 'Root', content: typeB };

        expect(serializer.serialize(root as AstNode)).toBe('type-b 42');
    });
});

/**
 * Tests for serializeValue hook - custom serialization of terminal/datatype rule values.
 * Demonstrates escaping keywords with backticks using a custom ValueConverter and serializeValue hook.
 */
describe('TextSerializer serializeValue Hook', () => {

    const grammar = expandToStringLF`
        grammar EscapedIdTest

        entry Model: 'model' name=ID;

        ID returns string: RawId | EscapedId;

        hidden terminal WS: /\\s+/;
        terminal RawId: /[_a-zA-Z][\\w]*/;
        terminal EscapedId: /\`[^\`]*\`/;
    `;

    /**
     * Custom ValueConverter that strips backticks from EscapedId during parsing.
     */
    class EscapedIdValueConverter extends DefaultValueConverter {
        protected override runConverter(rule: AbstractRule, input: string, cstNode: CstNode): ValueType {
            if (rule.name === 'EscapedId') {
                // Strip backticks: `model` → model
                return input.substring(1, input.length - 1);
            }
            return super.runConverter(rule, input, cstNode);
        }
    }

    /**
     * Extracts all keywords from a grammar.
     */
    function getAllKeywords(grammarNode: Grammar): Set<string> {
        return AstUtils.streamAst(grammarNode)
            .filter(GrammarAST.isKeyword)
            .map(node => node.value)
            .toSet();
    }

    let services: LangiumCoreServices;
    let parse: ReturnType<typeof parseHelper<AstNode>>;
    let keywords: Set<string>;

    beforeAll(async () => {
        services = await createServicesForGrammar({
            grammar,
            module: {
                parser: {
                    ValueConverter: () => new EscapedIdValueConverter()
                }
            }
        });
        parse = parseHelper(services);
        keywords = getAllKeywords(services.Grammar);
    });

    beforeEach(() => {
        clearDocuments(services);
    });

    /**
     * Helper to serialize with keyword escaping using the serializeValue hook.
     */
    function serializeWithEscaping(node: AstNode): string {
        return services.serializer.TextSerializer.serialize(node, {
            serializeValue: (ctx: SerializeValueContext) => {
                if (ctx.ruleName === 'ID' || ctx.ruleName === 'RawId' || ctx.ruleName === 'EscapedId') {
                    const strValue = String(ctx.value);
                    if (keywords.has(strValue)) {
                        return `\`${strValue}\``;
                    }
                    return strValue;
                }
                return String(ctx.value);
            }
        });
    }

    test('Keywords are correctly extracted from grammar', () => {
        expect(keywords.has('model')).toBe(true);
    });

    test('Parse escaped keyword - backticks are stripped', async () => {
        const result = await parse('model `model`');
        expect(result.parseResult.parserErrors).toHaveLength(0);
        expect((result.parseResult.value as unknown as { name: string }).name).toBe('model');
    });

    test('Parse regular ID - no transformation', async () => {
        const result = await parse('model sample');
        expect(result.parseResult.parserErrors).toHaveLength(0);
        expect((result.parseResult.value as unknown as { name: string }).name).toBe('sample');
    });

    test('Serialize with serializeValue hook - keyword gets escaped', async () => {
        const result = await parse('model `model`');
        expect(result.parseResult.parserErrors).toHaveLength(0);

        const text = serializeWithEscaping(result.parseResult.value);
        expect(text).toBe('model `model`');
    });

    test('Serialize with serializeValue hook - non-keyword stays unescaped', async () => {
        const result = await parse('model sample');
        expect(result.parseResult.parserErrors).toHaveLength(0);

        const text = serializeWithEscaping(result.parseResult.value);
        expect(text).toBe('model sample');
    });

    test('Roundtrip escaped keyword', async () => {
        const input = 'model `model`';
        const result1 = await parse(input);
        expect(result1.parseResult.parserErrors).toHaveLength(0);

        const serialized = serializeWithEscaping(result1.parseResult.value);
        expect(serialized).toBe(input);

        // Verify it parses back to same AST
        const result2 = await parse(serialized);
        expect(result2.parseResult.parserErrors).toHaveLength(0);
        expect((result2.parseResult.value as unknown as { name: string }).name).toBe('model');
    });

    test('serializeValue context contains expected properties', async () => {
        const result = await parse('model test');
        expect(result.parseResult.parserErrors).toHaveLength(0);

        let capturedContext: SerializeValueContext | undefined;
        services.serializer.TextSerializer.serialize(result.parseResult.value, {
            serializeValue: (context: SerializeValueContext) => {
                capturedContext = context;
                return String(context.value);
            }
        });

        expect(capturedContext).toMatchObject({
            node: expect.objectContaining({ $type: 'Model' }),
            property: 'name',
            value: 'test',
            ruleName: expect.stringMatching(/ID|RawId|EscapedId/),
            languageId: 'EscapedIdTest'
        });
    });
});
