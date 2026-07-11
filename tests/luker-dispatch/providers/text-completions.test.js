// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest } from '@jest/globals';
import { dispatchTextCompletions } from '../../../src/luker-dispatch/providers/text-completions/dispatch.js';
import { TEXTGEN_TYPES } from '../../../src/constants.js';

/**
 * Build a fake DispatchContext matching src/luker-dispatch/context.js shape.
 * Mirrors openai-compatible.test.js but tailored for text-completions
 * (api_type driver, api_server, no `chat_completion_source`).
 */
function fakeCtx({ body = {}, onFetch, signal } = {}) {
    const emitted = [];
    const ac = new AbortController();
    const attachedInspections = [];
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
        signal: signal || ac.signal,
        fetch: onFetch || jest.fn(async () => new Response(JSON.stringify({
            id: 'tc-1',
            choices: [{ index: 0, text: 'hello back', finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }), { status: 200, headers: { 'content-type': 'application/json' } })),
        secrets: {
            read: jest.fn(() => ''),
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

function chunkToStr(c) {
    return Buffer.from(c.data).toString('utf8');
}

describe('dispatchTextCompletions', () => {
    describe('URL suffix per api_type', () => {
        const cases = [
            [TEXTGEN_TYPES.OOBA, 'http://127.0.0.1:5000/v1/completions'],
            [TEXTGEN_TYPES.TOGETHERAI, 'http://127.0.0.1:5000/v1/completions'],
            [TEXTGEN_TYPES.DREAMGEN, 'http://127.0.0.1:5000/api/openai/v1/completions'],
            [TEXTGEN_TYPES.MANCER, 'http://127.0.0.1:5000/oai/v1/completions'],
            [TEXTGEN_TYPES.LLAMACPP, 'http://127.0.0.1:5000/completion'],
            [TEXTGEN_TYPES.OLLAMA, 'http://127.0.0.1:5000/api/generate'],
            [TEXTGEN_TYPES.OPENROUTER, 'http://127.0.0.1:5000/v1/chat/completions'],
        ];
        test.each(cases)('%s → %s', async (apiType, expectedUrl) => {
            const ctx = fakeCtx({ body: { api_type: apiType } });
            await dispatchTextCompletions(ctx);
            expect(ctx.fetch).toHaveBeenCalledTimes(1);
            const [url] = ctx.fetch.mock.calls[0];
            expect(String(url)).toBe(expectedUrl);
        });
    });

    test('localhost → 127.0.0.1 rewrite', async () => {
        const ctx = fakeCtx({
            body: { api_type: TEXTGEN_TYPES.OOBA, api_server: 'http://localhost:5000/v1' },
        });
        await dispatchTextCompletions(ctx);
        const [url] = ctx.fetch.mock.calls[0];
        expect(String(url)).toBe('http://127.0.0.1:5000/v1/completions');
    });

    describe('body pickBy per api_type', () => {
        test('TOGETHERAI pickBy → only TOGETHERAI_KEYS survive', async () => {
            const ctx = fakeCtx({
                body: {
                    api_type: TEXTGEN_TYPES.TOGETHERAI,
                    model: 'togmodel',
                    prompt: 'hi',
                    temperature: 0.5,
                    max_tokens: 32,
                    // Not in TOGETHERAI_KEYS — must be filtered out:
                    foobar_extra: 'nope',
                    luker_generation: { persist_target: 'x' },
                },
            });
            await dispatchTextCompletions(ctx);
            const [, init] = ctx.fetch.mock.calls[0];
            const parsed = JSON.parse(init.body);
            expect(parsed.model).toBe('togmodel');
            expect(parsed.foobar_extra).toBeUndefined();
            expect(parsed.luker_generation).toBeUndefined();
        });

        test('OPENROUTER: provider array → { allow_fallbacks, order } + pickBy', async () => {
            const ctx = fakeCtx({
                body: {
                    api_type: TEXTGEN_TYPES.OPENROUTER,
                    model: 'or-model',
                    provider: ['groq', 'together'],
                    allow_fallbacks: false,
                    quantizations: ['int8'],
                    max_tokens: 128,
                    temperature: 0.5,
                },
            });
            await dispatchTextCompletions(ctx);
            const [, init] = ctx.fetch.mock.calls[0];
            const parsed = JSON.parse(init.body);
            expect(parsed.provider).toEqual({
                allow_fallbacks: false,
                order: ['groq', 'together'],
                quantizations: ['int8'],
            });
        });

        test('OLLAMA re-shape: options + raw + keep_alive wrapping', async () => {
            const ctx = fakeCtx({
                body: {
                    api_type: TEXTGEN_TYPES.OLLAMA,
                    model: 'llama3',
                    prompt: 'hi',
                    stream: false,
                    // OLLAMA_KEYS include temperature, top_p, etc. — should
                    // land inside `options`:
                    temperature: 0.9,
                    top_p: 0.95,
                },
            });
            await dispatchTextCompletions(ctx);
            const [, init] = ctx.fetch.mock.calls[0];
            const parsed = JSON.parse(init.body);
            expect(parsed.model).toBe('llama3');
            expect(parsed.prompt).toBe('hi');
            expect(parsed.raw).toBe(true);
            expect(parsed.stream).toBe(false);
            expect(parsed).toHaveProperty('keep_alive');
            expect(parsed.options.temperature).toBe(0.9);
            expect(parsed.options.top_p).toBe(0.95);
            // top-level temperature should NOT be present after re-shape:
            expect(parsed.temperature).toBeUndefined();
        });
    });

    test('non-streaming: emits single chunk with JSON body then end', async () => {
        const ctx = fakeCtx();
        await dispatchTextCompletions(ctx);
        const kinds = ctx._emitted.map(e => e.kind);
        expect(kinds).toContain('chunk');
        expect(kinds[kinds.length - 1]).toBe('end');
        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        const parsed = JSON.parse(chunkToStr(chunks[0]));
        expect(parsed.choices[0].text).toBe('hello back');
    });

    test('streaming (non-Ollama): forwards raw SSE chunks then end', async () => {
        const sseBody =
            'data: {"choices":[{"text":"he"}]}\n\n' +
            'data: {"choices":[{"text":"llo"}]}\n\n' +
            'data: [DONE]\n\n';
        const ctx = fakeCtx({
            body: { stream: true },
            onFetch: jest.fn(async () => new Response(sseBody, {
                status: 200, headers: { 'content-type': 'text/event-stream' },
            })),
        });
        await dispatchTextCompletions(ctx);
        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks.length).toBeGreaterThan(0);
        const decoded = chunks.map(chunkToStr).join('');
        expect(decoded).toContain('"text":"he"');
        expect(decoded).toContain('[DONE]');
        expect(ctx._emitted[ctx._emitted.length - 1].kind).toBe('end');
    });

    test('upstream non-2xx: surfaces status+body via head+chunk+end (no emit.error)', async () => {
        const ctx = fakeCtx({
            onFetch: jest.fn(async () => new Response('{"error":{"message":"bad"}}', {
                status: 500, headers: { 'content-type': 'application/json' },
            })),
        });
        await dispatchTextCompletions(ctx);

        const errs = ctx._emitted.filter(e => e.kind === 'error');
        expect(errs).toHaveLength(0);

        const heads = ctx._emitted.filter(e => e.kind === 'head');
        expect(heads).toHaveLength(1);
        expect(heads[0].data.status).toBe(500);

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        expect(new TextDecoder().decode(chunks[0].data)).toBe('{"error":{"message":"bad"}}');

        expect(ctx._emitted.filter(e => e.kind === 'end')).toHaveLength(1);
        expect(ctx.inspection.fail).toHaveBeenCalled();
    });

    test('ctx.signal abort: emits error, no chunk', async () => {
        const ac = new AbortController();
        const ctx = fakeCtx({
            signal: ac.signal,
            onFetch: jest.fn((_url, init) => new Promise((_resolve, reject) => {
                init.signal.addEventListener('abort', () => {
                    const err = new Error('The user aborted a request.');
                    err.name = 'AbortError';
                    reject(err);
                });
            })),
        });
        const p = dispatchTextCompletions(ctx);
        setImmediate(() => ac.abort());
        await p;
        expect(ctx._emitted.filter(e => e.kind === 'chunk')).toHaveLength(0);
        expect(ctx._emitted.filter(e => e.kind === 'error').length).toBeGreaterThan(0);
    });

    test('KOBOLDCPP abort side channel: POST to /api/extra/abort when signal aborts', async () => {
        const ac = new AbortController();
        const upstreamPromise = new Promise((_resolve, reject) => {
            // Never resolves until aborted, mimicking a long-running gen.
        });
        const fetchMock = jest.fn((url, init) => {
            if (String(url).includes('/api/extra/abort')) {
                return Promise.resolve(new Response('{}', { status: 200 }));
            }
            // First call = the /v1/completions request; hang until abort.
            return new Promise((_resolve, reject) => {
                init.signal.addEventListener('abort', () => {
                    const err = new Error('aborted');
                    err.name = 'AbortError';
                    reject(err);
                });
            });
        });
        const ctx = fakeCtx({
            signal: ac.signal,
            body: {
                api_type: TEXTGEN_TYPES.KOBOLDCPP,
                api_server: 'http://127.0.0.1:5001',
                stream: true,
            },
            onFetch: fetchMock,
        });
        const p = dispatchTextCompletions(ctx);
        // Give the dispatch a tick to register the abort listener + issue
        // the initial fetch, then abort.
        await new Promise(r => setImmediate(r));
        ac.abort();
        await p;
        // Give the fire-and-forget abort a chance to run.
        await new Promise(r => setImmediate(r));

        const abortCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/extra/abort'));
        expect(abortCalls).toHaveLength(1);
        const [abortUrl, abortInit] = abortCalls[0];
        expect(String(abortUrl)).toBe('http://127.0.0.1:5001/api/extra/abort');
        expect(abortInit.method).toBe('POST');
        void upstreamPromise;
    });

    test('OLLAMA stream: NDJSON → SSE data: frames + trailing [DONE]', async () => {
        // Build an async iterable body of NDJSON bytes matching the Ollama
        // streaming shape (`{response, thinking}` per line).
        const enc = new TextEncoder();
        const lines = [
            JSON.stringify({ response: 'foo', thinking: '' }),
            JSON.stringify({ response: 'bar', thinking: '' }),
        ];
        const bodyText = lines.join('\n') + '\n';
        const upstream = new Response(bodyText, {
            status: 200, headers: { 'content-type': 'application/x-ndjson' },
        });
        const ctx = fakeCtx({
            body: {
                api_type: TEXTGEN_TYPES.OLLAMA,
                api_server: 'http://127.0.0.1:11434',
                stream: true,
                model: 'llama3',
                prompt: 'hi',
            },
            onFetch: jest.fn(async () => upstream),
        });
        await dispatchTextCompletions(ctx);

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks.length).toBeGreaterThanOrEqual(2);
        const decoded = chunks.map(chunkToStr).join('');
        // Each Ollama NDJSON line should be reshaped to a `data: {choices:[{text,...}]}\n\n` frame.
        expect(decoded).toContain('data: {"choices":[{"text":"foo"');
        expect(decoded).toContain('data: {"choices":[{"text":"bar"');
        expect(decoded.trim().endsWith('data: [DONE]')).toBe(true);
        expect(ctx._emitted[ctx._emitted.length - 1].kind).toBe('end');
        // Confirm no reference-character corruption on the reshape:
        expect(decoded).not.toContain('\ufffd');
        // Provide encoder reference so linter is quiet.
        void enc;
    });

    test('unsupported api_type: emits error, no fetch', async () => {
        const ctx = fakeCtx({ body: { api_type: 'not-a-real-api-type' } });
        await dispatchTextCompletions(ctx);
        const errs = ctx._emitted.filter(e => e.kind === 'error');
        expect(errs.length).toBeGreaterThan(0);
        expect(errs[0].error.message).toContain('unsupported api_type');
        expect(ctx.fetch).not.toHaveBeenCalled();
    });

    test('missing api_server: emits error, no fetch', async () => {
        const ctx = fakeCtx({ body: { api_type: TEXTGEN_TYPES.OOBA, api_server: '' } });
        await dispatchTextCompletions(ctx);
        const errs = ctx._emitted.filter(e => e.kind === 'error');
        expect(errs.length).toBeGreaterThan(0);
        expect(errs[0].error.message).toContain('api_server missing');
        expect(ctx.fetch).not.toHaveBeenCalled();
    });

    test('INFERMATICAI non-streaming: message.content → text reshape', async () => {
        const upstream = new Response(JSON.stringify({
            id: 'inf-1',
            choices: [
                { index: 0, message: { role: 'assistant', content: 'hi from infermatic' }, logprobs: null },
            ],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
        const ctx = fakeCtx({
            body: { api_type: TEXTGEN_TYPES.INFERMATICAI, model: 'inf-model', prompt: 'p', stream: false },
            onFetch: jest.fn(async () => upstream),
        });
        await dispatchTextCompletions(ctx);
        const chunk = ctx._emitted.find(e => e.kind === 'chunk');
        const parsed = JSON.parse(chunkToStr(chunk));
        expect(parsed.choices[0].text).toBe('hi from infermatic');
        expect(parsed.choices[0].index).toBe(0);
    });
});
