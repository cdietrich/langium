/******************************************************************************
 * Copyright 2025 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import { describe, expect, test } from 'vitest';
import { backtrack, type BacktrackHandler } from '../../../src/serializer/backtrack.js';
import type { Nfa } from '../../../src/serializer/nfa-types.js';

/**
 * Simple test state for NFA testing.
 */
interface TestState {
    id: string;
    followers: TestState[];
    value?: number; // Optional value to collect
}

/**
 * Simple NFA implementation for testing.
 */
function createTestNfa(start: TestState, stop: TestState): Nfa<TestState> {
    return {
        getStart: () => start,
        getStop: () => stop,
        getFollowers: (state) => state.followers
    };
}

/**
 * Create a linear chain of states.
 */
function createLinearNfa(values: number[]): { nfa: Nfa<TestState>; start: TestState; stop: TestState } {
    const stop: TestState = { id: 'stop', followers: [] };
    let current = stop;

    // Build backwards
    for (let i = values.length - 1; i >= 0; i--) {
        const state: TestState = {
            id: `state${i}`,
            value: values[i],
            followers: [current]
        };
        current = state;
    }

    const start: TestState = { id: 'start', followers: [current] };
    return { nfa: createTestNfa(start, stop), start, stop };
}

describe('backtrack', () => {

    describe('linear paths', () => {

        test('finds path through simple linear NFA', () => {
            const { nfa } = createLinearNfa([1, 2, 3]);

            const handler: BacktrackHandler<TestState, number[]> = {
                handle: (state, previous) => {
                    if (state.value !== undefined) {
                        return [...previous, state.value];
                    }
                    return previous;
                },
                isSolution: () => true,
                sortFollowers: (_, followers) => followers
            };

            const result = backtrack(nfa, [], handler);

            expect(result).toBeDefined();
            expect(result!.length).toBeGreaterThan(0);
            // Last result should contain all values
            const lastResult = result![result!.length - 1];
            expect(lastResult).toEqual([1, 2, 3]);
        });

        test('returns trace of all intermediate results', () => {
            const { nfa } = createLinearNfa([1, 2]);

            const handler: BacktrackHandler<TestState, number[]> = {
                handle: (state, previous) => {
                    if (state.value !== undefined) {
                        return [...previous, state.value];
                    }
                    return previous;
                },
                isSolution: () => true,
                sortFollowers: (_, followers) => followers
            };

            const result = backtrack(nfa, [], handler);

            expect(result).toBeDefined();
            // Should have: initial, start, state0, state1, stop
            expect(result!.length).toBe(5);
            expect(result![0]).toEqual([]); // Initial
            expect(result![1]).toEqual([]); // Start
            expect(result![2]).toEqual([1]); // After state0
            expect(result![3]).toEqual([1, 2]); // After state1
            expect(result![4]).toEqual([1, 2]); // Stop
        });

        test('empty NFA returns path with just start/stop', () => {
            const stop: TestState = { id: 'stop', followers: [] };
            const start: TestState = { id: 'start', followers: [stop] };
            const nfa = createTestNfa(start, stop);

            const handler: BacktrackHandler<TestState, string> = {
                handle: () => 'ok',
                isSolution: () => true,
                sortFollowers: (_, followers) => followers
            };

            const result = backtrack(nfa, 'init', handler);

            expect(result).toBeDefined();
            expect(result!.length).toBe(3); // init, start, stop
        });
    });

    describe('branching and backtracking', () => {

        test('explores alternatives until solution found', () => {
            // Create NFA: start -> [a, b] -> stop
            // where only 'b' leads to a solution
            const stop: TestState = { id: 'stop', followers: [] };
            const stateA: TestState = { id: 'a', value: 1, followers: [stop] };
            const stateB: TestState = { id: 'b', value: 2, followers: [stop] };
            const start: TestState = { id: 'start', followers: [stateA, stateB] };
            const nfa = createTestNfa(start, stop);

            let exploredA = false;
            let exploredB = false;

            const handler: BacktrackHandler<TestState, number> = {
                handle: (state, previous) => {
                    if (state.id === 'a') {
                        exploredA = true;
                        return undefined; // Reject path through 'a'
                    }
                    if (state.id === 'b') {
                        exploredB = true;
                        return 2;
                    }
                    return previous;
                },
                isSolution: () => true,
                sortFollowers: (_, followers) => followers
            };

            const result = backtrack(nfa, 0, handler);

            expect(result).toBeDefined();
            expect(exploredA).toBe(true);
            expect(exploredB).toBe(true);
        });

        test('backtracks when path fails', () => {
            // Create NFA: start -> state1 -> [dead, state2] -> stop
            // where 'dead' has no valid path to stop
            const stop: TestState = { id: 'stop', followers: [] };
            const dead: TestState = { id: 'dead', followers: [] }; // No path to stop
            const state2: TestState = { id: 'state2', value: 2, followers: [stop] };
            const state1: TestState = { id: 'state1', value: 1, followers: [dead, state2] };
            const start: TestState = { id: 'start', followers: [state1] };
            const nfa = createTestNfa(start, stop);

            const handler: BacktrackHandler<TestState, number[]> = {
                handle: (state, previous) => {
                    if (state.value !== undefined) {
                        return [...previous, state.value];
                    }
                    return previous;
                },
                isSolution: () => true,
                sortFollowers: (_, followers) => followers
            };

            const result = backtrack(nfa, [], handler);

            expect(result).toBeDefined();
            const lastResult = result![result!.length - 1];
            expect(lastResult).toEqual([1, 2]); // Should find path through state2
        });

        test('returns undefined when no solution exists', () => {
            // Create NFA where handler always rejects
            const stop: TestState = { id: 'stop', followers: [] };
            const state: TestState = { id: 'state', followers: [stop] };
            const start: TestState = { id: 'start', followers: [state] };
            const nfa = createTestNfa(start, stop);

            const handler: BacktrackHandler<TestState, number> = {
                handle: () => undefined, // Always reject
                isSolution: () => true,
                sortFollowers: (_, followers) => followers
            };

            const result = backtrack(nfa, 0, handler);

            expect(result).toBeUndefined();
        });

        test('returns undefined when isSolution returns false', () => {
            const stop: TestState = { id: 'stop', followers: [] };
            const start: TestState = { id: 'start', followers: [stop] };
            const nfa = createTestNfa(start, stop);

            const handler: BacktrackHandler<TestState, number> = {
                handle: (_, prev) => prev,
                isSolution: () => false, // Never accept
                sortFollowers: (_, followers) => followers
            };

            const result = backtrack(nfa, 0, handler);

            expect(result).toBeUndefined();
        });
    });

    describe('sortFollowers', () => {

        test('explores followers in sorted order', () => {
            // Create NFA: start -> [a(3), b(1), c(2)] -> stop
            const stop: TestState = { id: 'stop', followers: [] };
            const stateA: TestState = { id: 'a', value: 3, followers: [stop] };
            const stateB: TestState = { id: 'b', value: 1, followers: [stop] };
            const stateC: TestState = { id: 'c', value: 2, followers: [stop] };
            const start: TestState = { id: 'start', followers: [stateA, stateB, stateC] };
            const nfa = createTestNfa(start, stop);

            const explorationOrder: string[] = [];

            const handler: BacktrackHandler<TestState, number[]> = {
                handle: (state, previous) => {
                    if (state.value !== undefined) {
                        explorationOrder.push(state.id);
                    }
                    return previous; // Accept all
                },
                isSolution: (result) => result.length > 0, // Accept first value found
                // Sort by value ascending
                sortFollowers: (_, followers) =>
                    [...followers].sort((a, b) => (a.value ?? 0) - (b.value ?? 0))
            };

            backtrack(nfa, [], handler);

            // First explored should be 'b' (value 1)
            expect(explorationOrder[0]).toBe('b');
        });

        test('sortFollowers receives correct result context', () => {
            const stop: TestState = { id: 'stop', followers: [] };
            const state: TestState = { id: 'state', value: 42, followers: [stop] };
            const start: TestState = { id: 'start', followers: [state] };
            const nfa = createTestNfa(start, stop);

            const receivedResults: number[][] = [];

            const handler: BacktrackHandler<TestState, number[]> = {
                handle: (state, previous) => {
                    if (state.value !== undefined) {
                        return [...previous, state.value];
                    }
                    return previous;
                },
                isSolution: () => true,
                sortFollowers: (result, followers) => {
                    receivedResults.push([...result]);
                    return followers;
                }
            };

            backtrack(nfa, [], handler);

            // sortFollowers called for: initial, after start, after state
            expect(receivedResults).toContainEqual([]); // After start
            expect(receivedResults).toContainEqual([42]); // After state
        });
    });

    describe('cycle handling', () => {

        test('handles cycles without infinite loop when handler rejects revisits', () => {
            // Create NFA with cycle: start -> state -> (stop | state)
            const stop: TestState = { id: 'stop', followers: [] };
            const state: TestState = { id: 'state', value: 1, followers: [] };
            state.followers = [stop, state]; // Add cycle
            const start: TestState = { id: 'start', followers: [state] };
            const nfa = createTestNfa(start, stop);

            const visited = new Set<string>();

            const handler: BacktrackHandler<TestState, number[]> = {
                handle: (state, previous) => {
                    // Reject if already visited (prevents infinite loop)
                    if (state.value !== undefined) {
                        if (visited.has(state.id)) {
                            return undefined;
                        }
                        visited.add(state.id);
                        return [...previous, state.value];
                    }
                    return previous;
                },
                isSolution: () => true,
                sortFollowers: (_, followers) => followers
            };

            const result = backtrack(nfa, [], handler);

            expect(result).toBeDefined();
        });

        test('can traverse same state multiple times if handler allows', () => {
            // Create NFA: start -> state -> (stop | state)
            // Allow visiting 'state' up to 3 times
            const stop: TestState = { id: 'stop', followers: [] };
            const state: TestState = { id: 'state', value: 1, followers: [] };
            state.followers = [state, stop]; // Cycle first, then stop
            const start: TestState = { id: 'start', followers: [state] };
            const nfa = createTestNfa(start, stop);

            let visitCount = 0;
            const maxVisits = 3;

            const handler: BacktrackHandler<TestState, number[]> = {
                handle: (s, previous) => {
                    if (s.value !== undefined) {
                        if (visitCount >= maxVisits) {
                            return undefined;
                        }
                        visitCount++;
                        return [...previous, s.value];
                    }
                    return previous;
                },
                isSolution: (result) => result.length === maxVisits,
                sortFollowers: (_, followers) => followers
            };

            const result = backtrack(nfa, [], handler);

            expect(result).toBeDefined();
            const lastResult = result![result!.length - 1];
            expect(lastResult).toEqual([1, 1, 1]);
        });
    });

    describe('complex scenarios', () => {

        test('diamond-shaped NFA finds correct path', () => {
            // Create diamond: start -> [a, b] -> merge -> stop
            const stop: TestState = { id: 'stop', followers: [] };
            const merge: TestState = { id: 'merge', value: 0, followers: [stop] };
            const stateA: TestState = { id: 'a', value: 1, followers: [merge] };
            const stateB: TestState = { id: 'b', value: 2, followers: [merge] };
            const start: TestState = { id: 'start', followers: [stateA, stateB] };
            const nfa = createTestNfa(start, stop);

            const handler: BacktrackHandler<TestState, number[]> = {
                handle: (state, previous) => {
                    if (state.value !== undefined) {
                        return [...previous, state.value];
                    }
                    return previous;
                },
                isSolution: () => true,
                sortFollowers: (_, followers) => followers
            };

            const result = backtrack(nfa, [], handler);

            expect(result).toBeDefined();
            const lastResult = result![result!.length - 1];
            // Should go through 'a' first (first in followers), then merge
            expect(lastResult).toEqual([1, 0]);
        });

        test('conditional solution acceptance', () => {
            // NFA where solution requires specific sum
            const stop: TestState = { id: 'stop', followers: [] };
            const s1: TestState = { id: 's1', value: 1, followers: [stop] };
            const s2: TestState = { id: 's2', value: 2, followers: [stop] };
            const s3: TestState = { id: 's3', value: 3, followers: [stop] };
            const start: TestState = { id: 'start', followers: [s1, s2, s3] };
            const nfa = createTestNfa(start, stop);

            const handler: BacktrackHandler<TestState, number> = {
                handle: (state, previous) => {
                    if (state.value !== undefined) {
                        return previous + state.value;
                    }
                    return previous;
                },
                // Only accept if sum is 2
                isSolution: (result) => result === 2,
                sortFollowers: (_, followers) => followers
            };

            const result = backtrack(nfa, 0, handler);

            expect(result).toBeDefined();
            // Should find path through s2 (value 2)
            expect(result![result!.length - 1]).toBe(2);
        });
    });
});
