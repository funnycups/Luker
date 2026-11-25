// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest } from '@jest/globals';
import { dispatchMakerSuite } from '../../../src/luker-dispatch/providers/chat-completions/makersuite.js';
import {
    ProtocolParseError,
    WIRE_PROTOCOLS,
    isParsedTurnEmpty,
    parseProtocolResponse,
} from '../../../public/scripts/lib/protocol-parser/index.js';

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
    test('MAKERSUITE non-streaming: relays verbatim native Gemini JSON then end', async () => {
        const ctx = fakeCtx();
        await dispatchMakerSuite(ctx);

        const kinds = ctx._emitted.map(e => e.kind);
        expect(kinds).toContain('chunk');
        expect(kinds[kinds.length - 1]).toBe('end');

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        const parsed = JSON.parse(Buffer.from(chunks[0].data).toString('utf8'));
        expect(parsed.choices).toBeUndefined();
        expect(Array.isArray(parsed.candidates)).toBe(true);
        expect(parsed.candidates[0].content.parts[0].text).toBe('hello back');

        expect(ctx.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = ctx.fetch.mock.calls[0];
        expect(String(url)).toContain('generativelanguage.googleapis.com');
        expect(String(url)).toContain('gemini-2.5-flash:generateContent');
        expect(String(url)).toContain('key=gemini-fake-key');
        expect(init.method).toBe('POST');
        expect(init.headers['Content-Type']).toBe('application/json');
        expect(init.signal).toBe(ctx.signal);
    });

    test('MAKERSUITE non-streaming: replays tool call ids on functionCall and functionResponse parts', async () => {
        const ctx = fakeCtx({
            body: {
                messages: [
                    { role: 'user', content: 'do the thing' },
                    { role: 'assistant', content: '', tool_calls: [
                        { id: 'gemini-call-1', type: 'function', function: { name: 'do_thing', arguments: '{}' } },
                    ] },
                    { role: 'tool', content: 'thing done', tool_call_id: 'gemini-call-1' },
                ],
            },
        });
        await dispatchMakerSuite(ctx);

        const [, init] = ctx.fetch.mock.calls[0];
        const requestBody = JSON.parse(init.body);
        const parts = requestBody.contents.flatMap(content => content.parts);
        const funcCall = parts.find(part => part.functionCall);
        const funcResp = parts.find(part => part.functionResponse);
        expect(funcCall.functionCall.id).toBe('gemini-call-1');
        expect(funcResp.functionResponse.id).toBe('gemini-call-1');
    });

    test('MAKERSUITE non-streaming: relays verbatim Gemini body and feeds native JSON to inspector', async () => {
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
        const rawText = JSON.stringify(rawGemini);
        const ctx = fakeCtx({
            onFetch: jest.fn(async () => new Response(rawText, {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })),
        });
        await dispatchMakerSuite(ctx);

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        expect(Buffer.from(chunks[0].data).toString('utf8')).toBe(rawText);

        expect(ctx.inspection.complete).toHaveBeenCalledTimes(1);
        const [payloadArg, rawArg] = ctx.inspection.complete.mock.calls[0];
        expect(payloadArg).toEqual(rawGemini);
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

    test('MAKERSUITE HTTP 200 with top-level error object: forwards error payload verbatim instead of normalizing to empty choices', async () => {
        const rawError = {
            error: { code: 502, message: 'upstream stream closed', status: 'UNAVAILABLE' },
            extra: { detail: 'preserved' },
        };
        const ctx = fakeCtx({
            onFetch: jest.fn(async () => new Response(JSON.stringify(rawError), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })),
        });
        await dispatchMakerSuite(ctx);

        expect(ctx._emitted.filter(e => e.kind === 'error')).toHaveLength(0);
        const heads = ctx._emitted.filter(e => e.kind === 'head');
        expect(heads).toHaveLength(1);
        expect(heads[0].data.status).toBe(200);

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        const parsed = JSON.parse(new TextDecoder().decode(chunks[0].data));
        expect(parsed).toEqual(rawError);
        expect(parsed.choices).toBeUndefined();

        expect(ctx._emitted.filter(e => e.kind === 'end')).toHaveLength(1);
        expect(ctx.inspection.complete).toHaveBeenCalledTimes(1);
        expect(ctx.inspection.complete).toHaveBeenCalledWith(rawError, rawError);
    });

    test('MAKERSUITE HTTP 200 with array-wrapped error object: relays native payload verbatim for protocol parser classification', async () => {
        const rawArrayError = [{
            error: { code: 503, message: 'service unavailable', status: 'UNAVAILABLE' },
        }];
        const ctx = fakeCtx({
            onFetch: jest.fn(async () => new Response(JSON.stringify(rawArrayError), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })),
        });
        await dispatchMakerSuite(ctx);

        expect(ctx._emitted.filter(e => e.kind === 'error')).toHaveLength(0);
        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        const parsed = JSON.parse(new TextDecoder().decode(chunks[0].data));
        expect(parsed).toEqual(rawArrayError);
        expect(parsed.choices).toBeUndefined();

        expect(ctx._emitted.filter(e => e.kind === 'end')).toHaveLength(1);
        expect(ctx.inspection.complete).toHaveBeenCalledTimes(1);
        expect(ctx.inspection.complete).toHaveBeenCalledWith(rawArrayError, rawArrayError);
    });

    test('MAKERSUITE 200 with empty candidates array + promptFeedback.blockReason: relays native Gemini JSON verbatim and shared parser classifies terminal provider_error', async () => {
        const rawPayload = {
            candidates: [],
            promptFeedback: { blockReason: 'SAFETY' },
        };
        const ctx = fakeCtx({
            onFetch: jest.fn(async () => new Response(JSON.stringify(rawPayload), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })),
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
        expect(parsed).toEqual(rawPayload);
        expect(parsed.error).toBeUndefined();

        const ends = ctx._emitted.filter(e => e.kind === 'end');
        expect(ends).toHaveLength(1);

        expect(ctx.inspection.complete).toHaveBeenCalledTimes(1);
        const [payloadArg, rawArg] = ctx.inspection.complete.mock.calls[0];
        expect(payloadArg).toEqual(rawPayload);
        expect(rawArg).toEqual(rawPayload);

        // Shared parser classifies promptFeedback.blockReason as terminal provider_error.
        let blockedErr = null;
        try {
            parseProtocolResponse(WIRE_PROTOCOLS.GEMINI, parsed);
        } catch (err) {
            blockedErr = err;
        }
        expect(blockedErr).toBeInstanceOf(ProtocolParseError);
        expect(blockedErr.stage).toBe('provider_error');
        expect(blockedErr.message).toContain('SAFETY');
    });

    test('MAKERSUITE 200 with empty candidates array + NO blockReason: relays native Gemini JSON verbatim and shared parser classifies retriable empty turn', async () => {
        const rawPayload = { candidates: [] };
        const ctx = fakeCtx({
            onFetch: jest.fn(async () => new Response(JSON.stringify(rawPayload), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })),
        });
        await dispatchMakerSuite(ctx);

        expect(ctx._emitted.filter(e => e.kind === 'error')).toHaveLength(0);
        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        const parsed = JSON.parse(new TextDecoder().decode(chunks[0].data));
        expect(parsed).toEqual(rawPayload);

        const turn = parseProtocolResponse(WIRE_PROTOCOLS.GEMINI, parsed);
        expect(isParsedTurnEmpty(turn)).toBe(true);
    });

    test('MAKERSUITE 200 with candidate empty text AND deterministic blocked finishReason (BLOCKLIST): relays native Gemini JSON verbatim and shared parser classifies terminal provider_error', async () => {
        const rawPayload = {
            candidates: [{
                content: { role: 'model', parts: [] },
                finishReason: 'BLOCKLIST',
            }],
        };
        const ctx = fakeCtx({
            onFetch: jest.fn(async () => new Response(JSON.stringify(rawPayload), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })),
        });
        await dispatchMakerSuite(ctx);

        expect(ctx._emitted.filter(e => e.kind === 'error')).toHaveLength(0);
        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        const parsed = JSON.parse(new TextDecoder().decode(chunks[0].data));
        expect(parsed).toEqual(rawPayload);
        expect(parsed.error).toBeUndefined();
        expect(ctx.inspection.complete).toHaveBeenCalledTimes(1);

        let blocklistErr = null;
        try {
            parseProtocolResponse(WIRE_PROTOCOLS.GEMINI, parsed);
        } catch (err) {
            blocklistErr = err;
        }
        expect(blocklistErr).toBeInstanceOf(ProtocolParseError);
        expect(blocklistErr.stage).toBe('provider_error');
        expect(blocklistErr.message).toContain('BLOCKLIST');
    });

    test('MAKERSUITE 200 with candidate empty text and probabilistic filter (SAFETY): relays native Gemini JSON verbatim as retriable empty turn', async () => {
        const rawPayload = {
            candidates: [{
                content: { role: 'model', parts: [] },
                finishReason: 'SAFETY',
            }],
        };
        const ctx = fakeCtx({
            onFetch: jest.fn(async () => new Response(JSON.stringify(rawPayload), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })),
        });
        await dispatchMakerSuite(ctx);

        expect(ctx._emitted.filter(e => e.kind === 'error')).toHaveLength(0);
        const parsed = JSON.parse(new TextDecoder().decode(ctx._emitted.find(e => e.kind === 'chunk').data));
        expect(parsed).toEqual(rawPayload);

        const turn = parseProtocolResponse(WIRE_PROTOCOLS.GEMINI, parsed);
        expect(isParsedTurnEmpty(turn)).toBe(true);
        expect(turn.finishReason).toBe('content_filter');
    });

    test('MAKERSUITE 200 with candidate empty text and probabilistic filter (PROHIBITED_CONTENT): relays native Gemini JSON verbatim as retriable empty turn', async () => {
        const rawPayload = {
            candidates: [{
                content: { role: 'model', parts: [] },
                finishReason: 'PROHIBITED_CONTENT',
            }],
        };
        const ctx = fakeCtx({
            onFetch: jest.fn(async () => new Response(JSON.stringify(rawPayload), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })),
        });
        await dispatchMakerSuite(ctx);

        const parsed = JSON.parse(new TextDecoder().decode(ctx._emitted.find(e => e.kind === 'chunk').data));
        expect(parsed).toEqual(rawPayload);

        const turn = parseProtocolResponse(WIRE_PROTOCOLS.GEMINI, parsed);
        expect(isParsedTurnEmpty(turn)).toBe(true);
    });

    test('MAKERSUITE 200 with candidate empty text and finishReason=STOP: relays native Gemini JSON verbatim as retriable empty turn', async () => {
        const rawPayload = {
            candidates: [{
                content: { role: 'model', parts: [] },
                finishReason: 'STOP',
            }],
        };
        const ctx = fakeCtx({
            onFetch: jest.fn(async () => new Response(JSON.stringify(rawPayload), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })),
        });
        await dispatchMakerSuite(ctx);

        expect(ctx._emitted.filter(e => e.kind === 'error')).toHaveLength(0);
        const parsed = JSON.parse(new TextDecoder().decode(ctx._emitted.find(e => e.kind === 'chunk').data));
        expect(parsed).toEqual(rawPayload);

        const turn = parseProtocolResponse(WIRE_PROTOCOLS.GEMINI, parsed);
        expect(isParsedTurnEmpty(turn)).toBe(true);
        expect(turn.finishReason).toBe('stop');
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

    describe('reasoning_effort → thinkingConfig mapping', () => {
        function thinkingConfigFromCtx(ctx) {
            const [, init] = ctx.fetch.mock.calls[0];
            return JSON.parse(init.body).generationConfig.thinkingConfig;
        }

        test('gemini-2.5-flash + off → thinkingBudget === 0', async () => {
            const ctx = fakeCtx({ body: { model: 'gemini-2.5-flash', reasoning_effort: 'off' } });
            await dispatchMakerSuite(ctx);
            expect(thinkingConfigFromCtx(ctx).thinkingBudget).toBe(0);
        });

        test('gemini-2.5-pro + off → thinkingBudget not set to 0 (cannot disable)', async () => {
            const ctx = fakeCtx({ body: { model: 'gemini-2.5-pro', reasoning_effort: 'off' } });
            await dispatchMakerSuite(ctx);
            const cfg = thinkingConfigFromCtx(ctx);
            expect(cfg.thinkingBudget).not.toBe(0);
            expect('thinkingBudget' in cfg).toBe(false);
        });

        test('gemini-3-pro + off → thinkingLevel === low (Pro has no minimal support)', async () => {
            const ctx = fakeCtx({ body: { model: 'gemini-3-pro', reasoning_effort: 'off' } });
            await dispatchMakerSuite(ctx);
            expect(thinkingConfigFromCtx(ctx).thinkingLevel).toBe('low');
        });

        test('gemini-3.1-pro + off → thinkingLevel === low', async () => {
            const ctx = fakeCtx({ body: { model: 'gemini-3.1-pro', reasoning_effort: 'off' } });
            await dispatchMakerSuite(ctx);
            expect(thinkingConfigFromCtx(ctx).thinkingLevel).toBe('low');
        });

        test('gemini-3.1-pro + medium → thinkingLevel === medium', async () => {
            const ctx = fakeCtx({ body: { model: 'gemini-3.1-pro', reasoning_effort: 'medium' } });
            await dispatchMakerSuite(ctx);
            expect(thinkingConfigFromCtx(ctx).thinkingLevel).toBe('medium');
        });

        test('path-prefixed gemini-3-pro + off → thinkingLevel === low (family match tolerates prefix)', async () => {
            const ctx = fakeCtx({ body: { model: 'publishers/google/models/gemini-3-pro', reasoning_effort: 'off' } });
            await dispatchMakerSuite(ctx);
            expect(thinkingConfigFromCtx(ctx).thinkingLevel).toBe('low');
        });

        test('gemini-3.7-flash + off → thinkingLevel === low (no minimal support)', async () => {
            const ctx = fakeCtx({ body: { model: 'gemini-3.7-flash', reasoning_effort: 'off' } });
            await dispatchMakerSuite(ctx);
            expect(thinkingConfigFromCtx(ctx).thinkingLevel).toBe('low');
        });

        test('gemini-2.5-flash-lite + off → thinkingBudget === 0', async () => {
            const ctx = fakeCtx({ body: { model: 'gemini-2.5-flash-lite', reasoning_effort: 'off' } });
            await dispatchMakerSuite(ctx);
            expect(thinkingConfigFromCtx(ctx).thinkingBudget).toBe(0);
        });

        test('path-prefixed model id + off → thinkingBudget === 0 (family match tolerates prefix)', async () => {
            const ctx = fakeCtx({ body: { model: 'publishers/google/models/gemini-2.5-flash', reasoning_effort: 'off' } });
            await dispatchMakerSuite(ctx);
            expect(thinkingConfigFromCtx(ctx).thinkingBudget).toBe(0);
        });

        test('gemini-2.5-flash + minimal → thinkingBudget === 0', async () => {
            const ctx = fakeCtx({ body: { model: 'gemini-2.5-flash', reasoning_effort: 'minimal' } });
            await dispatchMakerSuite(ctx);
            expect(thinkingConfigFromCtx(ctx).thinkingBudget).toBe(0);
        });

        test('gemini-3-pro + xhigh → thinkingLevel === high', async () => {
            const ctx = fakeCtx({ body: { model: 'gemini-3-pro', reasoning_effort: 'xhigh' } });
            await dispatchMakerSuite(ctx);
            expect(thinkingConfigFromCtx(ctx).thinkingLevel).toBe('high');
        });

        test('gemini-4-argon + high → thinkingConfig carries includeThoughts and thinkingLevel === high', async () => {
            const ctx = fakeCtx({ body: { model: 'gemini-4-argon', reasoning_effort: 'high', include_reasoning: true } });
            await dispatchMakerSuite(ctx);
            const cfg = thinkingConfigFromCtx(ctx);
            expect(cfg.includeThoughts).toBe(true);
            expect(cfg.thinkingLevel).toBe('high');
        });

        test('gemini-4-argon + off → thinkingLevel === low (no minimal support)', async () => {
            const ctx = fakeCtx({ body: { model: 'gemini-4-argon', reasoning_effort: 'off' } });
            await dispatchMakerSuite(ctx);
            expect(thinkingConfigFromCtx(ctx).thinkingLevel).toBe('low');
        });

        test('gemini-4-argon drops deprecated sampling parameters', async () => {
            const ctx = fakeCtx({ body: { model: 'gemini-4-argon', reasoning_effort: 'medium', top_k: 40 } });
            await dispatchMakerSuite(ctx);
            const [, init] = ctx.fetch.mock.calls[0];
            const gc = JSON.parse(init.body).generationConfig;
            expect('temperature' in gc).toBe(false);
            expect('topP' in gc).toBe(false);
            expect('topK' in gc).toBe(false);
            expect('candidateCount' in gc).toBe(false);
        });
    });

    describe('additional parameters', () => {
        test('deep-merges generationConfig, keeps generated fields, and applies top-level overrides', async () => {
            const ctx = fakeCtx({
                body: {
                    custom_include_body: 'generationConfig:\n  topK: 64\n  thinkingConfig:\n    thinkingBudget: 1024\ncustomProbe: applied\n',
                    custom_exclude_body: 'safetySettings\n',
                    custom_include_headers: 'X-Additional-Parameter: applied\n',
                },
            });

            await dispatchMakerSuite(ctx);

            const [, init] = ctx.fetch.mock.calls[0];
            expect(init.headers['X-Additional-Parameter']).toBe('applied');

            const requestBody = JSON.parse(init.body);
            expect(requestBody.customProbe).toBe('applied');
            expect(requestBody.safetySettings).toBeUndefined();
            expect(requestBody.generationConfig.topK).toBe(64);
            // The generated sampling and token fields survive the merge.
            expect(requestBody.generationConfig.temperature).toBe(0.7);
            expect(requestBody.generationConfig.maxOutputTokens).toBe(128);
            // A nested object supplied by the user replaces the generated one
            // instead of accumulating stale fields.
            expect(requestBody.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 1024 });
        });
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

    describe('image mode, tools, and capability conflicts', () => {
        test('gemini-nano-banana-2.1 and gemini-3-pro-image preserve systemInstruction, imageConfig, and googleSearch in image mode', async () => {
            for (const model of ['gemini-nano-banana-2.1', 'gemini-3-pro-image', 'gemini-3.1-flash-image']) {
                const ctx = fakeCtx({
                    body: {
                        model,
                        request_images: true,
                        request_image_resolution: '2K',
                        request_image_aspect_ratio: '16:9',
                        use_sysprompt: true,
                        enable_web_search: true,
                    },
                });
                await dispatchMakerSuite(ctx);
                expect(ctx.fetch).toHaveBeenCalledTimes(1);
                const sent = JSON.parse(ctx.fetch.mock.calls[0][1].body);
                expect(sent.generationConfig.responseModalities).toEqual(['text', 'image']);
                expect(sent.generationConfig.imageConfig).toEqual({ imageSize: '2K', aspectRatio: '16:9' });
                expect(sent.systemInstruction?.parts?.[0]?.text).toBe('you are helpful');
                expect(sent.tools).toEqual([{ googleSearch: {} }]);
            }
        });

        test('gemini-2.5-flash-image preserves systemInstruction and aspectRatio while omitting unsupported imageSize', async () => {
            const ctx = fakeCtx({
                body: {
                    model: 'gemini-2.5-flash-image',
                    request_images: true,
                    request_image_resolution: '2K',
                    request_image_aspect_ratio: '1:1',
                    use_sysprompt: true,
                },
            });
            await dispatchMakerSuite(ctx);
            const sent = JSON.parse(ctx.fetch.mock.calls[0][1].body);
            expect(sent.generationConfig.responseModalities).toEqual(['text', 'image']);
            expect(sent.generationConfig.imageConfig).toEqual({ aspectRatio: '1:1' });
            expect(sent.systemInstruction?.parts?.[0]?.text).toBe('you are helpful');
        });

        test('unknown future model honors explicit request_images without requiring allowlist update', async () => {
            const ctx = fakeCtx({
                body: {
                    model: 'gemini-future-canvas-v9',
                    request_images: true,
                    use_sysprompt: true,
                },
            });
            await dispatchMakerSuite(ctx);
            expect(ctx.fetch).toHaveBeenCalledTimes(1);
            const sent = JSON.parse(ctx.fetch.mock.calls[0][1].body);
            expect(sent.generationConfig.responseModalities).toEqual(['text', 'image']);
            expect(sent.generationConfig.imageConfig).toBeUndefined();
            expect(sent.systemInstruction?.parts?.[0]?.text).toBe('you are helpful');
        });

        test('Gemini 3 and Gemini 4 allow combining functionDeclarations and googleSearch', async () => {
            for (const model of ['gemini-3.1-pro-preview', 'gemini-4-argon']) {
                const ctx = fakeCtx({
                    body: {
                        model,
                        enable_web_search: true,
                        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }],
                    },
                });
                await dispatchMakerSuite(ctx);
                expect(ctx.fetch).toHaveBeenCalledTimes(1);
                const sent = JSON.parse(ctx.fetch.mock.calls[0][1].body);
                expect(sent.tools).toHaveLength(2);
                expect(sent.tools[0].functionDeclarations[0].name).toBe('lookup');
                expect(sent.tools[1]).toEqual({ googleSearch: {} });
            }
        });

        test('emits explicit non-retryable HTTP 400 conflict without fetching on incompatible combinations', async () => {
            const cases = [
                {
                    body: { model: 'gemini-2.5-flash', request_images: true },
                    expectedCode: 'gemini_image_output_unsupported',
                },
                {
                    body: {
                        model: 'gemini-3-pro-image',
                        request_images: true,
                        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
                    },
                    expectedCode: 'gemini_function_calling_unsupported',
                },
                {
                    body: { model: 'gemini-3.1-flash-lite-image', request_images: true, enable_web_search: true },
                    expectedCode: 'gemini_web_search_unsupported',
                },
                {
                    body: {
                        model: 'gemini-2.5-flash',
                        enable_web_search: true,
                        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
                    },
                    expectedCode: 'gemini_builtin_and_function_tools_conflict',
                },
            ];

            for (const { body, expectedCode } of cases) {
                const ctx = fakeCtx({ body });
                await dispatchMakerSuite(ctx);
                expect(ctx.fetch).not.toHaveBeenCalled();
                const heads = ctx._emitted.filter(e => e.kind === 'head');
                expect(heads).toHaveLength(1);
                expect(heads[0].data.status).toBe(400);
                const payload = JSON.parse(new TextDecoder().decode(ctx._emitted.find(e => e.kind === 'chunk').data));
                expect(payload.error.type).toBe('capability_conflict');
                expect(payload.error.code).toBe(expectedCode);
                expect(payload.error.non_retryable).toBe(true);
                expect(ctx.inspection.fail).toHaveBeenCalledTimes(1);
            }
        });

        test('gemini-nano-banana-2.1 forwards thinkingLevel and strips unsupported text sampling and seed', async () => {
            const ctx = fakeCtx({
                body: {
                    model: 'gemini-nano-banana-2.1',
                    request_images: true,
                    request_image_resolution: '2K',
                    reasoning_effort: 'high',
                    include_reasoning: true,
                    temperature: 0.8,
                    top_p: 0.9,
                    top_k: 40,
                    seed: 42,
                },
            });
            await dispatchMakerSuite(ctx);
            expect(ctx.fetch).toHaveBeenCalledTimes(1);
            const sent = JSON.parse(ctx.fetch.mock.calls[0][1].body);
            expect(sent.generationConfig.thinkingConfig).toEqual({
                includeThoughts: true,
                thinkingLevel: 'high',
            });
            expect(sent.generationConfig.imageConfig).toEqual({ imageSize: '2K' });
            expect(sent.generationConfig.temperature).toBeUndefined();
            expect(sent.generationConfig.topP).toBeUndefined();
            expect(sent.generationConfig.topK).toBeUndefined();
            expect(sent.generationConfig.seed).toBeUndefined();
        });

        test('streaming non-2xx upstream response records inspection failure and relays error body', async () => {
            const ctx = fakeCtx({
                body: { model: 'gemini-2.5-flash', stream: true },
                onFetch: jest.fn(async () => new Response(JSON.stringify({ error: { message: 'Quota exceeded' } }), {
                    status: 429,
                    headers: { 'content-type': 'application/json' },
                })),
            });
            await dispatchMakerSuite(ctx);
            expect(ctx.inspection.fail).toHaveBeenCalledTimes(1);
            expect(ctx.inspection.fail.mock.calls[0][1]).toBe(429);
            const heads = ctx._emitted.filter(e => e.kind === 'head');
            expect(heads).toHaveLength(1);
            expect(heads[0].data.status).toBe(429);
            expect(ctx._emitted.some(e => e.kind === 'end')).toBe(true);
        });
    });
});
