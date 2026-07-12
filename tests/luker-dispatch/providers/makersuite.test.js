// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest } from '@jest/globals';
import { dispatchMakerSuite } from '../../../src/luker-dispatch/providers/chat-completions/makersuite.js';

/**
 * Build a fake DispatchContext matching src/luker-dispatch/context.js shape.
 * Mirrors ai21.test.js. onFetch: async (url, init) => Response.
 *
 * `source` toggles MAKERSUITE vs VERTEXAI branch. `secret` seeds the primary
 * key (MAKERSUITE api key, VERTEXAI express key, or vertex service-account
 * JSON depending on branch); we route via `secretsReadImpl` for granular
 * per-key mocking.
 */
function fakeCtx({
    body = {},
    onFetch,
    secret = 'gemini-fake-key',
    secretsReadImpl,
    signal,
    source = 'makersuite',
} = {}) {
    const emitted = [];
    const ac = new AbortController();
    const attachedInspections = [];

    const defaultOkResponse = () => new Response(JSON.stringify({
        candidates: [{
            content: { role: 'model', parts: [{ text: 'hello back' }] },
            finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });

    return {
        body: {
            chat_completion_source: source,
            model: 'gemini-2.5-flash',
            messages: [
                { role: 'system', content: 'you are helpful' },
                { role: 'user', content: 'hi' },
            ],
            use_sysprompt: true,
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
        fetch: onFetch || jest.fn(async () => defaultOkResponse()),
        secrets: {
            read: jest.fn((key) => {
                if (secretsReadImpl) return secretsReadImpl(key);
                return secret;
            }),
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

describe('dispatchMakerSuite', () => {
    test('MAKERSUITE non-streaming: normalizes Gemini JSON to OpenAI shape then end', async () => {
        const ctx = fakeCtx();
        await dispatchMakerSuite(ctx);

        const kinds = ctx._emitted.map(e => e.kind);
        expect(kinds).toContain('chunk');
        expect(kinds[kinds.length - 1]).toBe('end');

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        const parsed = JSON.parse(Buffer.from(chunks[0].data).toString('utf8'));
        // normalizeGeminiResponseToOAI returns an OpenAI-shaped envelope.
        expect(parsed.choices).toBeDefined();
        expect(Array.isArray(parsed.choices)).toBe(true);
        expect(parsed.choices[0].message.content).toBe('hello back');

        expect(ctx.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = ctx.fetch.mock.calls[0];
        expect(String(url)).toContain('generativelanguage.googleapis.com');
        expect(String(url)).toContain('gemini-2.5-flash:generateContent');
        expect(String(url)).toContain('key=gemini-fake-key');
        expect(init.method).toBe('POST');
        expect(init.headers['Content-Type']).toBe('application/json');
        expect(init.signal).toBe(ctx.signal);
    });

    test('MAKERSUITE non-streaming: feeds raw Gemini body to inspector alongside OAI-normalized reply (Task 2D)', async () => {
        // extractUsageFromGemini reads usageMetadata.cachedContentTokenCount
        // + candidatesTokenCount from the raw shape; extractPartsFromPayload
        // walks raw.candidates[0].content.parts for thoughtSignature,
        // inlineData, functionCall. The OAI-normalized reply flattens
        // usageMetadata → usage.prompt_tokens/completion_tokens/
        // prompt_tokens_details and drops thoughtSignature entirely, so
        // rawApiResponse must reach the inspector for the extractors to
        // see the source-of-truth fields.
        const rawGemini = {
            candidates: [{
                content: {
                    role: 'model',
                    parts: [
                        { text: 'reasoning trace', thought: true, thoughtSignature: 'thought-sig-1' },
                        { text: 'final answer' },
                    ],
                },
                finishReason: 'STOP',
            }],
            usageMetadata: {
                promptTokenCount: 100,
                candidatesTokenCount: 20,
                cachedContentTokenCount: 60,
                totalTokenCount: 120,
            },
        };
        const ctx = fakeCtx({
            onFetch: jest.fn(async () => new Response(JSON.stringify(rawGemini), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })),
        });
        await dispatchMakerSuite(ctx);

        expect(ctx.inspection.complete).toHaveBeenCalledTimes(1);
        const [oaiArg, rawArg] = ctx.inspection.complete.mock.calls[0];
        // First arg = OAI-normalized (has choices[].message).
        expect(oaiArg.choices?.[0]?.message?.content).toBe('final answer');
        // Second arg = raw Gemini body (preserves usageMetadata +
        // thoughtSignature).
        expect(rawArg).toEqual(rawGemini);
        expect(rawArg.usageMetadata.cachedContentTokenCount).toBe(60);
        expect(rawArg.candidates[0].content.parts[0].thoughtSignature).toBe('thought-sig-1');
    });

    test('MAKERSUITE missing API key (no base_url, no reverse_proxy): emits error, no fetch', async () => {
        const ctx = fakeCtx({ secret: '' });
        await dispatchMakerSuite(ctx);

        const errs = ctx._emitted.filter(e => e.kind === 'error');
        expect(errs.length).toBeGreaterThan(0);
        expect(ctx.fetch).not.toHaveBeenCalled();
    });

    test('MAKERSUITE streaming: forwards upstream SSE chunks verbatim, URL contains alt=sse', async () => {
        const sseBody =
            'data: {"candidates":[{"content":{"parts":[{"text":"he"}]}}]}\n\n' +
            'data: {"candidates":[{"content":{"parts":[{"text":"llo"}]}}]}\n\n';

        const ctx = fakeCtx({
            body: { stream: true },
            onFetch: jest.fn(async () => new Response(sseBody, {
                status: 200,
                headers: { 'content-type': 'text/event-stream' },
            })),
        });

        await dispatchMakerSuite(ctx);

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks.length).toBeGreaterThan(0);
        const decoded = chunks.map(c => Buffer.from(c.data).toString('utf8')).join('');
        expect(decoded).toContain('"text":"he"');
        expect(decoded).toContain('"text":"llo"');
        expect(ctx._emitted[ctx._emitted.length - 1].kind).toBe('end');

        const [url] = ctx.fetch.mock.calls[0];
        expect(String(url)).toContain(':streamGenerateContent');
        expect(String(url)).toContain('alt=sse');
    });

    test('MAKERSUITE upstream non-2xx: surfaces status+body via head+chunk+end (no emit.error)', async () => {
        const ctx = fakeCtx({
            onFetch: jest.fn(async () => new Response('{"error":{"message":"bad key"}}', {
                status: 401,
                headers: { 'content-type': 'application/json' },
            })),
        });
        await dispatchMakerSuite(ctx);

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

    test('MAKERSUITE 200 with empty candidates array: emits head 200 + `{error:{message}}` chunk (legacy soft-error envelope)', async () => {
        // Legacy shape: `res.send({error:{message}})` (Express default 200).
        // Delivered post-head as head+chunk+end so the client's
        // `data.error` branch (openai.js:4455) fires with the descriptive
        // block-reason message. HTTP 500 would bury the message inside the
        // `!response.ok` generic throw at openai.js:4037.
        const ctx = fakeCtx({
            onFetch: jest.fn(async () => new Response(JSON.stringify({
                candidates: [],
                promptFeedback: { blockReason: 'SAFETY' },
            }), { status: 200, headers: { 'content-type': 'application/json' } })),
        });
        await dispatchMakerSuite(ctx);

        const errs = ctx._emitted.filter(e => e.kind === 'error');
        expect(errs).toHaveLength(0);

        const heads = ctx._emitted.filter(e => e.kind === 'head');
        expect(heads).toHaveLength(1);
        expect(heads[0].data.status).toBe(200);

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        const parsed = JSON.parse(new TextDecoder().decode(chunks[0].data));
        expect(parsed.error).toBeDefined();
        expect(parsed.error.message).toContain('no candidate');
        expect(parsed.error.message).toContain('SAFETY');

        const ends = ctx._emitted.filter(e => e.kind === 'end');
        expect(ends).toHaveLength(1);

        // Soft error still routes to inspection.complete so the run shows up
        // as a completed request (with the error payload) rather than an
        // aborted/failed one.
        expect(ctx.inspection.complete).toHaveBeenCalledTimes(1);
        const [payloadArg, rawArg] = ctx.inspection.complete.mock.calls[0];
        expect(payloadArg.error.message).toContain('no candidate');
        expect(rawArg.promptFeedback.blockReason).toBe('SAFETY');
    });

    test('MAKERSUITE 200 with candidate but empty text/no functionCall/no inlineData: emits head 200 + `{error:{message}}` chunk', async () => {
        // "Candidate text empty" branch — same legacy envelope shape as
        // no-candidate above. Candidate present but content extraction
        // yields nothing usable.
        const ctx = fakeCtx({
            onFetch: jest.fn(async () => new Response(JSON.stringify({
                candidates: [{
                    content: { role: 'model', parts: [] },
                    finishReason: 'STOP',
                }],
            }), { status: 200, headers: { 'content-type': 'application/json' } })),
        });
        await dispatchMakerSuite(ctx);

        const errs = ctx._emitted.filter(e => e.kind === 'error');
        expect(errs).toHaveLength(0);

        const heads = ctx._emitted.filter(e => e.kind === 'head');
        expect(heads).toHaveLength(1);
        expect(heads[0].data.status).toBe(200);

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        const parsed = JSON.parse(new TextDecoder().decode(chunks[0].data));
        expect(parsed.error).toBeDefined();
        expect(parsed.error.message).toContain('Candidate text empty');

        const ends = ctx._emitted.filter(e => e.kind === 'end');
        expect(ends).toHaveLength(1);

        expect(ctx.inspection.complete).toHaveBeenCalledTimes(1);
    });

    test('MAKERSUITE ctx.signal aborted mid-request: fetch AbortError caught, emits error, no chunk', async () => {
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

        const dispatchPromise = dispatchMakerSuite(ctx);
        setImmediate(() => ac.abort());
        await dispatchPromise;

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(0);
        const errs = ctx._emitted.filter(e => e.kind === 'error');
        expect(errs.length).toBeGreaterThan(0);
    });

    test('VERTEXAI reverse-proxy branch: /v1/publishers/google/models URL, Authorization header, no key= param', async () => {
        // Vertex express/full auth modes read secrets via readSecret (NOT
        // ctx.secrets.read) inside getVertexAIAuth; those paths need the
        // real filesystem-backed secret store to exercise. The reverse-proxy
        // branch is auth-mode-independent (short-circuits before secret
        // lookup) and exercises the Vertex-specific URL builder + auth
        // header path, so we cover the MAKERSUITE-vs-VERTEXAI distinction
        // through this path.
        const ctx = fakeCtx({
            source: 'vertexai',
            body: {
                chat_completion_source: 'vertexai',
                reverse_proxy: 'https://vertex-proxy.example.com',
                proxy_password: 'proxy-token-xyz',
                model: 'gemini-2.5-pro',
            },
        });

        await dispatchMakerSuite(ctx);

        expect(ctx.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = ctx.fetch.mock.calls[0];
        const urlStr = String(url);
        // Proxy mode: uses original apiUrl base + /v1/publishers/google/models/...
        expect(urlStr).toContain('vertex-proxy.example.com');
        expect(urlStr).toContain('/v1/publishers/google/models/gemini-2.5-pro:generateContent');
        // Vertex proxy mode uses Authorization header, NOT ?key= param.
        expect(urlStr).not.toContain('key=');
        expect(init.headers['Authorization']).toBe('Bearer proxy-token-xyz');

        // End-to-end: still emits chunk + end for the default OK response.
        const kinds = ctx._emitted.map(e => e.kind);
        expect(kinds[kinds.length - 1]).toBe('end');
    });
});
