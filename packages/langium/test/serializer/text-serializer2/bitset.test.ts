/******************************************************************************
 * Copyright 2025 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import { describe, expect, test } from 'vitest';
import { BitSet } from '../../../src/serializer/bitset.js';

describe('BitSet', () => {

    describe('set and get', () => {
        test('should set and get single bits', () => {
            const bs = new BitSet(32);
            expect(bs.get(0)).toBe(false);
            expect(bs.get(5)).toBe(false);

            bs.set(0);
            bs.set(5);

            expect(bs.get(0)).toBe(true);
            expect(bs.get(5)).toBe(true);
            expect(bs.get(1)).toBe(false);
            expect(bs.get(4)).toBe(false);
        });

        test('should handle bit 31 (last bit of first word)', () => {
            const bs = new BitSet(32);
            bs.set(31);
            expect(bs.get(31)).toBe(true);
            expect(bs.get(30)).toBe(false);
            expect(bs.get(32)).toBe(false);
        });

        test('should handle bit 32 boundary (first bit of second word)', () => {
            const bs = new BitSet(64);
            bs.set(31);
            bs.set(32);
            bs.set(33);

            expect(bs.get(31)).toBe(true);
            expect(bs.get(32)).toBe(true);
            expect(bs.get(33)).toBe(true);
            expect(bs.get(30)).toBe(false);
            expect(bs.get(34)).toBe(false);
        });

        test('should auto-grow when setting bits beyond initial size', () => {
            const bs = new BitSet(32);
            bs.set(100);

            expect(bs.get(100)).toBe(true);
            expect(bs.get(99)).toBe(false);
            expect(bs.get(101)).toBe(false);
        });

        test('should handle large indices (> 64 features)', () => {
            const bs = new BitSet(32);
            const indices = [0, 31, 32, 63, 64, 100, 127, 128, 200];

            for (const idx of indices) {
                bs.set(idx);
            }

            for (const idx of indices) {
                expect(bs.get(idx)).toBe(true);
            }

            expect(bs.get(50)).toBe(false);
            expect(bs.get(150)).toBe(false);
        });

        test('should return false for unset bits beyond size', () => {
            const bs = new BitSet(32);
            expect(bs.get(1000)).toBe(false);
        });
    });

    describe('or', () => {
        test('should combine bits from another BitSet', () => {
            const bs1 = new BitSet(32);
            bs1.set(0);
            bs1.set(2);

            const bs2 = new BitSet(32);
            bs2.set(1);
            bs2.set(2);
            bs2.set(3);

            bs1.or(bs2);

            expect(bs1.get(0)).toBe(true);
            expect(bs1.get(1)).toBe(true);
            expect(bs1.get(2)).toBe(true);
            expect(bs1.get(3)).toBe(true);
            expect(bs1.get(4)).toBe(false);
        });

        test('should grow if other BitSet is larger', () => {
            const bs1 = new BitSet(32);
            bs1.set(0);

            const bs2 = new BitSet(128);
            bs2.set(100);

            bs1.or(bs2);

            expect(bs1.get(0)).toBe(true);
            expect(bs1.get(100)).toBe(true);
        });

        test('should return true if bits were added', () => {
            const bs1 = new BitSet(32);
            bs1.set(0);

            const bs2 = new BitSet(32);
            bs2.set(1);

            expect(bs1.or(bs2)).toBe(true);
        });

        test('should return false if no bits were added', () => {
            const bs1 = new BitSet(32);
            bs1.set(0);
            bs1.set(1);

            const bs2 = new BitSet(32);
            bs2.set(0);

            expect(bs1.or(bs2)).toBe(false);
        });

        test('should not modify the other BitSet', () => {
            const bs1 = new BitSet(32);
            bs1.set(0);

            const bs2 = new BitSet(32);
            bs2.set(1);

            bs1.or(bs2);

            expect(bs2.get(0)).toBe(false);
            expect(bs2.get(1)).toBe(true);
        });
    });

    describe('equals', () => {
        test('should return true for equal BitSets', () => {
            const bs1 = new BitSet(32);
            bs1.set(0);
            bs1.set(5);
            bs1.set(31);

            const bs2 = new BitSet(32);
            bs2.set(0);
            bs2.set(5);
            bs2.set(31);

            expect(bs1.equals(bs2)).toBe(true);
        });

        test('should return false for different BitSets', () => {
            const bs1 = new BitSet(32);
            bs1.set(0);

            const bs2 = new BitSet(32);
            bs2.set(1);

            expect(bs1.equals(bs2)).toBe(false);
        });

        test('should handle BitSets of different sizes', () => {
            const bs1 = new BitSet(32);
            bs1.set(0);

            const bs2 = new BitSet(128);
            bs2.set(0);

            // They should be equal if all set bits are the same
            expect(bs1.equals(bs2)).toBe(true);

            bs2.set(100);
            expect(bs1.equals(bs2)).toBe(false);
        });

        test('should return true for two empty BitSets', () => {
            const bs1 = new BitSet(32);
            const bs2 = new BitSet(64);
            expect(bs1.equals(bs2)).toBe(true);
        });
    });

    describe('clone', () => {
        test('should create an independent copy', () => {
            const bs1 = new BitSet(32);
            bs1.set(0);
            bs1.set(5);

            const bs2 = bs1.clone();

            expect(bs2.get(0)).toBe(true);
            expect(bs2.get(5)).toBe(true);

            // Modifying clone should not affect original
            bs2.set(10);
            expect(bs2.get(10)).toBe(true);
            expect(bs1.get(10)).toBe(false);

            // Modifying original should not affect clone
            bs1.set(15);
            expect(bs1.get(15)).toBe(true);
            expect(bs2.get(15)).toBe(false);
        });

        test('should clone large BitSets correctly', () => {
            const bs1 = new BitSet(32);
            bs1.set(0);
            bs1.set(50);
            bs1.set(100);

            const bs2 = bs1.clone();

            expect(bs2.get(0)).toBe(true);
            expect(bs2.get(50)).toBe(true);
            expect(bs2.get(100)).toBe(true);
            expect(bs1.equals(bs2)).toBe(true);
        });
    });

    describe('isEmpty', () => {
        test('should return true for new BitSet', () => {
            const bs = new BitSet(32);
            expect(bs.isEmpty()).toBe(true);
        });

        test('should return false when bits are set', () => {
            const bs = new BitSet(32);
            bs.set(5);
            expect(bs.isEmpty()).toBe(false);
        });

        test('should return true after clearing', () => {
            const bs = new BitSet(32);
            bs.set(5);
            bs.clear();
            expect(bs.isEmpty()).toBe(true);
        });
    });

    describe('clear', () => {
        test('should clear all bits', () => {
            const bs = new BitSet(64);
            bs.set(0);
            bs.set(31);
            bs.set(32);
            bs.set(63);

            bs.clear();

            expect(bs.get(0)).toBe(false);
            expect(bs.get(31)).toBe(false);
            expect(bs.get(32)).toBe(false);
            expect(bs.get(63)).toBe(false);
            expect(bs.isEmpty()).toBe(true);
        });
    });

    describe('cardinality', () => {
        test('should return 0 for empty BitSet', () => {
            const bs = new BitSet(32);
            expect(bs.cardinality()).toBe(0);
        });

        test('should count set bits correctly', () => {
            const bs = new BitSet(64);
            bs.set(0);
            bs.set(1);
            bs.set(31);
            bs.set(32);
            bs.set(63);

            expect(bs.cardinality()).toBe(5);
        });

        test('should handle sparse bits across words', () => {
            const bs = new BitSet(32);
            bs.set(10);
            bs.set(50);
            bs.set(100);

            expect(bs.cardinality()).toBe(3);
        });
    });

    describe('toString', () => {
        test('should return string representation', () => {
            const bs = new BitSet(32);
            bs.set(0);
            bs.set(5);
            bs.set(10);

            expect(bs.toString()).toBe('{0, 5, 10}');
        });

        test('should return empty set for empty BitSet', () => {
            const bs = new BitSet(32);
            expect(bs.toString()).toBe('{}');
        });
    });
});
