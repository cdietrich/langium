/******************************************************************************
 * Copyright 2024 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

/**
 * Converts a semantic value to its text representation.
 * Used during serialization of terminal rules and datatype rules.
 */
export type ToStringConverter = (value: unknown) => string;

/**
 * Service that provides toString converters for terminal and datatype rules.
 * Converters are registered by rule name.
 */
export interface ToStringConverterService {
    /**
     * Get the toString converter for a terminal or datatype rule.
     * Returns a default converter that uses `String(value)` if none is registered.
     * @param ruleName The name of the terminal or datatype rule.
     */
    getConverter(ruleName: string): ToStringConverter;
    /**
     * Register a custom converter for a terminal or datatype rule.
     * @param ruleName The name of the terminal or datatype rule.
     * @param converter The converter function.
     */
    register(ruleName: string, converter: ToStringConverter): void;
}

/**
 * Default implementation of ToStringConverterService.
 * Provides built-in converters for common terminal rules.
 */
export class DefaultToStringConverterService implements ToStringConverterService {
    protected readonly converters: Map<string, ToStringConverter> = new Map();
    protected defaultConverter: ToStringConverter = (value) => String(value);

    constructor() {
        this.registerDefaults();
    }

    getConverter(ruleName: string): ToStringConverter {
        return this.converters.get(ruleName) ?? this.defaultConverter;
    }

    register(ruleName: string, converter: ToStringConverter): void {
        this.converters.set(ruleName, converter);
    }

    protected registerDefaults(): void {
        this.register('STRING', (value) => {
            const str = String(value);
            const escaped = str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            return `"${escaped}"`;
        });
        this.register('ID', (value) => String(value));
        this.register('INT', (value) => String(value));
    }
}
