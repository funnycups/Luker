import { describe, expect, test, jest } from '@jest/globals';
import { createMessageEditorHandle } from '../../../public/scripts/message-takeover.js';
import { applyPatch, EditorOpsError } from '../../../public/scripts/extensions/orchestrator/editor-ops.js';

function setup(initialText = '') {
    const chat = [{ mes: initialText, extra: { reasoning: '' }, is_user: false }];
    const emit = jest.fn(async () => {});
    const handle = createMessageEditorHandle({
        generationType: 'normal',
        originalText: initialText,
        flushIntervalMs: 0,
    });
    handle.setOnUpdate((text, reasoning) => {
        chat[0].mes = text;
        chat[0].extra.reasoning = reasoning;
    });
    return { chat, handle };
}

describe('applyPatch — low-level kinds', () => {
    test('replace_range', () => {
        const { chat, handle } = setup('Hello, old world.');
        applyPatch(handle, { kind: 'replace_range', start: 7, end: 10, text: 'new' });
        expect(chat[0].mes).toBe('Hello, new world.');
    });

    test('insert_at', () => {
        const { chat, handle } = setup('Hello world.');
        applyPatch(handle, { kind: 'insert_at', offset: 6, text: 'big ' });
        expect(chat[0].mes).toBe('Hello big world.');
    });

    test('delete_range', () => {
        const { chat, handle } = setup('Hello, junk world.');
        applyPatch(handle, { kind: 'delete_range', start: 5, end: 11 });
        expect(chat[0].mes).toBe('Hello world.');
    });

    test('array of patches applies in order', () => {
        const { chat, handle } = setup('aaa bbb ccc');
        applyPatch(handle, [
            { kind: 'replace_range', start: 0, end: 3, text: 'AAA' },
            { kind: 'insert_at', offset: 11, text: ' done' },
        ]);
        expect(chat[0].mes).toBe('AAA bbb ccc done');
    });

    test('unknown kind throws', () => {
        const { handle } = setup('text');
        expect(() => applyPatch(handle, { kind: 'nonsense' })).toThrow(EditorOpsError);
    });
});
