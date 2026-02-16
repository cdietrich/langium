/******************************************************************************
 * Copyright 2024 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { AstNode, CstNode } from '../../src/syntax-tree.js';
import type { Grammar, AbstractRule } from '../../src/languages/generated/ast.js';
import { isKeyword as isGrammarKeyword } from '../../src/languages/generated/ast.js';
import type { SerializeValueContext } from '../../src/serializer/text-serializer.js';
import type { ValueType } from '../../src/parser/value-converter.js';
import type { LangiumCoreServices } from '../../src/services.js';
import { streamAst } from '../../src/utils/ast-utils.js';
import { DefaultValueConverter } from '../../src/parser/value-converter.js';
import { createServicesForGrammar } from '../../src/grammar/internal-grammar-util.js';
import { expandToStringLF } from '../../src/generate/template-string.js';
import { parseHelper, clearDocuments } from '../../src/test/langium-test.js';
import { beforeEach, beforeAll, describe, expect, test } from 'vitest';
import { DefaultTextSerializer } from '../../src/serializer/text-serializer.js';

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

        TerminalEcho: 'term' value=INT INT;

        hidden terminal WS: /\s+/;
        terminal ID: /[_a-zA-Z][\w]*/;
        terminal INT returns number: /[0-9]+/;
        terminal STRING: /"[^"]*"/;
    `;

    const services = await createServicesForGrammar({ grammar });
    const serializer = new DefaultTextSerializer(services);

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

    test('Serialize unassigned terminal rule calls', () => {
        const echo = { $type: 'TerminalEcho', value: 3 };

        expect(() => serializer.serialize(echo as AstNode)).toThrow();
    });
});

describe('TextSerializer Roundtrip Tests', async () => {

    const grammar = expandToStringLF`
        grammar TextSerializerRoundtripTest

        entry Model: items+=Item (',' items+=Item)*;

        Item: 'item' name=ID ('ref' ref=[Item])?;

        hidden terminal WS: /\\s+/;
        terminal ID: /[_a-zA-Z][\\w]*/;
    `;

    const services = await createServicesForGrammar({ grammar });
    const serializer = new DefaultTextSerializer(services);
    const jsonSerializer = services.serializer.JsonSerializer;
    const parse = parseHelper<AstNode>(services);

    beforeEach(() => {
        clearDocuments(services);
    });

    async function expectRoundtrip(input: string, options?: { space?: string; useRefText?: boolean }) {
        const doc1 = await parse(input);
        await services.shared.workspace.DocumentBuilder.build([doc1]);
        expect(doc1.parseResult.lexerErrors).toHaveLength(0);
        expect(doc1.parseResult.parserErrors).toHaveLength(0);
        const ast1 = doc1.parseResult.value;

        const serialized = serializer.serialize(ast1, options);

        const doc2 = await parse(serialized);
        await services.shared.workspace.DocumentBuilder.build([doc2]);
        expect(doc2.parseResult.lexerErrors).toHaveLength(0);
        expect(doc2.parseResult.parserErrors).toHaveLength(0);
        const ast2 = doc2.parseResult.value;

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
        grammar UnionTypeArrayTest

        entry Container: 'model' name=ID '{' children+=Child* '}';
        Child: ChildA | ChildB;
        ChildA: 'a' name=ID;
        ChildB: 'b' name=ID;

        hidden terminal WS: /\\s+/;
        terminal ID: /[_a-zA-Z][\\w]*/;
    `;

    const services = await createServicesForGrammar({ grammar });
    const serializer = new DefaultTextSerializer(services);

    test('Serialize array with union type children', () => {
        const childA = { $type: 'ChildA', name: 'first' };
        const childB = { $type: 'ChildB', name: 'second' };
        const container = { $type: 'Container', name: 'MyModel', children: [childA, childB] };

        const text = serializer.serialize(container as AstNode);

        expect(text).toMatch(/model MyModel \{ a first/);
        expect(text).toMatch(/b second/);
    });
});

describe('TextSerializer Fragment Rules', async () => {

    const grammar = expandToStringLF`
        grammar FragmentRuleTest

        entry Model: Visibility 'model' name=ID '{' children+=Child* '}';
        Child: Visibility 'element' name=ID;
        fragment Visibility: visibility=('public'|'private'|'protected')?;

        hidden terminal WS: /\\s+/;
        terminal ID: /[_a-zA-Z][\\w]*/;
    `;

    const services = await createServicesForGrammar({ grammar });
    const serializer = new DefaultTextSerializer(services);

    test('Serialize model without visibility', () => {
        const model = { $type: 'Model', name: 'MyModel', children: [] };
        expect(serializer.serialize(model as AstNode)).toBe('model MyModel { }');
    });
});

describe('TextSerializer BooleanLiteral Pattern', async () => {

    const grammar = expandToStringLF`
        grammar BooleanLiteralTest

        entry Model: 'model' items+=LiteralWrapper*;

        LiteralWrapper: 'lit' value=BooleanLiteral;

        BooleanLiteral: value ?= 'true' | 'false';

        hidden terminal WS: /\\s+/;
    `;

    const services = await createServicesForGrammar({ grammar });
    const serializer = new DefaultTextSerializer(services);

    test('Serialize BooleanLiteral with true', () => {
        const boolTrue = { $type: 'BooleanLiteral', value: true };
        const wrapper = { $type: 'LiteralWrapper', value: boolTrue };
        const model = { $type: 'Model', items: [wrapper] };

        const text = serializer.serialize(model as AstNode);
        expect(text).toBe('model lit true');
    });
});

describe('TextSerializer BooleanLiteral Optional Pattern', async () => {

    const grammar = expandToStringLF`
        grammar BooleanLiteralOptionalTest

        entry Model: 'model' items+=LiteralWrapper*;

        LiteralWrapper: 'lit' value=BooleanLiteral?;

        BooleanLiteral: value ?= 'true'?;

        hidden terminal WS: /\\s+/;
    `;

    const services = await createServicesForGrammar({ grammar });
    const serializer = new DefaultTextSerializer(services);

    test('Serialize BooleanLiteral optional with true', () => {
        const boolTrue = { $type: 'BooleanLiteral', value: true };
        const wrapper = { $type: 'LiteralWrapper', value: boolTrue };
        const model = { $type: 'Model', items: [wrapper] };

        const text = serializer.serialize(model as AstNode);
        expect(text).toBe('model lit true');
    });

    test('Serialize BooleanLiteral optional without value', () => {
        const wrapper = { $type: 'LiteralWrapper' };
        const model = { $type: 'Model', items: [wrapper] };

        const text = serializer.serialize(model as AstNode);
        expect(text).toBe('model lit');
    });
});

describe('TextSerializer Infers Type Collision', async () => {

    const grammar = expandToStringLF`
        grammar InfersCollisionTest

        entry Model: 'model' items+=Item*;

        Item: 'item' name=ID type=ObjectType?;

        ObjectType: 'object' '<' '{' fields+=Field* '}' '>';

        SimplifiedObjectType infers ObjectType: '{' fields+=Field* '}';

        Field: name=ID ':' type=ID;

        hidden terminal WS: /\\s+/;
        terminal ID: /[_a-zA-Z][\\w]*/;
    `;

    const services = await createServicesForGrammar({ grammar });
    const serializer = new DefaultTextSerializer(services);

    test('Serialize ObjectType with full syntax', () => {
        const field = { $type: 'Field', name: 'foo', type: 'String' };
        const objType = { $type: 'ObjectType', fields: [field] };
        const item = { $type: 'Item', name: 'test', type: objType };
        const model = { $type: 'Model', items: [item] };

        const text = serializer.serialize(model as AstNode);
        expect(text).toBe('model item test object < { foo : String } >');
    });
});

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
    const serializer = new DefaultTextSerializer(services);

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

describe('TextSerializer Deeply Nested Optional Groups', async () => {

    const grammar = expandToStringLF`
        grammar DeeplyNestedTest

        entry DeeplyNested:
            'deep'
            ('level1' l1=ID
                ('level2' l2=ID
                    ('level3' l3=ID
                        ('level4' l4=ID)?
                    )?
                )?
            )?
            'end';

        hidden terminal WS: /\\s+/;
        terminal ID: /[_a-zA-Z][\\w]*/;
    `;

    const services = await createServicesForGrammar({ grammar });
    const serializer = new DefaultTextSerializer(services);

    test('Serialize deeply nested - all present', () => {
        const deep = {
            $type: 'DeeplyNested',
            l1: 'a', l2: 'b', l3: 'c', l4: 'd'
        };
        expect(serializer.serialize(deep as AstNode)).toBe('deep level1 a level2 b level3 c level4 d end');
    });

    test('Serialize deeply nested - level 3 only', () => {
        const deep = { $type: 'DeeplyNested', l1: 'a', l2: 'b', l3: 'c' };
        expect(serializer.serialize(deep as AstNode)).toBe('deep level1 a level2 b level3 c end');
    });

    test('Serialize deeply nested - level 2 only', () => {
        const deep = { $type: 'DeeplyNested', l1: 'a', l2: 'b' };
        expect(serializer.serialize(deep as AstNode)).toBe('deep level1 a level2 b end');
    });

    test('Serialize deeply nested - level 1 only', () => {
        const deep = { $type: 'DeeplyNested', l1: 'a' };
        expect(serializer.serialize(deep as AstNode)).toBe('deep level1 a end');
    });

    test('Serialize deeply nested - none', () => {
        const deep = { $type: 'DeeplyNested' };
        expect(serializer.serialize(deep as AstNode)).toBe('deep end');
    });
});

describe('TextSerializer Required List Pattern', async () => {

    const grammar = expandToStringLF`
        grammar RequiredListTest

        entry RequiredList: 'required' values+=ID (',' values+=ID)*;

        hidden terminal WS: /\\s+/;
        terminal ID: /[_a-zA-Z][\\w]*/;
    `;

    const services = await createServicesForGrammar({ grammar });
    const serializer = new DefaultTextSerializer(services);

    test('Serialize required list with single value', () => {
        const list = { $type: 'RequiredList', values: ['only'] };
        expect(serializer.serialize(list as AstNode)).toBe('required only');
    });

    test('Serialize required list with multiple values', () => {
        const list = { $type: 'RequiredList', values: ['a', 'b', 'c'] };
        expect(serializer.serialize(list as AstNode)).toBe('required a , b , c');
    });
});

describe('TextSerializer Boolean Assignments with false', async () => {

    const grammar = expandToStringLF`
        grammar BooleanValueTest

        entry Model: 'model' flag=BOOLEAN;

        terminal BOOLEAN returns boolean: /true|false/;
        hidden terminal WS: /\\s+/;
    `;

    const services = await createServicesForGrammar({ grammar });
    const serializer = new DefaultTextSerializer(services);

    test('Serialize boolean assignment with false value', () => {
        const model = { $type: 'Model', flag: false };
        expect(serializer.serialize(model as AstNode)).toBe('model false');
    });

    test('Serialize boolean assignment with true value', () => {
        const model = { $type: 'Model', flag: true };
        expect(serializer.serialize(model as AstNode)).toBe('model true');
    });
});

describe('TextSerializer Empty CrossRef Array', async () => {

    const grammar = expandToStringLF`
        grammar EmptyCrossRefTest

        entry Model: items+=Item*;

        Item: 'item' name=ID | EmptyArrayHolder;

        EmptyArrayHolder: 'holder' name=ID ('refs' refs+=[Item])*;

        hidden terminal WS: /\\s+/;
        terminal ID: /[_a-zA-Z][\\w]*/;
    `;

    const services = await createServicesForGrammar({ grammar });
    const serializer = new DefaultTextSerializer(services);

    test('Serialize empty cross-reference array', () => {
        const holder = { $type: 'EmptyArrayHolder', name: 'empty', refs: [] };
        const model = { $type: 'Model', items: [holder] };
        const text = serializer.serialize(model as AstNode);
        expect(text).toBe('holder empty');
    });
});

describe('TextSerializer serializeValue Hook', async () => {

    const grammar = expandToStringLF`
        grammar EscapedIdTest

        entry Model: 'model' name=ID;

        ID returns string: RawId | EscapedId;

        hidden terminal WS: /\\s+/;
        terminal RawId: /[_a-zA-Z][\\w]*/;
        terminal EscapedId: /\`[^\`]*\`/;
    `;

    class EscapedIdValueConverter extends DefaultValueConverter {
        protected override runConverter(rule: AbstractRule, input: string, _cstNode: CstNode): ValueType {
            if (rule.name === 'EscapedId') {
                return input.substring(1, input.length - 1);
            }
            return super.runConverter(rule, input, _cstNode);
        }
    }

    function getAllKeywords(grammarNode: Grammar): Set<string> {
        return streamAst(grammarNode)
            .filter(n => isGrammarKeyword(n))
            .map(n => (n as { value: string }).value)
            .toSet();
    }

    let services: LangiumCoreServices;
    let serializer: DefaultTextSerializer;
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
        serializer = new DefaultTextSerializer(services);
        parse = parseHelper(services);
        keywords = getAllKeywords(services.Grammar);
    });

    beforeEach(() => {
        clearDocuments(services);
    });

    function serializeWithEscaping(node: AstNode): string {
        return serializer.serialize(node, {
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

    test('serializeValue context contains expected properties', async () => {
        const result = await parse('model test');
        expect(result.parseResult.parserErrors).toHaveLength(0);

        let capturedContext: SerializeValueContext | undefined;
        serializer.serialize(result.parseResult.value, {
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
