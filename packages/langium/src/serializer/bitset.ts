/******************************************************************************
 * Copyright 2025 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

/**
 * Simple BitSet implementation for tracking reachable features during serialization.
 * Uses Uint32Array for efficient storage and operations.
 *
 * This is used by the NFA-based serializer to track which features can still be
 * reached from a given state, enabling early pruning during backtracking.
 */
export class BitSet {
    private data: Uint32Array;

    constructor(size: number = 32) {
        const words = Math.ceil(size / 32);
        this.data = new Uint32Array(words);
    }

    /**
     * Set the bit at the given index.
     */
    set(index: number): void {
        const wordIndex = Math.floor(index / 32);
        if (wordIndex >= this.data.length) {
            this.grow(wordIndex + 1);
        }
        const bitIndex = index % 32;
        this.data[wordIndex] |= (1 << bitIndex);
    }

    /**
     * Get the bit at the given index.
     */
    get(index: number): boolean {
        const wordIndex = Math.floor(index / 32);
        if (wordIndex >= this.data.length) {
            return false;
        }
        const bitIndex = index % 32;
        return (this.data[wordIndex] & (1 << bitIndex)) !== 0;
    }

    /**
     * Perform OR operation with another BitSet, modifying this BitSet in place.
     * Returns true if any bits were added (useful for fixed-point iteration).
     */
    or(other: BitSet): boolean {
        let changed = false;
        if (other.data.length > this.data.length) {
            this.grow(other.data.length);
        }
        for (let i = 0; i < other.data.length; i++) {
            const before = this.data[i];
            this.data[i] |= other.data[i];
            if (this.data[i] !== before) {
                changed = true;
            }
        }
        return changed;
    }

    /**
     * Check if this BitSet equals another BitSet.
     */
    equals(other: BitSet): boolean {
        const maxLen = Math.max(this.data.length, other.data.length);
        for (let i = 0; i < maxLen; i++) {
            const thisWord = i < this.data.length ? this.data[i] : 0;
            const otherWord = i < other.data.length ? other.data[i] : 0;
            if (thisWord !== otherWord) {
                return false;
            }
        }
        return true;
    }

    /**
     * Create a copy of this BitSet.
     */
    clone(): BitSet {
        const result = new BitSet(this.data.length * 32);
        result.data.set(this.data);
        return result;
    }

    /**
     * Check if this BitSet is empty (no bits set).
     */
    isEmpty(): boolean {
        for (let i = 0; i < this.data.length; i++) {
            if (this.data[i] !== 0) {
                return false;
            }
        }
        return true;
    }

    /**
     * Clear all bits.
     */
    clear(): void {
        this.data.fill(0);
    }

    /**
     * Get the number of bits that are set.
     */
    cardinality(): number {
        let count = 0;
        for (let i = 0; i < this.data.length; i++) {
            count += this.popCount(this.data[i]);
        }
        return count;
    }

    /**
     * Count the number of set bits in a 32-bit integer (population count).
     */
    private popCount(n: number): number {
        n = n - ((n >>> 1) & 0x55555555);
        n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
        n = (n + (n >>> 4)) & 0x0f0f0f0f;
        n = n + (n >>> 8);
        n = n + (n >>> 16);
        return n & 0x3f;
    }

    /**
     * Grow the internal array to accommodate at least the given number of words.
     */
    private grow(minWords: number): void {
        const newData = new Uint32Array(minWords);
        newData.set(this.data);
        this.data = newData;
    }

    /**
     * Return string representation for debugging.
     */
    toString(): string {
        const bits: number[] = [];
        for (let i = 0; i < this.data.length * 32; i++) {
            if (this.get(i)) {
                bits.push(i);
            }
        }
        return `{${bits.join(', ')}}`;
    }
}
