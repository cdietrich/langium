/******************************************************************************
 * Copyright 2024 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { TerminalRule, ParserRule, AbstractRule, Grammar } from '../languages/generated/ast.js';
import type { ValueType } from '../parser/value-converter.js';
import { isTerminalRule, isParserRule } from '../languages/generated/ast.js';
import { isDataTypeRule, getTypeName } from '../utils/grammar-utils.js';

export interface ToStringConverter {
    convert(value: ValueType, ruleName: string): string;
    convertWithRule(value: ValueType, rule: AbstractRule): string;
}

export type ToStringConverterRuleMatcher = (ruleName: string) => AbstractRule | undefined;

export class DefaultToStringConverter implements ToStringConverter {
    protected readonly grammar: Grammar;
    protected readonly ruleMatcher: ToStringConverterRuleMatcher;

    constructor(grammar: Grammar, ruleMatcher?: ToStringConverterRuleMatcher) {
        this.grammar = grammar;
        this.ruleMatcher = ruleMatcher ?? this.defaultRuleMatcher.bind(this);
    }

    protected defaultRuleMatcher(ruleName: string): AbstractRule | undefined {
        for (const rule of this.grammar.rules) {
            if (rule.name === ruleName) {
                return rule;
            }
        }
        return undefined;
    }

    convert(value: ValueType, ruleName: string): string {
        const rule = this.ruleMatcher(ruleName);
        if (rule) {
            return this.convertWithRule(value, rule);
        }
        return this.convertDefault(value);
    }

    convertWithRule(value: ValueType, rule: AbstractRule): string {
        if (isTerminalRule(rule)) {
            return this.convertTerminal(value, rule);
        }
        if (isParserRule(rule)) {
            if (isDataTypeRule(rule)) {
                return this.convertDataTypeRule(value, rule);
            }
        }
        return this.convertDefault(value);
    }

    protected convertTerminal(value: ValueType, _rule: TerminalRule): string {
        return this.convertDefault(value);
    }

    protected convertDataTypeRule(value: ValueType, rule: ParserRule): string {
        const typeName = getTypeName(rule)?.toLowerCase();
        switch (typeName) {
            case 'string':
                return this.convertString(value);
            case 'number':
            case 'int':
                return this.convertNumber(value);
            case 'boolean':
                return this.convertBoolean(value);
            case 'bigint':
                return this.convertBigint(value);
            case 'date':
                return this.convertDate(value);
            default:
                return this.convertDefault(value);
        }
    }

    protected convertDefault(value: ValueType): string {
        if (value === null || value === undefined) {
            return '';
        }
        if (typeof value === 'string') {
            return value;
        }
        return String(value);
    }

    protected convertString(value: ValueType): string {
        if (typeof value !== 'string') {
            return this.convertDefault(value);
        }
        return ToStringConverter.escapeString(value);
    }

    protected convertNumber(value: ValueType): string {
        if (typeof value !== 'number') {
            return this.convertDefault(value);
        }
        return String(value);
    }

    protected convertBoolean(value: ValueType): string {
        if (typeof value !== 'boolean') {
            return this.convertDefault(value);
        }
        return value ? 'true' : 'false';
    }

    protected convertBigint(value: ValueType): string {
        if (typeof value !== 'bigint') {
            return this.convertDefault(value);
        }
        return String(value);
    }

    protected convertDate(value: ValueType): string {
        if (!(value instanceof Date)) {
            return this.convertDefault(value);
        }
        return value.toISOString();
    }
}

export namespace ToStringConverter {

    export function escapeString(value: string, quote: string = '"'): string {
        let result = quote;
        for (let i = 0; i < value.length; i++) {
            const c = value.charAt(i);
            const escaped = escapeCharacter(c, quote);
            result += escaped;
        }
        result += quote;
        return result;
    }

    function escapeCharacter(char: string, quote: string): string {
        switch (char) {
            case '\b': return '\\b';
            case '\f': return '\\f';
            case '\n': return '\\n';
            case '\r': return '\\r';
            case '\t': return '\\t';
            case '\v': return '\\v';
            case '\0': return '\\0';
            case '\\': return '\\\\';
            default:
                if (char === quote) {
                    return '\\' + char;
                }
                return char;
        }
    }

    export function quoteId(value: string, keywords: Set<string>): string {
        if (keywords.has(value) || needsQuoting(value)) {
            return '^' + value;
        }
        return value;
    }

    function needsQuoting(value: string): boolean {
        if (value.length === 0) {
            return true;
        }
        if (!isIdStart(value.charAt(0))) {
            return true;
        }
        for (let i = 1; i < value.length; i++) {
            if (!isIdPart(value.charAt(i))) {
                return true;
            }
        }
        return false;
    }

    function isIdStart(char: string): boolean {
        return /[a-zA-Z_]/.test(char);
    }

    function isIdPart(char: string): boolean {
        return /[a-zA-Z0-9_]/.test(char);
    }
}