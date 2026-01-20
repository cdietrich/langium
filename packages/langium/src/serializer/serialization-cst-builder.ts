/******************************************************************************
 * Copyright 2024 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { TokenType } from 'chevrotain';
import type { Range } from 'vscode-languageserver-types';
import type { AbstractElement } from '../languages/generated/ast.js';
import type { AstNode, CompositeCstNode, CstNode, LeafCstNode, Mutable, RootCstNode } from '../syntax-tree.js';
import { Position } from 'vscode-languageserver-types';
import { CompositeCstNodeImpl, LeafCstNodeImpl, RootCstNodeImpl } from '../parser/cst-node-builder.js';

/**
 * A token type used for serialized tokens that don't have a corresponding Chevrotain token type.
 */
const SerializedTokenType: TokenType = {
    name: 'SerializedToken',
    PATTERN: undefined
};

/**
 * A token type used for hidden whitespace tokens.
 */
const HiddenWhitespaceTokenType: TokenType = {
    name: 'HiddenWhitespace',
    PATTERN: /\s+/,
    GROUP: 'hidden'
};

/**
 * Builds a CST during text serialization. Tracks position as tokens are emitted
 * and creates corresponding CST nodes with bidirectional AST ↔ CST links.
 *
 * ## Key Responsibilities
 *
 * - Track current offset and line/column position as tokens are emitted
 * - Build leaf nodes for keywords and terminal values
 * - Build composite nodes for grammar rules
 * - Add hidden nodes for whitespace separators
 * - Maintain bidirectional AST ↔ CST links
 *
 * ## Usage
 *
 * ```typescript
 * const builder = new SerializationCstBuilder();
 * builder.beginDocument();
 *
 * // When entering a grammar rule/node
 * builder.beginNode(grammarElement, astNode);
 *
 * // When emitting tokens
 * builder.addToken('keyword', grammarElement);
 * builder.addSeparator(' ');
 * builder.addToken('value', grammarElement);
 *
 * // When exiting a grammar rule/node
 * builder.endNode();
 *
 * // When done
 * const rootCst = builder.endDocument(fullText);
 * ```
 */
/**
 * Represents a saved state of the CST builder for rollback purposes.
 */
export interface CstBuilderState {
    offset: number;
    line: number;
    column: number;
    needsSeparator: boolean;
    nodeStackLength: number;
    currentContentLength: number;
}

export class SerializationCstBuilder {

    private rootNode!: RootCstNodeImpl;
    private nodeStack: CompositeCstNodeImpl[] = [];
    private offset = 0;
    private line = 0;
    private column = 0;
    private separator: string = ' ';
    private needsSeparator = false;

    /**
     * Returns the current composite node being built.
     */
    get current(): CompositeCstNodeImpl {
        return this.nodeStack[this.nodeStack.length - 1] ?? this.rootNode;
    }

    /**
     * Begins building a new document CST.
     * @param separator The separator string to use between tokens (default: space)
     */
    beginDocument(separator: string = ' '): void {
        this.rootNode = new RootCstNodeImpl('');
        this.rootNode.root = this.rootNode;
        this.nodeStack = [this.rootNode];
        this.offset = 0;
        this.line = 0;
        this.column = 0;
        this.separator = separator;
        this.needsSeparator = false;
    }

    /**
     * Finishes building the document CST and sets the full text.
     * @param fullText The complete serialized text
     * @returns The root CST node
     */
    endDocument(fullText: string): RootCstNode {
        // Set the full text on the root node via type assertion
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this.rootNode as any)['_text'] = fullText;
        return this.rootNode;
    }

    /**
     * Begins a new composite node for a grammar element.
     * Any pending separator is emitted to the parent BEFORE creating the child node.
     * @param grammarSource The grammar element (rule, group, alternatives, etc.)
     * @param astNode Optional AST node to associate with this composite node
     */
    beginNode(grammarSource: AbstractElement, astNode?: AstNode): CompositeCstNode {
        // Emit any pending separator to the current (parent) node before creating the child
        if (this.needsSeparator && this.separator) {
            this.emitHiddenSeparator();
            this.needsSeparator = false;
        }

        const compositeNode = new CompositeCstNodeImpl();
        compositeNode.grammarSource = grammarSource;
        compositeNode.root = this.rootNode;

        if (astNode) {
            compositeNode.astNode = astNode;
            (astNode as Mutable<AstNode>).$cstNode = compositeNode;
        }

        this.current.content.push(compositeNode);
        this.nodeStack.push(compositeNode);
        return compositeNode;
    }

    /**
     * Ends the current composite node and pops it from the stack.
     */
    endNode(): void {
        const node = this.nodeStack.pop();
        // Empty composite nodes are not valid - remove them
        if (node && node.content.length === 0) {
            this.removeNode(node);
        }
    }

    /**
     * Saves the current state of the CST builder for potential rollback.
     * Used when entering optional/alternative groups that may fail.
     */
    saveState(): CstBuilderState {
        return {
            offset: this.offset,
            line: this.line,
            column: this.column,
            needsSeparator: this.needsSeparator,
            nodeStackLength: this.nodeStack.length,
            currentContentLength: this.current.content.length
        };
    }

    /**
     * Restores the CST builder to a previously saved state.
     * Removes any CST nodes that were added since the state was saved.
     */
    restoreState(state: CstBuilderState): void {
        this.offset = state.offset;
        this.line = state.line;
        this.column = state.column;
        this.needsSeparator = state.needsSeparator;

        // Pop any extra composite nodes from the stack
        while (this.nodeStack.length > state.nodeStackLength) {
            const node = this.nodeStack.pop();
            if (node) {
                this.removeNode(node);
            }
        }

        // Remove any content added to the current node since the save
        const currentContent = this.current.content;
        while (currentContent.length > state.currentContentLength) {
            currentContent.pop();
        }
    }

    /**
     * Marks that a separator should be emitted before the next token.
     * This is a no-op now since the separator is handled automatically.
     * @deprecated Use beginDocument(separator) to set the separator instead.
     */
    addSeparator(_separator: string): void {
        // No-op - separator is handled automatically via needsSeparator flag
    }

    /**
     * Adds a leaf node for a token (keyword or terminal value).
     * If this is not the first token, emits a separator first as a hidden node.
     * @param text The token text
     * @param grammarSource The grammar element that produced this token
     * @param tokenType Optional token type (defaults to SerializedTokenType)
     */
    addToken(text: string, grammarSource?: AbstractElement, tokenType?: TokenType): LeafCstNode {
        // Emit separator before this token if needed (not the first token)
        if (this.needsSeparator && this.separator) {
            this.emitHiddenSeparator();
        }

        const range = this.createRange(text);
        const leafNode = new LeafCstNodeImpl(
            this.offset,
            text.length,
            range,
            tokenType ?? SerializedTokenType,
            false // not hidden
        );
        leafNode.grammarSource = grammarSource;
        leafNode.root = this.rootNode;

        this.current.content.push(leafNode);
        this.advancePosition(text);

        // Mark that next token needs a separator
        this.needsSeparator = true;

        return leafNode;
    }

    /**
     * Emits a hidden whitespace node for the separator.
     */
    private emitHiddenSeparator(): void {
        const text = this.separator;
        const range = this.createRange(text);
        const hiddenNode = new LeafCstNodeImpl(
            this.offset,
            text.length,
            range,
            HiddenWhitespaceTokenType,
            true // hidden
        );
        hiddenNode.root = this.rootNode;

        this.current.content.push(hiddenNode);
        this.advancePosition(text);
    }

    /**
     * Creates a Range for the given text at the current position.
     */
    private createRange(text: string): Range {
        const startLine = this.line;
        const startColumn = this.column;

        // Calculate end position
        let endLine = startLine;
        let endColumn = startColumn;
        for (const char of text) {
            if (char === '\n') {
                endLine++;
                endColumn = 0;
            } else {
                endColumn++;
            }
        }

        return {
            start: Position.create(startLine, startColumn),
            end: Position.create(endLine, endColumn)
        };
    }

    /**
     * Advances the current position by the given text.
     */
    private advancePosition(text: string): void {
        this.offset += text.length;
        for (const char of text) {
            if (char === '\n') {
                this.line++;
                this.column = 0;
            } else {
                this.column++;
            }
        }
    }

    /**
     * Removes a node from its parent's content.
     */
    private removeNode(node: CstNode): void {
        const parent = node.container;
        if (parent) {
            const index = parent.content.indexOf(node);
            if (index >= 0) {
                parent.content.splice(index, 1);
            }
        }
    }
}
