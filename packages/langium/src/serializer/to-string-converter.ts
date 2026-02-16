/******************************************************************************
 * Copyright 2024 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { AbstractRule, PrimitiveType } from '../languages/generated/ast.js';
import { isParserRule, isTerminalRule } from '../languages/generated/ast.js';
import type { AstNode } from '../syntax-tree.js';

export interface ToStringValueContext {
    node: AstNode;
    property: string;
    value: unknown;
    rule: AbstractRule;
    languageId: string;
}

export type ToStringValueConverter = (value: unknown, rule: AbstractRule) => string;
export type ToStringValueConverterWithContext = (ctx: ToStringValueContext) => string;

/**
 * Service that provides toString converters for terminal and datatype rules.
 * Converters are registered by rule name.
 */
export interface ToStringValueConverterService {
    /**
     * Get the toString converter for a terminal or datatype rule.
     * @param ruleName The name of the terminal or datatype rule.
     */
    getConverter(ruleName: string): ToStringValueConverter;
    /**
     * Get the toString converter for a terminal or datatype rule with full context.
     * @param ruleName The name of the terminal or datatype rule.
     */
    getConverterWithContext(ruleName: string): ToStringValueConverterWithContext;
    /**
     * Get converter for a rule - handles both terminal rules and datatype rules.
     * @param rule The abstract rule (terminal or parser rule)
     */
    getConverterForRule(rule: AbstractRule): ToStringValueConverter;
    /**
     * Get converter for a rule with full context.
     * @param rule The abstract rule (terminal or parser rule)
     */
    getConverterForRuleWithContext(rule: AbstractRule): ToStringValueConverterWithContext;
    /**
     * Register a custom converter for a terminal or datatype rule.
     * @param ruleName The name of the terminal or datatype rule.
     * @param converter The converter function.
     */
    register(ruleName: string, converter: ToStringValueConverter): void;
    /**
     * Register a custom converter with full context for a terminal or datatype rule.
     * @param ruleName The name of the terminal or datatype rule.
     * @param converter The converter function with context.
     */
    registerWithContext(ruleName: string, converter: ToStringValueConverterWithContext): void;
}

/**
 * Default implementation of ToStringValueConverterService.
 * Provides built-in converters for common terminal rules and primitive types.
 */
export class DefaultToStringValueConverterService implements ToStringValueConverterService {
    protected readonly converters: Map<string, ToStringValueConverter> = new Map();
    protected readonly convertersWithContext: Map<string, ToStringValueConverterWithContext> = new Map();
    protected readonly primitiveConverters: Map<PrimitiveType, ToStringValueConverter> = new Map();

    constructor() {
        this.registerDefaults();
    }

    getConverter(ruleName: string): ToStringValueConverter {
        return this.converters.get(ruleName) ?? this.defaultConverter;
    }

    getConverterWithContext(ruleName: string): ToStringValueConverterWithContext {
        return this.convertersWithContext.get(ruleName) ?? this.defaultConverterWithContext;
    }

    register(ruleName: string, converter: ToStringValueConverter): void {
        this.converters.set(ruleName, converter);
    }

    registerWithContext(ruleName: string, converter: ToStringValueConverterWithContext): void {
        this.convertersWithContext.set(ruleName, converter);
    }

    protected get ruleName(): string | undefined {
        return undefined;
    }

    protected get defaultConverter(): ToStringValueConverter {
        return (value: unknown) => String(value);
    }

    protected get defaultConverterWithContext(): ToStringValueConverterWithContext {
        return (ctx: ToStringValueContext) => String(ctx.value);
    }

    protected registerDefaults(): void {
        // STRING: add quotes and escape special characters
        this.register('STRING', (value) => {
            const str = String(value);
            const escaped = str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            return `"${escaped}"`;
        });

        // ID: pass through as-is
        this.register('ID', (value) => String(value));

        // INT: convert to string
        this.register('INT', (value) => String(value));

        // Register primitive type converters
        this.primitiveConverters.set('number', (value) => String(value));
        this.primitiveConverters.set('boolean', (value) => (value === true ? 'true' : 'false'));
        this.primitiveConverters.set('string', (value) => {
            // For string type, check if it needs quoting
            const str = String(value);
            // If the string matches ID pattern (including dots for qualified names), don't quote
            if (/^[_a-zA-Z][\w.]*$/.test(str) && !str.includes(' ')) {
                return str;
            }
            // Check if it's already quoted
            if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
                return str;
            }
            // Escape and quote
            const escaped = str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            return `"${escaped}"`;
        });
        this.primitiveConverters.set('bigint', (value) => String(value));
        this.primitiveConverters.set('Date', (value) => {
            if (value instanceof Date) {
                return value.toISOString();
            }
            return String(value);
        });
    }

    /**
     * Get converter for a primitive type (e.g., from 'returns number').
     */
    getPrimitiveConverter(type: PrimitiveType): ToStringValueConverter {
        return this.primitiveConverters.get(type) ?? this.defaultConverter;
    }

    /**
     * Get converter for a rule - handles both terminal rules and datatype rules.
     * Custom converters registered for a rule name take precedence over primitive type converters.
     */
    getConverterForRule(rule: AbstractRule): ToStringValueConverter {
        if (isTerminalRule(rule)) {
            return this.getConverter(rule.name);
        }
        if (isParserRule(rule)) {
            const customConverter = this.converters.get(rule.name);
            if (customConverter) {
                return customConverter;
            }
            if (rule.dataType) {
                return this.getPrimitiveConverter(rule.dataType);
            }
            return this.defaultConverter;
        }
        return this.defaultConverter;
    }

    /**
     * Get converter for a rule with full context.
     * Custom context converters registered for a rule name take precedence over primitive type converters.
     */
    getConverterForRuleWithContext(rule: AbstractRule): ToStringValueConverterWithContext {
        if (isTerminalRule(rule)) {
            return this.getConverterWithContext(rule.name);
        }
        if (isParserRule(rule)) {
            const customConverter = this.convertersWithContext.get(rule.name);
            if (customConverter) {
                return customConverter;
            }
            if (rule.dataType) {
                const primitive = this.primitiveConverters.get(rule.dataType);
                if (primitive) {
                    return (ctx) => primitive(ctx.value, rule);
                }
            }
            return this.defaultConverterWithContext;
        }
        return this.defaultConverterWithContext;
    }
}
