// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest } from '@jest/globals';
import { dispatchAzureOpenAI } from '../../../src/luker-dispatch/providers/chat-completions/azure-openai.js';

/**
 * Build a fake DispatchContext matching src/luker-dispatch/context.js shape.
 * Mirrors the AI21 test harness (tests/luker-dispatch/providers/ai21.test.js).
 * onFetch: async (url, init) => Response.
 */
function fakeCtx({ body = {}, onFetch, secret = 'azure-fake-key', signal } = {}) {
    const emitted = [];
    const ac = new AbortController();
    const attachedInspections = [];
    return {
        body: {
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'hi' }],
            stream: false,
            max_tokens: 128,
            temperature: 0.7,
            top_p: 1,
            azure_base_url: 'https://myresource.openai.azure.com',
            azure_deployment_name: 'my-deployment',
            azure_api_version: '2024-02-01',
            ...body,
        },
        user: {
            handle: 'alice',
            directories: {},
            profile: { handle: 'alice' },
        },
        signal: signal || ac.signal,
        fetch: onFetch || jest.fn(async () => new Response(JSON.stringify({
            id: 'azure-1',
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

describe('dispatchAzureOpenAI', () => {
    test('non-streaming: constructs Azure URL, uses api-key header, emits chunk then end', async () => {
        const ctx = fakeCtx();
        await dispatchAzureOpenAI(ctx);

        const kinds = ctx._emitted.map(e => e.kind);
        expect(kinds).toContain('chunk');
        expect(kinds[kinds.length - 1]).toBe('end');

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        const parsed = JSON.parse(Buffer.from(chunks[0].data).toString('utf8'));
        expect(parsed.choices[0].message.content).toBe('hello back');

        expect(ctx.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = ctx.fetch.mock.calls[0];
        const urlStr = String(url);
        expect(urlStr).toContain('myresource.openai.azure.com');
        expect(urlStr).toContain('/openai/deployments/my-deployment/chat/completions');
        expect(urlStr).toContain('api-version=2024-02-01');
        expect(init.method).toBe('POST');
        // Azure uses 'api-key' header, NOT Bearer Authorization.
        expect(init.headers['api-key']).toBe('azure-fake-key');
        expect(init.headers['Authorization']).toBeUndefined();
        expect(init.signal).toBe(ctx.signal);
    });

    test('missing configuration (no api key): emits error, no fetch', async () => {
        const ctx = fakeCtx({ secret: '' });
        await dispatchAzureOpenAI(ctx);

        const errs = ctx._emitted.filter(e => e.kind === 'error');
        expect(errs.length).toBeGreaterThan(0);
        expect(errs[0].error.message).toContain('Azure OpenAI configuration is incomplete');
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

        await dispatchAzureOpenAI(ctx);

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
        await dispatchAzureOpenAI(ctx);

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

        const dispatchPromise = dispatchAzureOpenAI(ctx);
        setImmediate(() => ac.abort());
        await dispatchPromise;

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(0);
        const errs = ctx._emitted.filter(e => e.kind === 'error');
        expect(errs.length).toBeGreaterThan(0);
    });
});
