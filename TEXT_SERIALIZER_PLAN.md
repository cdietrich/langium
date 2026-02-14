# Text Serializer Implementation Plan

## Overview

Implement an unparser/serializer for Langium that transforms programmatically created ASTs back to text. Unlike Xtext's combined `IValueConverter`, we use a separate `ToStringConverterService` focused solely on serialization.

## Goals

- Serialize valid Langium ASTs into text that re-parses to an equivalent AST
- Provide extensible value conversion for terminal and datatype rules
- Keep serialization deterministic and grammar-driven

## Non-Goals

- Formatting or pretty-printing beyond minimal, grammar-defined text
- Preserving whitespace or comments from original sources
- Supporting ambiguous or invalid ASTs

## Out of Scope (Future)

- Infix rules / operator precedence (Pottier's DCST algorithm)
- Formatting/pretty-printing integration
- Whitespace/comments preservation
- Concrete syntax validation

## Architecture

```
serializer/
├── index.ts                    # Exports
├── json-serializer.ts          # Existing
├── text-serializer.ts          # NEW - Main serializer
├── to-string-converter.ts      # NEW - Converter service
└── grammar-info.ts             # NEW - Precomputed grammar analysis
```

## Decision Points

- Alternatives resolution: property-based matching vs explicit rule metadata
- Error mode: throw fast vs best-effort with diagnostics
- Cross-reference fallback: `$refText` only vs `NameProvider.getName`

## Task Breakdown

### Phase 1: Foundation

- [ ] Create `ToStringConverterService` interface and `DefaultToStringConverterService`
- [ ] Add default fallback converter `(v) => String(v)`
- [ ] Add built-in converters for `STRING` (escaping) and `ID`
- [ ] Create `GrammarInfo` utilities for grammar analysis
- [ ] Build `typeToRule` map: AST type → ParserRule(s)
- [ ] Build `ruleAssignments` map: ParserRule → Assignment[]
- [ ] Build `assignmentTerminal` map: Assignment → terminal/datatype rule name
- [ ] Register `TextSerializer` and `ToStringConverterService` in `services.ts` and `default-module.ts`

**Testing Notes**
- Unit tests for converter service
- Unit tests for grammar analysis utilities

### Phase 2: Core Serialization

- [ ] Create `TextSerializer` interface and `DefaultTextSerializer` skeleton
- [ ] Define `serialize(node: AstNode): string`
- [ ] Inject dependencies (services, converter, grammarInfo)
- [ ] Implement entry point: find matching rule, delegate to rule serializer
- [ ] Implement keyword emission
- [ ] Implement assignment handling (single value)
- [ ] Implement cross-reference serialization

**Testing Notes**
- Simple grammar keyword emission
- `name=ID`, `count=INT`, `[Type:ID]` references

### Phase 3: Value Handling

- [ ] Integrate `ToStringConverterService` for terminal rules
- [ ] Handle converter errors gracefully
- [ ] Handle datatype rules (no assignments, primitive return type)

**Testing Notes**
- Custom converter coverage
- `QualifiedName returns string`, `IntValue returns number`

### Phase 4: Grammar Structure

- [ ] Implement cardinality handling (`?`, `*`, `+`)
- [ ] Implement Alternatives resolution
- [ ] Implement Group handling
- [ ] Implement UnorderedGroup handling
- [ ] Implement Actions handling

**Testing Notes**
- Optional keywords, list properties, nested groups
- Multiple alternatives and ambiguous cases
- Grammar using actions

### Phase 5: Integration & Polish

- [ ] Implement fragment rule handling
- [ ] Add error handling and error types/messages
- [ ] Write roundtrip tests (`parse → serialize → parse → compare ASTs`)
- [ ] Documentation (JSDoc, usage examples, custom converters)

**Testing Notes**
- Langium's own grammar
- Example DSLs

## Handling Grammar Elements Summary

| Element | Approach |
|---------|----------|
| **Keyword** | Emit literal text (Phase 2) |
| **Assignment** `name=ID` | Property value + converter (Phase 2/3) |
| **Assignment** `items+=Item*` | Iterate array (Phase 4) |
| **Assignment** `flag?=KEY` | Emit keyword if true (Phase 4) |
| **CrossReference** `[Type:ID]` | `$refText` or `NameProvider` (Phase 2) |
| **Alternatives** | Match branch by properties (Phase 4) |
| **Group** | Emit elements in order (Phase 4) |
| **Datatype rule** | Apply `ToStringConverterService` (Phase 3) |
| **Terminal rule** | Apply `ToStringConverterService` (Phase 3) |
| **Actions** `{Type}` | Determine correct alternative (Phase 4) |
| **UnorderedGroup** | Emit in grammar order (Phase 4) |
| **Fragment rules** | Inline content (Phase 5) |

## Service Registration

```typescript
// services.ts
readonly serializer: {
    JsonSerializer: () => JsonSerializer;
    TextSerializer: () => TextSerializer;
    ToStringConverter: () => ToStringConverterService;
}

// default-module.ts
serializer: {
    JsonSerializer: () => new DefaultJsonSerializer(),
    TextSerializer: () => new DefaultTextSerializer(services),
    ToStringConverter: () => new DefaultToStringConverterService()
}
```

## Usage Example

```typescript
const text = services.serializer.TextSerializer.serialize(astNode);
```

## User Customization Example

```typescript
class MyToStringConverterService extends DefaultToStringConverterService {
    constructor() {
        super();
        this.register('HEX_VALUE', (value: number) => '0x' + value.toString(16));
        this.register('BINARY', (value: number) => value.toString(2) + 'b');
        this.register('STRING', (value: string) => `"${value.replace(/"/g, '\\"')}"`);
    }
}
```

## References

- Xtext ISerializer2 architecture (semantic/syntactic sequencer)
- Pottier, F. (2024). "Correct, Fast LR(1) Unparsing" - Disjunctive Concrete Syntax Trees
