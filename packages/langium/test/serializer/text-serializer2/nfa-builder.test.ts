/******************************************************************************
 * Copyright 2025 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import { describe, expect, test } from 'vitest';
import { createServicesForGrammar } from 'langium/grammar';
import { expandToStringLF } from 'langium/generate';
import { NfaBuilder } from '../../../src/serializer/nfa-builder.js';
import type { SemState } from '../../../src/serializer/nfa-types.js';

describe('NfaBuilder', () => {

    describe('simple assignments', () => {

        test('single assignment creates state with correct feature', async () => {
            const grammar = expandToStringLF`
                grammar Test
                entry Model: name=ID;
                terminal ID: /[a-z]+/;
            `;
            const services = await createServicesForGrammar({ grammar });
            const builder = new NfaBuilder(services);

            const nfa = builder.getNfa('Model');
            const featureMap = builder.getFeatureMap('Model');

            expect(featureMap.get('name')).toBe(0);

            // Start -> Assignment -> Stop
            const start = nfa.getStart();
            expect(start.type).toBe('START');
            expect(start.followers.length).toBeGreaterThan(0);

            // Find assignment state
            const assignmentState = findStateByFeature(start, 'name');
            expect(assignmentState).toBeDefined();
            expect(assignmentState!.featureIndex).toBe(0);
        });

        test('boolean assignment marked correctly', async () => {
            const grammar = expandToStringLF`
                grammar Test
                entry Model: flag?='flag';
                terminal ID: /[a-z]+/;
            `;
            const services = await createServicesForGrammar({ grammar });
            const builder = new NfaBuilder(services);

            const nfa = builder.getNfa('Model');
            const assignmentState = findStateByFeature(nfa.getStart(), 'flag');

            expect(assignmentState).toBeDefined();
            expect(assignmentState!.isBooleanAssignment).toBe(true);
        });

        test('regular assignment not marked as boolean', async () => {
            const grammar = expandToStringLF`
                grammar Test
                entry Model: name=ID;
                terminal ID: /[a-z]+/;
            `;
            const services = await createServicesForGrammar({ grammar });
            const builder = new NfaBuilder(services);

            const nfa = builder.getNfa('Model');
            const assignmentState = findStateByFeature(nfa.getStart(), 'name');

            expect(assignmentState).toBeDefined();
            expect(assignmentState!.isBooleanAssignment).toBe(false);
        });
    });

    describe('sequences', () => {

        test('sequence creates connected states', async () => {
            const grammar = expandToStringLF`
                grammar Test
                entry Model: a=ID b=ID;
                terminal ID: /[a-z]+/;
            `;
            const services = await createServicesForGrammar({ grammar });
            const builder = new NfaBuilder(services);

            const nfa = builder.getNfa('Model');
            const featureMap = builder.getFeatureMap('Model');

            expect(featureMap.size).toBe(2);
            expect(featureMap.get('a')).toBe(0);
            expect(featureMap.get('b')).toBe(1);

            // Verify both states exist
            const stateA = findStateByFeature(nfa.getStart(), 'a');
            const stateB = findStateByFeature(nfa.getStart(), 'b');

            expect(stateA).toBeDefined();
            expect(stateB).toBeDefined();
        });

        test('sequence with keyword', async () => {
            const grammar = expandToStringLF`
                grammar Test
                entry Model: 'item' name=ID;
                terminal ID: /[a-z]+/;
            `;
            const services = await createServicesForGrammar({ grammar });
            const builder = new NfaBuilder(services);

            const nfa = builder.getNfa('Model');

            // Should have keyword and assignment states
            const allStates = collectAllStates(nfa);
            const keywordStates = allStates.filter(s => s.type === 'KEYWORD');
            const assignmentStates = allStates.filter(s => s.type === 'ASSIGNMENT');

            expect(keywordStates.length).toBeGreaterThan(0);
            expect(assignmentStates.length).toBe(1);
        });
    });

    describe('alternatives', () => {

        test('alternatives create multiple paths', async () => {
            const grammar = expandToStringLF`
                grammar Test
                entry Model: name=ID | value=INT;
                terminal ID: /[a-z]+/;
                terminal INT: /[0-9]+/;
            `;
            const services = await createServicesForGrammar({ grammar });
            const builder = new NfaBuilder(services);

            const nfa = builder.getNfa('Model');
            const featureMap = builder.getFeatureMap('Model');

            expect(featureMap.size).toBe(2);

            // Start should have followers for both alternatives
            const start = nfa.getStart();
            expect(start.followers.length).toBeGreaterThanOrEqual(2);

            // Both features should be reachable
            const stateA = findStateByFeature(start, 'name');
            const stateB = findStateByFeature(start, 'value');

            expect(stateA).toBeDefined();
            expect(stateB).toBeDefined();
        });
    });

    describe('cardinality', () => {

        test('optional element allows skipping', async () => {
            const grammar = expandToStringLF`
                grammar Test
                entry Model: name=ID?;
                terminal ID: /[a-z]+/;
            `;
            const services = await createServicesForGrammar({ grammar });
            const builder = new NfaBuilder(services);

            const nfa = builder.getNfa('Model');
            const start = nfa.getStart();
            const stop = nfa.getStop();

            // Should be able to reach stop directly (optional)
            const canSkipToStop = start.followers.some(f => f === stop || canReach(f, stop, new Set()));
            expect(canSkipToStop).toBe(true);
        });

        test('repeated element (*) allows zero or more', async () => {
            const grammar = expandToStringLF`
                grammar Test
                entry Model: values+=ID*;
                terminal ID: /[a-z]+/;
            `;
            const services = await createServicesForGrammar({ grammar });
            const builder = new NfaBuilder(services);

            const nfa = builder.getNfa('Model');
            const allStates = collectAllStates(nfa);
            const assignmentState = allStates.find(s => s.feature === 'values');

            expect(assignmentState).toBeDefined();
        });

        test('required repeated element (+) requires at least one', async () => {
            const grammar = expandToStringLF`
                grammar Test
                entry Model: values+=ID+;
                terminal ID: /[a-z]+/;
            `;
            const services = await createServicesForGrammar({ grammar });
            const builder = new NfaBuilder(services);

            const nfa = builder.getNfa('Model');
            const allStates = collectAllStates(nfa);
            const assignmentState = allStates.find(s => s.feature === 'values');

            expect(assignmentState).toBeDefined();
        });
    });

    describe('followerFeatures', () => {

        test('followerFeatures computed for reachable features', async () => {
            const grammar = expandToStringLF`
                grammar Test
                entry Model: a=ID b=ID;
                terminal ID: /[a-z]+/;
            `;
            const services = await createServicesForGrammar({ grammar });
            const builder = new NfaBuilder(services);

            const nfa = builder.getNfa('Model');
            const start = nfa.getStart();

            // Start should have both features reachable
            expect(start.followerFeatures).toBeDefined();
            expect(start.followerFeatures!.get(0)).toBe(true); // 'a'
            expect(start.followerFeatures!.get(1)).toBe(true); // 'b'
        });

        test('followerFeatures reflects actual reachability', async () => {
            const grammar = expandToStringLF`
                grammar Test
                entry Model: a=ID b=ID c=ID;
                terminal ID: /[a-z]+/;
            `;
            const services = await createServicesForGrammar({ grammar });
            const builder = new NfaBuilder(services);

            const nfa = builder.getNfa('Model');
            const featureMap = builder.getFeatureMap('Model');

            expect(featureMap.size).toBe(3);

            // All states should have followerFeatures computed
            const allStates = collectAllStates(nfa);
            for (const state of allStates) {
                expect(state.followerFeatures).toBeDefined();
            }
        });
    });

    describe('feature map', () => {

        test('builds correct feature map', async () => {
            const grammar = expandToStringLF`
                grammar Test
                entry Model: a=ID b=INT c=STRING;
                terminal ID: /[a-z]+/;
                terminal INT: /[0-9]+/;
                terminal STRING: /"[^"]*"/;
            `;
            const services = await createServicesForGrammar({ grammar });
            const builder = new NfaBuilder(services);

            const featureMap = builder.getFeatureMap('Model');

            expect(featureMap.size).toBe(3);
            expect(featureMap.has('a')).toBe(true);
            expect(featureMap.has('b')).toBe(true);
            expect(featureMap.has('c')).toBe(true);

            // Indices should be sequential
            const indices = [...featureMap.values()].sort((a, b) => a - b);
            expect(indices).toEqual([0, 1, 2]);
        });

        test('handles nested assignments', async () => {
            const grammar = expandToStringLF`
                grammar Test
                entry Model: (a=ID | b=INT) c=STRING;
                terminal ID: /[a-z]+/;
                terminal INT: /[0-9]+/;
                terminal STRING: /"[^"]*"/;
            `;
            const services = await createServicesForGrammar({ grammar });
            const builder = new NfaBuilder(services);

            const featureMap = builder.getFeatureMap('Model');

            expect(featureMap.size).toBe(3);
            expect(featureMap.has('a')).toBe(true);
            expect(featureMap.has('b')).toBe(true);
            expect(featureMap.has('c')).toBe(true);
        });
    });

    describe('caching', () => {

        test('NFA is cached', async () => {
            const grammar = expandToStringLF`
                grammar Test
                entry Model: name=ID;
                terminal ID: /[a-z]+/;
            `;
            const services = await createServicesForGrammar({ grammar });
            const builder = new NfaBuilder(services);

            const nfa1 = builder.getNfa('Model');
            const nfa2 = builder.getNfa('Model');

            expect(nfa1).toBe(nfa2);
        });

        test('feature map is cached', async () => {
            const grammar = expandToStringLF`
                grammar Test
                entry Model: name=ID;
                terminal ID: /[a-z]+/;
            `;
            const services = await createServicesForGrammar({ grammar });
            const builder = new NfaBuilder(services);

            const map1 = builder.getFeatureMap('Model');
            const map2 = builder.getFeatureMap('Model');

            expect(map1).toBe(map2);
        });
    });

    describe('error handling', () => {

        test('throws for unknown type', async () => {
            const grammar = expandToStringLF`
                grammar Test
                entry Model: name=ID;
                terminal ID: /[a-z]+/;
            `;
            const services = await createServicesForGrammar({ grammar });
            const builder = new NfaBuilder(services);

            expect(() => builder.getNfa('UnknownType')).toThrow(/No grammar rule found/);
        });
    });
});

// Helper functions

function findStateByFeature(start: SemState, feature: string): SemState | undefined {
    const visited = new Set<SemState>();
    const queue: SemState[] = [start];

    while (queue.length > 0) {
        const state = queue.shift()!;
        if (visited.has(state)) continue;
        visited.add(state);

        if (state.feature === feature) {
            return state;
        }

        queue.push(...state.followers);
    }

    return undefined;
}

function collectAllStates(nfa: { getStart(): SemState }): SemState[] {
    const states: SemState[] = [];
    const visited = new Set<SemState>();

    const visit = (state: SemState) => {
        if (visited.has(state)) return;
        visited.add(state);
        states.push(state);
        for (const follower of state.followers) {
            visit(follower);
        }
    };

    visit(nfa.getStart());
    return states;
}

function canReach(from: SemState, to: SemState, visited: Set<SemState>): boolean {
    if (from === to) return true;
    if (visited.has(from)) return false;
    visited.add(from);

    for (const follower of from.followers) {
        if (canReach(follower, to, visited)) {
            return true;
        }
    }

    return false;
}
