// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest } from '@jest/globals';
import { dispatchOpenAICompatible } from '../../../src/luker-dispatch/providers/chat-completions/openai-compatible.js';
import { CHAT_COMPLETION_SOURCES } from '../../../src/constants.js';

/**
 * Build a fake DispatchContext matching src/luker-dispatch/context.js shape.
 * Mirrors azure-openai.test.js.
 */
function fakeCtx({ body = {}, onFetch, secretMap = {}, signal } = {}) {
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
            chat_completion_source: CHAT_COMPLETION_SOURCES.OPENAI,
            ...body,
        },
        user: { handle: 'alice', directories: {}, profile: { handle: 'alice' } },
        signal: signal || ac.signal,
        fetch: onFetch || jest.fn(async () => new Response(JSON.stringify({
            id: 'oc-1',
            choices: [{ index: 0, message: { role: 'assistant', content: 'hello back' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }), { status: 200, headers: { 'content-type': 'application/json' } })),
        secrets: {
            read: jest.fn((key /*, opts */) => secretMap[key] ?? ''),
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

describe('dispatchOpenAICompatible', () => {
    describe('resolveOpenAI', () => {
        test('default URL + Bearer + POST /chat/completions', async () => {
            const ctx = fakeCtx({ secretMap: { api_key_openai: 'oa-key' } });
            await dispatchOpenAICompatible(ctx);

            expect(ctx.fetch).toHaveBeenCalledTimes(1);
            const [url, init] = ctx.fetch.mock.calls[0];
            expect(String(url)).toBe('https://api.openai.com/v1/chat/completions');
            expect(init.method).toBe('POST');
            expect(init.headers['Authorization']).toBe('Bearer oa-key');
            expect(init.headers['Content-Type']).toBe('application/json');
            expect(init.signal).toBe(ctx.signal);
        });

        test('reverse_proxy overrides base URL, proxy_password overrides secret', async () => {
            const ctx = fakeCtx({
                body: {
                    reverse_proxy: 'https://proxy.example.com/v1',
                    proxy_password: 'proxy-pw',
                },
                secretMap: { api_key_openai: 'oa-key' },
            });
            await dispatchOpenAICompatible(ctx);
            const [url, init] = ctx.fetch.mock.calls[0];
            expect(String(url)).toBe('https://proxy.example.com/v1/chat/completions');
            expect(init.headers['Authorization']).toBe('Bearer proxy-pw');
        });
    });

    describe('resolveWorkersai', () => {
        test('constructs per-account URL, missing account_id emits error', async () => {
            const ctx = fakeCtx({
                body: {
                    chat_completion_source: CHAT_COMPLETION_SOURCES.WORKERS_AI,
                    workers_ai_account_id: 'acct-123',
                },
                secretMap: { api_key_workers_ai: 'wai-key' },
            });
            await dispatchOpenAICompatible(ctx);
            const [url] = ctx.fetch.mock.calls[0];
            expect(String(url)).toBe('https://api.cloudflare.com/client/v4/accounts/acct-123/ai/v1/chat/completions');

            const ctx2 = fakeCtx({
                body: {
                    chat_completion_source: CHAT_COMPLETION_SOURCES.WORKERS_AI,
                    workers_ai_account_id: '',
                },
                secretMap: { api_key_workers_ai: 'wai-key' },
            });
            await dispatchOpenAICompatible(ctx2);
            const errs = ctx2._emitted.filter(e => e.kind === 'error');
            expect(errs.length).toBeGreaterThan(0);
            expect(errs[0].error.message).toContain('Cloudflare Workers AI Account ID is missing');
            expect(ctx2.fetch).not.toHaveBeenCalled();
        });
    });

    describe('resolveCustom', () => {
        test('honors custom_url + merges custom_include_body/headers', async () => {
            const ctx = fakeCtx({
                body: {
                    chat_completion_source: CHAT_COMPLETION_SOURCES.CUSTOM,
                    custom_url: 'http://localhost:5001/v1',
                    custom_include_body: 'foo: bar\n',
                    custom_include_headers: 'X-Custom: yes\n',
                },
                secretMap: { api_key_custom: 'c-key' },
            });
            await dispatchOpenAICompatible(ctx);
            const [url, init] = ctx.fetch.mock.calls[0];
            expect(String(url)).toBe('http://localhost:5001/v1/chat/completions');
            expect(init.headers['X-Custom']).toBe('yes');
            const parsed = JSON.parse(init.body);
            expect(parsed.foo).toBe('bar');
            expect(init.headers['Authorization']).toBe('Bearer c-key');
        });

        test('CUSTOM without API key still dispatches (local server exemption)', async () => {
            const ctx = fakeCtx({
                body: {
                    chat_completion_source: CHAT_COMPLETION_SOURCES.CUSTOM,
                    custom_url: 'http://localhost:5001/v1',
                },
                secretMap: {},
            });
            await dispatchOpenAICompatible(ctx);
            expect(ctx.fetch).toHaveBeenCalledTimes(1);
            const errs = ctx._emitted.filter(e => e.kind === 'error');
            expect(errs).toHaveLength(0);
        });
    });

    test('non-streaming: emits chunk with JSON body then end', async () => {
        const ctx = fakeCtx({ secretMap: { api_key_openai: 'oa-key' } });
        await dispatchOpenAICompatible(ctx);
        const kinds = ctx._emitted.map(e => e.kind);
        expect(kinds).toContain('chunk');
        expect(kinds[kinds.length - 1]).toBe('end');
        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        const parsed = JSON.parse(Buffer.from(chunks[0].data).toString('utf8'));
        expect(parsed.choices[0].message.content).toBe('hello back');
    });

    test('streaming: forwards SSE chunks verbatim then end', async () => {
        const sseBody =
            'data: {"choices":[{"delta":{"content":"he"}}]}\n\n' +
            'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n' +
            'data: [DONE]\n\n';
        const ctx = fakeCtx({
            body: { stream: true },
            secretMap: { api_key_openai: 'oa-key' },
            onFetch: jest.fn(async () => new Response(sseBody, {
                status: 200, headers: { 'content-type': 'text/event-stream' },
            })),
        });
        await dispatchOpenAICompatible(ctx);
        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks.length).toBeGreaterThan(0);
        const decoded = chunks.map(c => Buffer.from(c.data).toString('utf8')).join('');
        expect(decoded).toContain('"content":"he"');
        expect(decoded).toContain('[DONE]');
        expect(ctx._emitted[ctx._emitted.length - 1].kind).toBe('end');
    });

    test('upstream non-2xx: surfaces status+body via head+chunk+end (no emit.error)', async () => {
        const ctx = fakeCtx({
            secretMap: { api_key_openai: 'oa-key' },
            onFetch: jest.fn(async () => new Response('{"error":{"message":"bad key"}}', {
                status: 401, headers: { 'content-type': 'application/json' },
            })),
        });
        await dispatchOpenAICompatible(ctx);

        const errs = ctx._emitted.filter(e => e.kind === 'error');
        expect(errs).toHaveLength(0);

        const heads = ctx._emitted.filter(e => e.kind === 'head');
        expect(heads).toHaveLength(1);
        expect(heads[0].data.status).toBe(401);

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        expect(new TextDecoder().decode(chunks[0].data)).toBe('{"error":{"message":"bad key"}}');

        expect(ctx._emitted.filter(e => e.kind === 'end')).toHaveLength(1);
        expect(ctx.inspection.fail).toHaveBeenCalled();
    });

    test('missing apiKey (OPENAI, no proxy/base): emits error, no fetch', async () => {
        const ctx = fakeCtx({ secretMap: {} });
        await dispatchOpenAICompatible(ctx);
        const errs = ctx._emitted.filter(e => e.kind === 'error');
        expect(errs.length).toBeGreaterThan(0);
        expect(errs[0].error.message).toContain('OpenAI API key is missing');
        expect(ctx.fetch).not.toHaveBeenCalled();
        expect(ctx.inspection.fail).toHaveBeenCalled();
    });

    test('ctx.signal abort: emits error, no chunk', async () => {
        const ac = new AbortController();
        const ctx = fakeCtx({
            signal: ac.signal,
            secretMap: { api_key_openai: 'oa-key' },
            onFetch: jest.fn((url, init) => new Promise((_, reject) => {
                init.signal.addEventListener('abort', () => {
                    const err = new Error('The user aborted a request.');
                    err.name = 'AbortError';
                    reject(err);
                });
            })),
        });
        const p = dispatchOpenAICompatible(ctx);
        setImmediate(() => ac.abort());
        await p;
        expect(ctx._emitted.filter(e => e.kind === 'chunk')).toHaveLength(0);
        expect(ctx._emitted.filter(e => e.kind === 'error').length).toBeGreaterThan(0);
    });

    test('unsupported source: emits error, no fetch', async () => {
        const ctx = fakeCtx({ body: { chat_completion_source: 'not-a-real-source' } });
        await dispatchOpenAICompatible(ctx);
        const errs = ctx._emitted.filter(e => e.kind === 'error');
        expect(errs.length).toBeGreaterThan(0);
        expect(errs[0].error.message).toContain('unsupported source');
        expect(ctx.fetch).not.toHaveBeenCalled();
    });

    // Per-provider URL/key smoke tests.
    describe('per-provider URL/key smoke', () => {
        test('PERPLEXITY', async () => {
            const ctx = fakeCtx({
                body: { chat_completion_source: CHAT_COMPLETION_SOURCES.PERPLEXITY },
                secretMap: { api_key_perplexity: 'pk' },
            });
            await dispatchOpenAICompatible(ctx);
            const [url, init] = ctx.fetch.mock.calls[0];
            expect(String(url)).toBe('https://api.perplexity.ai/chat/completions');
            expect(init.headers['Authorization']).toBe('Bearer pk');
        });

        test('GROQ', async () => {
            const ctx = fakeCtx({
                body: { chat_completion_source: CHAT_COMPLETION_SOURCES.GROQ },
                secretMap: { api_key_groq: 'gk' },
            });
            await dispatchOpenAICompatible(ctx);
            const [url, init] = ctx.fetch.mock.calls[0];
            expect(String(url)).toBe('https://api.groq.com/openai/v1/chat/completions');
            expect(init.headers['Authorization']).toBe('Bearer gk');
        });

        test('FIREWORKS', async () => {
            const ctx = fakeCtx({
                body: { chat_completion_source: CHAT_COMPLETION_SOURCES.FIREWORKS },
                secretMap: { api_key_fireworks: 'fk' },
            });
            await dispatchOpenAICompatible(ctx);
            const [url] = ctx.fetch.mock.calls[0];
            expect(String(url)).toBe('https://api.fireworks.ai/inference/v1/chat/completions');
        });

        test('NANOGPT + custom headers (X-Provider, X-Billing-Mode)', async () => {
            const ctx = fakeCtx({
                body: {
                    chat_completion_source: CHAT_COMPLETION_SOURCES.NANOGPT,
                    nanogpt_provider: 'anthropic',
                    nanogpt_payg_override: true,
                },
                secretMap: { api_key_nanogpt: 'nk' },
            });
            await dispatchOpenAICompatible(ctx);
            const [url, init] = ctx.fetch.mock.calls[0];
            expect(String(url)).toBe('https://nano-gpt.com/api/v1/chat/completions');
            expect(init.headers['X-Provider']).toBe('anthropic');
            expect(init.headers['X-Billing-Mode']).toBe('paygo');
            const parsed = JSON.parse(init.body);
            expect(parsed.billing_mode).toBe('paygo');
        });

        test('POLLINATIONS (uses readSecret with secret_id)', async () => {
            const ctx = fakeCtx({
                body: {
                    chat_completion_source: CHAT_COMPLETION_SOURCES.POLLINATIONS,
                    secret_id: 'user-scoped-id',
                },
                secretMap: { api_key_pollinations: 'pk-secret' },
            });
            await dispatchOpenAICompatible(ctx);
            const [url, init] = ctx.fetch.mock.calls[0];
            expect(String(url)).toBe('https://gen.pollinations.ai/v1/chat/completions');
            expect(init.headers['Authorization']).toBe('Bearer pk-secret');
            // Verify secret_id was forwarded to secrets.read.
            expect(ctx.secrets.read).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ secretId: 'user-scoped-id' }),
            );
        });

        test('MOONSHOT (reverse_proxy honored)', async () => {
            const ctx = fakeCtx({
                body: {
                    chat_completion_source: CHAT_COMPLETION_SOURCES.MOONSHOT,
                    reverse_proxy: 'https://moonshot-proxy.example.com/v1',
                },
                secretMap: { api_key_moonshot: 'mk' },
            });
            await dispatchOpenAICompatible(ctx);
            const [url, init] = ctx.fetch.mock.calls[0];
            expect(String(url)).toContain('moonshot-proxy.example.com');
            expect(String(url)).toContain('/chat/completions');
            expect(init.headers['Authorization']).toBe('Bearer mk');
        });

        test('MOONSHOT renames assistant `reasoning` to `reasoning_content` on wire', async () => {
            const ctx = fakeCtx({
                body: {
                    chat_completion_source: CHAT_COMPLETION_SOURCES.MOONSHOT,
                    model: 'kimi-k2.6',
                    messages: [
                        { role: 'user', content: 'q1' },
                        { role: 'assistant', content: 'a1', reasoning: 'think about q1' },
                        { role: 'user', content: 'q2' },
                    ],
                },
                secretMap: { api_key_moonshot: 'mk' },
            });
            await dispatchOpenAICompatible(ctx);
            const [, init] = ctx.fetch.mock.calls[0];
            const wireBody = JSON.parse(init.body);
            const assistantMsg = wireBody.messages.find(m => m.role === 'assistant');
            expect(assistantMsg.reasoning_content).toBe('think about q1');
            expect(assistantMsg).not.toHaveProperty('reasoning');
        });

        test('MOONSHOT preserves pre-existing reasoning_content unchanged', async () => {
            const ctx = fakeCtx({
                body: {
                    chat_completion_source: CHAT_COMPLETION_SOURCES.MOONSHOT,
                    model: 'kimi-k2.6',
                    messages: [
                        { role: 'user', content: 'q' },
                        { role: 'assistant', content: 'a', reasoning: 'stray', reasoning_content: 'authoritative' },
                    ],
                },
                secretMap: { api_key_moonshot: 'mk' },
            });
            await dispatchOpenAICompatible(ctx);
            const [, init] = ctx.fetch.mock.calls[0];
            const wireBody = JSON.parse(init.body);
            const assistantMsg = wireBody.messages.find(m => m.role === 'assistant');
            expect(assistantMsg.reasoning_content).toBe('authoritative');
            expect(assistantMsg.reasoning).toBe('stray');
        });

        test('MOONSHOT does not add reasoning_content when reasoning is absent or empty', async () => {
            const ctx = fakeCtx({
                body: {
                    chat_completion_source: CHAT_COMPLETION_SOURCES.MOONSHOT,
                    model: 'kimi-k2.6',
                    messages: [
                        { role: 'user', content: 'q1' },
                        { role: 'assistant', content: 'no thinking here' },
                        { role: 'user', content: 'q2' },
                        { role: 'assistant', content: 'empty string reasoning', reasoning: '' },
                    ],
                },
                secretMap: { api_key_moonshot: 'mk' },
            });
            await dispatchOpenAICompatible(ctx);
            const [, init] = ctx.fetch.mock.calls[0];
            const wireBody = JSON.parse(init.body);
            for (const m of wireBody.messages.filter(x => x.role === 'assistant')) {
                expect(m).not.toHaveProperty('reasoning_content');
            }
        });

        test('COMETAPI (temporarily disabled: emits error, no fetch)', async () => {
            const ctx = fakeCtx({
                body: { chat_completion_source: CHAT_COMPLETION_SOURCES.COMETAPI },
                secretMap: { api_key_cometapi: 'ck' },
            });
            await dispatchOpenAICompatible(ctx);
            const errs = ctx._emitted.filter(e => e.kind === 'error');
            expect(errs.length).toBeGreaterThan(0);
            expect(errs[0].error.message).toContain('temporarily disabled');
            expect(ctx.fetch).not.toHaveBeenCalled();
        });

        test('ZAI (adds Accept-Language, chooses common URL by default)', async () => {
            const ctx = fakeCtx({
                body: { chat_completion_source: CHAT_COMPLETION_SOURCES.ZAI },
                secretMap: { api_key_zai: 'zk' },
            });
            await dispatchOpenAICompatible(ctx);
            const [url, init] = ctx.fetch.mock.calls[0];
            expect(String(url)).toContain('api.z.ai/api/paas/v4');
            expect(init.headers['Accept-Language']).toBe('en-US,en');
            expect(init.headers['Authorization']).toBe('Bearer zk');
        });

        test('SILICONFLOW (default endpoint = COM, CN endpoint honored)', async () => {
            const ctx = fakeCtx({
                body: { chat_completion_source: CHAT_COMPLETION_SOURCES.SILICONFLOW },
                secretMap: { api_key_siliconflow: 'sk' },
            });
            await dispatchOpenAICompatible(ctx);
            const [url] = ctx.fetch.mock.calls[0];
            expect(String(url)).toBe('https://api.siliconflow.com/v1/chat/completions');

            const ctx2 = fakeCtx({
                body: {
                    chat_completion_source: CHAT_COMPLETION_SOURCES.SILICONFLOW,
                    siliconflow_endpoint: 'cn',
                },
                secretMap: { api_key_siliconflow: 'sk' },
            });
            await dispatchOpenAICompatible(ctx2);
            const [url2] = ctx2.fetch.mock.calls[0];
            expect(String(url2)).toBe('https://api.siliconflow.cn/v1/chat/completions');
        });

        test('OPENROUTER (URL, OPENROUTER_HEADERS present, transforms honored)', async () => {
            const ctx = fakeCtx({
                body: {
                    chat_completion_source: CHAT_COMPLETION_SOURCES.OPENROUTER,
                    model: 'openai/gpt-4o',
                    middleout: 'off',
                },
                secretMap: { api_key_openrouter: 'ok' },
            });
            await dispatchOpenAICompatible(ctx);
            const [url, init] = ctx.fetch.mock.calls[0];
            expect(String(url)).toBe('https://openrouter.ai/api/v1/chat/completions');
            expect(init.headers['Authorization']).toBe('Bearer ok');
            // OPENROUTER_HEADERS include HTTP-Referer / X-Title.
            expect(init.headers['HTTP-Referer'] || init.headers['X-Title']).toBeDefined();
            const parsed = JSON.parse(init.body);
            expect(parsed.transforms).toEqual([]);
        });
    });
});
