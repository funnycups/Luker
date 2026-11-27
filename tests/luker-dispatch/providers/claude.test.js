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
    const attachCalls = [];
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
            attach: jest.fn((...args) => {
                attachedInspections.push(args[0]);
                attachCalls.push(args);
            }),
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
        _attachCalls: attachCalls,
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

    test('non-streaming: relays verbatim Anthropic body and feeds native JSON to inspector', async () => {
        const rawAnthropic = {
            id: 'msg_cache_1',
            type: 'message',
            role: 'assistant',
            content: [
                { type: 'thinking', thinking: 'internal reasoning', signature: 'sig-abc' },
                { type: 'text', text: 'answer' },
            ],
            stop_reason: 'end_turn',
            usage: {
                input_tokens: 100,
                output_tokens: 10,
                cache_creation_input_tokens: 500,
                cache_read_input_tokens: 800,
            },
        };
        const rawText = JSON.stringify(rawAnthropic);
        const ctx = fakeCtx({
            onFetch: jest.fn(async () => new Response(rawText, {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })),
        });
        await dispatchClaude(ctx);

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        expect(Buffer.from(chunks[0].data).toString('utf8')).toBe(rawText);

        expect(ctx.inspection.complete).toHaveBeenCalledTimes(1);
        const [payloadArg, rawArg] = ctx.inspection.complete.mock.calls[0];
        expect(payloadArg).toEqual(rawAnthropic);
        expect(rawArg).toEqual(rawAnthropic);
        expect(rawArg.usage.cache_creation_input_tokens).toBe(500);
        expect(rawArg.usage.cache_read_input_tokens).toBe(800);
        expect(rawArg.content[0].type).toBe('thinking');
        expect(rawArg.content[0].signature).toBe('sig-abc');
    });

    test('missing API key with no reverse_proxy: emits head+chunk+end with HTTP 400 JSON envelope, no fetch', async () => {
        const ctx = fakeCtx({ secret: '' });
        await dispatchClaude(ctx);

        // Legacy shape: `.status(400).send({error:true})`. Delivered post-head
        // via head+chunk+end so the client sees Response.status=400 + a
        // parseable JSON body (not a generic transport error).
        const errs = ctx._emitted.filter(e => e.kind === 'error');
        expect(errs).toHaveLength(0);
        expect(ctx.fetch).not.toHaveBeenCalled();

        const heads = ctx._emitted.filter(e => e.kind === 'head');
        expect(heads).toHaveLength(1);
        expect(heads[0].data.status).toBe(400);

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        const parsed = JSON.parse(new TextDecoder().decode(chunks[0].data));
        expect(parsed.error).toBe(true);
        expect(parsed.message).toContain('Claude API key is missing');

        const ends = ctx._emitted.filter(e => e.kind === 'end');
        expect(ends).toHaveLength(1);

        expect(ctx.inspection.fail).toHaveBeenCalledTimes(1);
        expect(ctx.inspection.fail.mock.calls[0][1]).toBe(400);
    });

    test('missing API key with custom base_url or reverse_proxy succeeds and omits empty x-api-key header', async () => {
        for (const body of [
            { base_url: 'https://claude-proxy.example.com/v1' },
            { reverse_proxy: 'https://claude-rev.example.com/v1' },
        ]) {
            const ctx = fakeCtx({ secret: '', body });
            await dispatchClaude(ctx);

            expect(ctx.fetch).toHaveBeenCalledTimes(1);
            const [url, init] = ctx.fetch.mock.calls[0];
            expect(String(url)).toMatch(/\/v1\/messages$/);
            expect('x-api-key' in init.headers).toBe(false);
            expect(ctx._emitted.filter(e => e.kind === 'error')).toHaveLength(0);
            expect(ctx._emitted.find(e => e.kind === 'head')?.data.status).toBe(200);
        }
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

    test('non-streaming HTTP 200 with error payload: forwards error object verbatim instead of normalizing to empty choices', async () => {
        const rawError = {
            type: 'error',
            error: { type: 'overloaded_error', message: 'Overloaded' },
        };
        const ctx = fakeCtx({
            onFetch: jest.fn(async () => new Response(JSON.stringify(rawError), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })),
        });
        await dispatchClaude(ctx);

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

    test('thinking mode with max_tokens<=1024 auto-bumps and warns the user', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
        try {
            const fetchMock = jest.fn(async () => new Response(JSON.stringify({
                id: 'msg_1', type: 'message', role: 'assistant',
                content: [{ type: 'text', text: 'ok' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 1, output_tokens: 1 },
            }), { status: 200, headers: { 'content-type': 'application/json' } }));

            const ctx = fakeCtx({
                onFetch: fetchMock,
                body: {
                    // Non-adaptive thinking model (matches useThinking regex,
                    // does NOT match isAdaptiveModel), so budgetTokens is an
                    // integer instead of an effort string.
                    model: 'claude-3-7-sonnet-20250219',
                    max_tokens: 100,
                    reasoning_effort: 'min',
                },
            });
            await dispatchClaude(ctx);

            // Auto-bump kicked in: request body sent to upstream carries
            // max_tokens = 100 + 1024 = 1124.
            expect(fetchMock).toHaveBeenCalledTimes(1);
            const [, init] = fetchMock.mock.calls[0];
            const sentBody = JSON.parse(init.body);
            expect(sentBody.max_tokens).toBe(1124);
            expect(sentBody.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });

            // User-visible signal that max_tokens was mutated.
            const warnCalls = warnSpy.mock.calls.map(args => String(args[0]));
            expect(warnCalls.some(msg => msg.includes('Claude thinking requires a minimum of 1024'))).toBe(true);
            const infoCalls = infoSpy.mock.calls.map(args => String(args[0]));
            expect(infoCalls.some(msg => msg.includes('Increasing response length to 1124'))).toBe(true);
        } finally {
            warnSpy.mockRestore();
            infoSpy.mockRestore();
        }
    });

    test('thinking mode with max_tokens>1024 does NOT bump or warn', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
        try {
            const fetchMock = jest.fn(async () => new Response(JSON.stringify({
                id: 'msg_1', type: 'message', role: 'assistant',
                content: [{ type: 'text', text: 'ok' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 1, output_tokens: 1 },
            }), { status: 200, headers: { 'content-type': 'application/json' } }));

            const ctx = fakeCtx({
                onFetch: fetchMock,
                body: {
                    model: 'claude-3-7-sonnet-20250219',
                    max_tokens: 4096,
                    reasoning_effort: 'min',
                },
            });
            await dispatchClaude(ctx);

            const [, init] = fetchMock.mock.calls[0];
            const sentBody = JSON.parse(init.body);
            expect(sentBody.max_tokens).toBe(4096);

            const bumpMsgs = warnSpy.mock.calls
                .map(args => String(args[0]))
                .filter(m => m.includes('Claude thinking requires a minimum'));
            expect(bumpMsgs).toHaveLength(0);
            const infoBumpMsgs = infoSpy.mock.calls
                .map(args => String(args[0]))
                .filter(m => m.includes('Increasing response length'));
            expect(infoBumpMsgs).toHaveLength(0);
        } finally {
            warnSpy.mockRestore();
            infoSpy.mockRestore();
        }
    });

    test('inspector fingerprint reflects x-api-key overridden by custom_include_headers', async () => {
        const ctx = fakeCtx({
            secret: 'sk-ant-stored',
            body: {
                custom_include_headers: 'x-api-key: plugin-proxy-key\n',
            },
        });
        await dispatchClaude(ctx);

        const [, init] = ctx.fetch.mock.calls[0];
        expect(init.headers['x-api-key']).toBe('plugin-proxy-key');

        expect(ctx._attachCalls).toHaveLength(1);
        const [, attachedKey] = ctx._attachCalls[0];
        expect(attachedKey).toBe('plugin-proxy-key');
    });

    test('inspector fingerprint keeps resolved key when custom headers leave auth untouched', async () => {
        const ctx = fakeCtx({
            secret: 'sk-ant-stored',
            body: {
                custom_include_headers: 'X-Custom: yes\n',
            },
        });
        await dispatchClaude(ctx);

        const [, init] = ctx.fetch.mock.calls[0];
        expect(init.headers['x-api-key']).toBe('sk-ant-stored');

        expect(ctx._attachCalls).toHaveLength(1);
        const [, attachedKey] = ctx._attachCalls[0];
        expect(attachedKey).toBe('sk-ant-stored');
    });

    describe('per-model reasoning_effort mapping', () => {
        async function send(body) {
            const fetchMock = jest.fn(async () => new Response(JSON.stringify({
                id: 'msg_1', type: 'message', role: 'assistant',
                content: [{ type: 'text', text: 'ok' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 1, output_tokens: 1 },
            }), { status: 200, headers: { 'content-type': 'application/json' } }));
            const ctx = fakeCtx({ onFetch: fetchMock, body });
            await dispatchClaude(ctx);
            expect(fetchMock).toHaveBeenCalledTimes(1);
            return {
                sent: JSON.parse(fetchMock.mock.calls[0][1].body),
                ctx,
            };
        }

        test('sonnet-5 off disables thinking', async () => {
            const { sent } = await send({ model: 'claude-sonnet-5', reasoning_effort: 'off' });
            expect(sent.thinking).toEqual({ type: 'disabled' });
        });

        test('opus-5 off disables thinking', async () => {
            const { sent } = await send({ model: 'claude-opus-5', reasoning_effort: 'off' });
            expect(sent.thinking).toEqual({ type: 'disabled' });
        });

        test('opus-5 max sends max with adaptive thinking', async () => {
            const { sent } = await send({ model: 'claude-opus-5', reasoning_effort: 'max' });
            expect(sent.thinking?.type).not.toBe('disabled');
            expect(sent.thinking).toEqual({ type: 'adaptive' });
            expect(sent.output_config?.effort).toBe('max');
        });

        test('opus-5-5 max sends max', async () => {
            const { sent } = await send({ model: 'claude-opus-5-5', reasoning_effort: 'max' });
            expect(sent.thinking).toEqual({ type: 'adaptive' });
            expect(sent.output_config?.effort).toBe('max');
        });

        test('opus-5-5 xhigh sends xhigh', async () => {
            const { sent } = await send({ model: 'claude-opus-5-5', reasoning_effort: 'xhigh' });
            expect(sent.thinking).toEqual({ type: 'adaptive' });
            expect(sent.output_config?.effort).toBe('xhigh');
        });

        test('sonnet-5-5 max sends max', async () => {
            const { sent } = await send({ model: 'claude-sonnet-5-5', reasoning_effort: 'max' });
            expect(sent.thinking).toEqual({ type: 'adaptive' });
            expect(sent.output_config?.effort).toBe('max');
        });

        test('opus-4-5 minimal uses extended thinking with 1024 budget', async () => {
            const { sent } = await send({ model: 'claude-opus-4-5', max_tokens: 8192, reasoning_effort: 'minimal' });
            expect(sent.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
        });

        test('opus-4-7 off omits the thinking key', async () => {
            const { sent } = await send({ model: 'claude-opus-4-7', reasoning_effort: 'off' });
            expect(sent).not.toHaveProperty('thinking');
        });

        test('opus-4-6 off omits the thinking key', async () => {
            const { sent } = await send({ model: 'claude-opus-4-6', reasoning_effort: 'off' });
            expect(sent).not.toHaveProperty('thinking');
        });

        test('fable-5 off is ignored and sends no thinking key', async () => {
            const { sent, ctx } = await send({ model: 'claude-fable-5', reasoning_effort: 'off' });
            expect(sent).not.toHaveProperty('thinking');
            expect(ctx._emitted.filter(e => e.kind === 'error')).toHaveLength(0);
        });

        test('sonnet-5-5 off uses between_tools thinking', async () => {
            const { sent } = await send({ model: 'claude-sonnet-5-5', reasoning_effort: 'off' });
            expect(sent.thinking).toEqual({ type: 'between_tools' });
        });

        test('sonnet-5 auto with include_reasoning requests summarized display', async () => {
            const { sent } = await send({ model: 'claude-sonnet-5', reasoning_effort: 'auto', include_reasoning: true });
            expect(sent.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
        });

        test('fable-5 off with include_reasoning still honors summarized display', async () => {
            const { sent } = await send({ model: 'claude-fable-5', reasoning_effort: 'off', include_reasoning: true });
            expect(sent.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
        });

        test('haiku-5-5 high uses adaptive thinking with output_config effort', async () => {
            const { sent } = await send({ model: 'claude-haiku-5-5', reasoning_effort: 'high' });
            expect(sent.thinking).toEqual({ type: 'adaptive' });
            expect(sent.output_config?.effort).toBe('high');
            expect(sent.thinking?.budget_tokens).toBeUndefined();
        });

        test('haiku-5-5 max sends max', async () => {
            const { sent } = await send({ model: 'claude-haiku-5-5', reasoning_effort: 'max' });
            expect(sent.thinking).toEqual({ type: 'adaptive' });
            expect(sent.output_config?.effort).toBe('max');
        });

        test('haiku-5-5 xhigh sends xhigh', async () => {
            const { sent } = await send({ model: 'claude-haiku-5-5', reasoning_effort: 'xhigh' });
            expect(sent.thinking).toEqual({ type: 'adaptive' });
            expect(sent.output_config?.effort).toBe('xhigh');
        });

        test('legacy min token maps to minimal on an extended-thinking model', async () => {
            const { sent } = await send({ model: 'claude-opus-4-5', max_tokens: 8192, reasoning_effort: 'min' });
            expect(sent.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
        });
    });

    describe('structured output and forced tool capability rules', () => {
        test('modern Claude 4.5+/5+ models use native output_config.format for json_schema', async () => {
            for (const model of ['claude-sonnet-4-5', 'claude-opus-4-6', 'claude-opus-5-5', 'claude-haiku-5-5']) {
                const ctx = fakeCtx({
                    body: {
                        model,
                        json_schema: { name: 'reply', value: { type: 'object', properties: { ok: { type: 'boolean' } } } },
                    },
                });
                await dispatchClaude(ctx);
                expect(ctx.fetch).toHaveBeenCalledTimes(1);
                const sent = JSON.parse(ctx.fetch.mock.calls[0][1].body);
                expect(sent.output_config?.format).toEqual({
                    type: 'json_schema',
                    schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
                });
                expect(sent.tools).toBeUndefined();
                expect(sent.tool_choice).toBeUndefined();
            }
        });

        test('legacy Claude 3.5 falls back to forced schema tool for json_schema', async () => {
            const ctx = fakeCtx({
                body: {
                    model: 'claude-3-5-sonnet-20241022',
                    json_schema: { name: 'reply', value: { type: 'object', properties: { ok: { type: 'boolean' } } } },
                },
            });
            await dispatchClaude(ctx);
            expect(ctx.fetch).toHaveBeenCalledTimes(1);
            const sent = JSON.parse(ctx.fetch.mock.calls[0][1].body);
            expect(sent.output_config?.format).toBeUndefined();
            expect(sent.tool_choice).toEqual({ type: 'tool', name: 'reply' });
            expect(sent.tools?.[0]?.name).toBe('reply');
        });

        test('rejects forced tool_choice with manual thinking or incompatible adaptive-thinking models with 400 conflict', async () => {
            const toolBody = {
                tools: [{ type: 'function', function: { name: 'do_thing', parameters: { type: 'object' } } }],
                tool_choice: { type: 'function', function: { name: 'do_thing' } },
            };

            const manualCtx = fakeCtx({
                body: { model: 'claude-sonnet-4-5', max_tokens: 4096, reasoning_effort: 'low', ...toolBody },
            });
            await dispatchClaude(manualCtx);
            expect(manualCtx.fetch).not.toHaveBeenCalled();
            expect(manualCtx._emitted.find(e => e.kind === 'head')?.data.status).toBe(400);
            const manualErr = JSON.parse(new TextDecoder().decode(manualCtx._emitted.find(e => e.kind === 'chunk').data));
            expect(manualErr.error.code).toBe('claude_manual_thinking_forced_tool_conflict');
            expect(manualErr.error.non_retryable).toBe(true);

            const adaptiveCtx = fakeCtx({
                body: { model: 'claude-opus-5-5', reasoning_effort: 'high', ...toolBody },
            });
            await dispatchClaude(adaptiveCtx);
            expect(adaptiveCtx.fetch).not.toHaveBeenCalled();
            expect(adaptiveCtx._emitted.find(e => e.kind === 'head')?.data.status).toBe(400);
            const adaptiveErr = JSON.parse(new TextDecoder().decode(adaptiveCtx._emitted.find(e => e.kind === 'chunk').data));
            expect(adaptiveErr.error.code).toBe('claude_adaptive_thinking_forced_tool_conflict');
        });

        test('allows forced tool_choice with adaptive thinking on compatible models (opus-4-7, haiku-5-5)', async () => {
            for (const model of ['claude-opus-4-7', 'claude-haiku-5-5']) {
                const ctx = fakeCtx({
                    body: {
                        model,
                        reasoning_effort: 'high',
                        tools: [{ type: 'function', function: { name: 'do_thing', parameters: { type: 'object' } } }],
                        tool_choice: { type: 'function', function: { name: 'do_thing' } },
                    },
                });
                await dispatchClaude(ctx);
                expect(ctx.fetch).toHaveBeenCalledTimes(1);
            }
        });

        test('pause_turn continuation keeps trailing assistant role and unmodified native content blocks on noPrefill/adaptive models', async () => {
            const pausedBlocks = [
                { type: 'thinking', thinking: 'Searching latest data', signature: 'sig_pause_1' },
                { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'test query' } },
                { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://example.com', title: 'Example' }] },
            ];
            const ctx = fakeCtx({
                body: {
                    model: 'claude-opus-4-7',
                    reasoning_effort: 'high',
                    enable_web_search: true,
                    claude_pause_turn_continuation: true,
                    messages: [
                        { role: 'user', content: 'Look this up.' },
                        { role: 'assistant', content: '', native_content_blocks: pausedBlocks },
                    ],
                },
            });
            await dispatchClaude(ctx);
            expect(ctx.fetch).toHaveBeenCalledTimes(1);
            const sent = JSON.parse(ctx.fetch.mock.calls[0][1].body);
            expect(sent.messages).toHaveLength(2);
            expect(sent.messages[1].role).toBe('assistant');
            expect(sent.messages[1].content).toEqual(pausedBlocks);
        });

        test('completed web-search assistant turn WITHOUT claude_pause_turn_continuation still rewrites trailing assistant to user on noPrefill models', async () => {
            const completedBlocks = [
                { type: 'thinking', thinking: 'Looked it up', signature: 'sig_done_1' },
                { type: 'server_tool_use', id: 'srvtoolu_done', name: 'web_search', input: { query: 'tide' } },
                { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_done', content: [{ type: 'web_search_result', url: 'https://example.com', title: 'Tide' }] },
                { type: 'text', text: 'High tide is at 18:40.' },
            ];
            const ctx = fakeCtx({
                body: {
                    model: 'claude-opus-4-7',
                    reasoning_effort: 'high',
                    enable_web_search: true,
                    messages: [
                        { role: 'user', content: 'When is high tide?' },
                        { role: 'assistant', content: 'High tide is at 18:40.', native_content_blocks: completedBlocks },
                    ],
                },
            });
            await dispatchClaude(ctx);
            expect(ctx.fetch).toHaveBeenCalledTimes(1);
            const sent = JSON.parse(ctx.fetch.mock.calls[0][1].body);
            expect(sent.messages[sent.messages.length - 1].role).toBe('user');
        });

        test('Claude 4.6 adaptive thinking drops temperature, top_p, and top_k', async () => {
            const prevEnv = process.env.SILLYTAVERN_CLAUDE_ENABLEADAPTIVETHINKING;
            process.env.SILLYTAVERN_CLAUDE_ENABLEADAPTIVETHINKING = 'true';
            try {
                const ctx = fakeCtx({
                    body: {
                        model: 'claude-opus-4-6',
                        reasoning_effort: 'high',
                        temperature: 0.7,
                        top_p: 0.9,
                        top_k: 40,
                    },
                });
                await dispatchClaude(ctx);
                const sent = JSON.parse(ctx.fetch.mock.calls[0][1].body);
                expect(sent.thinking).toEqual({ type: 'adaptive' });
                expect(sent.temperature).toBeUndefined();
                expect(sent.top_p).toBeUndefined();
                expect(sent.top_k).toBeUndefined();
            } finally {
                if (prevEnv === undefined) delete process.env.SILLYTAVERN_CLAUDE_ENABLEADAPTIVETHINKING;
                else process.env.SILLYTAVERN_CLAUDE_ENABLEADAPTIVETHINKING = prevEnv;
            }
        });

        test('AbortError records inspection abort instead of error', async () => {
            const ac = new AbortController();
            const ctx = fakeCtx({
                onFetch: jest.fn(async () => {
                    ac.abort();
                    throw new DOMException('aborted', 'AbortError');
                }),
            });
            ctx.signal = ac.signal;
            ctx.inspection.abort = jest.fn();
            await dispatchClaude(ctx);
            expect(ctx.inspection.abort).toHaveBeenCalledTimes(1);
            expect(ctx.inspection.fail).not.toHaveBeenCalled();
        });

        test('inspection.complete error surfaces via ctx.emit.error before ctx.emit.end', async () => {
            const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
            try {
                const ctx = fakeCtx();
                ctx.inspection.complete = jest.fn(() => {
                    throw new Error('inspection store failed');
                });
                await dispatchClaude(ctx);
                const kinds = ctx._emitted.map(e => e.kind);
                expect(kinds).toContain('error');
                expect(kinds).not.toContain('end');
                expect(ctx.inspection.fail).toHaveBeenCalledTimes(1);
            } finally {
                errorSpy.mockRestore();
            }
        });

        test.each([
            ['claude-sonnet-4-5', true, undefined, 'auto', 'body', true],
            ['claude-opus-5-5', true, undefined, 'auto', 'payload.text', true],
            ['claude-sonnet-4-5', true, undefined, { type: 'function', function: { name: 'reply' } }, 'body', true],
            ['claude-sonnet-4-5', true, undefined, 'none', 'body', false],
            ['claude-sonnet-4-5', false, undefined, 'auto', 'body', false],
            ['claude-3-5-sonnet-20241022', true, undefined, 'auto', 'body', false],
            ['claude-sonnet-4-5', true, 'https://bedrock-proxy.example.com/v1', 'auto', 'body', false],
            ['claude-sonnet-4-5', true, undefined, 'auto', 'count', false],
        ])('eager_input_streaming for %s, stream=%s, base_url=%s, tool_choice=%j, argument=%s', async (model, stream, baseUrl, toolChoice, argument, expectedEager) => {
            const tools = [
                {
                    type: 'function',
                    function: {
                        name: 'reply',
                        parameters: {
                            type: 'object',
                            properties: {
                                body: { type: 'string' },
                                count: { type: 'number' },
                                payload: { type: 'object', properties: { text: { type: 'string' } } },
                            },
                        },
                    },
                },
                {
                    type: 'function',
                    function: {
                        name: 'other',
                        parameters: { type: 'object', properties: { body: { type: 'string' } } },
                    },
                },
            ];
            const ctx = fakeCtx({
                body: {
                    model,
                    stream,
                    ...(baseUrl ? { base_url: baseUrl } : {}),
                    tools,
                    tool_choice: toolChoice,
                    luker_streaming_tool_reply: { name: 'reply', argument },
                },
            });
            await dispatchClaude(ctx);
            const sent = JSON.parse(ctx.fetch.mock.calls[0][1].body);
            const replyTool = sent.tools.find(t => t.name === 'reply');
            const otherTool = sent.tools.find(t => t.name === 'other');
            if (expectedEager) {
                expect(replyTool.eager_input_streaming).toBe(true);
            } else {
                expect(replyTool.eager_input_streaming).toBeUndefined();
            }
            expect(otherTool.eager_input_streaming).toBeUndefined();
            expect(sent).not.toHaveProperty('luker_streaming_tool_reply');
        });
    });
});
