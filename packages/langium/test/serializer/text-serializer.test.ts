/******************************************************************************
 * Copyright 2024 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { AstNode, CstNode } from '../../src/syntax-tree.js';
import type { AbstractRule } from '../../src/languages/generated/ast.js';
import type { ValueType } from '../../src/parser/value-converter.js';
import type { LangiumCoreServices } from '../../src/services.js';
import { DefaultValueConverter } from '../../src/parser/value-converter.js';
import { DefaultToStringValueConverterService, type ToStringValueConverterWithContext, type ToStringValueContext } from '../../src/serializer/to-string-converter.js';
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

    class EscapedIdToStringConverterService extends DefaultToStringValueConverterService {
        constructor(keywords: Set<string>) {
            super();
            const converter: ToStringValueConverterWithContext = (ctx) => {
                const strValue = String(ctx.value);
                if (keywords.has(strValue)) {
                    return `\`${strValue}\``;
                }
                return strValue;
            };
            this.registerWithContext('ID', converter);
            this.registerWithContext('EscapedId', converter);
        }
    }

    let services: LangiumCoreServices;
    let serializer: DefaultTextSerializer;
    let parse: ReturnType<typeof parseHelper<AstNode>>;
    let keywords: Set<string>;

    beforeAll(async () => {
        keywords = new Set(['model']);
        services = await createServicesForGrammar({
            grammar,
            module: {
                parser: {
                    ValueConverter: () => new EscapedIdValueConverter()
                },
                serializer: {
                    ToStringValueConverter: () => new EscapedIdToStringConverterService(keywords)
                }
            }
        });
        serializer = new DefaultTextSerializer(services);
        parse = parseHelper(services);
    });

    beforeEach(() => {
        clearDocuments(services);
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

    test('Serialize with ToStringValueConverter - keyword gets escaped', async () => {
        const result = await parse('model `model`');
        expect(result.parseResult.parserErrors).toHaveLength(0);

        const text = serializer.serialize(result.parseResult.value);
        expect(text).toBe('model `model`');
    });

    test('Serialize with ToStringValueConverter - non-keyword stays unescaped', async () => {
        const result = await parse('model sample');
        expect(result.parseResult.parserErrors).toHaveLength(0);

        const text = serializer.serialize(result.parseResult.value);
        expect(text).toBe('model sample');
    });

    test('ToStringValueContext contains expected properties', async () => {
        const result = await parse('model test');
        expect(result.parseResult.parserErrors).toHaveLength(0);

        let capturedContext: ToStringValueContext | undefined;
        const capturingConverter: ToStringValueConverterWithContext = (ctx) => {
            capturedContext = ctx;
            return String(ctx.value);
        };

        const servicesWithCapture = await createServicesForGrammar({
            grammar,
            module: {
                parser: {
                    ValueConverter: () => new EscapedIdValueConverter()
                },
                serializer: {
                    ToStringValueConverter: () => {
                        const svc = new DefaultToStringValueConverterService();
                        svc.registerWithContext('ID', capturingConverter);
                        svc.registerWithContext('RawId', capturingConverter);
                        svc.registerWithContext('EscapedId', capturingConverter);
                        return svc;
                    }
                }
            }
        });

        const capturingSerializer = new DefaultTextSerializer(servicesWithCapture);
        capturingSerializer.serialize(result.parseResult.value);

        expect(capturedContext).toMatchObject({
            node: expect.objectContaining({ $type: 'Model' }),
            property: 'name',
            value: 'test',
            rule: expect.objectContaining({ name: expect.stringMatching(/ID|RawId|EscapedId/) }),
            languageId: 'EscapedIdTest'
        });
    });
});

describe('TextSerializer2 Domain Model Grammar', async () => {

    const grammar = expandToStringLF`
        grammar DomainModelTest

        entry Domainmodel: (elements+=AbstractElement)*;

        AbstractElement: DataType | Entity | PackageDeclaration;

        DataType: 'datatype' name=ID;

        Entity: 'entity' name=ID ('extends' superType=[Entity:QualifiedName])? '{' (features+=Feature)* '}';

        Feature: (many?='many')? name=ID ':' type=[Type:QualifiedName];

        PackageDeclaration: 'package' name=ID '{' (elements+=AbstractElement)* '}';

        QualifiedName returns string: ID ('.' ID)*;

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

    async function expectRoundtrip(input: string) {
        const doc1 = await parse(input);
        await services.shared.workspace.DocumentBuilder.build([doc1]);
        expect(doc1.parseResult.lexerErrors).toHaveLength(0);
        expect(doc1.parseResult.parserErrors).toHaveLength(0);
        const ast1 = doc1.parseResult.value;

        const serialized = serializer.serialize(ast1);

        const doc2 = await parse(serialized);
        await services.shared.workspace.DocumentBuilder.build([doc2]);
        expect(doc2.parseResult.lexerErrors).toHaveLength(0);
        expect(doc2.parseResult.parserErrors).toHaveLength(0);
        const ast2 = doc2.parseResult.value;

        const json1 = jsonSerializer.serialize(ast1);
        const json2 = jsonSerializer.serialize(ast2);
        expect(json1).toBe(json2);
    }

    test('Serialize simple entity', () => {
        const stringType = { $type: 'DataType', name: 'String' };
        const feature = { $type: 'Feature', name: 'name', type: { $refText: 'String', ref: stringType } };
        const entity = { $type: 'Entity', name: 'Person', features: [feature] };
        const model = { $type: 'Domainmodel', elements: [stringType, entity] };

        const text = serializer.serialize(model as AstNode);

        expect(text).toBe('datatype String entity Person { name : String }');
    });

    test('Serialize entity with extends', () => {
        const parent = { $type: 'Entity', name: 'Parent', features: [] };
        const child = {
            $type: 'Entity',
            name: 'Child',
            superType: { $refText: 'Parent', ref: parent },
            features: []
        };
        const model = { $type: 'Domainmodel', elements: [parent, child] };

        const text = serializer.serialize(model as AstNode);

        expect(text).toBe('entity Parent { } entity Child extends Parent { }');
    });

    test('Serialize datatype', () => {
        const datatype = { $type: 'DataType', name: 'String' };
        const model = { $type: 'Domainmodel', elements: [datatype] };

        const text = serializer.serialize(model as AstNode);

        expect(text).toBe('datatype String');
    });

    test('Serialize mixed children (DataType + Entity)', () => {
        const stringType = { $type: 'DataType', name: 'String' };
        const intType = { $type: 'DataType', name: 'Int' };
        const feature = { $type: 'Feature', name: 'age', type: { $refText: 'Int', ref: intType } };
        const entity = { $type: 'Entity', name: 'Person', features: [feature] };
        const model = { $type: 'Domainmodel', elements: [stringType, intType, entity] };

        const text = serializer.serialize(model as AstNode);

        expect(text).toBe('datatype String datatype Int entity Person { age : Int }');
    });

    test('Serialize feature with many flag', () => {
        const itemType = { $type: 'DataType', name: 'Item' };
        const feature = { $type: 'Feature', many: true, name: 'items', type: { $refText: 'Item', ref: itemType } };
        const entity = { $type: 'Entity', name: 'Container', features: [feature] };
        const model = { $type: 'Domainmodel', elements: [itemType, entity] };

        const text = serializer.serialize(model as AstNode);

        expect(text).toBe('datatype Item entity Container { many items : Item }');
    });

    test('Serialize simple package', () => {
        const entity = { $type: 'Entity', name: 'MyEntity', features: [] };
        const pkg = { $type: 'PackageDeclaration', name: 'mypackage', elements: [entity] };
        const model = { $type: 'Domainmodel', elements: [pkg] };

        const text = serializer.serialize(model as AstNode);

        expect(text).toBe('package mypackage { entity MyEntity { } }');
    });

    test('Serialize nested packages', () => {
        const entity = { $type: 'Entity', name: 'E', features: [] };
        const innerPkg = { $type: 'PackageDeclaration', name: 'bar', elements: [entity] };
        const outerPkg = { $type: 'PackageDeclaration', name: 'foo', elements: [innerPkg] };
        const model = { $type: 'Domainmodel', elements: [outerPkg] };

        const text = serializer.serialize(model as AstNode);

        expect(text).toBe('package foo { package bar { entity E { } } }');
    });

    test('Roundtrip: Simple entity', async () => {
        const input = 'datatype String entity Person { name : String }';
        const doc = await parse(input);
        await services.shared.workspace.DocumentBuilder.build([doc]);
        expect(doc.parseResult.parserErrors).toHaveLength(0);

        const serialized = serializer.serialize(doc.parseResult.value);
        expect(serialized).toContain('datatype String');
        expect(serialized).toContain('entity Person');
    });

    test('Roundtrip: Entity with extends', async () => {
        await expectRoundtrip('entity Parent { } entity Child extends Parent { }');
    });

    test('Roundtrip: Datatype', async () => {
        await expectRoundtrip('datatype String');
    });

    test('Roundtrip: Nested packages', async () => {
        await expectRoundtrip('package foo { package bar { entity E { } } }');
    });
});

describe('TextSerializer2 QualifiedName DataType Rule', async () => {

    const grammar = expandToStringLF`
        grammar QualifiedNameTest

        entry Model: 'model' name=QualifiedName;

        QualifiedName returns string: ID ('.' ID)*;

        hidden terminal WS: /\\s+/;
        terminal ID: /[_a-zA-Z][\\w]*/;
    `;

    const services = await createServicesForGrammar({ grammar });
    const serializer = new DefaultTextSerializer(services);
    const parse = parseHelper<AstNode>(services);

    beforeEach(() => {
        clearDocuments(services);
    });

    test('Serialize simple qualified name', () => {
        const model = { $type: 'Model', name: 'simple' };
        expect(serializer.serialize(model as AstNode)).toBe('model simple');
    });

    test('Serialize two-part qualified name', () => {
        const model = { $type: 'Model', name: 'foo.bar' };
        expect(serializer.serialize(model as AstNode)).toBe('model foo.bar');
    });

    test('Serialize multi-part qualified name', () => {
        const model = { $type: 'Model', name: 'org.example.domain.MyClass' };
        expect(serializer.serialize(model as AstNode)).toBe('model org.example.domain.MyClass');
    });

    test('Roundtrip: Simple qualified name', async () => {
        const input = 'model simple';
        const doc = await parse(input);
        expect(doc.parseResult.parserErrors).toHaveLength(0);

        const serialized = serializer.serialize(doc.parseResult.value);
        expect(serialized).toBe(input);
    });

    test('Roundtrip: Multi-part qualified name', async () => {
        const input = 'model org.example.MyClass';
        const doc = await parse(input);
        expect(doc.parseResult.parserErrors).toHaveLength(0);

        const serialized = serializer.serialize(doc.parseResult.value);
        expect(serialized).toBe(input);
    });
});

describe('TextSerializer2 Statemachine Grammar', async () => {

    const grammar = expandToStringLF`
        grammar StatemachineTest

        entry Statemachine:
            'statemachine' name=ID
            ('events' events+=Event+)?
            ('commands' commands+=Command+)?
            'initialState' init=[State]
            states+=State*;

        Event: name=ID;

        Command: name=ID;

        State:
            'state' name=ID
            ('actions' '{' actions+=[Command]+ '}')?
            transitions+=Transition*
            'end';

        Transition: event=[Event] '=>' state=[State];

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

    async function expectRoundtrip(input: string) {
        const doc1 = await parse(input);
        await services.shared.workspace.DocumentBuilder.build([doc1]);
        expect(doc1.parseResult.lexerErrors).toHaveLength(0);
        expect(doc1.parseResult.parserErrors).toHaveLength(0);
        const ast1 = doc1.parseResult.value;

        const serialized = serializer.serialize(ast1);

        const doc2 = await parse(serialized);
        await services.shared.workspace.DocumentBuilder.build([doc2]);
        expect(doc2.parseResult.lexerErrors).toHaveLength(0);
        expect(doc2.parseResult.parserErrors).toHaveLength(0);
        const ast2 = doc2.parseResult.value;

        const json1 = jsonSerializer.serialize(ast1);
        const json2 = jsonSerializer.serialize(ast2);
        expect(json1).toBe(json2);
    }

    test('Serialize minimal statemachine (no events/commands)', () => {
        const state = { $type: 'State', name: 'idle', actions: [], transitions: [] };
        const sm = {
            $type: 'Statemachine',
            name: 'minimal',
            init: { $refText: 'idle', ref: state },
            states: [state]
        };

        const text = serializer.serialize(sm as AstNode);

        expect(text).toBe('statemachine minimal initialState idle state idle end');
    });

    test('Serialize statemachine with events block', () => {
        const event1 = { $type: 'Event', name: 'e1' };
        const event2 = { $type: 'Event', name: 'e2' };
        const state = { $type: 'State', name: 'idle', actions: [], transitions: [] };
        const sm = {
            $type: 'Statemachine',
            name: 'withEvents',
            events: [event1, event2],
            init: { $refText: 'idle', ref: state },
            states: [state]
        };

        const text = serializer.serialize(sm as AstNode);

        expect(text).toBe('statemachine withEvents events e1 e2 initialState idle state idle end');
    });

    test('Serialize state with actions', () => {
        const cmd1 = { $type: 'Command', name: 'lockDoor' };
        const state = {
            $type: 'State',
            name: 'locked',
            actions: [{ $refText: 'lockDoor', ref: cmd1 }],
            transitions: []
        };
        const sm = {
            $type: 'Statemachine',
            name: 'doorLock',
            commands: [cmd1],
            init: { $refText: 'locked', ref: state },
            states: [state]
        };

        const text = serializer.serialize(sm as AstNode);

        expect(text).toBe('statemachine doorLock commands lockDoor initialState locked state locked actions { lockDoor } end');
    });

    test('Roundtrip: Minimal statemachine', async () => {
        await expectRoundtrip('statemachine minimal initialState idle state idle end');
    });

    test('Roundtrip: Statemachine with events', async () => {
        await expectRoundtrip('statemachine withEvents events e1 e2 e3 initialState idle state idle end');
    });

    test('Roundtrip: State with actions', async () => {
        const input = 'statemachine withActions commands beep flash initialState active state active actions { beep flash } end';
        const doc = await parse(input);
        expect(doc.parseResult.parserErrors).toHaveLength(0);

        const serialized = serializer.serialize(doc.parseResult.value);
        expect(serialized).toContain('statemachine');
        expect(serialized).toContain('actions');
    });

    test('Roundtrip: Full statemachine', async () => {
        const input = 'statemachine doorLock events lock unlock commands lockDoor unlockDoor soundAlarm initialState unlocked state unlocked lock => locked end state locked actions { lockDoor soundAlarm } unlock => unlocked end';
        const doc = await parse(input);
        expect(doc.parseResult.parserErrors).toHaveLength(0);

        const serialized = serializer.serialize(doc.parseResult.value);
        expect(serialized).toContain('statemachine');
        expect(serialized).toContain('lock => locked');
    });
});

describe('TextSerializer2 Group+ Cardinality', async () => {

    const grammar = expandToStringLF`
        grammar GroupPlusTest

        entry Model: 'items' items+=Item+;

        Item: 'item' name=ID;

        hidden terminal WS: /\\s+/;
        terminal ID: /[_a-zA-Z][\\w]*/;
    `;

    const services = await createServicesForGrammar({ grammar });
    const serializer = new DefaultTextSerializer(services);
    const parse = parseHelper<AstNode>(services);

    beforeEach(() => {
        clearDocuments(services);
    });

    test('Serialize single item (minimum for + cardinality)', () => {
        const item = { $type: 'Item', name: 'only' };
        const model = { $type: 'Model', items: [item] };

        const text = serializer.serialize(model as AstNode);

        expect(text).toBe('items item only');
    });

    test('Serialize multiple items', () => {
        const item1 = { $type: 'Item', name: 'first' };
        const item2 = { $type: 'Item', name: 'second' };
        const item3 = { $type: 'Item', name: 'third' };
        const model = { $type: 'Model', items: [item1, item2, item3] };

        const text = serializer.serialize(model as AstNode);

        expect(text).toBe('items item first item second item third');
    });

    test('Roundtrip: Single item', async () => {
        const input = 'items item single';
        const doc = await parse(input);
        expect(doc.parseResult.parserErrors).toHaveLength(0);

        const serialized = serializer.serialize(doc.parseResult.value);
        expect(serialized).toBe(input);
    });

    test('Roundtrip: Multiple items', async () => {
        const input = 'items item a item b item c';
        const doc = await parse(input);
        expect(doc.parseResult.parserErrors).toHaveLength(0);

        const serialized = serializer.serialize(doc.parseResult.value);
        expect(serialized).toBe(input);
    });
});

describe('TextSerializer2 Optional Keyword Block', async () => {

    const grammar = expandToStringLF`
        grammar OptionalBlockTest

        entry Model:
            'model' name=ID
            ('options' '{' options+=Option+ '}')?
            ;

        Option: name=ID '=' value=ID;

        hidden terminal WS: /\\s+/;
        terminal ID: /[_a-zA-Z][\\w]*/;
    `;

    const services = await createServicesForGrammar({ grammar });
    const serializer = new DefaultTextSerializer(services);
    const parse = parseHelper<AstNode>(services);

    beforeEach(() => {
        clearDocuments(services);
    });

    test('Serialize without optional block', () => {
        const model = { $type: 'Model', name: 'simple' };

        const text = serializer.serialize(model as AstNode);

        expect(text).toBe('model simple');
    });

    test('Serialize with optional block', () => {
        const opt1 = { $type: 'Option', name: 'debug', value: 'true' };
        const opt2 = { $type: 'Option', name: 'mode', value: 'fast' };
        const model = { $type: 'Model', name: 'configured', options: [opt1, opt2] };

        const text = serializer.serialize(model as AstNode);

        expect(text).toContain('model configured');
        expect(text).toContain('options');
        expect(text).toContain('debug');
        expect(text).toContain('mode');
    });

    test('Roundtrip: Without optional block', async () => {
        const input = 'model simple';
        const doc = await parse(input);
        expect(doc.parseResult.parserErrors).toHaveLength(0);

        const serialized = serializer.serialize(doc.parseResult.value);
        expect(serialized).toBe(input);
    });

    test('Roundtrip: With optional block', async () => {
        const input = 'model configured options { debug = true mode = fast }';
        const doc = await parse(input);
        expect(doc.parseResult.parserErrors).toHaveLength(0);

        const serialized = serializer.serialize(doc.parseResult.value);
        expect(serialized).toContain('model configured');
        expect(serialized).toContain('options');
    });
});
