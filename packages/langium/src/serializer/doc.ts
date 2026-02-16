/******************************************************************************
 * Copyright 2024 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

/**
 * Simple Doc type for serialization.
 * Uses flat concatenation with single space - no layout decisions in Phase 1.
 */
export type Doc = string | Doc[];

/**
 * Creates a Doc from a string literal.
 */
export function text(s: string): Doc {
    return s;
}

/**
 * Empty document.
 */
export const nil: Doc = '';

/**
 * Single space document.
 * Used as default separator between documents.
 */
export const space: Doc = ' ';

/**
 * Concatenates multiple documents into a single document.
 * Empty strings are filtered out.
 */
export function concat(docs: Doc[]): Doc {
    const filtered = docs.filter((d) => d !== nil && d !== '' && (Array.isArray(d) ? d.length > 0 : true));
    if (filtered.length === 0) {
        return nil;
    }
    if (filtered.length === 1) {
        return filtered[0];
    }
    return filtered;
}

/**
 * Joins documents with a separator.
 * @param docs Array of documents to join
 * @param sep Separator document (default: space)
 */
export function join(docs: Doc[], sep: Doc = space): Doc {
    if (docs.length === 0) {
        return nil;
    }
    if (docs.length === 1) {
        return docs[0];
    }
    const result: Doc[] = [docs[0]];
    for (let i = 1; i < docs.length; i++) {
        result.push(sep);
        result.push(docs[i]);
    }
    return concat(result);
}

/**
 * Renders a Doc to a string.
 * Concatenates all parts without automatic space insertion.
 * Use `space` Doc explicitly where spaces are needed.
 */
export function render(doc: Doc): string {
    if (typeof doc === 'string') {
        return doc;
    }
    if (doc.length === 0) {
        return '';
    }
    const parts: string[] = [];
    for (const d of doc) {
        if (typeof d === 'string') {
            if (d.length > 0) {
                parts.push(d);
            }
        } else if (Array.isArray(d)) {
            const rendered = render(d);
            if (rendered.length > 0) {
                parts.push(rendered);
            }
        }
    }
    return parts.join('');
}
