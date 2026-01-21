# Implementation Plan: TextSerializer2 (Refined)

## Goal

Create `TextSerializer2` in Langium that implements Xtext's NFA-based serialization algorithm with a **simplified approach** suitable for Langium's architecture.

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| NFA construction | Direct from grammar | Simpler than Xtext's 5-phase PDA chain |
| Node model preservation | Not in v1 | Adds complexity, not needed for basic serialization |
| Transient values | Not in v1 | Can add later if needed |
| Content validation | Skip in v1 | Backtracking handles it, optimize later if needed |
| Wrapper object | SerializableObject | Pre-compute values for efficient access |

---

## Architecture Overview

### Simplified Two-Phase Approach

**Phase A: Static Analysis (one-time, on grammar load)**
```
Grammar Rules --> Semantic NFA (direct) + BitSet metadata
```

*Note: Xtext uses a 5-phase PDA transformation chain (GrammarPDA -> ContextPDA -> ContextTypePDA -> SyntacticSequencerPDA -> SemanticNFA), but we simplify this for Langium by building the NFA directly from grammar rules.*

**Phase B: Runtime Serialization (per AST node)**
```
AST Node --> SerializableObject --> NFA backtracking search --> Token stream
```

---

## Core Data Structures

### SemState (Semantic NFA State)

```typescript
/**
 * Represents a semantic state in the NFA - typically an assignment point.
 * 
 * Derived from Xtext's ISemState interface.
 */
interface SemState {
    /** The grammar element (Assignment, Keyword, RuleCall, Action) */
    grammarElement: AbstractElement;
    
    /** Property name on the AST node (undefined for START/STOP states) */
    feature: string | undefined;
    
    /** Index into feature array for BitSet operations */
    featureIndex: number;
    
    /** Successor states in the NFA */
    followers: SemState[];
    
    /** 
     * BitSet where bit i is set if feature i can still be reached from this state.
     * This is the KEY optimization - enables early pruning during backtracking.
     * Computed via backward analysis from STOP state.
     */
    followerFeatures: BitSet;
    
    /** Grammar declaration order for deterministic sorting */
    orderID: number;
    
    /** True for boolean assignments (?=) */
    isBooleanAssignment: boolean;
}
```

### Nfa Interface

```typescript
/**
 * Simple NFA interface following Xtext's pattern.
 */
interface Nfa<S> {
    getStart(): S;
    getStop(): S;
    getFollowers(state: S): S[];
}
```

### BitSet

```typescript
/**
 * Simple BitSet for tracking reachable features.
 * Use Uint32Array for efficiency with typical feature counts (<32).
 */
class BitSet {
    private data: Uint32Array;
    
    set(index: number): void;
    get(index: number): boolean;
    or(other: BitSet): void;
    equals(other: BitSet): boolean;
    clone(): BitSet;
}
```

### SerializableObject

```typescript
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
 */
class SerializableObject {
    readonly node: AstNode;
    readonly type: string;
    
    /** Pre-extracted values indexed by featureIndex */
    private values: unknown[];
    
    /** Feature count per index (1 for single, length for array, 0 for missing) */
    private valueCounts: number[];
    
    constructor(node: AstNode, featureMap: Map<string, number>) {
        this.node = node;
        this.type = node.$type;
        this.values = [];
        this.valueCounts = [];
        
        for (const [feature, index] of featureMap) {
            const value = (node as GenericAstNode)[feature];
            this.values[index] = value;
            this.valueCounts[index] = Array.isArray(value) ? value.length 
                                    : (value !== undefined ? 1 : 0);
        }
    }
    
    getValue(featureIndex: number, arrayIndex: number): unknown {
        const value = this.values[featureIndex];
        return Array.isArray(value) ? value[arrayIndex] : value;
    }
    
    getValueCount(featureIndex: number): number {
        return this.valueCounts[featureIndex] ?? 0;
    }
}
```

### TraceItem

```typescript
/**
 * Tracks state during backtracking search.
 * 
 * Key insight from Xtext: clone() shares nextIndex array (no modification),
 * while cloneAndConsume() copies it (needs increment).
 */
class TraceItem {
    readonly obj: SerializableObject;
    state: SemState | undefined;      // undefined for initial item
    readonly nextIndex: number[];     // Next index to consume per feature
    value: unknown;                   // Consumed value (for emit)
    index: number;                    // Array index of consumed value
    
    constructor(obj: SerializableObject, nextIndex: number[]) {
        this.obj = obj;
        this.nextIndex = nextIndex;
    }
    
    /**
     * Clone for structural states (no consumption).
     * SHARES the nextIndex array - no modification expected.
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
     */
    cloneAndConsume(state: SemState): TraceItem | undefined {
        const featureIndex = state.featureIndex;
        const arrayIndex = this.nextIndex[featureIndex];
        
        if (arrayIndex >= this.obj.getValueCount(featureIndex)) {
            return undefined;
        }
        
        const value = this.obj.getValue(featureIndex, arrayIndex);
        
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
     */
    isConsumed(): boolean {
        for (let i = 0; i < this.nextIndex.length; i++) {
            if (this.nextIndex[i] < this.obj.getValueCount(i)) {
                return false;
            }
        }
        return true;
    }
    
    /**
     * BitSet pruning check - the KEY optimization.
     * Returns false if any unconsumed feature is not reachable from this state.
     */
    canEnter(state: SemState): boolean {
        // Rule 1: Boolean assignments require true value
        if (state.isBooleanAssignment) {
            const value = this.obj.getValue(state.featureIndex, this.nextIndex[state.featureIndex]);
            if (value !== true) {
                return false;
            }
        }
        
        // Rule 2: Check all remaining features are reachable
        for (let i = 0; i < this.nextIndex.length; i++) {
            if (i !== state.featureIndex) {
                const consumed = this.nextIndex[i];
                const total = this.obj.getValueCount(i);
                if (consumed < total) {
                    // Feature i has unconsumed values - is it reachable?
                    if (!state.followerFeatures.get(i)) {
                        return false;  // PRUNE: feature not reachable!
                    }
                }
            }
        }
        return true;
    }
}
```

---

## Implementation Steps

### Step 1: BitSet Implementation

**File:** `packages/langium/src/serializer/bitset.ts`

Simple BitSet using Uint32Array. Operations needed:
- `set(index)` - set bit
- `get(index)` - check bit  
- `or(other)` - union
- `equals(other)` - comparison
- `clone()` - copy

### Step 2: NFA Builder

**File:** `packages/langium/src/serializer/nfa-builder.ts`

Build semantic NFA directly from grammar rules:

```typescript
class NfaBuilder {
    private grammar: Grammar;
    private featureMap: Map<string, Map<string, number>>;  // type -> (feature -> index)
    
    /**
     * Build NFA for a given AST type.
     * 
     * Algorithm:
     * 1. Find the parser rule that produces this type
     * 2. Traverse rule definition, creating SemState for each:
     *    - Assignment (=, +=, ?=)
     *    - Keyword (in unassigned position or for boolean)
     *    - RuleCall (unassigned calls to data type rules)
     * 3. Connect states based on grammar structure
     * 4. Compute followerFeatures via backward analysis
     * 5. Assign orderIDs based on grammar declaration order
     */
    buildNfa(type: string): Nfa<SemState>;
    
    /**
     * Backward analysis to compute followerFeatures BitSets.
     * 
     * Algorithm (from Xtext SemanticSequencerNfaProvider):
     * 1. Create inverse NFA (reverse all edges)
     * 2. Start from STOP state with empty BitSet
     * 3. Traverse backwards:
     *    - If state assigns a feature, add that feature to BitSet
     *    - Propagate accumulated BitSet to all predecessors
     * 4. Continue until fixed point (no new bits added)
     */
    private initFollowerFeatures(nfa: Nfa<SemState>): void;
    
    /**
     * Assign orderIDs based on grammar element declaration order.
     * Used for deterministic follower sorting.
     */
    private initOrderIDs(nfa: Nfa<SemState>): void;
}
```

### Step 3: Backtracking Engine

**File:** `packages/langium/src/serializer/text-serializer2.ts`

```typescript
/**
 * Backtracking handler interface (from Xtext NfaUtil).
 */
interface BacktrackHandler<S, R> {
    handle(state: S, previous: R): R | undefined;
    isSolution(result: R): boolean;
    sortFollowers(result: R, followers: Iterable<S>): Iterable<S>;
}

/**
 * Generic backtracking algorithm (from Xtext NfaUtil).
 */
function backtrack<S, R>(
    nfa: Nfa<S>, 
    initial: R, 
    handler: BacktrackHandler<S, R>
): R[] | undefined {
    const trace: Array<{ result: R; followers: Iterator<S> }> = [];
    trace.push({ 
        result: initial, 
        followers: [nfa.getStart()][Symbol.iterator]() 
    });
    
    const stopState = nfa.getStop();
    
    while (trace.length > 0) {
        const item = trace[trace.length - 1];
        
        const next = item.followers.next();
        if (next.done) {
            trace.pop();  // Backtrack
            continue;
        }
        
        const nextState = next.value;
        const nextResult = handler.handle(nextState, item.result);
        
        if (nextResult !== undefined) {
            const followers = handler.sortFollowers(nextResult, nfa.getFollowers(nextState));
            trace.push({ 
                result: nextResult, 
                followers: followers[Symbol.iterator]() 
            });
            
            if (nextState === stopState && handler.isSolution(nextResult)) {
                return trace.map(t => t.result);
            }
        }
    }
    
    return undefined;  // No solution found
}
```

### Step 4: Serializer Implementation

```typescript
export class TextSerializer2 implements TextSerializer {
    private nfaBuilder: NfaBuilder;
    private nfaCache = new Map<string, Nfa<SemState>>();
    
    serialize(node: AstNode, options?: TextSerializeOptions): string {
        const nfa = this.getNfa(node.$type);
        const obj = new SerializableObject(node, this.getFeatureMap(node.$type));
        const initial = new TraceItem(obj, new Array(obj.featureCount).fill(0));
        
        const trace = backtrack(nfa, initial, {
            handle: (state, previous) => {
                if (!previous.canEnter(state)) {
                    return undefined;
                }
                if (state.feature !== undefined) {
                    return previous.cloneAndConsume(state);
                } else {
                    return previous.clone(state);
                }
            },
            
            isSolution: (result) => result.isConsumed(),
            
            sortFollowers: (result, followers) => 
                this.sortFollowers([...followers], result.obj)
        });
        
        if (!trace) {
            throw new Error(`Failed to serialize AST node of type '${node.$type}'.`);
        }
        
        return this.emitTokens(trace, options);
    }
    
    /**
     * Follower sorting heuristics to reduce backtracking.
     * 
     * Priority order (from Xtext FollowerSorter):
     * 1. Structural states (null feature) first - START/STOP states
     * 2. Mandatory features before optional - skipped in v1 (no optional tracking)
     * 3. Features with values before empty - prefer features that have data
     * 4. Grammar declaration order - deterministic fallback
     * 
     * Note: Xtext also prioritizes matching original node model elements
     * for formatting preservation, but we skip this in v1.
     */
    private sortFollowers(followers: SemState[], obj: SerializableObject): SemState[] {
        return followers.sort((a, b) => {
            // Priority 1: Structural states (null feature) first
            if (a.feature === undefined && b.feature === undefined) return 0;
            if (a.feature === undefined) return -1;
            if (b.feature === undefined) return 1;
            
            // Priority 2: Mandatory before optional - skipped in v1
            
            // Priority 3: Features with values before empty
            const aCount = obj.getValueCount(a.featureIndex);
            const bCount = obj.getValueCount(b.featureIndex);
            if (aCount === 0 && bCount > 0) return 1;
            if (bCount === 0 && aCount > 0) return -1;
            
            // Priority 4: Grammar declaration order
            return a.orderID - b.orderID;
        });
    }
    
    private emitTokens(trace: TraceItem[], options: TextSerializeOptions): string {
        // Convert trace to token stream and join
    }
}
```

---

## Content Validation (Future Enhancement)

### The Problem

When multiple grammar alternatives assign to the **same feature**, the serializer needs to determine which grammar element matches a given value.

**Example:**
```langium
Expression:
    value=INT | value=STRING | value=ID;
```

If `value = "hello"`, which alternative produced it?
- `INT` -> No (not a number)
- `STRING` -> Yes (if quoted string)  
- `ID` -> Maybe (if valid identifier)

### Xtext's Solution

1. **During NFA construction:** Mark states where multiple grammar elements assign to the same feature (`toBeValidatedAssignedElements`)

2. **During serialization:** Validate that the grammar element can produce the value via `AssignmentFinder` service

### Our Approach (v1)

Skip content validation. Rely on backtracking with BitSet pruning. This works correctly but may be slower for highly ambiguous grammars where early pruning would help.

### Future Enhancement

Add `AssignmentFinder` service to validate values against specific grammar elements:

```typescript
interface AssignmentFinder {
    findValidAssignments(
        node: AstNode,
        feature: string,
        value: unknown,
        candidates: AbstractElement[]
    ): Set<AbstractElement>;
}
```

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/langium/src/serializer/bitset.ts` | **Create** | Simple BitSet implementation |
| `packages/langium/src/serializer/nfa-builder.ts` | **Create** | NFA construction from grammar |
| `packages/langium/src/serializer/text-serializer2.ts` | **Create** | New serializer implementation |
| `packages/langium/src/serializer/index.ts` | Modify | Export new serializer |
| `packages/langium/src/default-module.ts` | Optional | Register as alternative |
| **Integration Tests** | | |
| `packages/langium/test/serializer/text-serializer2.test.ts` | **Create** | Copied from text-serializer.test.ts |
| `packages/langium/test/serializer/text-serializer2-lotse-apis.test.ts` | **Create** | Copied from lotse-apis test |
| **Component Tests** | | |
| `packages/langium/test/serializer/text-serializer2/bitset.test.ts` | **Create** | BitSet unit tests |
| `packages/langium/test/serializer/text-serializer2/nfa-builder.test.ts` | **Create** | NFA builder unit tests |
| `packages/langium/test/serializer/text-serializer2/backtrack.test.ts` | **Create** | Backtracking algorithm tests |
| `packages/langium/test/serializer/text-serializer2/serializable-object.test.ts` | **Create** | SerializableObject tests |
| `packages/langium/test/serializer/text-serializer2/trace-item.test.ts` | **Create** | TraceItem + canEnter tests |

---

## Testing Strategy

### Integration Tests (Copy Existing)

Port tests from `text-serializer.test.ts` and `text-serializer-lotse-apis.test.ts`:

1. **Copy test files**, rename to `text-serializer2*.test.ts`
2. **Change import** to use `TextSerializer2`
3. **Run tests** - initially many will fail
4. **Iterate** - fix implementation until tests pass
5. **Compare** - verify output matches `DefaultTextSerializer` where expected

### Key Test Categories

- Basic serialization (keywords, references)
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
- BooleanLiteral pattern
- Complex real-world grammars (LotseAPIs)

---

## Component Tests

In addition to integration tests, we create unit tests for each component to enable faster debugging and better edge case coverage.

### Test File Structure

```
packages/langium/test/serializer/
├── text-serializer2.test.ts              # Integration tests (copied from existing)
├── text-serializer2-lotse-apis.test.ts   # Integration tests (copied from existing)
└── text-serializer2/
    ├── bitset.test.ts                    # Unit tests for BitSet
    ├── nfa-builder.test.ts               # Unit tests for NFA construction
    ├── backtrack.test.ts                 # Unit tests for backtracking algorithm
    ├── serializable-object.test.ts       # Unit tests for AST wrapper
    └── trace-item.test.ts                # Unit tests for TraceItem + canEnter
```

### Component Test Coverage

#### `bitset.test.ts`
- Set and get single bits
- `or()` combines bits correctly
- `equals()` comparison
- `clone()` creates independent copy
- Bit 31/32 boundary handling (Uint32Array word boundary)
- Large indices (> 64 features)

#### `nfa-builder.test.ts`
- Simple assignment creates correct state
- Sequence (a=ID b=ID) creates connected states
- Alternatives create branching NFA
- Groups with cardinality (*, +, ?)
- `followerFeatures` BitSets computed correctly via backward analysis
- `orderID` assigned in grammar declaration order
- Boolean assignments marked correctly
- Actions handled (type changes)
- Cross-references handled
- Fragments inlined correctly

#### `backtrack.test.ts`
- Finds path through simple linear NFA
- Handles branching (alternatives)
- Backtracks when path fails
- Returns undefined when no solution exists
- `sortFollowers` called with correct arguments
- Respects `canEnter` pruning
- Handles cycles without infinite loop

#### `serializable-object.test.ts`
- Extracts single values correctly
- Extracts array values correctly
- Returns correct count for single (1) vs array (length) vs missing (0)
- `getValue()` with array index
- Handles undefined/missing properties

#### `trace-item.test.ts`
- `clone()` shares nextIndex array (reference equality)
- `cloneAndConsume()` copies nextIndex array (different reference)
- `cloneAndConsume()` increments correct feature index
- `cloneAndConsume()` returns undefined when no value available
- `isConsumed()` returns true when all features consumed
- `isConsumed()` returns false when values remain
- `canEnter()` returns false for unreachable features (BitSet pruning)
- `canEnter()` returns false for boolean assignment without true value
- `canEnter()` returns true when all remaining features reachable

### Benefits of Component Tests

1. **Faster debugging** - When integration tests fail, component tests isolate the issue
2. **Edge case coverage** - Test scenarios hard to trigger via grammar alone
3. **Documentation** - Tests demonstrate expected component behavior
4. **Refactoring safety** - Change internals with confidence
5. **TDD-friendly** - Build components incrementally with passing tests

---

## Implementation Milestones

### Milestone 1: Core Infrastructure
1. Create `BitSet` class + `bitset.test.ts`
2. Define `SemState` and `Nfa` interfaces
3. Create `SerializableObject` wrapper + `serializable-object.test.ts`
4. Implement `TraceItem` with clone/cloneAndConsume/canEnter + `trace-item.test.ts`

### Milestone 2: NFA Builder
1. Build NFA directly from parser rules
2. Handle basic elements: assignments, keywords, groups, alternatives
3. Implement `initFollowerFeatures` backward analysis
4. Implement `initOrderIDs`
5. Add `nfa-builder.test.ts` for each grammar pattern

### Milestone 3: Backtracking Engine
1. Implement generic `backtrack()` function + `backtrack.test.ts`
2. Implement `TextSerializer2.serialize()`
3. Implement `sortFollowers()` with priority order
4. Implement `emitTokens()` for output

### Milestone 4: Integration Testing
1. Copy and adapt `text-serializer.test.ts`
2. Copy and adapt `text-serializer-lotse-apis.test.ts`
3. Handle edge cases discovered by failing tests

### Milestone 5: Optimization & Polish
1. Add NFA caching per type
2. Benchmark against DefaultTextSerializer
3. Profile and optimize hot paths
4. Documentation

---

## Key Differences from DefaultTextSerializer

| Aspect | DefaultTextSerializer | TextSerializer2 |
|--------|----------------------|-----------------|
| Algorithm | Grammar traversal (recursive) | NFA backtracking (stack-based) |
| Pruning | None | BitSet-based follower features |
| Pre-computation | Rule targets map | Full NFA + BitSets per type |
| Ambiguity handling | Try alternatives in order | Formal search with pruning |
| State tracking | Implicit (call stack) | Explicit (TraceItem + nextIndex) |

---

## Xtext Reference

Key classes in Xtext for reference:

| Class | Location | Purpose |
|-------|----------|---------|
| `BacktrackingSemanticSequencer` | `sequencer/` | Runtime backtracking |
| `SemanticSequencerNfaProvider` | `analysis/` | NFA construction |
| `ISemanticSequencerNfaProvider.ISemState` | `analysis/` | State interface |
| `NfaUtil` | `util/formallang/` | Backtracking algorithm |
| `FollowerSorter` | Inner class | Sorting heuristics |
| `SerializableObject` | Inner class | AST wrapper |
| `TraceItem` | Inner class | Backtrack state |

Source location: `/Users/dietrich/xtext-main2/git/xtext/org.eclipse.xtext/`

---

## Risks & Mitigation

| Risk | Mitigation |
|------|------------|
| NFA construction complexity | Start simple, handle basic cases first |
| Performance regression | Benchmark against current, BitSet pruning should help |
| Incomplete grammar coverage | Extensive test suite from existing tests |
| TypeScript BitSet efficiency | Use Uint32Array, profile if needed |
| Edge cases in backtracking | Follow Xtext's proven algorithm closely |
