/******************************************************************************
 * Copyright 2025 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { AbstractElement } from '../languages/generated/ast.js';
import type { BitSet } from './bitset.js';

/**
 * Represents a semantic state in the NFA - typically an assignment point.
 *
 * Derived from Xtext's ISemState interface.
 *
 * @see https://github.com/eclipse/xtext/blob/main/org.eclipse.xtext/src/org/eclipse/xtext/serializer/analysis/ISemanticSequencerNfaProvider.java
 */
export interface SemState {
    /**
     * The grammar element this state represents.
     * Can be Assignment, Keyword, RuleCall, Action, CrossReference, etc.
     */
    readonly grammarElement: AbstractElement;

    /**
     * Property name on the AST node (undefined for START/STOP states or structural states).
     */
    readonly feature: string | undefined;

    /**
     * Index into the feature array for BitSet operations.
     * -1 for START/STOP states.
     */
    readonly featureIndex: number;

    /**
     * Successor states in the NFA.
     * Mutable during construction, treated as immutable during serialization.
     */
    followers: SemState[];

    /**
     * BitSet where bit i is set if feature i can still be reached from this state.
     * This is the KEY optimization - enables early pruning during backtracking.
     * Computed via backward analysis from STOP state.
     *
     * undefined during construction, populated by initFollowerFeatures().
     */
    followerFeatures: BitSet | undefined;

    /**
     * Grammar declaration order for deterministic sorting.
     * Used to ensure consistent serialization output.
     */
    orderID: number;

    /**
     * True for boolean assignments (?=).
     * Boolean assignments only match when the value is `true`.
     */
    readonly isBooleanAssignment: boolean;

    /**
     * State type marker for debugging and state identification.
     */
    readonly type: SemStateType;

    /**
     * For RULE_CALL states referencing parser rules, the expected AST type.
     * Used when searching for matching properties during serialization.
     */
    readonly ruleType: string | undefined;

    /**
     * True if this is an unassigned rule call that requires property search.
     * For parser rules: search for AST property matching ruleType.
     * For terminal rules: search for primitive property.
     */
    readonly isUnassignedRuleCall: boolean;
}

/**
 * Type markers for semantic states.
 */
export type SemStateType =
    | 'START'
    | 'STOP'
    | 'ASSIGNMENT'
    | 'KEYWORD'
    | 'RULE_CALL'
    | 'ACTION'
    | 'CROSS_REFERENCE'
    | 'EPSILON';  // Structural state for joins/loops that doesn't emit tokens

/**
 * Simple NFA interface following Xtext's pattern.
 *
 * An NFA (Non-deterministic Finite Automaton) has:
 * - A single start state
 * - A single stop state
 * - States may have multiple followers (non-determinism)
 *
 * @see https://github.com/eclipse/xtext/blob/main/org.eclipse.xtext/src/org/eclipse/xtext/util/formallang/Nfa.java
 */
export interface Nfa<S> {
    /**
     * Get the start state of the NFA.
     */
    getStart(): S;

    /**
     * Get the stop (accepting) state of the NFA.
     */
    getStop(): S;

    /**
     * Get the follower states of a given state.
     */
    getFollowers(state: S): S[];
}

/**
 * Concrete implementation of Nfa<SemState>.
 */
export class SemNfa implements Nfa<SemState> {
    constructor(
        private readonly start: SemState,
        private readonly stop: SemState
    ) {}

    getStart(): SemState {
        return this.start;
    }

    getStop(): SemState {
        return this.stop;
    }

    getFollowers(state: SemState): SemState[] {
        return state.followers;
    }
}

/**
 * Factory function to create a SemState.
 */
export function createSemState(
    grammarElement: AbstractElement,
    type: SemStateType,
    options?: {
        feature?: string;
        featureIndex?: number;
        isBooleanAssignment?: boolean;
        ruleType?: string;
        isUnassignedRuleCall?: boolean;
    }
): SemState {
    return {
        grammarElement,
        type,
        feature: options?.feature,
        featureIndex: options?.featureIndex ?? -1,
        followers: [],
        followerFeatures: undefined,
        orderID: 0,
        isBooleanAssignment: options?.isBooleanAssignment ?? false,
        ruleType: options?.ruleType,
        isUnassignedRuleCall: options?.isUnassignedRuleCall ?? false
    };
}

/**
 * Helper function to create a START state.
 */
export function createStartState(grammarElement: AbstractElement): SemState {
    return createSemState(grammarElement, 'START');
}

/**
 * Helper function to create a STOP state.
 */
export function createStopState(grammarElement: AbstractElement): SemState {
    return createSemState(grammarElement, 'STOP');
}

/**
 * Backtracking handler interface (from Xtext NfaUtil).
 *
 * This interface defines how the backtracking algorithm interacts with
 * the specific domain (serialization in our case).
 */
export interface BacktrackHandler<S, R> {
    /**
     * Handle transitioning to a new state.
     * @param state The state being entered
     * @param previous The current result/context
     * @returns A new result if the transition is valid, undefined to reject
     */
    handle(state: S, previous: R): R | undefined;

    /**
     * Check if the current result represents a complete solution.
     * @param result The current result
     * @returns True if this is a valid complete solution
     */
    isSolution(result: R): boolean;

    /**
     * Sort followers to optimize search order.
     * @param result The current result
     * @param followers The available follower states
     * @returns Sorted followers (iteration order determines search priority)
     */
    sortFollowers(result: R, followers: Iterable<S>): Iterable<S>;
}

/**
 * Map from AST type to feature name to feature index.
 * Used to map property names to BitSet indices.
 */
export type FeatureMap = Map<string, number>;

/**
 * Map from AST type to its FeatureMap.
 */
export type TypeFeatureMap = Map<string, FeatureMap>;
