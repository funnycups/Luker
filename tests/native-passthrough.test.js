// SPDX-License-Identifier: AGPL-3.0-or-later
import http from 'node:http';
import express from 'express';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';

import { createDeliveryServer } from '../src/ws-delivery.js';
import { runLukerDispatch } from '../src/luker-dispatch/runner.js';
import { dispatchClaude } from '../src/luker-dispatch/providers/chat-completions/claude.js';
import { dispatchMakerSuite } from '../src/luker-dispatch/providers/chat-completions/makersuite.js';
import { dispatchCohere } from '../src/luker-dispatch/providers/chat-completions/cohere.js';
import { dispatchOpenAIResponses } from '../src/luker-dispatch/providers/chat-completions/openai-responses.js';
import { dispatchOpenAICompatible } from '../src/luker-dispatch/providers/chat-completions/openai-compatible.js';
import { getBufferForHandle } from '../src/request-inspector.js';
import { getTaskByRequestId } from '../src/endpoints/backends/luker-generation.js';
import {
    createLukerDelivery,
    getLukerResponseMeta,
    installFetchProxy,
    onLukerResponseMeta,
} from '../public/scripts/ws-delivery.js';
import {
    ProtocolParseError,
    createProtocolStreamParser,
    isParsedTurnEmpty,
    parseProtocolResponse,
} from '../public/scripts/lib/protocol-parser/index.js';

const HANDLE = 'native-passthrough-alice';

function startFakeUpstream() {
    let nextHandler = null;
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const rawReqBody = Buffer.concat(chunks).toString('utf8');
            if (!nextHandler) {
                res.writeHead(500, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'no upstream handler configured' } }));
                return;
            }
            nextHandler(req, res, rawReqBody);
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({
                baseUrl: `http://127.0.0.1:${server.address().port}`,
                setHandler(fn) { nextHandler = fn; },
                close() {
                    server.closeAllConnections();
                    return new Promise(r => server.close(r));
                },
            });
        });
    });
}

function selectProviderForTest(body, upstreamBaseUrl) {
    const src = body.chat_completion_source;
    if (src === 'claude') {
        return async (ctx) => {
            ctx.body.reverse_proxy = `${upstreamBaseUrl}/v1`;
            ctx.body.proxy_password = 'test-claude-key';
            return dispatchClaude(ctx);
        };
    }
    if (src === 'makersuite') {
        return async (ctx) => {
            ctx.body.reverse_proxy = upstreamBaseUrl;
            ctx.body.proxy_password = 'test-gemini-key';
            return dispatchMakerSuite(ctx);
        };
    }
    if (src === 'cohere') {
        return async (ctx) => {
            const origFetch = ctx.fetch;
            ctx.fetch = (url, init) => origFetch(String(url).replace('https://api.cohere.ai/v2', `${upstreamBaseUrl}/v2`), init);
            ctx.secrets = { read: () => 'test-cohere-key' };
            return dispatchCohere(ctx);
        };
    }
    if (src === 'openai_responses') {
        return async (ctx) => {
            ctx.body.responses_url = `${upstreamBaseUrl}/v1`;
            ctx.secrets = { read: () => 'test-oai-key' };
            return dispatchOpenAIResponses(ctx);
        };
    }
    return async (ctx) => {
        ctx.body.reverse_proxy = `${upstreamBaseUrl}/v1`;
        ctx.body.proxy_password = 'test-oai-key';
        return dispatchOpenAICompatible(ctx);
    };
}

function startLukerApp(upstreamBaseUrl) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { profile: { handle: HANDLE }, directories: {} };
        next();
    });
    app.post('/api/backends/chat-completions/generate', (req, res) =>
        runLukerDispatch(req, res, {
            endpoint: 'chat-completions',
            select: (body) => selectProviderForTest(body, upstreamBaseUrl),
        }));

    const httpServer = http.createServer(app);
    const delivery = createDeliveryServer({
        httpServer,
        verifyTicket: () => ({ user_handle: HANDLE }),
    });

    return new Promise((resolve) => {
        httpServer.listen(0, '127.0.0.1', () => {
            const port = httpServer.address().port;
            resolve({
                port,
                baseUrl: `http://127.0.0.1:${port}`,
                async close() {
                    await delivery.close();
                    httpServer.closeAllConnections();
                    await new Promise(r => httpServer.close(r));
                },
            });
        });
    });
}

describe('Native HTTP passthrough + out-of-band WS meta channel', () => {
    let upstream;
    let lukerServer;
    let delivery;
    let fakeWindow;
    let savedWebSocket;
    let savedLocation;

    beforeAll(async () => {
        upstream = await startFakeUpstream();
        lukerServer = await startLukerApp(upstream.baseUrl);

        savedWebSocket = globalThis.WebSocket;
        savedLocation = globalThis.location;
        globalThis.WebSocket = WebSocket;
        globalThis.location = { protocol: 'http:', host: `127.0.0.1:${lukerServer.port}` };

        delivery = createLukerDelivery({ reconnectBackoffMs: 50 });
        await delivery.connect(async () => 'test-ticket');

        fakeWindow = { Response, Headers, DOMException };
        installFetchProxy(delivery, {
            targetWindow: fakeWindow,
            originalFetch: (url, init) => {
                const resolved = String(url).startsWith('http') ? url : `${lukerServer.baseUrl}${url}`;
                return fetch(resolved, init);
            },
        });
    });

    afterAll(async () => {
        if (delivery) delivery.close();
        if (lukerServer) await lukerServer.close();
        if (upstream) await upstream.close();
        globalThis.WebSocket = savedWebSocket;
        globalThis.location = savedLocation;
    });

    async function callWithPluginObserver(requestId, body) {
        const pluginObserved = { status: null, rawBodyText: null };
        const observedMetaEvents = [];
        const resp = await fakeWindow.fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-luker-request-id': requestId,
            },
            body: JSON.stringify({
                ...body,
                luker_generation: { job_id: requestId },
            }),
        });
        pluginObserved.status = resp.status;
        onLukerResponseMeta(resp, (m) => observedMetaEvents.push(m));
        const cloned = resp.clone();
        const [rawBodyText, consumerBodyText] = await Promise.all([
            cloned.text(),
            resp.text(),
        ]);
        pluginObserved.rawBodyText = rawBodyText;
        const job = getTaskByRequestId(requestId, HANDLE);
        if (job?.persistenceTimer) {
            clearTimeout(job.persistenceTimer);
            job.persistenceTimer = null;
        }
        return {
            resp,
            pluginObserved,
            consumerBodyText,
            meta: getLukerResponseMeta(resp),
            observedMetaEvents,
            job,
        };
    }

    const nonStreamCases = [
        {
            name: 'Claude native Messages API',
            requestId: 'pt-ns-claude',
            source: 'claude',
            model: 'claude-3-7-sonnet-20250219',
            upstreamBody: JSON.stringify({
                id: 'msg_pt_1',
                type: 'message',
                role: 'assistant',
                content: [
                    { type: 'thinking', thinking: 'claude plan', signature: 'sig-c1' },
                    { type: 'text', text: 'Claude native reply' },
                ],
                stop_reason: 'end_turn',
                usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 5 },
            }),
            expectedText: 'Claude native reply',
            expectedReasoning: 'claude plan',
        },
        {
            name: 'Gemini native generateContent',
            requestId: 'pt-ns-gemini',
            source: 'makersuite',
            model: 'gemini-2.5-flash',
            upstreamBody: JSON.stringify({
                candidates: [{
                    content: {
                        role: 'model',
                        parts: [
                            { thought: true, text: 'gemini plan', thoughtSignature: 'sig-g1' },
                            { text: 'Gemini native reply' },
                        ],
                    },
                    finishReason: 'STOP',
                }],
                usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5, thoughtsTokenCount: 7, totalTokenCount: 24 },
            }),
            expectedText: 'Gemini native reply',
            expectedReasoning: 'gemini plan',
        },
        {
            name: 'Cohere v2 native Chat',
            requestId: 'pt-ns-cohere',
            source: 'cohere',
            model: 'command-a-03-2025',
            upstreamBody: JSON.stringify({
                id: 'coh_pt_1',
                message: {
                    role: 'assistant',
                    content: [
                        { type: 'thinking', thinking: 'cohere plan' },
                        { type: 'text', text: 'Cohere native reply' },
                    ],
                },
                finish_reason: 'COMPLETE',
                usage: { billed_units: { input_tokens: 8, output_tokens: 3 } },
            }),
            expectedText: 'Cohere native reply',
            expectedReasoning: 'cohere plan',
        },
        {
            name: 'OpenAI Responses native API',
            requestId: 'pt-ns-responses',
            source: 'openai_responses',
            model: 'gpt-5',
            upstreamBody: JSON.stringify({
                id: 'resp_pt_1',
                object: 'response',
                status: 'completed',
                output: [
                    { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'responses plan' }] },
                    { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Responses native reply' }] },
                ],
                usage: { input_tokens: 15, output_tokens: 6, total_tokens: 21 },
            }),
            expectedText: 'Responses native reply',
            expectedReasoning: 'responses plan',
        },
        {
            name: 'OpenAI Chat Completions native API',
            requestId: 'pt-ns-oai',
            source: 'openai',
            model: 'gpt-4o',
            upstreamBody: JSON.stringify({
                id: 'chatcmpl_pt_1',
                object: 'chat.completion',
                choices: [{
                    index: 0,
                    message: { role: 'assistant', content: 'OpenAI native reply', reasoning_content: 'oai plan' },
                    finish_reason: 'stop',
                }],
                usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
            }),
            expectedText: 'OpenAI native reply',
            expectedReasoning: 'oai plan',
        },
    ];

    for (const tc of nonStreamCases) {
        test(`non-streaming passthrough: ${tc.name} preserves exact upstream bytes and delivers meta out-of-band`, async () => {
            upstream.setHandler((_req, res) => {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(tc.upstreamBody);
            });

            const { pluginObserved, consumerBodyText, meta, job } = await callWithPluginObserver(tc.requestId, {
                chat_completion_source: tc.source,
                model: tc.model,
                stream: false,
                messages: [{ role: 'user', content: 'hello' }],
                max_tokens: 64,
            });

            expect(pluginObserved.status).toBe(200);
            expect(pluginObserved.rawBodyText).toBe(tc.upstreamBody);
            expect(consumerBodyText).toBe(tc.upstreamBody);
            expect(pluginObserved.rawBodyText).not.toContain('"luker"');

            expect(meta).toEqual(expect.objectContaining({
                generation_id: tc.requestId,
                persisted: expect.any(Boolean),
                status: expect.any(String),
            }));

            const parsed = parseProtocolResponse(tc.source, JSON.parse(consumerBodyText));
            expect(parsed.text).toBe(tc.expectedText);
            expect(parsed.reasoning).toBe(tc.expectedReasoning);

            expect(job?.text).toBe(tc.expectedText);
            const inspectorEntry = getBufferForHandle(HANDLE).find(e => e.model === tc.model && e.responseText === tc.expectedText);
            expect(inspectorEntry).toBeDefined();
            expect(inspectorEntry.status).toBe('success');
        });
    }

    const streamCases = [
        {
            name: 'Claude native SSE',
            requestId: 'pt-st-claude',
            source: 'claude',
            model: 'claude-3-7-sonnet-20250219',
            sseBody:
                'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":11,"output_tokens":0}}}\n\n' +
                'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n' +
                'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"plan"}}\n\n' +
                'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n' +
                'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"stream claude"}}\n\n' +
                'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n' +
                'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            expectedText: 'stream claude',
            expectedReasoning: 'plan',
        },
        {
            name: 'Gemini native SSE',
            requestId: 'pt-st-gemini',
            source: 'makersuite',
            model: 'gemini-2.5-flash',
            sseBody:
                'data: {"candidates":[{"content":{"role":"model","parts":[{"thought":true,"text":"g-plan"}]}}]}\n\n' +
                'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"stream gemini"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":3,"totalTokenCount":13}}\n\n',
            expectedText: 'stream gemini',
            expectedReasoning: 'g-plan',
        },
        {
            name: 'Cohere native SSE',
            requestId: 'pt-st-cohere',
            source: 'cohere',
            model: 'command-a-03-2025',
            sseBody:
                'event: content-delta\ndata: {"type":"content-delta","delta":{"message":{"content":{"thinking":"c-plan"}}}}\n\n' +
                'event: content-delta\ndata: {"type":"content-delta","delta":{"message":{"content":{"text":"stream cohere"}}}}\n\n' +
                'event: message-end\ndata: {"type":"message-end","delta":{"finish_reason":"COMPLETE","usage":{"billed_units":{"input_tokens":7,"output_tokens":2}}}}\n\n',
            expectedText: 'stream cohere',
            expectedReasoning: 'c-plan',
        },
        {
            name: 'OpenAI Responses native SSE',
            requestId: 'pt-st-responses',
            source: 'openai_responses',
            model: 'gpt-5',
            sseBody:
                'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"r-plan"}\n\n' +
                'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"stream responses"}\n\n' +
                'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"stream responses"}]}],"usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\n\n',
            expectedText: 'stream responses',
            expectedReasoning: 'r-plan',
        },
        {
            name: 'OpenAI Chat native SSE',
            requestId: 'pt-st-oai',
            source: 'openai',
            model: 'gpt-4o',
            sseBody:
                'data: {"choices":[{"index":0,"delta":{"reasoning_content":"o-plan"}}]}\n\n' +
                'data: {"choices":[{"index":0,"delta":{"content":"stream openai"},"finish_reason":"stop"}]}\n\n' +
                'data: [DONE]\n\n',
            expectedText: 'stream openai',
            expectedReasoning: 'o-plan',
        },
    ];

    for (const tc of streamCases) {
        test(`streaming passthrough: ${tc.name} delivers exact upstream SSE bytes with zero synthetic luker frames`, async () => {
            upstream.setHandler((_req, res) => {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.end(tc.sseBody);
            });

            const { pluginObserved, consumerBodyText, meta, job } = await callWithPluginObserver(tc.requestId, {
                chat_completion_source: tc.source,
                model: tc.model,
                stream: true,
                messages: [{ role: 'user', content: 'hello' }],
                max_tokens: 64,
            });

            expect(pluginObserved.status).toBe(200);
            expect(pluginObserved.rawBodyText).toBe(tc.sseBody);
            expect(consumerBodyText).toBe(tc.sseBody);
            expect(pluginObserved.rawBodyText).not.toContain('"luker"');

            expect(meta).toEqual(expect.objectContaining({
                generation_id: tc.requestId,
                persisted: expect.any(Boolean),
                status: expect.any(String),
            }));

            const streamParser = createProtocolStreamParser(tc.source);
            streamParser.feedSseChunk(consumerBodyText);
            const parsed = streamParser.finish();
            expect(parsed.text).toBe(tc.expectedText);
            expect(parsed.reasoning).toBe(tc.expectedReasoning);

            expect(job?.text).toBe(tc.expectedText);
        });
    }

    test('Gemini non-streaming promptFeedback.blockReason passes native JSON verbatim while Inspector and shared parser report terminal error', async () => {
        const blockedPayload = JSON.stringify({
            candidates: [],
            promptFeedback: { blockReason: 'SAFETY' },
        });
        upstream.setHandler((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(blockedPayload);
        });

        const { pluginObserved, consumerBodyText } = await callWithPluginObserver('pt-gemini-blocked', {
            chat_completion_source: 'makersuite',
            model: 'gemini-2.5-flash',
            stream: false,
            messages: [{ role: 'user', content: 'blocked prompt' }],
            max_tokens: 64,
        });

        expect(pluginObserved.rawBodyText).toBe(blockedPayload);
        expect(JSON.parse(consumerBodyText).error).toBeUndefined();

        expect(() => parseProtocolResponse('makersuite', JSON.parse(consumerBodyText))).toThrow(ProtocolParseError);

        const inspectorEntry = getBufferForHandle(HANDLE).find(
            e => e.source === 'makersuite' && e.status === 'error' && String(e.error).includes('SAFETY'),
        );
        expect(inspectorEntry).toBeDefined();
        expect(inspectorEntry.parseError).toBeNull();
    });

    test('Gemini non-streaming probabilistic SAFETY empty candidate passes native JSON verbatim as retriable empty turn', async () => {
        const emptyPayload = JSON.stringify({
            candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'SAFETY' }],
        });
        upstream.setHandler((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(emptyPayload);
        });

        const { pluginObserved, consumerBodyText } = await callWithPluginObserver('pt-gemini-empty', {
            chat_completion_source: 'makersuite',
            model: 'gemini-2.5-flash',
            stream: false,
            messages: [{ role: 'user', content: 'retryable empty' }],
            max_tokens: 64,
        });

        expect(pluginObserved.rawBodyText).toBe(emptyPayload);
        const turn = parseProtocolResponse('makersuite', JSON.parse(consumerBodyText));
        expect(isParsedTurnEmpty(turn)).toBe(true);
    });
});
