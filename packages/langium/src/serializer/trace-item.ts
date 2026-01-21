/******************************************************************************
 * Copyright 2025 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { SemState } from './nfa-types.js';
import type { SerializableObject } from './serializable-object.js';

/**
 * Tracks state during backtracking search.
 *
 * Key insight from Xtext: clone() shares nextIndex array (no modification),
 * while cloneAndConsume() copies it (needs increment).
 *
 * @see https://github.com/eclipse/xtext/blob/main/org.eclipse.xtext/src/org/eclipse/xtext/serializer/sequencer/BacktrackingSemanticSequencer.java
 */
export class TraceItem {
    /** The serializable object being processed */
    readonly obj: SerializableObject;

    /** The current NFA state (undefined for initial item before entering start state) */
    state: SemState | undefined;

    /**
     * Next index to consume per feature.
     * Shared between clone()s, copied in cloneAndConsume().
     */
    readonly nextIndex: number[];

    /** The consumed value (populated after cloneAndConsume) */
    value: unknown;

    /** The array index of the consumed value */
    index: number;

    constructor(obj: SerializableObject, nextIndex: number[]) {
        this.obj = obj;
        this.nextIndex = nextIndex;
        this.index = -1;
    }

    /**
     * Clone for structural states (no consumption).
     * SHARES the nextIndex array - no modification expected.
     *
     * This is used when transitioning to states that don't consume values,
     * such as the START state, STOP state, or pure keyword states.
     */
    clone(state: SemState): TraceItem {
        const item = new TraceItem(this.obj, this.nextIndex);
        item.state = state;
        return item;
    }

    /**
     * Clone and consume a value from a feature.
     * COPIES the nextIndex array since we're incrementing.
     * Returns undefined if no value available.
     *
     * This is used when transitioning to assignment states that consume
     * a value from the AST node.
     */
    cloneAndConsume(state: SemState): TraceItem | undefined {
        const featureIndex = state.featureIndex;
        if (featureIndex < 0) {
            // START/STOP states don't consume
            return undefined;
        }

        const arrayIndex = this.nextIndex[featureIndex] ?? 0;
        const totalCount = this.obj.getValueCount(featureIndex);

        if (arrayIndex >= totalCount) {
            // No more values to consume for this feature
            return undefined;
        }

        const value = this.obj.getValue(featureIndex, arrayIndex);

        // Copy the nextIndex array and increment the consumed feature's index
        const newNextIndex = [...this.nextIndex];
        newNextIndex[featureIndex] = arrayIndex + 1;

        const item = new TraceItem(this.obj, newNextIndex);
        item.state = state;
        item.value = value;
        item.index = arrayIndex;
        return item;
    }

    /**
     * Check if all features are fully consumed.
     * Returns true when there are no more values to serialize.
     */
    isConsumed(): boolean {
        return this.obj.isFullyConsumed(this.nextIndex);
    }

    /**
     * BitSet pruning check - the KEY optimization.
     * Returns false if any unconsumed feature is not reachable from this state.
     *
     * This check enables early termination of search paths that cannot
     * possibly lead to a complete solution because some unconsumed feature
     * values would become unreachable.
     */
    canEnter(state: SemState): boolean {
        // Rule 1: Boolean assignments require true value
        if (state.isBooleanAssignment && state.featureIndex >= 0) {
            const nextIdx = this.nextIndex[state.featureIndex] ?? 0;
            const value = this.obj.getValue(state.featureIndex, nextIdx);
            if (value !== true) {
                return false;
            }
        }

        // Rule 2: Check all remaining features are reachable
        // If followerFeatures is not computed yet, we can't prune
        if (!state.followerFeatures) {
            return true;
        }

        for (let i = 0; i < this.obj.featureCount; i++) {
            // Skip the feature being consumed by this state (if any)
            if (i === state.featureIndex) {
                continue;
            }

            const consumed = this.nextIndex[i] ?? 0;
            const total = this.obj.getValueCount(i);

            if (consumed < total) {
                // Feature i has unconsumed values - is it reachable from this state?
                if (!state.followerFeatures.get(i)) {
                    // PRUNE: feature i has values but is not reachable from this state!
                    return false;
                }
            }
        }

        return true;
    }

    /**
     * Create the initial trace item for serializing an object.
     * All feature indices start at 0.
     */
    static createInitial(obj: SerializableObject): TraceItem {
        const nextIndex = new Array(obj.featureCount).fill(0);
        return new TraceItem(obj, nextIndex);
    }
}
