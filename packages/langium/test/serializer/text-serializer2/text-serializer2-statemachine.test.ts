/******************************************************************************
 * Copyright 2025 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { AstNode } from '../../../src/syntax-tree.js';
import { createServicesForGrammar } from '../../../src/grammar/internal-grammar-util.js';
import { expandToStringLF } from '../../../src/generate/template-string.js';
import { beforeEach, describe, expect, test } from 'vitest';
import { clearDocuments, parseHelper } from '../../../src/test/langium-test.js';
import { TextSerializer2 } from '../../../src/serializer/text-serializer2.js';

/**
 * Tests for TextSerializer2 using Statemachine-style grammar patterns.
 *
 * This covers:
 * - Group + (one or more cardinality)
 * - Optional keyword blocks: ('events' events+=Event+)?
 * - Nested ref array in block: 'actions' '{' actions+=[Cmd]+ '}'
 * - Transitions with cross-references
 */
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

    test('Serialize statemachine with commands block', () => {
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

        const text = serializer.serialize(sm as AstNode);

        expect(text).toBe('statemachine withCommands commands cmd1 cmd2 initialState idle state idle end');
    });

    test('Serialize statemachine with events and commands', () => {
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

        const text = serializer.serialize(sm as AstNode);

        expect(text).toBe('statemachine full events buttonPress commands beep initialState idle state idle end');
    });

    test('Serialize state with actions', () => {
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

        const text = serializer.serialize(sm as AstNode);

        expect(text).toBe('statemachine doorLock commands lockDoor soundAlarm initialState locked state locked actions { lockDoor soundAlarm } end');
    });

    test('Serialize state with single action', () => {
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

        const text = serializer.serialize(sm as AstNode);

        expect(text).toBe('statemachine notifier commands notify initialState active state active actions { notify } end');
    });

    test('Serialize transitions', () => {
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

        const text = serializer.serialize(sm as AstNode);

        expect(text).toBe('statemachine runner events start initialState idle state idle start => running end state running end');
    });

    test('Serialize state with multiple transitions', () => {
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

        const text = serializer.serialize(sm as AstNode);

        expect(text).toBe('statemachine toggle events start reset initialState idle state idle start => running end state running reset => idle start => running end');
    });

    test('Serialize multiple states', () => {
        const state1 = { $type: 'State', name: 'state1', actions: [], transitions: [] };
        const state2 = { $type: 'State', name: 'state2', actions: [], transitions: [] };
        const state3 = { $type: 'State', name: 'state3', actions: [], transitions: [] };
        const sm = {
            $type: 'Statemachine',
            name: 'multi',
            init: { $refText: 'state1', ref: state1 },
            states: [state1, state2, state3]
        };

        const text = serializer.serialize(sm as AstNode);

        expect(text).toBe('statemachine multi initialState state1 state state1 end state state2 end state state3 end');
    });

    // Roundtrip tests

    test('Roundtrip: Minimal statemachine', async () => {
        await expectRoundtrip('statemachine minimal initialState idle state idle end');
    });

    test('Roundtrip: Statemachine with events', async () => {
        await expectRoundtrip('statemachine withEvents events e1 e2 e3 initialState idle state idle end');
    });

    test('Roundtrip: Statemachine with commands', async () => {
        await expectRoundtrip('statemachine withCommands commands c1 c2 initialState idle state idle end');
    });

    test('Roundtrip: Statemachine with events and commands', async () => {
        await expectRoundtrip('statemachine full events e1 e2 commands c1 c2 initialState idle state idle end');
    });

    test('Roundtrip: State with actions', async () => {
        await expectRoundtrip('statemachine withActions commands beep flash initialState active state active actions { beep flash } end');
    });

    test('Roundtrip: State with single action', async () => {
        await expectRoundtrip('statemachine single commands notify initialState active state active actions { notify } end');
    });

    test('Roundtrip: Transitions', async () => {
        await expectRoundtrip('statemachine runner events start stop initialState idle state idle start => running end state running stop => idle end');
    });

    test('Roundtrip: Multiple transitions in one state', async () => {
        await expectRoundtrip('statemachine complex events a b c initialState s1 state s1 a => s2 b => s3 end state s2 end state s3 c => s1 end');
    });

    test('Roundtrip: Full statemachine', async () => {
        await expectRoundtrip('statemachine doorLock events lock unlock commands lockDoor unlockDoor soundAlarm initialState unlocked state unlocked lock => locked end state locked actions { lockDoor soundAlarm } unlock => unlocked end');
    });

    test('Roundtrip: Single event (+ cardinality edge case)', async () => {
        await expectRoundtrip('statemachine oneEvent events singleEvent initialState idle state idle end');
    });

    test('Roundtrip: Single command (+ cardinality edge case)', async () => {
        await expectRoundtrip('statemachine oneCmd commands singleCommand initialState idle state idle end');
    });
});

/**
 * Tests for Group + (one or more) cardinality pattern.
 */
describe('TextSerializer2 Group+ Cardinality', async () => {

    const grammar = expandToStringLF`
        grammar GroupPlusTest

        entry Model: 'items' items+=Item+;

        Item: 'item' name=ID;

        hidden terminal WS: /\\s+/;
        terminal ID: /[_a-zA-Z][\\w]*/;
    `;

    const services = await createServicesForGrammar({ grammar });
    const serializer = new TextSerializer2(services);
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

/**
 * Tests for nested optional keyword block pattern.
 */
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
    const serializer = new TextSerializer2(services);
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

        expect(text).toBe('model configured options { debug = true mode = fast }');
    });

    test('Serialize with single option in block', () => {
        const opt = { $type: 'Option', name: 'verbose', value: 'yes' };
        const model = { $type: 'Model', name: 'verbose', options: [opt] };

        const text = serializer.serialize(model as AstNode);

        expect(text).toBe('model verbose options { verbose = yes }');
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
        expect(serialized).toBe(input);
    });
});
