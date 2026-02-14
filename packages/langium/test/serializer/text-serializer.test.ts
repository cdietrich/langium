/******************************************************************************
 * Copyright 2024 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createServicesForGrammar } from '../../src/grammar/internal-grammar-util.js';
import { expandToStringLF } from '../../src/generate/index.js';
import { clearDocuments, parseHelper } from '../../src/test/langium-test.js';
import type { AstNode } from '../../src/syntax-tree.js';

describe('TextSerializer', () => {
    test('serializes list assignments with separators', async () => {
        const grammar = expandToStringLF`
            grammar TextSerializerTest

            entry Model: 'm' ':' names+=ID (',' names+=ID)*;

            terminal ID: /[_a-zA-Z][\w]*/;
            hidden terminal WS: /\s+/;
        `;

        const services = await createServicesForGrammar({ grammar });
        const parse = parseHelper<Model>(services);

        const document = await parse('m:a,b');
        const model = document.parseResult.value;

        const serialized = services.serializer.TextSerializer.serialize(model);
        expect(serialized).toBe('m:a,b');
    });

    test('inserts spacing between keywords and identifiers', async () => {
        const grammar = expandToStringLF`
            grammar TextSerializerSpacing

            entry Model: 'element' name=ID;

            terminal ID: /[_a-zA-Z][\w]*/;
            hidden terminal WS: /\s+/;
        `;

        const services = await createServicesForGrammar({ grammar });
        const model = { $type: 'Model', name: 'foo' } as AstNode & { name: string };
        const serialized = services.serializer.TextSerializer.serialize(model);
        expect(serialized).toBe('element foo');
    });

    test('roundtrip with alternatives, actions, and fragments', async () => {
        const grammar = expandToStringLF`
            grammar TextSerializerRoundtrip

            entry Model: items+=Item*;

            Item: Person | Employee | FragmentItem;

            Person: {Person} 'person' name=ID;
            Employee: {Employee} 'employee' name=ID 'dept' dept=ID;

            FragmentItem: NameFragment;
            fragment NameFragment: 'item' name=ID;

            terminal ID: /[_a-zA-Z][\w]*/;
            hidden terminal WS: /\s+/;
        `;

        const services = await createServicesForGrammar({ grammar });
        const parse = parseHelper<AstNode>(services);

        const input = 'person Alice employee Bob dept Sales item Widget';
        const document = await parse(input);
        const serialized = services.serializer.TextSerializer.serialize(document.parseResult.value);
        const reparsed = await parse(serialized);

        expect(normalizeAst(document.parseResult.value)).toEqual(normalizeAst(reparsed.parseResult.value));
    });

    test('roundtrip with cross-references', async () => {
        const grammar = expandToStringLF`
            grammar TextSerializerRefs

            entry Model: items+=Item*;

            Item: 'item' name=ID ('ref' ref=[Item])?;

            terminal ID: /[_a-zA-Z][\w]*/;
            hidden terminal WS: /\s+/;
        `;

        const services = await createServicesForGrammar({ grammar });
        const parse = parseHelper<AstNode>(services);

        const input = 'item a item b ref a';
        const document = await parse(input);
        await services.shared.workspace.DocumentBuilder.build([document]);

        const serialized = services.serializer.TextSerializer.serialize(document.parseResult.value);
        const reparsed = await parse(serialized);

        expect(normalizeAst(document.parseResult.value)).toEqual(normalizeAst(reparsed.parseResult.value));
    });

    test('serializes datatype rules', async () => {
        const grammar = expandToStringLF`
            grammar TextSerializerDatatype

            entry Model: 'use' name=QualifiedName;

            QualifiedName returns string: ID ('.' ID)*;

            terminal ID: /[_a-zA-Z][\w]*/;
            hidden terminal WS: /\s+/;
        `;

        const services = await createServicesForGrammar({ grammar });
        const parse = parseHelper<AstNode>(services);

        const document = await parse('use a.b.c');
        const serialized = services.serializer.TextSerializer.serialize(document.parseResult.value);

        expect(serialized).toBe('use a.b.c');
    });

    test('serializes union/alias rule calls', async () => {
        const grammar = expandToStringLF`
            grammar UnionRuleTest

            entry Root: content=Content;
            Content: TypeA | TypeB;
            TypeA: 'type-a' name=ID;
            TypeB: 'type-b' value=INT;

            terminal ID: /[_a-zA-Z][\w]*/;
            terminal INT returns number: /[0-9]+/;
            hidden terminal WS: /\s+/;
        `;

        const services = await createServicesForGrammar({ grammar });
        const serializer = services.serializer.TextSerializer;

        const typeA = { $type: 'TypeA', name: 'test' } as AstNode;
        const typeB = { $type: 'TypeB', value: 42 } as AstNode;

        expect(serializer.serialize(typeA)).toBe('type-a test');
        expect(serializer.serialize(typeB)).toBe('type-b 42');
    });

    test('serializes unordered optional assignments with false values', async () => {
        const grammar = expandToStringLF`
            grammar UnorderedOptionalTest

            entry Model: 'unorderedOpt' (name=ID & flag?='flag');

            terminal ID: /[_a-zA-Z][\w]*/;
            hidden terminal WS: /\s+/;
        `;

        const services = await createServicesForGrammar({ grammar });
        const serializer = services.serializer.TextSerializer;

        const flagged = { $type: 'Model', name: 'n', flag: true } as AstNode & { name: string; flag?: boolean };
        const unflagged = { $type: 'Model', name: 'n', flag: false } as AstNode & { name: string; flag?: boolean };

        expect(serializer.serialize(flagged)).toBe('unorderedOpt n flag');
        expect(serializer.serialize(unflagged)).toBe('unorderedOpt n');
    });

    test('serializes deeply nested optional groups', async () => {
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

            terminal ID: /[_a-zA-Z][\w]*/;
            hidden terminal WS: /\s+/;
        `;

        const services = await createServicesForGrammar({ grammar });
        const serializer = services.serializer.TextSerializer;

        const all = { $type: 'DeeplyNested', l1: 'a', l2: 'b', l3: 'c', l4: 'd' } as AstNode;
        const partial = { $type: 'DeeplyNested', l1: 'a', l2: 'b' } as AstNode;
        const none = { $type: 'DeeplyNested' } as AstNode;

        expect(serializer.serialize(all)).toBe('deep level1 a level2 b level3 c level4 d end');
        expect(serializer.serialize(partial)).toBe('deep level1 a level2 b end');
        expect(serializer.serialize(none)).toBe('deep end');
    });

    test('serializes empty cross-reference arrays', async () => {
        const grammar = expandToStringLF`
            grammar EmptyCrossRefTest

            entry Model: items+=Item*;

            Item: 'item' name=ID | EmptyArrayHolder;
            EmptyArrayHolder: 'holder' name=ID ('refs' refs+=[Item])*;

            terminal ID: /[_a-zA-Z][\w]*/;
            hidden terminal WS: /\s+/;
        `;

        const services = await createServicesForGrammar({ grammar });
        const serializer = services.serializer.TextSerializer;

        const holder = { $type: 'EmptyArrayHolder', name: 'empty', refs: [] } as AstNode & { refs: unknown[] };
        expect(serializer.serialize(holder)).toBe('holder empty');
    });

    test('serializes boolean terminal assignments with false', async () => {
        const grammar = expandToStringLF`
            grammar BooleanValueTest

            entry Model: 'model' flag=BOOLEAN;

            terminal BOOLEAN returns boolean: /true|false/;
            hidden terminal WS: /\s+/;
        `;

        const services = await createServicesForGrammar({ grammar });
        const serializer = services.serializer.TextSerializer;

        const model = { $type: 'Model', flag: false } as AstNode & { flag: boolean };
        expect(serializer.serialize(model)).toBe('model false');
    });

    test('roundtrip union/alias rule calls', async () => {
        const grammar = expandToStringLF`
            grammar UnionRuleRoundtrip

            entry Root: content=Content;
            Content: TypeA | TypeB;
            TypeA: 'type-a' name=ID;
            TypeB: 'type-b' value=INT;

            terminal ID: /[_a-zA-Z][\w]*/;
            terminal INT returns number: /[0-9]+/;
            hidden terminal WS: /\s+/;
        `;

        const services = await createServicesForGrammar({ grammar });
        const parse = parseHelper<AstNode>(services);

        const input = 'type-a test';
        const document = await parse(input);
        const serialized = services.serializer.TextSerializer.serialize(document.parseResult.value);
        const reparsed = await parse(serialized);

        expect(normalizeAst(document.parseResult.value)).toEqual(normalizeAst(reparsed.parseResult.value));
    });

    test('roundtrip unordered optional assignments with false values', async () => {
        const grammar = expandToStringLF`
            grammar UnorderedOptionalRoundtrip

            entry Model: 'unorderedOpt' (name=ID & flag?='flag');

            terminal ID: /[_a-zA-Z][\w]*/;
            hidden terminal WS: /\s+/;
        `;

        const services = await createServicesForGrammar({ grammar });
        const parse = parseHelper<AstNode>(services);

        const input = 'unorderedOpt n';
        const document = await parse(input);
        const serialized = services.serializer.TextSerializer.serialize(document.parseResult.value);
        const reparsed = await parse(serialized);

        expect(normalizeAst(document.parseResult.value)).toEqual(normalizeAst(reparsed.parseResult.value));
    });

    test('roundtrip deeply nested optional groups', async () => {
        const grammar = expandToStringLF`
            grammar DeeplyNestedRoundtrip

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

            terminal ID: /[_a-zA-Z][\w]*/;
            hidden terminal WS: /\s+/;
        `;

        const services = await createServicesForGrammar({ grammar });
        const parse = parseHelper<AstNode>(services);

        const input = 'deep level1 a level2 b end';
        const document = await parse(input);
        const serialized = services.serializer.TextSerializer.serialize(document.parseResult.value);
        const reparsed = await parse(serialized);

        expect(normalizeAst(document.parseResult.value)).toEqual(normalizeAst(reparsed.parseResult.value));
    });

    test('roundtrip empty cross-reference arrays', async () => {
        const grammar = expandToStringLF`
            grammar EmptyCrossRefRoundtrip

            entry Model: holders+=EmptyArrayHolder+;

            EmptyArrayHolder: 'holder' name=ID ('refs' refs+=[EmptyArrayHolder])*;
            terminal ID: /[_a-zA-Z][\w]*/;
            hidden terminal WS: /\s+/;
        `;

        const services = await createServicesForGrammar({ grammar });
        const parse = parseHelper<AstNode>(services);

        const input = 'holder e';
        const document = await parse(input);
        await services.shared.workspace.DocumentBuilder.build([document]);
        expect(document.parseResult.parserErrors).toHaveLength(0);
        const serialized = services.serializer.TextSerializer.serialize(document.parseResult.value);
        const reparsed = await parse(serialized);
        expect(reparsed.parseResult.parserErrors).toHaveLength(0);

        expect(normalizeAst(document.parseResult.value)).toEqual(normalizeAst(reparsed.parseResult.value));
    });

    test('roundtrip boolean terminal assignments with false', async () => {
        const grammar = expandToStringLF`
            grammar BooleanValueRoundtrip

            entry Model: 'model' flag=BOOLEAN;

            terminal BOOLEAN returns boolean: /true|false/;
            hidden terminal WS: /\s+/;
        `;

        const services = await createServicesForGrammar({ grammar });
        const parse = parseHelper<AstNode>(services);

        const input = 'model false';
        const document = await parse(input);
        const serialized = services.serializer.TextSerializer.serialize(document.parseResult.value);
        const reparsed = await parse(serialized);

        expect(normalizeAst(document.parseResult.value)).toEqual(normalizeAst(reparsed.parseResult.value));
    });

    test('roundtrip uses inferred rule when multiple rules share a type', async () => {
        const grammar = expandToStringLF`
            grammar InfersCollisionTest

            entry Model: 'model' items+=Item+;

            Item: 'item' name=ID type=ObjectType?;

            ObjectType: FullObjectType | SimplifiedObjectType;

            FullObjectType: 'object' '<' '{' fields+=Field* '}' '>';

            SimplifiedObjectType infers ObjectType: '{' fields+=Field* '}';

            Field: name=ID ':' type=ID;

            terminal ID: /[_a-zA-Z][\w]*/;
            hidden terminal WS: /\s+/;
        `;

        const services = await createServicesForGrammar({ grammar });
        const parse = parseHelper<AstNode>(services);

        const input = 'model item t { f : S }';
        const document = await parse(input);
        await services.shared.workspace.DocumentBuilder.build([document]);
        expect(document.parseResult.parserErrors).toHaveLength(0);

        const serialized = services.serializer.TextSerializer.serialize(document.parseResult.value);
        const reparsed = await parse(serialized);

        expect(serialized).not.toContain('object');
        expect(normalizeAst(document.parseResult.value)).toEqual(normalizeAst(reparsed.parseResult.value));
    });
});

describe('TextSerializer Statemachine Grammar', () => {
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

        hidden terminal WS: /[ \t]+/;
        terminal ID: /[_a-zA-Z][_a-zA-Z0-9]*/;
    `;

    let services: Awaited<ReturnType<typeof createServicesForGrammar>>;
    let parse: ReturnType<typeof parseHelper<AstNode>>;

    beforeAll(async () => {
        services = await createServicesForGrammar({ grammar });
        parse = parseHelper<AstNode>(services);
    });

    beforeEach(() => {
        clearDocuments(services);
    });

    async function expectRoundtrip(input: string) {
        const doc1 = await parse(input);
        await services.shared.workspace.DocumentBuilder.build([doc1]);
        expect(doc1.parseResult.parserErrors).toHaveLength(0);

        const serialized = services.serializer.TextSerializer.serialize(doc1.parseResult.value);

        const doc2 = await parse(serialized);
        await services.shared.workspace.DocumentBuilder.build([doc2]);
        expect(doc2.parseResult.lexerErrors).toHaveLength(0);
        expect(doc2.parseResult.parserErrors).toHaveLength(0);

        expect(normalizeAst(doc1.parseResult.value)).toEqual(normalizeAst(doc2.parseResult.value));
    }

    test('serializes minimal statemachine (no events/commands)', () => {
        const state = { $type: 'State', name: 'idle', actions: [], transitions: [] };
        const sm = {
            $type: 'Statemachine',
            name: 'minimal',
            init: { $refText: 'idle', ref: state },
            states: [state]
        };

        const text = services.serializer.TextSerializer.serialize(sm as AstNode);

        expect(text).toBe('statemachine minimal initialState idle state idle end');
    });

    test('serializes statemachine with events block', () => {
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

        const text = services.serializer.TextSerializer.serialize(sm as AstNode);

        expect(text).toBe('statemachine withEvents events e1 e2 initialState idle state idle end');
    });

    test('serializes statemachine with commands block', () => {
        const cmd1 = { $type: 'Command', name: 'cmd1' };
        const cmd2 = { $type: 'Command', name: 'cmd2' };
        const state = { $type: 'State', name: 'idle', actions: [], transitions: [] };
        const sm = {
            $type: 'Statemachine',
            name: 'withCommands',
            commands: [cmd1, cmd2],
            init: { $refText: 'idle', ref: state },
            states: [state]
        };

        const text = services.serializer.TextSerializer.serialize(sm as AstNode);

        expect(text).toBe('statemachine withCommands commands cmd1 cmd2 initialState idle state idle end');
    });

    test('serializes statemachine with events and commands', () => {
        const event = { $type: 'Event', name: 'buttonPress' };
        const cmd = { $type: 'Command', name: 'beep' };
        const state = { $type: 'State', name: 'idle', actions: [], transitions: [] };
        const sm = {
            $type: 'Statemachine',
            name: 'full',
            events: [event],
            commands: [cmd],
            init: { $refText: 'idle', ref: state },
            states: [state]
        };

        const text = services.serializer.TextSerializer.serialize(sm as AstNode);

        expect(text).toBe('statemachine full events buttonPress commands beep initialState idle state idle end');
    });

    test('serializes state with actions', () => {
        const cmd1 = { $type: 'Command', name: 'lockDoor' };
        const cmd2 = { $type: 'Command', name: 'soundAlarm' };
        const state = {
            $type: 'State',
            name: 'locked',
            actions: [
                { $refText: 'lockDoor', ref: cmd1 },
                { $refText: 'soundAlarm', ref: cmd2 }
            ],
            transitions: []
        };
        const sm = {
            $type: 'Statemachine',
            name: 'doorLock',
            commands: [cmd1, cmd2],
            init: { $refText: 'locked', ref: state },
            states: [state]
        };

        const text = services.serializer.TextSerializer.serialize(sm as AstNode);

        expect(text).toBe('statemachine doorLock commands lockDoor soundAlarm initialState locked state locked actions{lockDoor soundAlarm}end');
    });

    test('serializes state with single action', () => {
        const cmd = { $type: 'Command', name: 'notify' };
        const state = {
            $type: 'State',
            name: 'active',
            actions: [{ $refText: 'notify', ref: cmd }],
            transitions: []
        };
        const sm = {
            $type: 'Statemachine',
            name: 'notifier',
            commands: [cmd],
            init: { $refText: 'active', ref: state },
            states: [state]
        };

        const text = services.serializer.TextSerializer.serialize(sm as AstNode);

        expect(text).toBe('statemachine notifier commands notify initialState active state active actions{notify}end');
    });

    test('serializes transitions', () => {
        const event = { $type: 'Event', name: 'start' };
        const idleState = { $type: 'State', name: 'idle', actions: [], transitions: [] as unknown[] };
        const runningState = { $type: 'State', name: 'running', actions: [], transitions: [] };

        idleState.transitions = [{
            $type: 'Transition',
            event: { $refText: 'start', ref: event },
            state: { $refText: 'running', ref: runningState }
        }];

        const sm = {
            $type: 'Statemachine',
            name: 'runner',
            events: [event],
            init: { $refText: 'idle', ref: idleState },
            states: [idleState, runningState]
        };

        const text = services.serializer.TextSerializer.serialize(sm as AstNode);

        expect(text).toBe('statemachine runner events start initialState idle state idle start=>running end state running end');
    });

    test('serializes state with multiple transitions', () => {
        const startEvent = { $type: 'Event', name: 'start' };
        const resetEvent = { $type: 'Event', name: 'reset' };
        const idleState = { $type: 'State', name: 'idle', actions: [], transitions: [] as unknown[] };
        const runningState = { $type: 'State', name: 'running', actions: [], transitions: [] as unknown[] };

        idleState.transitions = [{
            $type: 'Transition',
            event: { $refText: 'start', ref: startEvent },
            state: { $refText: 'running', ref: runningState }
        }];

        runningState.transitions = [
            {
                $type: 'Transition',
                event: { $refText: 'reset', ref: resetEvent },
                state: { $refText: 'idle', ref: idleState }
            },
            {
                $type: 'Transition',
                event: { $refText: 'start', ref: startEvent },
                state: { $refText: 'running', ref: runningState }
            }
        ];

        const sm = {
            $type: 'Statemachine',
            name: 'toggle',
            events: [startEvent, resetEvent],
            init: { $refText: 'idle', ref: idleState },
            states: [idleState, runningState]
        };

        const text = services.serializer.TextSerializer.serialize(sm as AstNode);

        expect(text).toBe('statemachine toggle events start reset initialState idle state idle start=>running end state running reset=>idle start=>running end');
    });

    test('serializes multiple states', () => {
        const state1 = { $type: 'State', name: 'state1', actions: [], transitions: [] };
        const state2 = { $type: 'State', name: 'state2', actions: [], transitions: [] };
        const state3 = { $type: 'State', name: 'state3', actions: [], transitions: [] };
        const sm = {
            $type: 'Statemachine',
            name: 'multi',
            init: { $refText: 'state1', ref: state1 },
            states: [state1, state2, state3]
        };

        const text = services.serializer.TextSerializer.serialize(sm as AstNode);

        expect(text).toBe('statemachine multi initialState state1 state state1 end state state2 end state state3 end');
    });

    test('roundtrip minimal statemachine', async () => {
        await expectRoundtrip('statemachine minimal initialState idle state idle end');
    });

    test('roundtrip statemachine with events', async () => {
        await expectRoundtrip('statemachine withEvents events e1 e2 e3 initialState idle state idle end');
    });

    test('roundtrip statemachine with commands', async () => {
        await expectRoundtrip('statemachine withCommands commands c1 c2 initialState idle state idle end');
    });

    test('roundtrip statemachine with events and commands', async () => {
        await expectRoundtrip('statemachine full events e1 e2 commands c1 c2 initialState idle state idle end');
    });

    test('roundtrip state with actions', async () => {
        await expectRoundtrip('statemachine withActions commands beep flash initialState active state active actions { beep flash } end');
    });

    test('roundtrip state with single action', async () => {
        await expectRoundtrip('statemachine single commands notify initialState active state active actions { notify } end');
    });

    test('roundtrip transitions', async () => {
        await expectRoundtrip('statemachine runner events start stop initialState idle state idle start => running end state running stop => idle end');
    });

    test('roundtrip multiple transitions in one state', async () => {
        await expectRoundtrip('statemachine complex events a b c initialState s1 state s1 a => s2 b => s3 end state s2 end state s3 c => s1 end');
    });

    test('roundtrip full statemachine', async () => {
        await expectRoundtrip('statemachine doorLock events lock unlock commands lockDoor unlockDoor soundAlarm initialState unlocked state unlocked lock => locked end state locked actions { lockDoor soundAlarm } unlock => unlocked end');
    });

    test('roundtrip single event (+ cardinality edge case)', async () => {
        await expectRoundtrip('statemachine oneEvent events singleEvent initialState idle state idle end');
    });

    test('roundtrip single command (+ cardinality edge case)', async () => {
        await expectRoundtrip('statemachine oneCmd commands singleCommand initialState idle state idle end');
    });
});

describe('TextSerializer Group+ Cardinality', () => {
    const grammar = expandToStringLF`
        grammar GroupPlusTest

        entry Model: 'items' items+=Item+;

        Item: 'item' name=ID;

        hidden terminal WS: /[ \t]+/;
        terminal ID: /[_a-zA-Z][_a-zA-Z0-9]*/;
    `;

    let services: Awaited<ReturnType<typeof createServicesForGrammar>>;
    let parse: ReturnType<typeof parseHelper<AstNode>>;

    beforeAll(async () => {
        services = await createServicesForGrammar({ grammar });
        parse = parseHelper<AstNode>(services);
    });

    beforeEach(() => {
        clearDocuments(services);
    });

    test('serializes single item (minimum for + cardinality)', () => {
        const item = { $type: 'Item', name: 'only' };
        const model = { $type: 'Model', items: [item] };

        const text = services.serializer.TextSerializer.serialize(model as AstNode);

        expect(text).toBe('items item only');
    });

    test('serializes multiple items', () => {
        const item1 = { $type: 'Item', name: 'first' };
        const item2 = { $type: 'Item', name: 'second' };
        const item3 = { $type: 'Item', name: 'third' };
        const model = { $type: 'Model', items: [item1, item2, item3] };

        const text = services.serializer.TextSerializer.serialize(model as AstNode);

        expect(text).toBe('items item first item second item third');
    });

    test('roundtrip single item', async () => {
        const input = 'items item single';
        const doc = await parse(input);
        expect(doc.parseResult.parserErrors).toHaveLength(0);

        const serialized = services.serializer.TextSerializer.serialize(doc.parseResult.value);
        const reparsed = await parse(serialized);

        expect(normalizeAst(doc.parseResult.value)).toEqual(normalizeAst(reparsed.parseResult.value));
    });

    test('roundtrip multiple items', async () => {
        const input = 'items item a item b item c';
        const doc = await parse(input);
        expect(doc.parseResult.parserErrors).toHaveLength(0);

        const serialized = services.serializer.TextSerializer.serialize(doc.parseResult.value);
        const reparsed = await parse(serialized);

        expect(normalizeAst(doc.parseResult.value)).toEqual(normalizeAst(reparsed.parseResult.value));
    });
});

describe('TextSerializer Optional Keyword Block', () => {
    const grammar = expandToStringLF`
        grammar OptionalBlockTest

        entry Model:
            'model' name=ID
            ('options' '{' options+=Option+ '}')?
            ;

        Option: name=ID '=' value=ID;

        hidden terminal WS: /[ \t]+/;
        terminal ID: /[_a-zA-Z][_a-zA-Z0-9]*/;
    `;

    let services: Awaited<ReturnType<typeof createServicesForGrammar>>;
    let parse: ReturnType<typeof parseHelper<AstNode>>;

    beforeAll(async () => {
        services = await createServicesForGrammar({ grammar });
        parse = parseHelper<AstNode>(services);
    });

    beforeEach(() => {
        clearDocuments(services);
    });

    test('serializes without optional block', () => {
        const model = { $type: 'Model', name: 'simple' };

        const text = services.serializer.TextSerializer.serialize(model as AstNode);

        expect(text).toBe('model simple');
    });

    test('serializes with optional block', () => {
        const opt1 = { $type: 'Option', name: 'debug', value: 'true' };
        const opt2 = { $type: 'Option', name: 'mode', value: 'fast' };
        const model = { $type: 'Model', name: 'configured', options: [opt1, opt2] };

        const text = services.serializer.TextSerializer.serialize(model as AstNode);

        expect(text).toBe('model configured options{debug=true mode=fast}');
    });

    test('serializes with single option in block', () => {
        const opt = { $type: 'Option', name: 'verbose', value: 'yes' };
        const model = { $type: 'Model', name: 'verbose', options: [opt] };

        const text = services.serializer.TextSerializer.serialize(model as AstNode);

        expect(text).toBe('model verbose options{verbose=yes}');
    });

    test('roundtrip without optional block', async () => {
        const input = 'model simple';
        const doc = await parse(input);
        expect(doc.parseResult.parserErrors).toHaveLength(0);

        const serialized = services.serializer.TextSerializer.serialize(doc.parseResult.value);
        const reparsed = await parse(serialized);

        expect(normalizeAst(doc.parseResult.value)).toEqual(normalizeAst(reparsed.parseResult.value));
    });

    test('roundtrip with optional block', async () => {
        const input = 'model configured options { debug = true mode = fast }';
        const doc = await parse(input);
        expect(doc.parseResult.parserErrors).toHaveLength(0);

        const serialized = services.serializer.TextSerializer.serialize(doc.parseResult.value);
        const reparsed = await parse(serialized);

        expect(normalizeAst(doc.parseResult.value)).toEqual(normalizeAst(reparsed.parseResult.value));
    });
});

describe('TextSerializer DomainModel Grammar', () => {
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

        hidden terminal WS: /[ \t]+/;
        terminal ID: /[_a-zA-Z][_a-zA-Z0-9]*/;
    `;

    let services: Awaited<ReturnType<typeof createServicesForGrammar>>;
    let parse: ReturnType<typeof parseHelper<AstNode>>;

    beforeAll(async () => {
        services = await createServicesForGrammar({ grammar });
        parse = parseHelper<AstNode>(services);
    });

    beforeEach(() => {
        clearDocuments(services);
    });

    async function expectRoundtrip(input: string) {
        const doc1 = await parse(input);
        await services.shared.workspace.DocumentBuilder.build([doc1]);
        expect(doc1.parseResult.parserErrors).toHaveLength(0);

        const serialized = services.serializer.TextSerializer.serialize(doc1.parseResult.value);

        const doc2 = await parse(serialized);
        await services.shared.workspace.DocumentBuilder.build([doc2]);
        expect(doc2.parseResult.lexerErrors).toHaveLength(0);
        expect(doc2.parseResult.parserErrors).toHaveLength(0);

        expect(normalizeAst(doc1.parseResult.value)).toEqual(normalizeAst(doc2.parseResult.value));
    }

    test('serializes simple entity', () => {
        const stringType = { $type: 'DataType', name: 'String' };
        const feature = { $type: 'Feature', name: 'name', type: { $refText: 'String', ref: stringType } };
        const entity = { $type: 'Entity', name: 'Person', features: [feature] };
        const model = { $type: 'Domainmodel', elements: [stringType, entity] };

        const text = services.serializer.TextSerializer.serialize(model as AstNode);

        expect(text).toBe('datatype String entity Person{name:String}');
    });

    test('serializes entity with extends', () => {
        const parent = { $type: 'Entity', name: 'Parent', features: [] };
        const child = {
            $type: 'Entity',
            name: 'Child',
            superType: { $refText: 'Parent', ref: parent },
            features: []
        };
        const model = { $type: 'Domainmodel', elements: [parent, child] };

        const text = services.serializer.TextSerializer.serialize(model as AstNode);

        expect(text).toBe('entity Parent{}entity Child extends Parent{}');
    });

    test('serializes datatype', () => {
        const datatype = { $type: 'DataType', name: 'String' };
        const model = { $type: 'Domainmodel', elements: [datatype] };

        const text = services.serializer.TextSerializer.serialize(model as AstNode);

        expect(text).toBe('datatype String');
    });

    test('serializes mixed children (DataType + Entity)', () => {
        const stringType = { $type: 'DataType', name: 'String' };
        const intType = { $type: 'DataType', name: 'Int' };
        const feature = { $type: 'Feature', name: 'age', type: { $refText: 'Int', ref: intType } };
        const entity = { $type: 'Entity', name: 'Person', features: [feature] };
        const model = { $type: 'Domainmodel', elements: [stringType, intType, entity] };

        const text = services.serializer.TextSerializer.serialize(model as AstNode);

        expect(text).toBe('datatype String datatype Int entity Person{age:Int}');
    });

    test('serializes feature with many flag', () => {
        const itemType = { $type: 'DataType', name: 'Item' };
        const feature = { $type: 'Feature', many: true, name: 'items', type: { $refText: 'Item', ref: itemType } };
        const entity = { $type: 'Entity', name: 'Container', features: [feature] };
        const model = { $type: 'Domainmodel', elements: [itemType, entity] };

        const text = services.serializer.TextSerializer.serialize(model as AstNode);

        expect(text).toBe('datatype Item entity Container{many items:Item}');
    });

    test('serializes feature without many flag', () => {
        const itemType = { $type: 'DataType', name: 'Item' };
        const feature = { $type: 'Feature', name: 'item', type: { $refText: 'Item', ref: itemType } };
        const entity = { $type: 'Entity', name: 'Holder', features: [feature] };
        const model = { $type: 'Domainmodel', elements: [itemType, entity] };

        const text = services.serializer.TextSerializer.serialize(model as AstNode);

        expect(text).toBe('datatype Item entity Holder{item:Item}');
    });

    test('serializes simple package', () => {
        const entity = { $type: 'Entity', name: 'MyEntity', features: [] };
        const pkg = { $type: 'PackageDeclaration', name: 'mypackage', elements: [entity] };
        const model = { $type: 'Domainmodel', elements: [pkg] };

        const text = services.serializer.TextSerializer.serialize(model as AstNode);

        expect(text).toBe('package mypackage{entity MyEntity{}}');
    });

    test('serializes nested packages', () => {
        const entity = { $type: 'Entity', name: 'E', features: [] };
        const innerPkg = { $type: 'PackageDeclaration', name: 'bar', elements: [entity] };
        const outerPkg = { $type: 'PackageDeclaration', name: 'foo', elements: [innerPkg] };
        const model = { $type: 'Domainmodel', elements: [outerPkg] };

        const text = services.serializer.TextSerializer.serialize(model as AstNode);

        expect(text).toBe('package foo{package bar{entity E{}}}');
    });

    test('serializes deeply nested packages (3 levels)', () => {
        const entity = { $type: 'Entity', name: 'DeepEntity', features: [] };
        const level3 = { $type: 'PackageDeclaration', name: 'level3', elements: [entity] };
        const level2 = { $type: 'PackageDeclaration', name: 'level2', elements: [level3] };
        const level1 = { $type: 'PackageDeclaration', name: 'level1', elements: [level2] };
        const model = { $type: 'Domainmodel', elements: [level1] };

        const text = services.serializer.TextSerializer.serialize(model as AstNode);

        expect(text).toBe('package level1{package level2{package level3{entity DeepEntity{}}}}');
    });

    test('serializes qualified name reference', async () => {
        const input = 'entity Test { ref : foo.bar.MyType }';
        const doc = await parse(input);
        const text = services.serializer.TextSerializer.serialize(doc.parseResult.value);
        expect(text).toBe('entity Test{ref:foo.bar.MyType}');
    });

    test('serializes entity with extends using qualified name', async () => {
        const input = 'entity Parent { } entity Child extends Parent { }';
        const doc = await parse(input);
        await services.shared.workspace.DocumentBuilder.build([doc]);
        expect(doc.parseResult.parserErrors).toHaveLength(0);
        const text = services.serializer.TextSerializer.serialize(doc.parseResult.value);
        expect(text).toBe('entity Parent{}entity Child extends Parent{}');
    });

    test('serializes entity with multiple features', async () => {
        const input = 'entity Person { name : String age : Int many friends : Person }';
        const doc = await parse(input);
        const text = services.serializer.TextSerializer.serialize(doc.parseResult.value);
        expect(text).toBe('entity Person{name:String age:Int many friends:Person}');
    });

    test('roundtrip simple entity', async () => {
        await expectRoundtrip('datatype String entity Person { name : String }');
    });

    test('roundtrip entity with extends', async () => {
        await expectRoundtrip('entity Parent { } entity Child extends Parent { }');
    });

    test('roundtrip datatype', async () => {
        await expectRoundtrip('datatype String');
    });

    test('roundtrip mixed children', async () => {
        await expectRoundtrip('datatype String datatype Int entity Person { age : Int }');
    });

    test('roundtrip feature with many flag', async () => {
        await expectRoundtrip('datatype Item entity Container { many items : Item }');
    });

    test('roundtrip simple package', async () => {
        await expectRoundtrip('package mypackage { entity MyEntity { } }');
    });

    test('roundtrip nested packages', async () => {
        await expectRoundtrip('package foo { package bar { entity E { } } }');
    });

    test('roundtrip deeply nested packages (3 levels)', async () => {
        await expectRoundtrip('package level1 { package level2 { package level3 { entity DeepEntity { } } } }');
    });

    test('roundtrip entity with multiple features', async () => {
        await expectRoundtrip('datatype String datatype Int entity Person { name : String age : Int many friends : Person }');
    });

    test('roundtrip complex model', async () => {
        await expectRoundtrip('package org { package example { datatype String datatype Item entity Base { name : String } entity Derived extends Base { many items : Item } } }');
    });

    test('roundtrip empty package', async () => {
        await expectRoundtrip('package empty { }');
    });

    test('roundtrip entity without features', async () => {
        await expectRoundtrip('entity Empty { }');
    });

    test('roundtrip multiple packages at top level', async () => {
        await expectRoundtrip('package a { entity A { } } package b { entity B { } }');
    });
});

describe('TextSerializer QualifiedName DataType Rule', () => {
    const grammar = expandToStringLF`
        grammar QualifiedNameTest

        entry Model: 'model' name=QualifiedName;

        QualifiedName returns string: ID ('.' ID)*;

        hidden terminal WS: /[ \t]+/;
        terminal ID: /[_a-zA-Z][_a-zA-Z0-9]*/;
    `;

    let services: Awaited<ReturnType<typeof createServicesForGrammar>>;
    let parse: ReturnType<typeof parseHelper<AstNode>>;

    beforeAll(async () => {
        services = await createServicesForGrammar({ grammar });
        parse = parseHelper<AstNode>(services);
    });

    beforeEach(() => {
        clearDocuments(services);
    });

    test('serializes simple qualified name', () => {
        const model = { $type: 'Model', name: 'simple' };
        expect(services.serializer.TextSerializer.serialize(model as AstNode)).toBe('model simple');
    });

    test('serializes two-part qualified name', () => {
        const model = { $type: 'Model', name: 'foo.bar' };
        expect(services.serializer.TextSerializer.serialize(model as AstNode)).toBe('model foo.bar');
    });

    test('serializes multi-part qualified name', () => {
        const model = { $type: 'Model', name: 'org.example.domain.MyClass' };
        expect(services.serializer.TextSerializer.serialize(model as AstNode)).toBe('model org.example.domain.MyClass');
    });

    test('roundtrip simple qualified name', async () => {
        const input = 'model simple';
        const doc = await parse(input);
        expect(doc.parseResult.parserErrors).toHaveLength(0);

        const serialized = services.serializer.TextSerializer.serialize(doc.parseResult.value);
        const reparsed = await parse(serialized);

        expect(normalizeAst(doc.parseResult.value)).toEqual(normalizeAst(reparsed.parseResult.value));
    });

    test('roundtrip multi-part qualified name', async () => {
        const input = 'model org.example.MyClass';
        const doc = await parse(input);
        expect(doc.parseResult.parserErrors).toHaveLength(0);

        const serialized = services.serializer.TextSerializer.serialize(doc.parseResult.value);
        const reparsed = await parse(serialized);

        expect(normalizeAst(doc.parseResult.value)).toEqual(normalizeAst(reparsed.parseResult.value));
    });
});

interface Model extends AstNode {
    names: string[];
}

function normalizeAst(node: AstNode): unknown {
    return JSON.parse(JSON.stringify(node, (key, value) => {
        if ((key.startsWith('$') && key !== '$type') || key.startsWith('_') || key === 'ref') {
            return undefined;
        }
        return value;
    }));
}
