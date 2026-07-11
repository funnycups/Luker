// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest } from '@jest/globals';
import { dispatchElectronHub } from '../../../src/luker-dispatch/providers/chat-completions/electronhub.js';

/**
 * Build a fake DispatchContext matching src/luker-dispatch/context.js shape.
 * Mirrors the AI21/CLAUDE test harness so future providers reuse the same
 * structural conventions.
 * onFetch: async (url, init) => Response.
 */
function fakeCtx({ body = {}, onFetch, secret = 'electronhub-fake-key', signal } = {}) {
    const emitted = [];
    const ac = new AbortController();
    const attachedInspections = [];
    return {
        body: {
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: 'hi' }],
            stream: false,
            max_tokens: 128,
            temperature: 0.7,
            top_p: 1,
            ...body,
        },
        user: {
            handle: 'alice',
            directories: {},
            profile: { handle: 'alice' },
        },
        signal: signal || ac.signal,
        fetch: onFetch || jest.fn(async () => new Response(JSON.stringify({
            id: 'eh-1',
            choices: [
                {
                    index: 0,
                    message: { role: 'assistant', content: 'hello back' },
                    finish_reason: 'stop',
                },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }), { status: 200, headers: { 'content-type': 'application/json' } })),
        secrets: {
            read: jest.fn(() => secret),
        },
        generation: {
            startJob: jest.fn(() => null),
            appendEvent: jest.fn(),
            hasActiveKeepAliveJob: jest.fn(() => false),
        },
        inspection: {
            start: jest.fn(),
            attach: jest.fn((url) => attachedInspections.push(url)),
            fail: jest.fn(),
        },
        emit: {
            head: (h) => emitted.push({ kind: 'head', data: h }),
            chunk: (b) => emitted.push({ kind: 'chunk', data: b }),
            end: () => emitted.push({ kind: 'end' }),
            error: (e) => emitted.push({ kind: 'error', error: e }),
        },
        _emitted: emitted,
        _abortController: ac,
        _attachedInspections: attachedInspections,
    };
}

describe('dispatchElectronHub', () => {
    test('non-streaming: emits single chunk containing upstream JSON body then end', async () => {
        const ctx = fakeCtx();
        await dispatchElectronHub(ctx);

        const kinds = ctx._emitted.map(e => e.kind);
        expect(kinds).toContain('chunk');
        expect(kinds[kinds.length - 1]).toBe('end');

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        const text = Buffer.from(chunks[0].data).toString('utf8');
        const parsed = JSON.parse(text);
        expect(parsed.choices[0].message.content).toBe('hello back');

        expect(ctx.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = ctx.fetch.mock.calls[0];
        expect(String(url)).toBe('https://api.electronhub.ai/v1/chat/completions');
        expect(init.method).toBe('POST');
        expect(init.headers['Authorization']).toBe('Bearer electronhub-fake-key');
        expect(init.signal).toBe(ctx.signal);
    });

    test('missing API key: emits error, no fetch', async () => {
        const ctx = fakeCtx({ secret: '' });
        await dispatchElectronHub(ctx);

        const errs = ctx._emitted.filter(e => e.kind === 'error');
        expect(errs.length).toBeGreaterThan(0);
        expect(ctx.fetch).not.toHaveBeenCalled();
    });

    test('streaming: forwards upstream SSE chunks verbatim then end', async () => {
        const sseBody =
            'data: {"choices":[{"delta":{"content":"he"}}]}\n\n' +
            'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n' +
            'data: [DONE]\n\n';

        const ctx = fakeCtx({
            body: { stream: true },
            onFetch: jest.fn(async () => new Response(sseBody, {
                status: 200,
                headers: { 'content-type': 'text/event-stream' },
            })),
        });

        await dispatchElectronHub(ctx);

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks.length).toBeGreaterThan(0);
        const decoded = chunks.map(c => Buffer.from(c.data).toString('utf8')).join('');
        expect(decoded).toContain('"content":"he"');
        expect(decoded).toContain('"content":"llo"');
        expect(decoded).toContain('[DONE]');
        expect(ctx._emitted[ctx._emitted.length - 1].kind).toBe('end');
    });

    test('upstream non-2xx: surfaces status+body via head+chunk+end (no emit.error)', async () => {
        const ctx = fakeCtx({
            onFetch: jest.fn(async () => new Response('{"error":{"message":"bad key"}}', {
                status: 401,
                headers: { 'content-type': 'application/json' },
            })),
        });
        await dispatchElectronHub(ctx);

        const errs = ctx._emitted.filter(e => e.kind === 'error');
        expect(errs).toHaveLength(0);

        const heads = ctx._emitted.filter(e => e.kind === 'head');
        expect(heads).toHaveLength(1);
        expect(heads[0].data.status).toBe(401);

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        const decoded = new TextDecoder().decode(chunks[0].data);
        expect(decoded).toBe('{"error":{"message":"bad key"}}');

        const ends = ctx._emitted.filter(e => e.kind === 'end');
        expect(ends).toHaveLength(1);

        expect(ctx.inspection.fail).toHaveBeenCalledTimes(1);
    });

    test('ctx.signal aborted mid-request: fetch AbortError caught, emits error, no chunk', async () => {
        const ac = new AbortController();
        const ctx = fakeCtx({
            signal: ac.signal,
            onFetch: jest.fn((url, init) => new Promise((_, reject) => {
                init.signal.addEventListener('abort', () => {
                    const err = new Error('The user aborted a request.');
                    err.name = 'AbortError';
                    reject(err);
                });
            })),
        });

        const dispatchPromise = dispatchElectronHub(ctx);
        setImmediate(() => ac.abort());
        await dispatchPromise;

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(0);
        const errs = ctx._emitted.filter(e => e.kind === 'error');
        expect(errs.length).toBeGreaterThan(0);
    });
});
