/******************************************************************************
 * Copyright 2025 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { Nfa, BacktrackHandler } from './nfa-types.js';

// Re-export BacktrackHandler for convenience
export type { BacktrackHandler } from './nfa-types.js';

/**
 * Represents an item on the backtracking stack.
 */
interface StackItem<S, R> {
    /** The result at this point in the search */
    result: R;
    /** Iterator over remaining followers to explore */
    followers: Iterator<S>;
}

/**
 * Generic NFA backtracking algorithm.
 *
 * Performs depth-first search through the NFA, using the handler to:
 * - Determine valid transitions (handle returns non-undefined)
 * - Detect solutions (isSolution returns true at stop state)
 * - Control exploration order (sortFollowers)
 *
 * Derived from Xtext's NfaUtil.backtrack().
 *
 * @param nfa The NFA to traverse
 * @param initial The initial result value
 * @param handler The backtracking handler
 * @returns Array of results along the solution path, or undefined if no solution found
 */
export function backtrack<S, R>(
    nfa: Nfa<S>,
    initial: R,
    handler: BacktrackHandler<S, R>
): R[] | undefined {
    const trace: StackItem<S, R>[] = [];

    // Start by exploring the start state
    trace.push({
        result: initial,
        followers: [nfa.getStart()][Symbol.iterator]()
    });

    const stopState = nfa.getStop();

    while (trace.length > 0) {
        const item = trace[trace.length - 1];

        // Get next follower to explore
        const next = item.followers.next();
        if (next.done) {
            // No more followers - backtrack
            trace.pop();
            continue;
        }

        const nextState = next.value;
        const nextResult = handler.handle(nextState, item.result);

        if (nextResult !== undefined) {
            // Valid transition - get sorted followers for this state
            const followers = handler.sortFollowers(
                nextResult,
                nfa.getFollowers(nextState)
            );

            trace.push({
                result: nextResult,
                followers: followers[Symbol.iterator]()
            });

            // Check for solution at stop state
            if (nextState === stopState && handler.isSolution(nextResult)) {
                // Return the full trace of results
                return trace.map(t => t.result);
            }
        }
    }

    // No solution found
    return undefined;
}
