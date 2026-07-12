// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest } from '@jest/globals';
import { dispatchCohere } from '../../../src/luker-dispatch/providers/chat-completions/cohere.js';

/**
 * Build a fake DispatchContext matching src/luker-dispatch/context.js shape.
 * Mirrors the AI21 / CLAUDE test harnesses.
 * onFetch: async (url, init) => Response.
 */
function fakeCtx({ body = {}, onFetch, secret = 'cohere-fake-key', signal } = {}) {
    const emitted = [];
    const ac = new AbortController();
    const attachedInspections = [];
    return {
        body: {
            model: 'command-r-plus',
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
        // Default upstream JSON is COHERE-native (message + finish_reason at top level)
        // so the provider's normalization path can be exercised.
        fetch: onFetch || jest.fn(async () => new Response(JSON.stringify({
            id: 'cohere-1',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'hello back' }],
            },
            finish_reason: 'complete',
            usage: {
                billed_units: { input_tokens: 5, output_tokens: 3 },
                tokens: { input_tokens: 5, output_tokens: 3 },
            },
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
            complete: jest.fn(),
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

describe('dispatchCohere', () => {
    test('non-streaming: emits single chunk with OAI-normalized JSON then end', async () => {
        const ctx = fakeCtx();
        await dispatchCohere(ctx);

        const kinds = ctx._emitted.map(e => e.kind);
        expect(kinds).toContain('chunk');
        expect(kinds[kinds.length - 1]).toBe('end');

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        const text = Buffer.from(chunks[0].data).toString('utf8');
        const parsed = JSON.parse(text);
        // Legacy sendCohereRequest normalizes the upstream body via
        // normalizeCohereResponseToOAI before returning; the dispatch
        // provider must preserve that transformation.
        expect(parsed.choices[0].message.role).toBe('assistant');
        expect(parsed.choices[0].message.content).toBe('hello back');
        expect(parsed.choices[0].finish_reason).toBe('stop');

        expect(ctx.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = ctx.fetch.mock.calls[0];
        expect(String(url)).toContain('api.cohere.ai/v2/chat');
        expect(init.method).toBe('POST');
        expect(init.headers['Authorization']).toBe('Bearer cohere-fake-key');
        expect(init.signal).toBe(ctx.signal);
    });

    test('non-streaming: feeds raw Cohere body to inspector alongside OAI-normalized reply (Task 2D)', async () => {
        // Cohere's raw response has tool_plan reasoning + nested
        // usage.tokens/billed_units that the OAI-normalized reply flattens
        // away. Passing rawApiResponse to the inspector is forward-compat
        // wiring for source='cohere' extractors that need the pre-flatten
        // shape (currently the inspector routes Cohere usage through
        // extractUsageFromOAI on the normalized payload; the raw body
        // arriving unchanged means future cohere-specific extractors can
        // land without touching this dispatch call site again).
        const rawCohere = {
            id: 'cohere-raw-1',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'raw answer' }],
                tool_plan: 'i will call the search tool',
            },
            finish_reason: 'complete',
            usage: {
                billed_units: { input_tokens: 42, output_tokens: 7 },
                tokens: { input_tokens: 42, output_tokens: 7 },
            },
        };
        const ctx = fakeCtx({
            onFetch: jest.fn(async () => new Response(JSON.stringify(rawCohere), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })),
        });
        await dispatchCohere(ctx);

        expect(ctx.inspection.complete).toHaveBeenCalledTimes(1);
        const [oaiArg, rawArg] = ctx.inspection.complete.mock.calls[0];
        // First arg = OAI-normalized (message lifted into choices[0]).
        expect(oaiArg.choices?.[0]?.message?.content).toBe('raw answer');
        expect(oaiArg.choices?.[0]?.message?.reasoning_content).toBe('i will call the search tool');
        // Second arg = raw Cohere body (preserves nested usage.tokens +
        // billed_units + top-level message.tool_plan).
        expect(rawArg).toEqual(rawCohere);
        expect(rawArg.usage.tokens.input_tokens).toBe(42);
        expect(rawArg.usage.billed_units.output_tokens).toBe(7);
        expect(rawArg.message.tool_plan).toBe('i will call the search tool');
    });

    test('missing API key: emits error, no fetch', async () => {
        const ctx = fakeCtx({ secret: '' });
        await dispatchCohere(ctx);

        const errs = ctx._emitted.filter(e => e.kind === 'error');
        expect(errs.length).toBeGreaterThan(0);
        expect(ctx.fetch).not.toHaveBeenCalled();
    });

    test('streaming: forwards upstream SSE chunks verbatim then end', async () => {
        const sseBody =
            'data: {"type":"content-delta","delta":{"message":{"content":{"text":"he"}}}}\n\n' +
            'data: {"type":"content-delta","delta":{"message":{"content":{"text":"llo"}}}}\n\n' +
            'data: {"type":"message-end"}\n\n';

        const ctx = fakeCtx({
            body: { stream: true },
            onFetch: jest.fn(async () => new Response(sseBody, {
                status: 200,
                headers: { 'content-type': 'text/event-stream' },
            })),
        });

        await dispatchCohere(ctx);

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks.length).toBeGreaterThan(0);
        const decoded = chunks.map(c => Buffer.from(c.data).toString('utf8')).join('');
        expect(decoded).toContain('"text":"he"');
        expect(decoded).toContain('"text":"llo"');
        expect(decoded).toContain('message-end');
        expect(ctx._emitted[ctx._emitted.length - 1].kind).toBe('end');

        // Streaming request body must carry stream:true so upstream honors SSE.
        const [, init] = ctx.fetch.mock.calls[0];
        const reqBody = JSON.parse(init.body);
        expect(reqBody.stream).toBe(true);
    });

    test('upstream non-2xx: surfaces status+body via head+chunk+end (no emit.error)', async () => {
        const ctx = fakeCtx({
            onFetch: jest.fn(async () => new Response('{"message":"invalid api token"}', {
                status: 401,
                headers: { 'content-type': 'application/json' },
            })),
        });
        await dispatchCohere(ctx);

        const errs = ctx._emitted.filter(e => e.kind === 'error');
        expect(errs).toHaveLength(0);

        const heads = ctx._emitted.filter(e => e.kind === 'head');
        expect(heads).toHaveLength(1);
        expect(heads[0].data.status).toBe(401);

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        const decoded = new TextDecoder().decode(chunks[0].data);
        expect(decoded).toBe('{"message":"invalid api token"}');

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

        const dispatchPromise = dispatchCohere(ctx);
        setImmediate(() => ac.abort());
        await dispatchPromise;

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(0);
        const errs = ctx._emitted.filter(e => e.kind === 'error');
        expect(errs.length).toBeGreaterThan(0);
    });
});
