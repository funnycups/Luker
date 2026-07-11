// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest } from '@jest/globals';
import { dispatchClaude } from '../../../src/luker-dispatch/providers/chat-completions/claude.js';

/**
 * Build a fake DispatchContext matching src/luker-dispatch/context.js shape.
 * onFetch: async (url, init) => Response.
 */
function fakeCtx({ body = {}, onFetch, secret = 'sk-ant-fake', signal } = {}) {
    const emitted = [];
    const ac = new AbortController();
    const attachedInspections = [];
    return {
        body: {
            model: 'claude-3-5-sonnet-20241022',
            messages: [{ role: 'user', content: 'hi' }],
            stream: false,
            max_tokens: 128,
            temperature: 1,
            top_p: 1,
            top_k: 0,
            ...body,
        },
        user: {
            handle: 'alice',
            directories: {},
            profile: { handle: 'alice' },
        },
        signal: signal || ac.signal,
        fetch: onFetch || jest.fn(async () => new Response(JSON.stringify({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'hello back' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 5, output_tokens: 3 },
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

describe('dispatchClaude', () => {
    test('non-streaming: emits single chunk containing upstream JSON body then end', async () => {
        const ctx = fakeCtx();
        await dispatchClaude(ctx);

        const kinds = ctx._emitted.map(e => e.kind);
        expect(kinds).toContain('chunk');
        expect(kinds[kinds.length - 1]).toBe('end');

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        const text = Buffer.from(chunks[0].data).toString('utf8');
        const parsed = JSON.parse(text);
        expect(parsed.content[0].text).toBe('hello back');

        // fetch called against anthropic endpoint w/ x-api-key + anthropic-version
        expect(ctx.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = ctx.fetch.mock.calls[0];
        expect(String(url)).toContain('/v1/messages');
        expect(init.method).toBe('POST');
        expect(init.headers['x-api-key']).toBe('sk-ant-fake');
        expect(init.headers['anthropic-version']).toBe('2023-06-01');
        expect(init.signal).toBe(ctx.signal);
    });

    test('missing API key with no reverse_proxy: emits error, no fetch', async () => {
        const ctx = fakeCtx({ secret: '' });
        await dispatchClaude(ctx);

        const errs = ctx._emitted.filter(e => e.kind === 'error');
        expect(errs.length).toBeGreaterThan(0);
        expect(ctx.fetch).not.toHaveBeenCalled();
    });

    test('streaming: forwards upstream SSE chunks verbatim then end', async () => {
        const sseBody =
            'event: message_start\ndata: {"type":"message_start"}\n\n' +
            'event: content_block_delta\ndata: {"delta":{"text":"hi"}}\n\n' +
            'event: message_stop\ndata: {"type":"message_stop"}\n\n';

        const ctx = fakeCtx({
            body: { stream: true },
            onFetch: jest.fn(async () => new Response(sseBody, {
                status: 200,
                headers: { 'content-type': 'text/event-stream' },
            })),
        });

        await dispatchClaude(ctx);

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks.length).toBeGreaterThan(0);
        const decoded = chunks.map(c => Buffer.from(c.data).toString('utf8')).join('');
        expect(decoded).toContain('event: message_start');
        expect(decoded).toContain('"text":"hi"');
        expect(decoded).toContain('event: message_stop');
        expect(ctx._emitted[ctx._emitted.length - 1].kind).toBe('end');
    });

    test('upstream non-2xx: surfaces status+body via head+chunk+end (no emit.error)', async () => {
        const ctx = fakeCtx({
            onFetch: jest.fn(async () => new Response('{"error":{"message":"bad key"}}', {
                status: 401,
                headers: { 'content-type': 'application/json' },
            })),
        });
        await dispatchClaude(ctx);

        // No emit.error: HTTP errors flow as a normal HTTP response via
        // head+chunk+end, so the client sees Response.status=<upstream>
        // and can read Response.body for structured inspection.
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
                // simulate fetch honoring signal
                init.signal.addEventListener('abort', () => {
                    const err = new Error('The user aborted a request.');
                    err.name = 'AbortError';
                    reject(err);
                });
            })),
        });

        const dispatchPromise = dispatchClaude(ctx);
        // trigger abort on next tick
        setImmediate(() => ac.abort());
        await dispatchPromise;

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(0);
        const errs = ctx._emitted.filter(e => e.kind === 'error');
        expect(errs.length).toBeGreaterThan(0);
    });
});
