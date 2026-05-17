import { describe, expect, test, jest } from '@jest/globals';
import { createMessageEditorHandle } from '../../../public/scripts/message-takeover.js';
import {
    appendText, appendReasoning,
    insertAt, replaceRange, deleteRange,
    EditorOpsError,
} from '../../../public/scripts/extensions/orchestrator/editor-ops.js';

function setup(initialText = '', initialReasoning = '') {
    const chat = [{ mes: initialText, extra: { reasoning: initialReasoning }, is_user: false }];
    const emit = jest.fn(async () => {});
    const handle = createMessageEditorHandle({
        generationType: 'normal',
        originalText: initialText,
        originalReasoning: initialReasoning,
        flushIntervalMs: 0,
    });
    handle.setOnUpdate((text, reasoning) => {
        chat[0].mes = text;
        chat[0].extra.reasoning = reasoning;
    });
    return { chat, emit, handle };
}

describe('appendText / appendReasoning', () => {
    test('appendText concatenates to current text', () => {
        const { chat, handle } = setup('Hello, ');
        appendText(handle, 'world.');
        expect(chat[0].mes).toBe('Hello, world.');
    });

    test('appendText with empty current text', () => {
        const { chat, handle } = setup('');
        appendText(handle, 'first');
        expect(chat[0].mes).toBe('first');
    });

    test('appendReasoning concatenates to current reasoning', () => {
        const { chat, handle } = setup('', 'first thought. ');
        appendReasoning(handle, 'second thought.');
        expect(chat[0].extra.reasoning).toBe('first thought. second thought.');
    });
});

describe('insertAt', () => {
    test('inserts at given offset', () => {
        const { chat, handle } = setup('Hello world.');
        insertAt(handle, 6, 'beautiful ');
        expect(chat[0].mes).toBe('Hello beautiful world.');
    });

    test('inserts at offset 0 (prepend)', () => {
        const { chat, handle } = setup('world.');
        insertAt(handle, 0, 'Hello, ');
        expect(chat[0].mes).toBe('Hello, world.');
    });

    test('inserts at end (equivalent to append)', () => {
        const { chat, handle } = setup('Hello');
        insertAt(handle, 5, ' there');
        expect(chat[0].mes).toBe('Hello there');
    });

    test('rejects negative offset', () => {
        const { handle } = setup('text');
        expect(() => insertAt(handle, -1, 'x')).toThrow(
            expect.objectContaining({ name: 'EditorOpsError', code: 'invalid_offset' }),
        );
    });

    test('rejects offset > text length', () => {
        const { handle } = setup('text');
        expect(() => insertAt(handle, 99, 'x')).toThrow(
            expect.objectContaining({ code: 'invalid_offset' }),
        );
    });
});

describe('replaceRange', () => {
    test('replaces a range with new text', () => {
        const { chat, handle } = setup('Hello, old world.');
        replaceRange(handle, 7, 10, 'new');
        expect(chat[0].mes).toBe('Hello, new world.');
    });

    test('replace with empty string deletes', () => {
        const { chat, handle } = setup('Hello, gone world.');
        replaceRange(handle, 7, 12, '');
        expect(chat[0].mes).toBe('Hello, world.');
    });

    test('rejects end < start', () => {
        const { handle } = setup('text');
        expect(() => replaceRange(handle, 3, 1, 'x')).toThrow(
            expect.objectContaining({ code: 'invalid_offset' }),
        );
    });

    test('rejects out-of-range bounds', () => {
        const { handle } = setup('text');
        expect(() => replaceRange(handle, 0, 99, 'x')).toThrow(
            expect.objectContaining({ code: 'invalid_offset' }),
        );
    });
});

describe('deleteRange', () => {
    test('deletes a range', () => {
        const { chat, handle } = setup('Hello, junk world.');
        deleteRange(handle, 5, 11);
        expect(chat[0].mes).toBe('Hello world.');
    });

    test('rejects out-of-range', () => {
        const { handle } = setup('text');
        expect(() => deleteRange(handle, 0, 99)).toThrow(
            expect.objectContaining({ code: 'invalid_offset' }),
        );
    });
});
