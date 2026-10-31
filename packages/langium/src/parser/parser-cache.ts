/******************************************************************************
 * Copyright 2026 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { Module } from '../dependency-injection.js';
import type { Grammar } from '../languages/generated/ast.js';
import type { LangiumCoreServices, PartialLangiumCoreServices } from '../services.js';
import type { LangiumParser, ParserOptions } from './langium-parser.js';
import type { Lexer } from './lexer.js';
import { createLangiumParser } from './langium-parser-builder.js';
import { DefaultLexer } from './lexer.js';

/**
 * Shares lexers and parsers between service containers of the same language.
 *
 * Creating a parser is expensive: the token types are built and analyzed, and Chevrotain runs its
 * self analysis. Applications that create many service containers for the same language (e.g. a fresh
 * workspace per request or per test) pay this cost again for every container. The lexer and the parser
 * keep no container-specific state between two `parse` calls besides a few service references, which the
 * cache rebinds before each call (see {@link LangiumParser.bindServices}).
 *
 * Entries are keyed by the grammar object, so the containers sharing an entry must be created from the same
 * modules: same token builder, parser config, lexer and value converter implementations.
 * Parsing is synchronous, so containers can use a shared parser alternately without interfering.
 */
export class LangiumParserCache {

    protected readonly lexers = new WeakMap<Grammar, Lexer>();
    protected readonly parsers = new WeakMap<Grammar, LangiumParser>();

    getLexer(services: LangiumCoreServices, create: () => Lexer = () => new DefaultLexer(services)): Lexer {
        let lexer = this.lexers.get(services.Grammar);
        if (!lexer) {
            lexer = create();
            this.lexers.set(services.Grammar, lexer);
        }
        return lexer;
    }

    getParser(services: LangiumCoreServices, create: () => LangiumParser = () => createLangiumParser(services)): LangiumParser {
        let parser = this.parsers.get(services.Grammar);
        if (!parser) {
            parser = create();
            this.parsers.set(services.Grammar, parser);
        }
        return bindParser(parser, services);
    }
}

/**
 * Returns a view of the shared parser that binds the given container's services before each parse.
 *
 * This is a `Proxy` rather than `Object.create(shared)`: V8 gives objects that serve as a prototype a special
 * map, and each field write of the parser during parsing would then invalidate the prototype chain caches,
 * which slows down parsing by ~20%.
 */
function bindParser(shared: LangiumParser, services: LangiumCoreServices): LangiumParser {
    const parse = (input: string, options?: ParserOptions) => {
        shared.bindServices(services);
        return shared.parse(input, options);
    };
    return new Proxy(shared, {
        get: (target, property, receiver) => property === 'parse' ? parse : Reflect.get(target, property, receiver)
    });
}

/**
 * A module that takes the lexer and the parser from the given cache. Inject it after the language's own modules.
 */
export function createParserCacheModule(cache: LangiumParserCache): Module<LangiumCoreServices, PartialLangiumCoreServices> {
    return {
        parser: {
            Lexer: services => cache.getLexer(services),
            LangiumParser: services => cache.getParser(services)
        }
    };
}
