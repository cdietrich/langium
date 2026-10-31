/******************************************************************************
 * Copyright 2026 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { IProduction, TokenType } from 'chevrotain';
import { Alternation, Alternative, NonTerminal, Option, Repetition, RepetitionMandatory, RepetitionMandatoryWithSeparator, RepetitionWithSeparator, Rule, Terminal } from 'chevrotain';

/**
 * The result of Chevrotain's grammar recording phase and of its error recovery follow set computation,
 * in a JSON-serializable form.
 *
 * Constructing a parser runs Chevrotain's `performSelfAnalysis`, which invokes every rule once in a
 * "recording mode" to build the grammar AST (GAST) and then derives the follow sets used for error recovery
 * from it. Both only depend on the grammar, so they can be computed at build time and shipped next to the
 * generated grammar. A parser that receives a matching analysis skips both steps.
 *
 * The lookahead functions are still computed at runtime, as they are closures over the GAST.
 */
export interface ParserAnalysis {
    readonly version: 1
    /**
     * Fingerprint of the parser the analysis was recorded with: rule names and token type names.
     * A parser whose fingerprint differs falls back to the regular recording phase.
     */
    readonly fingerprint: string
    readonly rules: SerializedProduction[]
    /** Follow sets for error recovery, keyed by Chevrotain's follow key, valued by token type names. */
    readonly follows?: Record<string, string[]>
}

export type SerializedProduction =
    | { t: 'Rule', name: string, def: SerializedProduction[] }
    | { t: 'Alt', def: SerializedProduction[], ign?: boolean }
    | { t: 'Or', idx: number, def: SerializedProduction[], ign?: boolean, pred?: boolean, la?: number }
    | { t: 'Opt' | 'Many' | 'AtLeastOne', idx: number, def: SerializedProduction[], la?: number }
    | { t: 'ManySep' | 'AtLeastOneSep', idx: number, def: SerializedProduction[], sep: string, la?: number }
    | { t: 'Sub', idx: number, name: string, label?: string }
    | { t: 'Tok', idx: number, name: string, label?: string };

/**
 * The parts of Chevrotain's parser internals that the analysis reads from or writes to.
 * They are not part of Chevrotain's public typings.
 */
export interface ChevrotainAnalysisInternals {
    definedRulesNames: string[]
    tokensMap: Record<string, TokenType>
    gastProductionsCache: Record<string, Rule>
    resyncFollows: Record<string, TokenType[]>
    recoveryEnabled: boolean
}

export function computeParserFingerprint(parser: ChevrotainAnalysisInternals): string {
    return parser.definedRulesNames.join(',') + '|' + Object.keys(parser.tokensMap).join(',');
}

/**
 * Serializes the analysis of a parser on which `performSelfAnalysis` has already run.
 */
export function serializeParserAnalysis(parser: ChevrotainAnalysisInternals): ParserAnalysis {
    const rules = parser.definedRulesNames.map(name => serializeProduction(parser.gastProductionsCache[name]));
    let follows: Record<string, string[]> | undefined;
    if (parser.recoveryEnabled) {
        follows = {};
        for (const [key, tokenTypes] of Object.entries(parser.resyncFollows)) {
            follows[key] = tokenTypes.map(tokenType => tokenType.name);
        }
    }
    return {
        version: 1,
        fingerprint: computeParserFingerprint(parser),
        rules,
        follows
    };
}

/**
 * Fields the grammar recorder sets on GAST productions that Chevrotain's typings do not declare.
 */
interface GastFlags {
    definition: IProduction[]
    maxLookahead?: number
    ignoreAmbiguities?: boolean
    hasPredicates?: boolean
}

const flags = (production: object): GastFlags => production as unknown as GastFlags;

function serializeProduction(production: IProduction): SerializedProduction {
    const def = (): SerializedProduction[] => flags(production).definition.map(serializeProduction);
    const la = flags(production).maxLookahead;
    const withLookahead = <T extends object>(value: T): T => la === undefined ? value : { ...value, la };
    if (production instanceof Rule) {
        return { t: 'Rule', name: production.name, def: def() };
    } else if (production instanceof Alternative) {
        return flags(production).ignoreAmbiguities ? { t: 'Alt', def: def(), ign: true } : { t: 'Alt', def: def() };
    } else if (production instanceof Alternation) {
        const result: SerializedProduction = { t: 'Or', idx: production.idx, def: def() };
        if (flags(production).ignoreAmbiguities) result.ign = true;
        if (flags(production).hasPredicates) result.pred = true;
        return withLookahead(result);
    } else if (production instanceof Option) {
        return withLookahead({ t: 'Opt', idx: production.idx, def: def() });
    } else if (production instanceof Repetition) {
        return withLookahead({ t: 'Many', idx: production.idx, def: def() });
    } else if (production instanceof RepetitionMandatory) {
        return withLookahead({ t: 'AtLeastOne', idx: production.idx, def: def() });
    } else if (production instanceof RepetitionWithSeparator) {
        return withLookahead({ t: 'ManySep', idx: production.idx, def: def(), sep: production.separator.name });
    } else if (production instanceof RepetitionMandatoryWithSeparator) {
        return withLookahead({ t: 'AtLeastOneSep', idx: production.idx, def: def(), sep: production.separator.name });
    } else if (production instanceof NonTerminal) {
        const result: SerializedProduction = { t: 'Sub', idx: production.idx, name: production.nonTerminalName };
        if (production.label !== undefined) result.label = production.label;
        return result;
    } else if (production instanceof Terminal) {
        const result: SerializedProduction = { t: 'Tok', idx: production.idx, name: production.terminalType.name };
        if (production.label !== undefined) result.label = production.label;
        return result;
    }
    throw new Error(`Unexpected grammar production: ${production.constructor.name}`);
}

/**
 * Recreates the recorded GAST rules. `NonTerminal.referencedRule` stays unset;
 * Chevrotain's grammar resolving step fills it in, just like after a regular recording.
 */
export function deserializeRules(analysis: ParserAnalysis, tokensMap: Record<string, TokenType>): Record<string, Rule> {
    const token = (name: string): TokenType => {
        const tokenType = tokensMap[name];
        if (!tokenType) {
            throw new Error(`Unknown token type in parser analysis: ${name}`);
        }
        return tokenType;
    };
    const build = (production: SerializedProduction): IProduction => {
        switch (production.t) {
            case 'Rule': return new Rule({ name: production.name, definition: production.def.map(build) });
            case 'Alt': {
                const alternative = new Alternative({ definition: production.def.map(build) });
                if (production.ign) flags(alternative).ignoreAmbiguities = true;
                return alternative;
            }
            case 'Or': {
                const alternation = new Alternation({ idx: production.idx, definition: production.def.map(build) as Alternative[] });
                flags(alternation).ignoreAmbiguities = production.ign === true;
                flags(alternation).hasPredicates = production.pred === true;
                return withLookahead(alternation, production.la);
            }
            case 'Opt': return withLookahead(new Option({ idx: production.idx, definition: production.def.map(build) }), production.la);
            case 'Many': return withLookahead(new Repetition({ idx: production.idx, definition: production.def.map(build) }), production.la);
            case 'AtLeastOne': return withLookahead(new RepetitionMandatory({ idx: production.idx, definition: production.def.map(build) }), production.la);
            case 'ManySep': return withLookahead(new RepetitionWithSeparator({ idx: production.idx, definition: production.def.map(build), separator: token(production.sep) }), production.la);
            case 'AtLeastOneSep': return withLookahead(new RepetitionMandatoryWithSeparator({ idx: production.idx, definition: production.def.map(build), separator: token(production.sep) }), production.la);
            case 'Sub': return new NonTerminal({ idx: production.idx, nonTerminalName: production.name, label: production.label, referencedRule: undefined });
            case 'Tok': return new Terminal({ idx: production.idx, terminalType: token(production.name), label: production.label });
        }
    };
    const rules: Record<string, Rule> = {};
    for (const rule of analysis.rules) {
        rules[(rule as { name: string }).name] = build(rule) as Rule;
    }
    return rules;
}

export function deserializeFollows(analysis: ParserAnalysis, tokensMap: Record<string, TokenType>): Record<string, TokenType[]> | undefined {
    if (!analysis.follows) {
        return undefined;
    }
    const follows: Record<string, TokenType[]> = {};
    for (const [key, names] of Object.entries(analysis.follows)) {
        follows[key] = names.map(name => tokensMap[name]);
    }
    return follows;
}

function withLookahead<T extends IProduction>(production: T, la: number | undefined): T {
    if (la !== undefined) {
        flags(production).maxLookahead = la;
    }
    return production;
}
