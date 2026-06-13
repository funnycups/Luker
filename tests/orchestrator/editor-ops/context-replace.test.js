import { describe, expect, test, jest } from '@jest/globals';
import { createMessageEditorHandle } from '../../../public/scripts/message-takeover.js';
import { applyPatch, patchBySemantic } from '../../../public/scripts/extensions/orchestrator/editor-ops.js';

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

describe('context_replace patch (via applyPatch)', () => {
    test('replaces unique oldString with newString', () => {
        const { chat, handle } = setup('The cat sat on the mat.');
        applyPatch(handle, { kind: 'context_replace', oldString: 'cat', newString: 'dog' });
        expect(chat[0].mes).toBe('The dog sat on the mat.');
    });

    test('throws patch_not_found if oldString missing', () => {
        const { handle } = setup('Hello world.');
        expect(() => applyPatch(handle, { kind: 'context_replace', oldString: 'xyzzy', newString: 'foo' })).toThrow(
            expect.objectContaining({ name: 'EditorOpsError', code: 'patch_not_found' }),
        );
    });

    test('throws patch_ambiguous when oldString matches multiple locations', () => {
        const { handle } = setup('The cat saw another cat.');
        expect(() => applyPatch(handle, { kind: 'context_replace', oldString: 'cat', newString: 'dog' })).toThrow(
            expect.objectContaining({ code: 'patch_ambiguous' }),
        );
    });

    test('patch_ambiguous message directs caller to expand context', () => {
        const { handle } = setup('cat cat cat');
        try {
            applyPatch(handle, { kind: 'context_replace', oldString: 'cat', newString: 'dog' });
            throw new Error('expected throw');
        } catch (err) {
            expect(err.code).toBe('patch_ambiguous');
            expect(err.message).toMatch(/(extend|expand).*context/i);
        }
    });

    test('uniquely-resolving oldString with surrounding context succeeds', () => {
        // Same target word appears multiple times; caller must include
        // enough surrounding context for the `oldString` to match exactly once.
        const { chat, handle } = setup('The cat saw another cat. The dog barked.');
        applyPatch(handle, {
            kind: 'context_replace',
            oldString: 'another cat.',
            newString: 'another dog.',
        });
        expect(chat[0].mes).toBe('The cat saw another dog. The dog barked.');
    });

    test('no normalization (whitespace, case, indent are strict)', () => {
        const { handle } = setup('Hello World.');
        expect(() => applyPatch(handle, { kind: 'context_replace', oldString: 'hello world.', newString: 'hi' })).toThrow(
            expect.objectContaining({ code: 'patch_not_found' }),
        );
    });

    test('empty oldString throws patch_not_found', () => {
        const { handle } = setup('text');
        expect(() => applyPatch(handle, { kind: 'context_replace', oldString: '', newString: 'x' })).toThrow(
            expect.objectContaining({ code: 'patch_not_found' }),
        );
    });

    test('occurrence field is ignored if supplied (no longer part of contract)', () => {
        // Older clients may still emit `occurrence` — it must not influence
        // the unique-match requirement: if oldString is unique, succeed; if
        // not, fail with patch_ambiguous regardless of the supplied occurrence.
        const { chat, handle } = setup('The cat sat.');
        applyPatch(handle, { kind: 'context_replace', oldString: 'cat', newString: 'dog', occurrence: 1 });
        expect(chat[0].mes).toBe('The dog sat.');

        const { handle: h2 } = setup('cat cat');
        expect(() => applyPatch(h2, { kind: 'context_replace', oldString: 'cat', newString: 'dog', occurrence: 2 })).toThrow(
            expect.objectContaining({ code: 'patch_ambiguous' }),
        );
    });
});

describe('patchBySemantic — sugar for context_replace', () => {
    test('equivalent to applyPatch with kind=context_replace', () => {
        const { chat, handle } = setup('alpha beta gamma.');
        patchBySemantic(handle, { oldString: 'beta', newString: 'BETA' });
        expect(chat[0].mes).toBe('alpha BETA gamma.');
    });

    test('multiple matches require expanding context (no occurrence escape)', () => {
        const { handle } = setup('x x x');
        expect(() => patchBySemantic(handle, { oldString: 'x', newString: 'Y' })).toThrow(
            expect.objectContaining({ code: 'patch_ambiguous' }),
        );
    });
});
