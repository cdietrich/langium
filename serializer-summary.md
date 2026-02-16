# Langium TextSerializer Implementation Summary

## Overview

This document summarizes the implementation of a text serializer/unparser for Langium, which converts AST nodes back to their textual representation.

## What Was Implemented

### Core Files

| File | Description |
|------|-------------|
| `packages/langium/src/serializer/doc.ts` | Doc type and render function (simple concatenation) |
| `packages/langium/src/serializer/to-string-converter.ts` | ToStringValueConverter service - inverse of ValueConverter |
| `packages/langium/src/serializer/grammar-info.ts` | Grammar analysis with fragment inlining |
| `packages/langium/src/serializer/text-serializer.ts` | Main TextSerializer implementation |

### Modified Files

| File | Changes |
|------|---------|
| `packages/langium/src/services.ts` | Added `TextSerializer` and `ToStringValueConverter` to serializer services |
| `packages/langium/src/default-module.ts` | Registered default implementations |
| `packages/langium/src/serializer/index.ts` | Export new modules |

### Features Working

- ✅ Keywords serialization
- ✅ Assignments (`=`, `+=`, `?=`)
- ✅ List handling with separators (e.g., `(',' items+=Item)*`)
- ✅ Optional groups (`?`)
- ✅ Repeated groups (`*`, `+`)
- ✅ Alternatives (union types)
- ✅ Unordered groups
- ✅ Cross-references (with `$refText` or computed name)
- ✅ Datatype rules (STRING, INT, returns number, etc.)
- ✅ Boolean optional assignments (`flag?='flag'`)
- ✅ Unassigned parser rule calls (e.g., `'wrap' Item`)
- ✅ Fragment inlining at grammar analysis time
- ✅ Infix rule validation (throws error as specified)
- ✅ ToStringValueConverterService for customization

### Test Coverage

```typescript
// Current tests passing
- Serialize canonical token stream
- Serialize reference with name provider
- Serialize optional boolean assignments
- Serialize alternatives with primitive values
- Serialize data type rules and strings
- Serialize unassigned rule calls
- Serialize multiple references with separators
- Serialize primitive lists with separators
- Serialize repeated assignments in a group
- Serialize unordered group assignments
- Serialize optional groups
- Serialize nested optional groups
- Serialize alternatives containing groups
- Serialize unordered optional assignments
- Serialize repeated group assignments
- Serialize unassigned terminal rule calls (throws error)
- Roundtrip: Basic model with items
- Roundtrip: Model with cross-references
- Roundtrip: Single item
- Roundtrip: Item with reference
- Roundtrip: Multiple items with chained references
- Roundtrip: Many items
- Roundtrip: Complex reference pattern
- Roundtrip: With custom space separator
- Roundtrip: With newline separator
- Serialize array with union type children
- Serialize model without visibility (fragment rules)
- Serialize BooleanLiteral with true
- Serialize BooleanLiteral optional with true
- Serialize BooleanLiteral optional without value
- Serialize ObjectType with full syntax
- Serialize through union rule - TypeA
- Serialize through union rule - TypeB
- Serialize deeply nested - all present
- Serialize deeply nested - level 3 only
- Serialize deeply nested - level 2 only
- Serialize deeply nested - level 1 only
- Serialize deeply nested - none
- Serialize required list with single value
- Serialize required list with multiple values
- Serialize boolean assignment with false value
- Serialize boolean assignment with true value
- Serialize empty cross-reference array
- Keywords are correctly extracted from grammar
- Parse escaped keyword - backticks are stripped
- Parse regular ID - no transformation
- Serialize with ToStringValueConverterService - keyword gets escaped
- Serialize with ToStringValueConverterService - non-keyword stays unescaped
- ToStringValueConverter context contains expected properties
```

## What Needs to Be Done

### Phase 1 (Current) - COMPLETED

| Issue | Status |
|-------|--------|
| Unassigned terminal rule calls | ✅ Throws error when no callback provided |
| Roundtrip tests | ✅ All passing |

### Phase 2: Pretty Printing

Add Wadler-style layout algorithm with:

| Feature | Description |
|---------|-------------|
| `line` combinator | Break point (space or newline) |
| `softline` combinator | Conditional break |
| `nest(i, doc)` | Indentation |
| `group(doc)` | Layout decision |
| Configurable width | Line width parameter |
| Configurable indent | Indent string (default: 2 spaces) |

```typescript
export interface TextSerializeOptions {
    format?: boolean;      // Enable pretty printing
    indent?: string;      // Indent string
    width?: number;      // Line width
    // ... existing options
}
```

### Additional Features

| Feature | Priority | Description |
|---------|----------|-------------|
| Error traces | Low | Already implemented with path tracking |
| serializeUnassignedTerminal hook | Low | For unassigned terminal rule calls (throws error if not provided) |

## Architecture

### Doc Type

```typescript
export type Doc = string | Doc[];

// Simple concatenation - no layout decisions
export function text(s: string): Doc
export function concat(docs: Doc[]): Doc
export const space: Doc = ' '
export function render(doc: Doc): string
```

### ToStringValueConverter

Inverse of ValueConverter - converts typed values back to strings:

```typescript
// Simple converter (legacy)
export type ToStringValueConverter = (value: unknown, rule: AbstractRule) => string;

// Context-based converter (new)
export interface ToStringValueContext {
    node: AstNode;
    property: string;
    value: unknown;
    rule: AbstractRule;
    languageId: string;
}

export type ToStringValueConverterWithContext = (ctx: ToStringValueContext) => string;

export interface ToStringValueConverterService {
    // Simple converters
    getConverter(ruleName: string): ToStringValueConverter | undefined;
    getConverterForRule(rule: AbstractRule): ToStringValueConverter | undefined;
    register(ruleName: string, converter: ToStringValueConverter): void;

    // Context-based converters (preferred)
    getConverterWithContext(ruleName: string): ToStringValueConverterWithContext | undefined;
    getConverterForRuleWithContext(rule: AbstractRule): ToStringValueConverterWithContext | undefined;
    registerWithContext(ruleName: string, converter: ToStringValueConverterWithContext): void;
}
```

### Grammar Analysis

Precomputes grammar information for efficient serialization:

```typescript
export interface GrammarInfo {
    typeToRule: Map<string, Set<ParserRule>>;
    ruleAssignments: Map<ParserRule, Assignment[]>;
    assignmentTerminal: Map<Assignment, string>;
    terminalRules: Map<string, TerminalRule>;
    datatypeRules: Map<string, ParserRule>;
    fragmentRules: Map<string, ParserRule>;
}
```

### TextSerializer API

```typescript
export interface TextSerializeOptions {
    useRefText?: boolean;           // Use $refText vs computed name
    // serializeValue hook removed - use ToStringValueConverterService instead
}
```

## Design Decisions

| Decision | Resolution |
|----------|------------|
| Infix rules | Throw error (not supported) |
| Ambiguous alternatives | First match wins |
| Fragments | Inline at analysis time |
| Formatting | Phase 2 (opt-in), Phase 1 uses one-space approach |
| Cardinalities | Full support via AST property inspection |

## Usage

```typescript
const services = await createServicesForGrammar({ grammar });
const serializer = services.serializer.TextSerializer;

const ast = parseResult.parseResult.value;
const text = serializer.serialize(ast);

// Custom value serialization via ToStringValueConverterService
services.serializer.ToStringValueConverterService.registerWithContext('MyRule', (ctx) => {
    // ctx.node - the AST node being serialized
    // ctx.property - the property name
    // ctx.value - the value to serialize
    // ctx.rule - the grammar rule
    // ctx.languageId - the language identifier
    return String(ctx.value);
});
```

## Dependencies

The serializer requires access to:
- `LangiumCoreServices`
- `Grammar` (generated AST)
- `ValueConverter` (for inverse mapping)
- `NameProvider` (for cross-refs)
- `AstReflection` (for property types)

## References

- Wadler, Philip. "A Prettier Printer" (1998)
- Hughes, John. "The Design of a Pretty-printing Library" (1995)
- Xtext Serializer Architecture
