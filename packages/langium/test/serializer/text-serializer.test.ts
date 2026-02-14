/******************************************************************************
 * Copyright 2024 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import { describe, test, expect } from 'vitest';
import { isParserRule } from '../../src/languages/generated/ast.js';
import { DefaultConcreteSyntaxValidator } from '../../src/serializer/concrete-syntax-validator.js';
import { DefaultContextResolver } from '../../src/serializer/context-resolver.js';
import { GrammarAnalyzer } from '../../src/serializer/grammar-analyzer.js';
import { DefaultToStringConverter, ToStringConverter } from '../../src/serializer/to-string-converter.js';
import { createLangiumGrammarServices } from '../../src/grammar/langium-grammar-module.js';
import { EmptyFileSystem } from '../../src/workspace/file-system-provider.js';

const services = createLangiumGrammarServices(EmptyFileSystem);
const grammar = services.grammar.Grammar;
const astReflection = services.shared.AstReflection;

describe('ConcreteSyntaxValidator', () => {
    test('should run validation without crashing', () => {
        const validator = new DefaultConcreteSyntaxValidator(grammar, astReflection);

        const node = {
            $type: 'ParserRule',
            name: 'TestRule',
            entry: false,
            fragment: false,
            parameters: [],
            definition: {
                $type: 'Keyword',
                value: 'test'
            }
        };

        // Just check that validation runs and returns a result
        const result = validator.validate(node as any, { allowPartial: true });
        expect(result).toBeDefined();
        expect(result.issues).toBeInstanceOf(Array);
    });

    test('should detect issues with incomplete node', () => {
        const validator = new DefaultConcreteSyntaxValidator(grammar, astReflection);

        const node = {
            $type: 'ParserRule',
            name: 'TestRule'
        };

        const result = validator.validate(node as any, { allowPartial: false });
        // Should have some issues
        expect(result.issues.length).toBeGreaterThan(0);
    });
});

describe('ContextResolver', () => {
    test('should find rule for type', () => {
        const resolver = new DefaultContextResolver(grammar);

        const rule = resolver.findRuleForType('ParserRule');
        expect(rule).toBeDefined();
        expect(rule?.name).toBe('ParserRule');
    });

    test('should return undefined for unknown type', () => {
        const resolver = new DefaultContextResolver(grammar);

        const rule = resolver.findRuleForType('UnknownType');
        expect(rule).toBeUndefined();
    });

    test('should find context for valid AST node', () => {
        const resolver = new DefaultContextResolver(grammar);

        const node = {
            $type: 'ParserRule',
            name: 'TestRule'
        };

        const context = resolver.findContext(node as any);
        expect(context).toBeDefined();
        expect(context?.rule.name).toBe('ParserRule');
    });
});

describe('GrammarAnalyzer', () => {
    test('should analyze grammar and produce results', () => {
        const analyzer = new GrammarAnalyzer(grammar);
        const result = analyzer.analyze();

        expect(result.typeToRule).toBeInstanceOf(Map);
        expect(result.ruleInfo).toBeInstanceOf(Map);
        expect(result.typeToRule.size).toBeGreaterThan(0);
    });

    test('should find rules for known types', () => {
        const analyzer = new GrammarAnalyzer(grammar);

        const rules = analyzer.getRulesForType('ParserRule');
        expect(rules.length).toBeGreaterThan(0);
        expect(rules[0].name).toBe('ParserRule');
    });

    test('should get rule info for parser rule', () => {
        const analyzer = new GrammarAnalyzer(grammar);

        const parserRule = grammar.rules.find(r => isParserRule(r) && r.name === 'ParserRule');
        expect(parserRule).toBeDefined();
        expect(isParserRule(parserRule)).toBe(true);

        if (isParserRule(parserRule)) {
            const info = analyzer.getRuleInfo(parserRule);
            expect(info).toBeDefined();
            expect(info?.typeName).toBe('ParserRule');
            expect(info?.assignments).toBeInstanceOf(Array);
        }
    });
});

describe('DefaultToStringConverter', () => {
    test('should convert strings by default', () => {
        const converter = new DefaultToStringConverter(grammar);
        expect(converter.convert('hello', 'ID')).toBe('hello');
    });

    test('should convert numbers by default', () => {
        const converter = new DefaultToStringConverter(grammar);
        expect(converter.convert(42, 'INT')).toBe('42');
    });

    test('should convert booleans by default', () => {
        const converter = new DefaultToStringConverter(grammar);
        expect(converter.convert(true, 'BOOLEAN')).toBe('true');
        expect(converter.convert(false, 'BOOLEAN')).toBe('false');
    });

    test('should handle null and undefined', () => {
        const converter = new DefaultToStringConverter(grammar);
        expect(converter.convert(null as any, 'ID')).toBe('');
        expect(converter.convert(undefined as any, 'ID')).toBe('');
    });
});

describe('ToStringConverter namespace', () => {
    test('escapeString should escape special characters', () => {
        expect(ToStringConverter.escapeString('hello')).toBe('"hello"');
        expect(ToStringConverter.escapeString('hello\nworld')).toBe('"hello\\nworld"');
        expect(ToStringConverter.escapeString('tab\there')).toBe('"tab\\there"');
        expect(ToStringConverter.escapeString('quote"test')).toBe('"quote\\"test"');
        expect(ToStringConverter.escapeString('backslash\\test')).toBe('"backslash\\\\test"');
    });

    test('escapeString should use specified quote character', () => {
        expect(ToStringConverter.escapeString('hello', "'")).toBe("'hello'");
        expect(ToStringConverter.escapeString("it's", "'")).toBe("'it\\'s'");
    });

    test('quoteId should prefix keywords', () => {
        const keywords = new Set(['if', 'else', 'while']);
        expect(ToStringConverter.quoteId('if', keywords)).toBe('^if');
        expect(ToStringConverter.quoteId('else', keywords)).toBe('^else');
        expect(ToStringConverter.quoteId('myVar', keywords)).toBe('myVar');
    });

    test('quoteId should prefix invalid identifiers', () => {
        const keywords = new Set<string>();
        expect(ToStringConverter.quoteId('123abc', keywords)).toBe('^123abc');
        expect(ToStringConverter.quoteId('my-var', keywords)).toBe('^my-var');
        expect(ToStringConverter.quoteId('', keywords)).toBe('^');
    });
});