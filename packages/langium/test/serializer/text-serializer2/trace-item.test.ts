/******************************************************************************
 * Copyright 2025 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import { describe, expect, test } from 'vitest';
import type { AstNode } from '../../../src/syntax-tree.js';
import type { SemState } from '../../../src/serializer/nfa-types.js';
import type { FeatureMap } from '../../../src/serializer/nfa-types.js';
import { BitSet } from '../../../src/serializer/bitset.js';
import { SerializableObject } from '../../../src/serializer/serializable-object.js';
import { TraceItem } from '../../../src/serializer/trace-item.js';

function createMockNode(props: Record<string, unknown>): AstNode {
    return {
        $type: 'TestNode',
        ...props
    } as unknown as AstNode;
}

function createFeatureMap(features: string[]): FeatureMap {
    const map = new Map<string, number>();
    features.forEach((f, i) => map.set(f, i));
    return map;
}

function createMockState(options: {
    feature?: string;
    featureIndex?: number;
    isBooleanAssignment?: boolean;
    followerFeatures?: BitSet;
}): SemState {
    return {
        grammarElement: {} as never,
        type: 'ASSIGNMENT',
        feature: options.feature,
        featureIndex: options.featureIndex ?? -1,
        followers: [],
        followerFeatures: options.followerFeatures,
        orderID: 0,
        isBooleanAssignment: options.isBooleanAssignment ?? false,
        ruleType: undefined,
        isUnassignedRuleCall: false
    };
}

describe('TraceItem', () => {

    describe('clone', () => {
        test('should share nextIndex array (reference equality)', () => {
            const node = createMockNode({ name: 'test' });
            const featureMap = createFeatureMap(['name']);
            const obj = new SerializableObject(node, featureMap);
            const original = TraceItem.createInitial(obj);

            const state = createMockState({ feature: undefined, featureIndex: -1 });
            const cloned = original.clone(state);

            // Should share the same nextIndex array
            expect(cloned.nextIndex).toBe(original.nextIndex);
            expect(cloned.state).toBe(state);
            expect(cloned.obj).toBe(original.obj);
        });

        test('should not copy consumed values', () => {
            const node = createMockNode({ name: 'test' });
            const featureMap = createFeatureMap(['name']);
            const obj = new SerializableObject(node, featureMap);
            const original = TraceItem.createInitial(obj);
            original.value = 'some-value';
            original.index = 5;

            const state = createMockState({});
            const cloned = original.clone(state);

            // Cloned item should have default values, not copied
            expect(cloned.value).toBe(undefined);
            expect(cloned.index).toBe(-1);
        });
    });

    describe('cloneAndConsume', () => {
        test('should copy nextIndex array (different reference)', () => {
            const node = createMockNode({ name: 'test' });
            const featureMap = createFeatureMap(['name']);
            const obj = new SerializableObject(node, featureMap);
            const original = TraceItem.createInitial(obj);

            const state = createMockState({ feature: 'name', featureIndex: 0 });
            const consumed = original.cloneAndConsume(state);

            expect(consumed).toBeDefined();
            // Should have different nextIndex array (copied)
            expect(consumed!.nextIndex).not.toBe(original.nextIndex);
        });

        test('should increment correct feature index', () => {
            const node = createMockNode({
                name: 'test',
                value: 42
            });
            const featureMap = createFeatureMap(['name', 'value']);
            const obj = new SerializableObject(node, featureMap);
            const original = TraceItem.createInitial(obj);

            // Consume 'value' (index 1)
            const state = createMockState({ feature: 'value', featureIndex: 1 });
            const consumed = original.cloneAndConsume(state);

            expect(consumed).toBeDefined();
            expect(original.nextIndex).toEqual([0, 0]); // unchanged
            expect(consumed!.nextIndex).toEqual([0, 1]); // value index incremented
        });

        test('should set consumed value and index', () => {
            const node = createMockNode({ name: 'test' });
            const featureMap = createFeatureMap(['name']);
            const obj = new SerializableObject(node, featureMap);
            const original = TraceItem.createInitial(obj);

            const state = createMockState({ feature: 'name', featureIndex: 0 });
            const consumed = original.cloneAndConsume(state);

            expect(consumed).toBeDefined();
            expect(consumed!.value).toBe('test');
            expect(consumed!.index).toBe(0);
        });

        test('should return undefined when no value available', () => {
            const node = createMockNode({ name: 'test' });
            const featureMap = createFeatureMap(['name', 'value']);
            const obj = new SerializableObject(node, featureMap);
            const original = TraceItem.createInitial(obj);

            // Try to consume 'value' which is undefined
            const state = createMockState({ feature: 'value', featureIndex: 1 });
            const consumed = original.cloneAndConsume(state);

            expect(consumed).toBeUndefined();
        });

        test('should return undefined when feature already fully consumed', () => {
            const node = createMockNode({ name: 'test' });
            const featureMap = createFeatureMap(['name']);
            const obj = new SerializableObject(node, featureMap);
            const original = TraceItem.createInitial(obj);

            const state = createMockState({ feature: 'name', featureIndex: 0 });

            // First consumption succeeds
            const first = original.cloneAndConsume(state);
            expect(first).toBeDefined();

            // Second consumption from same point succeeds
            const second = original.cloneAndConsume(state);
            expect(second).toBeDefined();

            // But consuming from the already-consumed item fails
            const third = first!.cloneAndConsume(state);
            expect(third).toBeUndefined();
        });

        test('should handle array values correctly', () => {
            const node = createMockNode({ items: ['a', 'b', 'c'] });
            const featureMap = createFeatureMap(['items']);
            const obj = new SerializableObject(node, featureMap);
            let item = TraceItem.createInitial(obj);

            const state = createMockState({ feature: 'items', featureIndex: 0 });

            // Consume first
            item = item.cloneAndConsume(state)!;
            expect(item.value).toBe('a');
            expect(item.index).toBe(0);
            expect(item.nextIndex).toEqual([1]);

            // Consume second
            item = item.cloneAndConsume(state)!;
            expect(item.value).toBe('b');
            expect(item.index).toBe(1);
            expect(item.nextIndex).toEqual([2]);

            // Consume third
            item = item.cloneAndConsume(state)!;
            expect(item.value).toBe('c');
            expect(item.index).toBe(2);
            expect(item.nextIndex).toEqual([3]);

            // No more
            const fourth = item.cloneAndConsume(state);
            expect(fourth).toBeUndefined();
        });

        test('should return undefined for START/STOP states (featureIndex -1)', () => {
            const node = createMockNode({ name: 'test' });
            const featureMap = createFeatureMap(['name']);
            const obj = new SerializableObject(node, featureMap);
            const original = TraceItem.createInitial(obj);

            const startState = createMockState({ featureIndex: -1 });
            const consumed = original.cloneAndConsume(startState);

            expect(consumed).toBeUndefined();
        });
    });

    describe('isConsumed', () => {
        test('should return true when all features consumed', () => {
            const node = createMockNode({
                name: 'test',
                items: ['a', 'b']
            });
            const featureMap = createFeatureMap(['name', 'items']);
            const obj = new SerializableObject(node, featureMap);

            // Manually create item with all consumed
            const item = new TraceItem(obj, [1, 2]);
            expect(item.isConsumed()).toBe(true);
        });

        test('should return false when values remain', () => {
            const node = createMockNode({
                name: 'test',
                items: ['a', 'b']
            });
            const featureMap = createFeatureMap(['name', 'items']);
            const obj = new SerializableObject(node, featureMap);

            const item = TraceItem.createInitial(obj);
            expect(item.isConsumed()).toBe(false);
        });

        test('should return true for node with no values', () => {
            const node = createMockNode({});
            const featureMap = createFeatureMap(['name']);
            const obj = new SerializableObject(node, featureMap);

            const item = TraceItem.createInitial(obj);
            // No values to consume, so already "consumed"
            expect(item.isConsumed()).toBe(true);
        });

        test('should handle partial consumption correctly', () => {
            const node = createMockNode({
                name: 'test',
                value: 42
            });
            const featureMap = createFeatureMap(['name', 'value']);
            const obj = new SerializableObject(node, featureMap);

            // name consumed, value not
            const item = new TraceItem(obj, [1, 0]);
            expect(item.isConsumed()).toBe(false);

            // both consumed
            const item2 = new TraceItem(obj, [1, 1]);
            expect(item2.isConsumed()).toBe(true);
        });
    });

    describe('canEnter', () => {
        test('should return false for boolean assignment without true value', () => {
            const node = createMockNode({ enabled: false });
            const featureMap = createFeatureMap(['enabled']);
            const obj = new SerializableObject(node, featureMap);
            const item = TraceItem.createInitial(obj);

            const state = createMockState({
                feature: 'enabled',
                featureIndex: 0,
                isBooleanAssignment: true
            });

            expect(item.canEnter(state)).toBe(false);
        });

        test('should return true for boolean assignment with true value', () => {
            const node = createMockNode({ enabled: true });
            const featureMap = createFeatureMap(['enabled']);
            const obj = new SerializableObject(node, featureMap);
            const item = TraceItem.createInitial(obj);

            const state = createMockState({
                feature: 'enabled',
                featureIndex: 0,
                isBooleanAssignment: true
            });

            expect(item.canEnter(state)).toBe(true);
        });

        test('should return false for unreachable features (BitSet pruning)', () => {
            const node = createMockNode({
                name: 'test',
                value: 42
            });
            const featureMap = createFeatureMap(['name', 'value']);
            const obj = new SerializableObject(node, featureMap);
            const item = TraceItem.createInitial(obj);

            // Create a state where only feature 0 (name) is reachable
            const followerFeatures = new BitSet(32);
            followerFeatures.set(0); // only name is reachable

            const state = createMockState({
                feature: 'name',
                featureIndex: 0,
                followerFeatures
            });

            // value (index 1) has unconsumed values but is not reachable
            expect(item.canEnter(state)).toBe(false);
        });

        test('should return true when all remaining features are reachable', () => {
            const node = createMockNode({
                name: 'test',
                value: 42
            });
            const featureMap = createFeatureMap(['name', 'value']);
            const obj = new SerializableObject(node, featureMap);
            const item = TraceItem.createInitial(obj);

            // Both features are reachable
            const followerFeatures = new BitSet(32);
            followerFeatures.set(0);
            followerFeatures.set(1);

            const state = createMockState({
                feature: 'name',
                featureIndex: 0,
                followerFeatures
            });

            expect(item.canEnter(state)).toBe(true);
        });

        test('should ignore already consumed features in reachability check', () => {
            const node = createMockNode({
                name: 'test',
                value: 42
            });
            const featureMap = createFeatureMap(['name', 'value']);
            const obj = new SerializableObject(node, featureMap);

            // value already consumed (index 1)
            const item = new TraceItem(obj, [0, 1]);

            // Only name is reachable, but value is already consumed
            const followerFeatures = new BitSet(32);
            followerFeatures.set(0);

            const state = createMockState({
                feature: 'name',
                featureIndex: 0,
                followerFeatures
            });

            // Should pass because value is already consumed
            expect(item.canEnter(state)).toBe(true);
        });

        test('should skip reachability check for the feature being consumed', () => {
            const node = createMockNode({
                name: 'test'
            });
            const featureMap = createFeatureMap(['name']);
            const obj = new SerializableObject(node, featureMap);
            const item = TraceItem.createInitial(obj);

            // Empty followerFeatures - nothing reachable after this state
            const followerFeatures = new BitSet(32);

            const state = createMockState({
                feature: 'name',
                featureIndex: 0,
                followerFeatures
            });

            // Should pass because we're consuming name, so we skip checking it
            expect(item.canEnter(state)).toBe(true);
        });

        test('should return true when followerFeatures is undefined', () => {
            const node = createMockNode({
                name: 'test',
                value: 42
            });
            const featureMap = createFeatureMap(['name', 'value']);
            const obj = new SerializableObject(node, featureMap);
            const item = TraceItem.createInitial(obj);

            // followerFeatures not set - can't prune
            const state = createMockState({
                feature: 'name',
                featureIndex: 0,
                followerFeatures: undefined
            });

            expect(item.canEnter(state)).toBe(true);
        });

        test('should handle empty node correctly', () => {
            const node = createMockNode({});
            const featureMap = createFeatureMap(['name']);
            const obj = new SerializableObject(node, featureMap);
            const item = TraceItem.createInitial(obj);

            const followerFeatures = new BitSet(32);
            // name not reachable, but that's ok because there's no value

            const state = createMockState({
                featureIndex: -1, // START state
                followerFeatures
            });

            expect(item.canEnter(state)).toBe(true);
        });
    });

    describe('createInitial', () => {
        test('should create item with all indices at 0', () => {
            const node = createMockNode({
                name: 'test',
                items: ['a', 'b'],
                value: 42
            });
            const featureMap = createFeatureMap(['name', 'items', 'value']);
            const obj = new SerializableObject(node, featureMap);

            const item = TraceItem.createInitial(obj);

            expect(item.nextIndex).toEqual([0, 0, 0]);
            expect(item.obj).toBe(obj);
            expect(item.state).toBeUndefined();
            expect(item.value).toBeUndefined();
            expect(item.index).toBe(-1);
        });

        test('should create item with correct feature count', () => {
            const node = createMockNode({ a: 1, b: 2, c: 3, d: 4, e: 5 });
            const featureMap = createFeatureMap(['a', 'b', 'c', 'd', 'e']);
            const obj = new SerializableObject(node, featureMap);

            const item = TraceItem.createInitial(obj);

            expect(item.nextIndex.length).toBe(5);
        });
    });

    describe('integration scenarios', () => {
        test('should support full consumption workflow', () => {
            const node = createMockNode({
                name: 'foo',
                values: [1, 2]
            });
            const featureMap = createFeatureMap(['name', 'values']);
            const obj = new SerializableObject(node, featureMap);

            let item = TraceItem.createInitial(obj);
            expect(item.isConsumed()).toBe(false);

            // Consume name
            const nameState = createMockState({ feature: 'name', featureIndex: 0 });
            item = item.cloneAndConsume(nameState)!;
            expect(item.value).toBe('foo');
            expect(item.isConsumed()).toBe(false);

            // Consume first value
            const valuesState = createMockState({ feature: 'values', featureIndex: 1 });
            item = item.cloneAndConsume(valuesState)!;
            expect(item.value).toBe(1);
            expect(item.isConsumed()).toBe(false);

            // Consume second value
            item = item.cloneAndConsume(valuesState)!;
            expect(item.value).toBe(2);
            expect(item.isConsumed()).toBe(true);
        });

        test('should allow backtracking by keeping original item unchanged', () => {
            const node = createMockNode({ choice: 'A' });
            const featureMap = createFeatureMap(['choice']);
            const obj = new SerializableObject(node, featureMap);

            const original = TraceItem.createInitial(obj);

            // Try path 1
            const state1 = createMockState({ feature: 'choice', featureIndex: 0 });
            const path1 = original.cloneAndConsume(state1);
            expect(path1).toBeDefined();
            expect(path1!.nextIndex).toEqual([1]);

            // Original unchanged - can try path 2
            expect(original.nextIndex).toEqual([0]);

            // Path 2 from original also works
            const path2 = original.cloneAndConsume(state1);
            expect(path2).toBeDefined();
            expect(path2!.nextIndex).toEqual([1]);
        });
    });
});
