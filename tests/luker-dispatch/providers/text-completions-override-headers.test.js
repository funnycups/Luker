// SPDX-License-Identifier: AGPL-3.0-or-later
// Config.yaml requestOverrides can replace the auth header for a textgen
// host. The inspector fingerprint must reflect the credential that actually
// goes on the wire, not the stored secret. Mocks getOverrideHeaders so the
// override is exercised without touching the real config file.
import { jest } from '@jest/globals';

jest.unstable_mockModule('../../../src/additional-headers.js', () => ({
    getOverrideHeaders: jest.fn(() => ({ 'Authorization': 'Bearer override-key' })),
}));

const { dispatchTextCompletions } = await import('../../../src/luker-dispatch/providers/text-completions/dispatch.js');
const { TEXTGEN_TYPES } = await import('../../../src/constants.js');

function fakeCtx({ body = {}, onFetch } = {}) {
    const emitted = [];
    const attachCalls = [];
    return {
        body: {
            api_type: TEXTGEN_TYPES.OOBA,
            api_server: 'http://127.0.0.1:5000/v1',
            model: 'test-model',
            prompt: 'hello',
            stream: false,
            max_tokens: 128,
            temperature: 0.7,
            ...body,
        },
        user: { handle: 'alice', directories: {}, profile: { handle: 'alice' } },
        signal: new AbortController().signal,
        abort() {},
        fetch: onFetch || jest.fn(async () => new Response(JSON.stringify({
            id: 'tc-1',
            choices: [{ index: 0, text: 'hello back', finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }), { status: 200, headers: { 'content-type': 'application/json' } })),
        secrets: { read: jest.fn(() => 'stored-textgen-key') },
        generation: {
            startJob: jest.fn(() => null),
            appendEvent: jest.fn(),
            hasActiveKeepAliveJob: jest.fn(() => false),
        },
        inspection: {
            start: jest.fn(),
            attach: jest.fn((...args) => attachCalls.push(args)),
            fail: jest.fn(),
        },
        emit: {
            head: (h) => emitted.push({ kind: 'head', data: h }),
            chunk: (b) => emitted.push({ kind: 'chunk', data: b }),
            end: () => emitted.push({ kind: 'end' }),
            error: (e) => emitted.push({ kind: 'error', error: e }),
        },
        _emitted: emitted,
        _attachCalls: attachCalls,
    };
}

describe('text-completions inspector fingerprint vs config.yaml overrides', () => {
    test('fingerprint reflects Authorization replaced by getOverrideHeaders', async () => {
        const ctx = fakeCtx();
        await dispatchTextCompletions(ctx);

        const [, init] = ctx.fetch.mock.calls[0];
        expect(init.headers['Authorization']).toBe('Bearer override-key');

        expect(ctx._attachCalls).toHaveLength(1);
        const [, attachedKey] = ctx._attachCalls[0];
        expect(attachedKey).toBe('override-key');
    });
});
