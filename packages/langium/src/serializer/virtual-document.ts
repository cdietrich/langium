/******************************************************************************
 * Copyright 2024 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { URI } from '../utils/uri-utils.js';
import type { Range, Position } from 'vscode-languageserver-protocol';
import type { AstNode } from '../syntax-tree.js';
import type { ParseResult } from '../parser/langium-parser.js';
import { DocumentState } from '../workspace/documents.js';

export interface VirtualTextDocument {
    readonly uri: string;
    readonly languageId: string;
    readonly version: number;
    readonly lineCount: number;
    getText(range?: Range): string;
    offsetAt(position: Position): number;
    positionAt(offset: number): Position;
}

export class DefaultVirtualTextDocument implements VirtualTextDocument {
    private readonly lines: string[];

    constructor(
        public readonly uri: string,
        public readonly languageId: string,
        public readonly version: number,
        private readonly text: string
    ) {
        this.lines = text.split('\n');
    }

    get lineCount(): number {
        return this.lines.length;
    }

    getText(range?: Range): string {
        if (!range) {
            return this.text;
        }

        const startOffset = this.offsetAt(range.start);
        const endOffset = this.offsetAt(range.end);

        return this.text.substring(startOffset, endOffset);
    }

    offsetAt(position: Position): number {
        let offset = 0;
        const lineIndex = position.line - 1;

        if (lineIndex < 0) {
            return 0;
        }

        for (let i = 0; i < lineIndex && i < this.lines.length; i++) {
            offset += this.lines[i].length + 1; // +1 for newline
        }

        const line = this.lines[lineIndex];
        const charIndex = position.character - 1;
        offset += Math.min(charIndex, line.length);

        return offset;
    }

    positionAt(offset: number): Position {
        if (offset < 0) {
            return { line: 1, character: 1 };
        }

        let currentOffset = 0;
        for (let lineIndex = 0; lineIndex < this.lines.length; lineIndex++) {
            const lineLength = this.lines[lineIndex].length;
            if (currentOffset + lineLength >= offset) {
                const character = offset - currentOffset + 1;
                return { line: lineIndex + 1, character };
            }
            currentOffset += lineLength + 1; // +1 for newline
        }

        // If offset is beyond text, return end of last line
        return {
            line: this.lines.length,
            character: (this.lines[this.lines.length - 1]?.length ?? 0) + 1
        };
    }
}

export interface VirtualLangiumDocument extends AstNode {
    readonly uri: URI;
    readonly textDocument: VirtualTextDocument;
    state: DocumentState;
    parseResult: ParseResult;
    references: never[];
    diagnostics?: never;
}

export class DefaultVirtualLangiumDocument implements VirtualLangiumDocument {
    state: DocumentState = DocumentState.Parsed;
    references: never[] = [];

    constructor(
        public readonly uri: URI,
        public readonly textDocument: VirtualTextDocument,
        public readonly parseResult: ParseResult
    ) {}

    get $document(): VirtualLangiumDocument {
        return this;
    }

    get $type(): string {
        return this.parseResult.value.$type;
    }

    get $cstNode(): never | undefined {
        return undefined;
    }

    get $container(): never | undefined {
        return undefined;
    }
}
