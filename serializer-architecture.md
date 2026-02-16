# Langium TextSerializer Architecture & Implementation

## Overview

The Langium TextSerializer converts AST nodes back to their textual representation (source code). It is the inverse of the parser - given an AST, it produces a string that could be parsed back to an equivalent AST.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            TextSerializer                               │
├─────────────────────────────────────────────────────────────────────────┤
│  serialize(node: AstNode, options?: TextSerializeOptions): string        │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        Serialization Process                            │
├─────────────────────────────────────────────────────────────────────────┤
│  1. GrammarInfo (precomputed at language creation)                     │
│     - typeToRule: Map<TypeName, Set<ParserRule>>                       │
│     - ruleAssignments: Map<ParserRule, Assignment[]>                   │
│     - datatypeRules, fragmentRules, terminalRules                       │
│                                                                         │
│  2. ToStringValueConverterService                                       │
│     - Converts typed values back to strings                             │
│     - Handles keywords, IDs, numbers, etc.                              │
│     - Provides context (node, property, value, rule, languageId)       │
│                                                                         │
│  3. Serialization Logic (per node type)                                 │
│     - Serialize keywords                                                │
│     - Serialize assignments (=, +=, ?=)                                 │
│     - Serialize cross-references                                        │
│     - Serialize lists with separators                                   │
│     - Handle cardinalities (*, +, ?)                                    │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                              Doc Type                                   │
├─────────────────────────────────────────────────────────────────────────┤
│  type Doc = string | Doc[]                                              │
│                                                                         │
│  Simple intermediate representation for building text:                  │
│  - text(s: string): Doc                                                │
│  - concat(docs: Doc[]): Doc                                            │
│  - space: Doc = ' '                                                    │
│  - render(doc: Doc): string                                            │
│                                                                         │
│  Note: Currently uses simple concatenation. Phase 2 will add           │
│  Wadler-style layout combinators for pretty printing.                  │
└─────────────────────────────────────────────────────────────────────────┘
```

## Key Components

### 1. GrammarInfo (`grammar-info.ts`)

Precomputes grammar structure for efficient serialization:

```typescript
export interface GrammarInfo {
    // Maps type to parser rules that produce it
    typeToRule: Map<string, Set<ParserRule>>;
    
    // Assignments within each parser rule
    ruleAssignments: Map<ParserRule, Assignment[]>;
    
    // Terminal rule for an assignment's value
    assignmentTerminal: Map<Assignment, string>;
    
    // Terminal/datatype/fragment rules
    terminalRules: Map<string, TerminalRule>;
    datatypeRules: Map<string, ParserRule>;
    fragmentRules: Map<string, ParserRule>;
}
```

**Key insight**: Fragments are inlined at grammar analysis time, not during serialization. This avoids repeated lookups.

### 2. ToStringValueConverterService (`to-string-converter.ts`)

The inverse of the `ValueConverter` - converts typed values back to strings:

```typescript
// Context provided to converters
export interface ToStringValueContext {
    node: AstNode;           // The AST node being serialized
    property: string;        // Property name (e.g., 'name', 'items')
    value: unknown;          // The actual value to serialize
    rule: AbstractRule;      // The grammar rule for this value
    languageId: string;      // Language identifier
}

// Converter function type
export type ToStringValueConverterWithContext = (ctx: ToStringValueContext) => string;

// Service interface
export interface ToStringValueConverterService {
    // Context-based API (preferred)
    getConverterWithContext(ruleName: string): ToStringValueConverterWithContext | undefined;
    getConverterForRuleWithContext(rule: AbstractRule): ToStringValueConverterWithContext | undefined;
    registerWithContext(ruleName: string, converter: ToStringValueConverterWithContext): void;

    // Legacy simple API
    getConverter(ruleName: string): ToStringValueConverter | undefined;
    getConverterForRule(rule: AbstractRule): ToStringValueConverter | undefined;
    register(ruleName: string, converter: ToStringValueConverter): void;
}
```

**Converter lookup order** (`getConverterForRuleWithContext`):
1. Check custom converters registered via `registerWithContext`
2. Check custom converters registered via `register` (legacy)
3. Check built-in converters for primitive types (string, number, boolean)
4. Return undefined (serializer will use default behavior)

### 3. TextSerializer (`text-serializer.ts`)

Main serialization logic:

```typescript
export interface TextSerializer {
    serialize(node: AstNode, options?: TextSerializeOptions): string;
}

export interface TextSerializeOptions {
    useRefText?: boolean;  // Use $refText for cross-refs vs computed name
}
```

**Serialization algorithm**:

1. For each node:
   - Find the parser rule that created it
   - Get all assignments from the rule
   - For each assignment:
     - Get the property value from the node
     - Serialize based on assignment type:
       - **Keyword**: Use keyword text directly
       - **Cross-reference**: Use `$refText` or call `NameProvider`
       - **Value (primitive)**: Use `ToStringValueConverterService`
       - **Value (AST node)**: Recursively serialize
       - **Array**: Serialize each element with separator
       - **Optional**: Serialize if present
       - **Cardinality (*, +)**: Serialize all elements

2. Collect all Docs and render to string

### 4. Doc Type (`doc.ts`)

Intermediate representation for building text:

```typescript
export type Doc = string | Doc[];

export function text(s: string): Doc
export function concat(docs: Doc[]): Doc
export const space: Doc = ' '
export function render(doc: Doc): string
```

Currently uses simple concatenation. Future phase will add Wadler-style layout combinators.

## Serialization Rules

### Keywords
- Extracted from grammar at analysis time
- Serialized as-is (no escaping needed)

### Assignments
| Syntax | Serialized |
|--------|------------|
| `name=ID` | `name = value` |
| `items+=Item` | `items += value` (with separator) |
| `flag?='flag'` | `flag` (when true) or omitted (when false) |

### Cross-References
- Uses `$refText` if available
- Falls back to `NameProvider.getName(node)` if not

### Lists
- Separator extracted from grammar (e.g., `(',' items+=Item)*`)
- Each element serialized recursively

### Optional Groups
- Only serialized if at least one contained assignment has a value
- Order preserved from grammar

### Alternatives (Union Types)
- Serializer checks actual runtime type
- Uses first matching parser rule from `typeToRule`

## Error Handling

| Situation | Behavior |
|-----------|----------|
| Infix rule encountered | Throws error (not supported) |
| Unassigned terminal rule call | Throws error (grammar issue) |
| Missing converter | Uses `String(value)` as fallback |
| Cross-ref with no name | Throws error |

## Example: Custom Value Converter

```typescript
// Register a converter for escaped IDs (e.g., `if` as identifier)
// On parse: backticks are stripped
// On serialize: add backticks back if value is a keyword

const converter: ToStringValueConverterWithContext = (ctx) => {
    const keywords = ['if', 'else', 'while', 'for'];
    const value = String(ctx.value);
    
    if (keywords.includes(value)) {
        return `\`${value}\``;
    }
    return value;
};

services.serializer.ToStringValueConverterService
    .registerWithContext('ID', converter);
```

## Dependencies

```
TextSerializer
    │
    ├── GrammarInfo (built at language creation)
    │
    ├── ToStringValueConverterService
    │       └── ToStringValueConverterWithContext
    │
    ├── NameProvider (for cross-refs)
    │
    └── AstReflection (for property types)
```

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Fragments inlined at analysis time | Avoid repeated checks during serialization |
| Context-based converters | Provides more info for complex serialization logic |
| One-space serialization | Simple, deterministic output. Pretty-printing is Phase 2 |
| First-match alternatives | Simple, predictable behavior for union types |
| Throw on infix rules | Complex layout decisions require pretty-printer |

## Future Enhancements

### Phase 2: Pretty Printing

```typescript
// Wadler-style layout combinators
export type Doc = 
    | string 
    | Doc[] 
    | { type: 'line' }
    | { type: 'softline' }
    | { type: 'nest', indent: number, doc: Doc }
    | { type: 'group', doc: Doc };

export interface TextSerializeOptions {
    format?: boolean;      // Enable pretty printing
    indent?: string;      // Indent string (default: 2 spaces)
    width?: number;       // Line width (default: 80)
}
```

## Testing Strategy

The serializer includes roundtrip tests:
1. Parse source → AST
2. Serialize AST → source2
3. Parse source2 → AST2
4. Compare ASTs (should be structurally equivalent)

This catches serialization bugs that would cause parse failures on output.
