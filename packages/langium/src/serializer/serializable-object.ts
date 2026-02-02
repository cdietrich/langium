/******************************************************************************
 * Copyright 2025 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { AstNode, GenericAstNode } from '../syntax-tree.js';
import type { FeatureMap } from './nfa-types.js';

/**
 * Wraps an AstNode with pre-computed serialization metadata.
 *
 * Purpose: Avoid repeated property lookups and provide uniform access to feature
 * values regardless of whether they're single values or arrays.
 *
 * In Xtext, this also handles:
 * - Transient values (ITransientValueService) - skipped in v1
 * - Node model references for formatting preservation - skipped in v1
 * - Content validation caching - skipped in v1
 *
 * @see https://github.com/eclipse/xtext/blob/main/org.eclipse.xtext/src/org/eclipse/xtext/serializer/sequencer/BacktrackingSemanticSequencer.java
 */
export class SerializableObject {
    /** The wrapped AST node */
    readonly node: AstNode;

    /** The AST type name */
    readonly type: string;

    /** Number of features tracked */
    readonly featureCount: number;

    /** Pre-extracted values indexed by featureIndex */
    private readonly values: unknown[];

    /** Feature count per index (1 for single, length for array, 0 for missing) */
    private readonly valueCounts: number[];

    constructor(node: AstNode, featureMap: FeatureMap, booleanAssignmentOnly: Set<number>) {
        this.node = node;
        this.type = node.$type;
        this.featureCount = featureMap.size;
        this.values = new Array(featureMap.size);
        this.valueCounts = new Array(featureMap.size);

        for (const [feature, index] of featureMap) {
            const value = (node as GenericAstNode)[feature];
            this.values[index] = value;
            this.valueCounts[index] = this.computeValueCount(value, index, booleanAssignmentOnly);
        }
    }

    /**
     * Get the value at a specific feature and array index.
     * For single values, arrayIndex is expected to be 0.
     * For arrays, arrayIndex indexes into the array.
     */
    getValue(featureIndex: number, arrayIndex: number): unknown {
        const value = this.values[featureIndex];
        if (Array.isArray(value)) {
            return value[arrayIndex];
        }
        // Single value - only index 0 is valid
        return arrayIndex === 0 ? value : undefined;
    }

    /**
     * Get the raw value for a feature (may be array or single value).
     */
    getRawValue(featureIndex: number): unknown {
        return this.values[featureIndex];
    }

    /**
     * Get the number of values for a feature.
     * Returns:
     * - 0 for undefined/missing
     * - 1 for single values (including null, false, 0, empty string)
     * - Array length for arrays
     */
    getValueCount(featureIndex: number): number {
        return this.valueCounts[featureIndex] ?? 0;
    }

    /**
     * Check if all features have been consumed at the given indices.
     * Used by TraceItem.isConsumed() to check if serialization is complete.
     */
    isFullyConsumed(nextIndices: number[]): boolean {
        for (let i = 0; i < this.valueCounts.length; i++) {
            const nextIndex = nextIndices[i] ?? 0;
            if (nextIndex < this.valueCounts[i]) {
                return false;
            }
        }
        return true;
    }

    /**
     * Compute the value count for a given value.
     * This determines how many "consumptions" are needed for this feature.
     *
     * Important: For boolean values, `false` counts as 0 (no value to emit).
     * This is because boolean assignments (`?=`) use `true` to mean "emit this"
     * and `false`/`undefined` to mean "skip this".
     */
    private computeValueCount(value: unknown, featureIndex: number, booleanAssignmentOnly: Set<number>): number {
        if (value === undefined) {
            return 0;
        }
        if (value === false && booleanAssignmentOnly.has(featureIndex)) {
            return 0;
        }
        if (Array.isArray(value)) {
            return value.length;
        }
        // Single value - counts as 1
        // This includes: strings, numbers, true, objects, null
        return 1;
    }
}
