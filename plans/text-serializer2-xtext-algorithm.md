# Implementation Plan: TextSerializer2 (Xtext-style Algorithm)

## Goal

Create `TextSerializer2` in Langium that implements Xtext's NFA-based serialization algorithm. The Xtext approach may be more robust and complete, handling more grammar patterns than the current grammar-driven traversal approach.

---

## Architecture Overview

The Xtext algorithm uses a **two-phase approach**:

### Phase A: Static Analysis (one-time, on grammar load)
```
Grammar → PDA → Semantic NFA + BitSet metadata
```

### Phase B: Runtime Serialization (per AST node)
```
AST Node → NFA backtracking search → Token stream
```

---

## Implementation Steps

### Step 1: Define Core Data Structures

**File:** `packages/langium/src/serializer/text-serializer2.ts`

```typescript
// NFA State representing a semantic assignment point
interface SemState {
    grammarElement: AbstractElement;     // The grammar element
    feature: string | undefined;         // EMF feature name (undefined for START/STOP)
    featureIndex: number;               // Feature ID for BitSet operations
    followers: SemState[];              // Successor states
    followerFeatures: BitSet;           // Features reachable from this state
    orderID: number;                    // Grammar declaration order
    isBooleanAssignment: boolean;       // Is this a ?= assignment
}

// Simple BitSet implementation
class BitSet {
    set(index: number): void;
    get(index: number): boolean;
    or(other: BitSet): void;
}

// Trace item for backtracking
interface TraceItem {
    state: SemState;
    nextIndex: number[];      // Next index to consume per feature
    value: unknown;           // Consumed value
    node: AstNode;           // Current AST node
}
```

### Step 2: Implement NFA Builder

**Build semantic NFA from grammar rules:**

1. Collect all assignments in a rule → these become NFA states
2. Build follower relationships (which assignments can follow which)
3. **Critical:** Compute `followerFeatures` BitSet via backward analysis
   - Each state knows which features are still reachable

```typescript
class NfaBuilder {
    buildNfa(rule: ParserRule, type: string): Nfa<SemState>;

    // Backward analysis to compute followerFeatures
    private initFollowerFeatures(nfa: Nfa<SemState>): void;
}
```

### Step 3: Implement Backtracking Serializer

**Runtime backtracking search through NFA:**

```typescript
class TextSerializer2 implements TextSerializer {
    // Cache: type name → NFA
    private nfaCache = new Map<string, Nfa<SemState>>();

    serialize(node: AstNode, options?: TextSerializeOptions): string {
        const nfa = this.getNfa(node.$type);
        const trace = this.backtrack(nfa, node);
        return this.emitTokens(trace, options);
    }

    private backtrack(nfa: Nfa<SemState>, node: AstNode): TraceItem[] | undefined {
        // Depth-first search with BitSet pruning
    }

    private canEnter(state: SemState, traceItem: TraceItem): boolean {
        // Check if all remaining features are reachable
        // This is where BitSet pruning happens
    }
}
```

### Step 4: Implement BitSet Pruning

**The key optimization from Xtext:**

```typescript
private canEnter(state: SemState, item: TraceItem, node: AstNode): boolean {
    // For each feature with remaining values
    for (let i = 0; i < item.nextIndex.length; i++) {
        const remaining = this.getValueCount(node, i) - item.nextIndex[i];
        if (remaining > 0) {
            // Is this feature reachable from the candidate state?
            if (!state.followerFeatures.get(i)) {
                return false;  // PRUNE: feature not reachable!
            }
        }
    }
    return true;
}
```

### Step 5: Implement Follower Sorting

**Heuristics to reduce backtracking:**

```typescript
private sortFollowers(followers: SemState[], node: AstNode): SemState[] {
    return followers.sort((a, b) => {
        // 1. Structural states (null feature) first
        if (!a.feature) return -1;
        if (!b.feature) return 1;

        // 2. Features with values before empty
        const aCount = this.getValueCount(node, a.featureIndex);
        const bCount = this.getValueCount(node, b.featureIndex);
        if (aCount > 0 && bCount === 0) return -1;
        if (bCount > 0 && aCount === 0) return 1;

        // 3. Grammar declaration order
        return a.orderID - b.orderID;
    });
}
```

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/langium/src/serializer/text-serializer2.ts` | **Create** | New serializer implementation |
| `packages/langium/src/serializer/nfa-builder.ts` | **Create** | NFA construction from grammar |
| `packages/langium/src/serializer/bitset.ts` | **Create** | Simple BitSet implementation |
| `packages/langium/src/serializer/index.ts` | Modify | Export new serializer |
| `packages/langium/src/default-module.ts` | Optional | Register as alternative |
| `packages/langium/test/serializer/text-serializer2.test.ts` | **Create** | Tests copied from text-serializer.test.ts |
| `packages/langium/test/serializer/text-serializer2-lotse-apis.test.ts` | **Create** | Tests copied from lotse-apis test |

---

## Testing Strategy

### Copy Existing Test Cases

The existing test files provide comprehensive coverage - we'll copy them for TextSerializer2:

**From `text-serializer.test.ts` (~692 lines):**
- Basic serialization (tokens, references)
- Boolean assignments (`?=`)
- Alternatives with primitives
- Data type rules and strings
- Unassigned terminal/rule calls
- Multiple references with separators
- Primitive lists with separators
- Repeated assignments in groups
- Unordered group assignments
- Optional and nested groups
- Union type arrays
- Fragment rules
- BooleanLiteral pattern (`value?='true' | 'false'`)
- Infers type collision handling
- Union/alias rules
- `serializeValue` hook

**From `text-serializer-lotse-apis.test.ts` (~904 lines):**
- Real-world LotseAPIs grammar
- ApplicationEndpoint roundtrip
- RemoteProxy roundtrip
- ApplicationApi roundtrip
- Complex nested types, annotations

### Test Approach

1. **Copy test files**, rename to `text-serializer2*.test.ts`
2. **Change import** to use `TextSerializer2`
3. **Run tests** - initially many will fail
4. **Iterate** - fix implementation until tests pass
5. **Compare** - verify output matches `DefaultTextSerializer` where expected

---

## Implementation Order

### Milestone 1: Core NFA Structure
1. Create `BitSet` class
2. Define `SemState` and `Nfa` interfaces
3. Create basic `NfaBuilder` that extracts assignments from rules

### Milestone 2: Backtracking Engine
1. Implement basic backtracking without pruning
2. Add `TraceItem` for tracking state
3. Verify basic serialization works

### Milestone 3: BitSet Pruning (Key Optimization)
1. Implement backward analysis for `followerFeatures`
2. Add `canEnter` pruning logic
3. Test on ambiguous grammars

### Milestone 4: Optimizations
1. Implement follower sorting heuristics
2. Add NFA caching per rule
3. Handle edge cases (actions, cross-refs, fragments)

### Milestone 5: Testing & Validation
1. Port existing `text-serializer.test.ts` tests
2. Add tests for cases where Xtext approach should excel
3. Compare behavior with `DefaultTextSerializer`

---

## Key Differences from Current Approach

| Aspect | DefaultTextSerializer | TextSerializer2 |
|--------|----------------------|-----------------|
| Algorithm | Grammar traversal | NFA backtracking |
| Pruning | None | BitSet-based |
| Pre-computation | Rule targets map | Full NFA per type |
| Ambiguity handling | Try alternatives | Formal search |
| Complexity | O(grammar depth) per node | O(states × features) |

---

## Verification Plan

1. **Roundtrip test:** `parse(serialize(node)) === node`
2. **Comparison test:** Both serializers produce parseable output
3. **Edge case tests:**
   - Ambiguous alternatives
   - Multiple `+=` in same group
   - Actions (type changes mid-rule)
   - Cross-references
   - Optional groups with complex nesting

---

## Risks & Mitigation

| Risk | Mitigation |
|------|------------|
| NFA construction complexity | Start simple, iterate |
| Performance regression | Benchmark against current |
| Incomplete grammar coverage | Extensive test suite |
| TypeScript BitSet efficiency | Use typed arrays |

---

## Questions Resolved

- **Goal:** Prototype `TextSerializer2` with Xtext's algorithm
- **Motivation:** More robust handling of complex grammars
- **Scope:** Full prototype implementation
