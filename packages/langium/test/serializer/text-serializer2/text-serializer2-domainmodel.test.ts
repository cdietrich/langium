/******************************************************************************
 * Copyright 2025 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { AstNode } from 'langium';
import { createServicesForGrammar } from 'langium/grammar';
import { expandToStringLF } from 'langium/generate';
import { beforeEach, describe, expect, test } from 'vitest';
import { clearDocuments, parseHelper } from 'langium/test';
import { TextSerializer2 } from '../../../src/serializer/text-serializer2.js';

/**
 * Tests for TextSerializer2 using DomainModel-style grammar patterns.
 *
 * This covers:
 * - QualifiedName data type rule (returns string with concatenation)
 * - Cross-references with qualified names: [Entity:QualifiedName]
 * - Nested packages
 * - many?= boolean flag pattern
 * - Mixed children (DataType + Entity)
 */
describe('TextSerializer2 DomainModel Grammar', async () => {

    const grammar = expandToStringLF`
        grammar DomainModelTest

        entry Domainmodel: (elements+=AbstractElement)*;

        AbstractElement: PackageDeclaration | Type;

        PackageDeclaration: 'package' name=QualifiedName '{' (elements+=AbstractElement)* '}';

        Type: DataType | Entity;

        DataType: 'datatype' name=ID;

        Entity: 'entity' name=ID ('extends' superType=[Entity:QualifiedName])? '{' (features+=Feature)* '}';

        Feature: (many?='many')? name=ID ':' type=[Type:QualifiedName];

        QualifiedName returns string: ID ('.' ID)*;

        hidden terminal WS: /\\s+/;
        terminal ID: /[_a-zA-Z][\\w]*/;
    `;

    const services = await createServicesForGrammar({ grammar });
    const serializer = new TextSerializer2(services);
    const jsonSerializer = services.serializer.JsonSerializer;
    const parse = parseHelper<AstNode>(services);

    beforeEach(() => {
        clearDocuments(services);
    });

    /**
     * Roundtrip test helper: Parse text, serialize to text, parse again, compare ASTs via JSON
     */
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

    // Basic serialization tests

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

    test('Serialize feature without many flag', () => {
        const itemType = { $type: 'DataType', name: 'Item' };
        const feature = { $type: 'Feature', name: 'item', type: { $refText: 'Item', ref: itemType } };
        const entity = { $type: 'Entity', name: 'Holder', features: [feature] };
        const model = { $type: 'Domainmodel', elements: [itemType, entity] };

        const text = serializer.serialize(model as AstNode);

        expect(text).toBe('datatype Item entity Holder { item : Item }');
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

    test('Serialize deeply nested packages (3 levels)', () => {
        const entity = { $type: 'Entity', name: 'DeepEntity', features: [] };
        const level3 = { $type: 'PackageDeclaration', name: 'level3', elements: [entity] };
        const level2 = { $type: 'PackageDeclaration', name: 'level2', elements: [level3] };
        const level1 = { $type: 'PackageDeclaration', name: 'level1', elements: [level2] };
        const model = { $type: 'Domainmodel', elements: [level1] };

        const text = serializer.serialize(model as AstNode);

        expect(text).toBe('package level1 { package level2 { package level3 { entity DeepEntity { } } } }');
    });

    test('Serialize qualified name reference', async () => {
        // Use roundtrip to test qualified name cross-references
        const input = 'entity Test { ref : foo.bar.MyType }';
        const doc = await parse(input);
        // Parser error expected since foo.bar.MyType doesn't exist, but serialization still works
        const text = serializer.serialize(doc.parseResult.value);
        expect(text).toBe(input);
    });

    test('Serialize entity with extends using qualified name', async () => {
        // Use roundtrip since we need proper cross-reference resolution
        const input = 'entity Parent { } entity Child extends Parent { }';
        const doc = await parse(input);
        await services.shared.workspace.DocumentBuilder.build([doc]);
        expect(doc.parseResult.parserErrors).toHaveLength(0);
        const text = serializer.serialize(doc.parseResult.value);
        expect(text).toBe(input);
    });

    test('Serialize entity with multiple features', async () => {
        // Use roundtrip to properly handle cross-references
        const input = 'entity Person { name : String age : Int many friends : Person }';
        const doc = await parse(input);
        const text = serializer.serialize(doc.parseResult.value);
        expect(text).toBe(input);
    });

    // Roundtrip tests

    test('Roundtrip: Simple entity', async () => {
        await expectRoundtrip('datatype String entity Person { name : String }');
    });

    test('Roundtrip: Entity with extends', async () => {
        await expectRoundtrip('entity Parent { } entity Child extends Parent { }');
    });

    test('Roundtrip: Datatype', async () => {
        await expectRoundtrip('datatype String');
    });

    test('Roundtrip: Mixed children', async () => {
        await expectRoundtrip('datatype String datatype Int entity Person { age : Int }');
    });

    test('Roundtrip: Feature with many flag', async () => {
        await expectRoundtrip('datatype Item entity Container { many items : Item }');
    });

    test('Roundtrip: Simple package', async () => {
        await expectRoundtrip('package mypackage { entity MyEntity { } }');
    });

    test('Roundtrip: Nested packages', async () => {
        await expectRoundtrip('package foo { package bar { entity E { } } }');
    });

    test('Roundtrip: Deeply nested packages (3 levels)', async () => {
        await expectRoundtrip('package level1 { package level2 { package level3 { entity DeepEntity { } } } }');
    });

    test('Roundtrip: Entity with multiple features', async () => {
        await expectRoundtrip('datatype String datatype Int entity Person { name : String age : Int many friends : Person }');
    });

    test('Roundtrip: Complex model', async () => {
        await expectRoundtrip('package org { package example { datatype String datatype Item entity Base { name : String } entity Derived extends Base { many items : Item } } }');
    });

    test('Roundtrip: Empty package', async () => {
        await expectRoundtrip('package empty { }');
    });

    test('Roundtrip: Entity without features', async () => {
        await expectRoundtrip('entity Empty { }');
    });

    test('Roundtrip: Multiple packages at top level', async () => {
        await expectRoundtrip('package a { entity A { } } package b { entity B { } }');
    });
});

/**
 * Tests for qualified name data type rule serialization.
 * Ensures that data type rules returning string with concatenation work correctly.
 */
describe('TextSerializer2 QualifiedName DataType Rule', async () => {

    const grammar = expandToStringLF`
        grammar QualifiedNameTest

        entry Model: 'model' name=QualifiedName;

        QualifiedName returns string: ID ('.' ID)*;

        hidden terminal WS: /\\s+/;
        terminal ID: /[_a-zA-Z][\\w]*/;
    `;

    const services = await createServicesForGrammar({ grammar });
    const serializer = new TextSerializer2(services);
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
