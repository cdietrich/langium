/******************************************************************************
 * Copyright 2025 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import { describe, expect, test } from 'vitest';
import type { AstNode } from '../../../src/syntax-tree.js';
import type { FeatureMap } from '../../../src/serializer/nfa-types.js';
import { SerializableObject } from '../../../src/serializer/serializable-object.js';

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

describe('SerializableObject', () => {

    describe('constructor', () => {
        test('should extract single values correctly', () => {
            const node = createMockNode({
                name: 'test',
                value: 42
            });
            const featureMap = createFeatureMap(['name', 'value']);
            const obj = new SerializableObject(node, featureMap);

            expect(obj.type).toBe('TestNode');
            expect(obj.featureCount).toBe(2);
            expect(obj.getValue(0, 0)).toBe('test');
            expect(obj.getValue(1, 0)).toBe(42);
        });

        test('should extract array values correctly', () => {
            const node = createMockNode({
                items: ['a', 'b', 'c']
            });
            const featureMap = createFeatureMap(['items']);
            const obj = new SerializableObject(node, featureMap);

            expect(obj.getValue(0, 0)).toBe('a');
            expect(obj.getValue(0, 1)).toBe('b');
            expect(obj.getValue(0, 2)).toBe('c');
        });

        test('should handle undefined/missing properties', () => {
            const node = createMockNode({
                name: 'test'
                // value is missing
            });
            const featureMap = createFeatureMap(['name', 'value']);
            const obj = new SerializableObject(node, featureMap);

            expect(obj.getValue(0, 0)).toBe('test');
            expect(obj.getValue(1, 0)).toBe(undefined);
        });
    });

    describe('getValueCount', () => {
        test('should return 1 for single values', () => {
            const node = createMockNode({
                name: 'test',
                count: 42,
                flag: true
            });
            const featureMap = createFeatureMap(['name', 'count', 'flag']);
            const obj = new SerializableObject(node, featureMap);

            expect(obj.getValueCount(0)).toBe(1);
            expect(obj.getValueCount(1)).toBe(1);
            expect(obj.getValueCount(2)).toBe(1);
        });

        test('should return array length for arrays', () => {
            const node = createMockNode({
                items: ['a', 'b', 'c'],
                empty: []
            });
            const featureMap = createFeatureMap(['items', 'empty']);
            const obj = new SerializableObject(node, featureMap);

            expect(obj.getValueCount(0)).toBe(3);
            expect(obj.getValueCount(1)).toBe(0); // empty array
        });

        test('should return 0 for undefined/missing properties', () => {
            const node = createMockNode({
                name: 'test'
            });
            const featureMap = createFeatureMap(['name', 'missing']);
            const obj = new SerializableObject(node, featureMap);

            expect(obj.getValueCount(0)).toBe(1);
            expect(obj.getValueCount(1)).toBe(0);
        });

        test('should return 0 for out-of-bounds featureIndex', () => {
            const node = createMockNode({ name: 'test' });
            const featureMap = createFeatureMap(['name']);
            const obj = new SerializableObject(node, featureMap);

            expect(obj.getValueCount(100)).toBe(0);
        });

        // NOTE: false is treated as 0 for boolean assignments (?=) which are optional.
        // When flag=false, the serializer should skip the optional element.
        test('should count false as 0 (for boolean assignments)', () => {
            const node = createMockNode({
                enabled: false
            });
            const featureMap = createFeatureMap(['enabled']);
            const obj = new SerializableObject(node, featureMap);

            expect(obj.getValueCount(0)).toBe(0);
            expect(obj.getValue(0, 0)).toBe(false); // raw value is still accessible
        });

        test('should count null as 1', () => {
            const node = createMockNode({
                value: null
            });
            const featureMap = createFeatureMap(['value']);
            const obj = new SerializableObject(node, featureMap);

            expect(obj.getValueCount(0)).toBe(1);
            expect(obj.getValue(0, 0)).toBe(null);
        });

        test('should count empty string as 1', () => {
            const node = createMockNode({
                name: ''
            });
            const featureMap = createFeatureMap(['name']);
            const obj = new SerializableObject(node, featureMap);

            expect(obj.getValueCount(0)).toBe(1);
            expect(obj.getValue(0, 0)).toBe('');
        });

        test('should count 0 as 1', () => {
            const node = createMockNode({
                count: 0
            });
            const featureMap = createFeatureMap(['count']);
            const obj = new SerializableObject(node, featureMap);

            expect(obj.getValueCount(0)).toBe(1);
            expect(obj.getValue(0, 0)).toBe(0);
        });
    });

    describe('getValue', () => {
        test('should return correct value for single at index 0', () => {
            const node = createMockNode({ name: 'test' });
            const featureMap = createFeatureMap(['name']);
            const obj = new SerializableObject(node, featureMap);

            expect(obj.getValue(0, 0)).toBe('test');
        });

        test('should return undefined for single at index > 0', () => {
            const node = createMockNode({ name: 'test' });
            const featureMap = createFeatureMap(['name']);
            const obj = new SerializableObject(node, featureMap);

            expect(obj.getValue(0, 1)).toBe(undefined);
            expect(obj.getValue(0, 10)).toBe(undefined);
        });

        test('should return correct array element at index', () => {
            const node = createMockNode({ items: ['a', 'b', 'c'] });
            const featureMap = createFeatureMap(['items']);
            const obj = new SerializableObject(node, featureMap);

            expect(obj.getValue(0, 0)).toBe('a');
            expect(obj.getValue(0, 1)).toBe('b');
            expect(obj.getValue(0, 2)).toBe('c');
            expect(obj.getValue(0, 3)).toBe(undefined);
        });

        test('should handle mixed single and array features', () => {
            const node = createMockNode({
                name: 'test',
                items: [1, 2, 3],
                flag: true
            });
            const featureMap = createFeatureMap(['name', 'items', 'flag']);
            const obj = new SerializableObject(node, featureMap);

            expect(obj.getValue(0, 0)).toBe('test');
            expect(obj.getValue(1, 0)).toBe(1);
            expect(obj.getValue(1, 1)).toBe(2);
            expect(obj.getValue(1, 2)).toBe(3);
            expect(obj.getValue(2, 0)).toBe(true);
        });
    });

    describe('getRawValue', () => {
        test('should return raw single value', () => {
            const node = createMockNode({ name: 'test' });
            const featureMap = createFeatureMap(['name']);
            const obj = new SerializableObject(node, featureMap);

            expect(obj.getRawValue(0)).toBe('test');
        });

        test('should return raw array value', () => {
            const items = ['a', 'b', 'c'];
            const node = createMockNode({ items });
            const featureMap = createFeatureMap(['items']);
            const obj = new SerializableObject(node, featureMap);

            expect(obj.getRawValue(0)).toEqual(['a', 'b', 'c']);
        });

        test('should return undefined for missing property', () => {
            const node = createMockNode({});
            const featureMap = createFeatureMap(['missing']);
            const obj = new SerializableObject(node, featureMap);

            expect(obj.getRawValue(0)).toBe(undefined);
        });
    });

    describe('isFullyConsumed', () => {
        test('should return true when all features consumed', () => {
            const node = createMockNode({
                name: 'test',
                items: ['a', 'b']
            });
            const featureMap = createFeatureMap(['name', 'items']);
            const obj = new SerializableObject(node, featureMap);

            // name: 1 value, items: 2 values
            // nextIndices [1, 2] means all consumed
            expect(obj.isFullyConsumed([1, 2])).toBe(true);
        });

        test('should return false when values remain', () => {
            const node = createMockNode({
                name: 'test',
                items: ['a', 'b']
            });
            const featureMap = createFeatureMap(['name', 'items']);
            const obj = new SerializableObject(node, featureMap);

            expect(obj.isFullyConsumed([1, 1])).toBe(false); // items has 1 remaining
            expect(obj.isFullyConsumed([0, 2])).toBe(false); // name has 1 remaining
            expect(obj.isFullyConsumed([0, 0])).toBe(false); // all remaining
        });

        test('should handle missing values correctly', () => {
            const node = createMockNode({
                name: 'test'
                // items is missing
            });
            const featureMap = createFeatureMap(['name', 'items']);
            const obj = new SerializableObject(node, featureMap);

            // items has 0 values, so [1, 0] means fully consumed
            expect(obj.isFullyConsumed([1, 0])).toBe(true);
            expect(obj.isFullyConsumed([0, 0])).toBe(false);
        });

        test('should handle empty arrays correctly', () => {
            const node = createMockNode({
                items: []
            });
            const featureMap = createFeatureMap(['items']);
            const obj = new SerializableObject(node, featureMap);

            // empty array has 0 values
            expect(obj.isFullyConsumed([0])).toBe(true);
        });
    });

    describe('node and type properties', () => {
        test('should preserve node reference', () => {
            const node = createMockNode({ name: 'test' });
            const featureMap = createFeatureMap(['name']);
            const obj = new SerializableObject(node, featureMap);

            expect(obj.node).toBe(node);
        });

        test('should extract type from node.$type', () => {
            const node = {
                $type: 'MyCustomType',
                name: 'test'
            } as unknown as AstNode;
            const featureMap = createFeatureMap(['name']);
            const obj = new SerializableObject(node, featureMap);

            expect(obj.type).toBe('MyCustomType');
        });
    });

    describe('complex values', () => {
        test('should handle object values', () => {
            const ref = { ref: { $type: 'Target' }, $refText: 'target' };
            const node = createMockNode({
                reference: ref
            });
            const featureMap = createFeatureMap(['reference']);
            const obj = new SerializableObject(node, featureMap);

            expect(obj.getValueCount(0)).toBe(1);
            expect(obj.getValue(0, 0)).toBe(ref);
        });

        test('should handle array of objects', () => {
            const refs = [
                { ref: { $type: 'A' }, $refText: 'a' },
                { ref: { $type: 'B' }, $refText: 'b' }
            ];
            const node = createMockNode({
                references: refs
            });
            const featureMap = createFeatureMap(['references']);
            const obj = new SerializableObject(node, featureMap);

            expect(obj.getValueCount(0)).toBe(2);
            expect(obj.getValue(0, 0)).toBe(refs[0]);
            expect(obj.getValue(0, 1)).toBe(refs[1]);
        });
    });
});
