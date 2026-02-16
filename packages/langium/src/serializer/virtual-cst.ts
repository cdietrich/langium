/******************************************************************************
 * Copyright 2024 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { Range, Position } from 'vscode-languageserver-protocol';
import type { AstNode } from '../syntax-tree.js';
import type { AbstractElement } from '../languages/generated/ast.js';
import type { TokenType } from 'chevrotain';

export interface VirtualCstNode {
    readonly text: string;
    readonly offset: number;
    readonly length: number;
    readonly end: number;
    readonly range: Range;
    readonly hidden: boolean;
    readonly container?: VirtualCompositeCstNode;
    readonly astNode: AstNode;
    readonly grammarSource?: AbstractElement;
    readonly root: VirtualRootCstNode;
}

export interface VirtualCompositeCstNode extends VirtualCstNode {
    readonly content: VirtualCstNode[];
}

export interface VirtualLeafCstNode extends VirtualCstNode {
    readonly tokenType: TokenType;
}

export class VirtualRootCstNode implements VirtualRootCstNode {
    readonly content: VirtualCstNode[] = [];
    readonly fullText: string;

    constructor(
        fullText: string,
        public readonly astNode: AstNode
    ) {
        this.fullText = fullText;
    }

    get text(): string {
        return this.fullText;
    }

    get offset(): number {
        return 0;
    }

    get length(): number {
        return this.fullText.length;
    }

    get end(): number {
        return this.fullText.length;
    }

    get range(): Range {
        return {
            start: { line: 1, character: 1 },
            end: positionAt(this.fullText.length)
        };
    }

    get hidden(): boolean {
        return false;
    }

    get root(): VirtualRootCstNode {
        return this;
    }

    get container(): undefined {
        return undefined;
    }
}

export class VirtualCompositeCstNodeImpl implements VirtualCompositeCstNode {
    readonly content: VirtualCstNode[] = [];

    constructor(
        public readonly text: string,
        public readonly offset: number,
        public readonly length: number,
        public readonly hidden: boolean,
        public readonly astNode: AstNode,
        public readonly grammarSource?: AbstractElement,
        public container?: VirtualCompositeCstNode
    ) {}

    get end(): number {
        return this.offset + this.length;
    }

    get range(): Range {
        return {
            start: positionAt(this.offset),
            end: positionAt(this.end)
        };
    }

    get root(): VirtualRootCstNode {
        let current: VirtualCstNode = this;
        while (current.container) {
            current = current.container;
        }
        return current as VirtualRootCstNode;
    }
}

export class VirtualLeafCstNodeImpl implements VirtualLeafCstNode {
    constructor(
        public readonly text: string,
        public readonly offset: number,
        public readonly length: number,
        public readonly tokenType: TokenType,
        public readonly hidden: boolean,
        public readonly astNode: AstNode,
        public readonly grammarSource?: AbstractElement,
        public container?: VirtualCompositeCstNode
    ) {
        if (container) {
            container.content.push(this);
        }
    }

    get end(): number {
        return this.offset + this.length;
    }

    get range(): Range {
        return {
            start: positionAt(this.offset),
            end: positionAt(this.end)
        };
    }

    get root(): VirtualRootCstNode {
        let current: VirtualCstNode = this;
        while (current.container) {
            current = current.container;
        }
        return current as VirtualRootCstNode;
    }
}

function positionAt(offset: number, text: string = ''): Position {
    let line = 1;
    let character = 1;
    for (let i = 0; i < offset; i++) {
        if (i < text.length && text[i] === '\n') {
            line++;
            character = 1;
        } else {
            character++;
        }
    }
    return { line, character };
}

export function createPositionAt(text: string): (offset: number) => Position {
    return (offset: number): Position => {
        let line = 1;
        let character = 1;
        for (let i = 0; i < offset; i++) {
            if (text[i] === '\n') {
                line++;
                character = 1;
            } else {
                character++;
            }
        }
        return { line, character };
    };
}
