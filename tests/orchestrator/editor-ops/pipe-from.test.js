import { describe, expect, test, jest } from '@jest/globals';
import { createMessageEditorHandle } from '../../../public/scripts/message-takeover.js';
import { pipeFrom } from '../../../public/scripts/extensions/orchestrator/editor-ops.js';

function setup({ initialText = '', generationType = 'normal' } = {}) {
    const chat = [{ mes: initialText, extra: { reasoning: '' }, is_user: false }];
    const emit = jest.fn(async () => {});
    const handle = createMessageEditorHandle({
        generationType,
        originalText: initialText,
        flushIntervalMs: 0,
    });
    handle.setOnUpdate((text, reasoning) => {
        chat[0].mes = text;
        chat[0].extra.reasoning = reasoning;
    });
    return { chat, handle };
}

async function* fakeStream(chunks) {
    for (const chunk of chunks) {
        yield chunk;
    }
}

describe('pipeFrom', () => {
    test('append mode (default): concatenates text deltas to current text', async () => {
        const { chat, handle } = setup({ initialText: 'pre: ' });
        await pipeFrom(handle, fakeStream([
            { type: 'text', delta: 'hello' },
            { type: 'text', delta: ', ' },
            { type: 'text', delta: 'world.' },
        ]));
        expect(chat[0].mes).toBe('pre: hello, world.');
    });

    test('reasoning deltas append to reasoning regardless of mode', async () => {
        const { chat, handle } = setup({});
        await pipeFrom(handle, fakeStream([
            { type: 'reasoning', delta: 'think a. ' },
            { type: 'text', delta: 'visible' },
            { type: 'reasoning', delta: 'think b.' },
        ]), { mode: 'append' });
        expect(chat[0].mes).toBe('visible');
        expect(chat[0].extra.reasoning).toBe('think a. think b.');
    });

    test('replace mode: clears text then appends', async () => {
        const { chat, handle } = setup({ initialText: 'old draft' });
        await pipeFrom(handle, fakeStream([
            { type: 'text', delta: 'new ' },
            { type: 'text', delta: 'draft' },
        ]), { mode: 'replace' });
        expect(chat[0].mes).toBe('new draft');
    });

    test('replace mode rejected during continue', async () => {
        const { handle } = setup({ initialText: 'prefix', generationType: 'continue' });
        await expect(pipeFrom(handle, fakeStream([{ type: 'text', delta: 'x' }]), { mode: 'replace' }))
            .rejects.toEqual(expect.objectContaining({ code: 'invalid_op_for_continue' }));
    });

    test('ignores unknown chunk types silently', async () => {
        const { chat, handle } = setup({});
        await pipeFrom(handle, fakeStream([
            { type: 'text', delta: 'a' },
            { type: 'mystery', delta: 'ignored' },
            { type: 'text', delta: 'b' },
        ]));
        expect(chat[0].mes).toBe('ab');
    });

    test('does not auto-commit', async () => {
        const { handle } = setup({});
        await pipeFrom(handle, fakeStream([{ type: 'text', delta: 'x' }]));
        expect(() => handle.setText('y')).not.toThrow();
    });

    test('propagates stream rejection with same error instance', async () => {
        const { handle } = setup({});
        const boom = new Error('upstream boom');
        async function* failingStream() {
            yield { type: 'text', delta: 'a' };
            throw boom;
        }
        await expect(pipeFrom(handle, failingStream())).rejects.toBe(boom);
    });
});
