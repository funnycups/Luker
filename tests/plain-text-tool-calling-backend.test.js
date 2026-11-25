// SPDX-License-Identifier: AGPL-3.0-or-later
import http from 'node:http';
import express from 'express';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';

import { createDeliveryServer } from '../src/ws-delivery.js';
import { runLukerDispatch } from '../src/luker-dispatch/runner.js';
import { dispatchOpenAICompatible } from '../src/luker-dispatch/providers/chat-completions/openai-compatible.js';
import {
    applyPlainTextResultToResponseParts,
    evaluatePlainTextToolCallTurn,
    preparePlainTextToolRequest,
} from '../src/luker-dispatch/plain-text-tool-calling.js';
import { getBufferForHandle } from '../src/request-inspector.js';
import { getTaskByRequestId } from '../src/endpoints/backends/luker-generation.js';
import {
    createLukerDelivery,
    getLukerResponseMeta,
    installFetchProxy,
} from '../public/scripts/ws-delivery.js';

const HANDLE = 'pt-backend-alice';
const SAMPLE_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'get_weather',
            description: 'Return current weather for a city.',
            parameters: {
                type: 'object',
                properties: {
                    city: { type: 'string', minLength: 1 },
                },
                required: ['city'],
                additionalProperties: false,
            },
        },
    },
];

function startFakeUpstream() {
    const capturedRequests = [];
    const queue = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            const rawBody = Buffer.concat(chunks).toString('utf8');
            let parsedBody = null;
            try { parsedBody = JSON.parse(rawBody); } catch { /* ignore */ }
            capturedRequests.push({ url: req.url, method: req.method, body: parsedBody, rawBody });
            const handler = queue.shift();
            if (!handler) {
                res.writeHead(500, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'empty upstream queue' } }));
                return;
            }
            handler(req, res, parsedBody);
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({
                baseUrl: `http://127.0.0.1:${server.address().port}`,
                capturedRequests,
                enqueue(fn) { queue.push(fn); },
                reset() {
                    capturedRequests.length = 0;
                    queue.length = 0;
                },
                close() {
                    server.closeAllConnections();
                    return new Promise(r => server.close(r));
                },
            });
        });
    });
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
            select: () => async (ctx) => {
                ctx.body.reverse_proxy = `${upstreamBaseUrl}/v1`;
                ctx.body.proxy_password = 'test-key';
                return dispatchOpenAICompatible(ctx);
            },
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

describe('Plain-text tool-calling pure contract', () => {
    test('preparePlainTextToolRequest strips internal config and native tools, normalizes history, and injects protocol prompt', () => {
        const prepared = preparePlainTextToolRequest({
            model: 'gpt-4o',
            chat_completion_source: 'openai',
            tools: SAMPLE_TOOLS,
            tool_choice: 'auto',
            messages: [
                { role: 'system', content: 'Base system.' },
                { role: 'user', content: 'Check weather.' },
                {
                    role: 'assistant',
                    content: 'Checking now.',
                    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } }],
                },
                { role: 'tool', tool_call_id: 'c1', content: 'Cloudy 12C' },
            ],
            luker_plain_text_tools: {
                mode: 'prompt_xml',
                tools: SAMPLE_TOOLS,
                toolChoice: 'auto',
                protocolStyle: 'json_schema',
                triggerSignal: '<Function_Unit1_Start/>',
                retry: { enabled: true, maxAttempts: 3 },
            },
        });

        expect(prepared.active).toBe(true);
        expect(prepared.config.triggerSignal).toBe('<Function_Unit1_Start/>');
        expect(prepared.dispatchBody.luker_plain_text_tools).toBeUndefined();
        expect(prepared.dispatchBody.tools).toBeUndefined();
        expect(prepared.dispatchBody.tool_choice).toBeUndefined();

        const systemMsgs = prepared.dispatchBody.messages.filter(m => m.role === 'system');
        expect(systemMsgs.some(m => m.content.includes('<Function_Unit1_Start/>') && m.content.includes('get_weather'))).toBe(true);
        expect(prepared.dispatchBody.messages.some(m => m.role === 'tool')).toBe(false);
        expect(prepared.dispatchBody.messages.some(m => m.role === 'user' && m.content.includes('<tool_result>') && m.content.includes('Cloudy 12C'))).toBe(true);
        const assistantMsg = prepared.dispatchBody.messages.find(m => m.role === 'assistant');
        expect(assistantMsg.tool_calls).toBeUndefined();
        expect(assistantMsg.content).toContain('<Function_Unit1_Start/>');
    });

    test('preparePlainTextToolRequest rejects invalid multi-line triggerSignal with HTTP 400 error', () => {
        expect(() => preparePlainTextToolRequest({
            messages: [{ role: 'user', content: 'hi' }],
            luker_plain_text_tools: {
                mode: 'prompt_xml',
                tools: SAMPLE_TOOLS,
                triggerSignal: '<Bad>\n<Trigger/>',
            },
        })).toThrow(/triggerSignal/);
    });

    test('evaluatePlainTextToolCallTurn distinguishes normal prose, parsed success, and strict syntax/schema failures', () => {
        const trigger = '<Function_Ev01_Start/>';
        const baseConfig = {
            mode: 'prompt_xml',
            tools: SAMPLE_TOOLS,
            toolChoice: 'auto',
            requiredFunctionName: '',
            requiresToolCall: false,
            triggerSignal: trigger,
        };

        // 1. Normal prose without trigger (including trigger only inside <thought>).
        const prose = evaluatePlainTextToolCallTurn(
            { text: `<thought>Maybe use ${trigger}?</thought>\nJust answering directly.` },
            baseConfig,
        );
        expect(prose.status).toBe('none');
        expect(prose.calls).toEqual([]);
        expect(prose.displayText).toContain('Just answering directly.');

        // 2. Mandatory tool call missing trigger -> parse_failed.
        const missingMandatory = evaluatePlainTextToolCallTurn(
            { text: 'No trigger emitted.' },
            { ...baseConfig, toolChoice: 'required', requiresToolCall: true },
        );
        expect(missingMandatory.status).toBe('parse_failed');
        expect(missingMandatory.failureReason).toBe('syntax');
        expect(missingMandatory.error).toContain('trigger signal');

        // 3. Valid call after trigger with preamble text.
        const rawSuccess = `Let me check.\n${trigger}\n<function_calls><function_call><tool>get_weather</tool><args_json><![CDATA[{"city":"Lisbon"}]]></args_json></function_call></function_calls>`;
        const parsed = evaluatePlainTextToolCallTurn({ text: rawSuccess }, baseConfig);
        expect(parsed.status).toBe('parsed');
        expect(parsed.displayText).toBe('Let me check.');
        expect(parsed.callRegionRaw).toBe(rawSuccess.slice(rawSuccess.indexOf(trigger)));
        expect(parsed.calls).toHaveLength(1);
        expect(parsed.calls[0].name).toBe('get_weather');
        expect(parsed.calls[0].args).toEqual({ city: 'Lisbon' });
        expect(parsed.toolCalls[0].function.arguments).toBe('{"city":"Lisbon"}');

        // 4. Entered call syntax with broken XML / incomplete JSON args -> parse_failed, never spliced into displayText.
        const rawBroken = `Checking now.\n${trigger}\n<function_calls><function_call><tool>get_weather</tool><args_json><![CDATA[{"city":]]></args_json></function_call></function_calls>`;
        const failed = evaluatePlainTextToolCallTurn({ text: rawBroken }, baseConfig);
        expect(failed.status).toBe('parse_failed');
        expect(failed.failureReason).toBe('syntax');
        expect(failed.displayText).toBe('Checking now.');
        expect(failed.displayText).not.toContain(trigger);
        expect(failed.displayText).not.toContain('<function_calls>');
        expect(failed.calls).toEqual([]);
        expect(failed.toolCalls).toEqual([]);
        expect(failed.callRegionRaw).toBe(rawBroken.slice(rawBroken.indexOf(trigger)));
        expect(failed.error).toContain('not valid JSON');

        // 5. Schema violation (unexpected extra property) -> parse_failed.
        const rawSchemaBad = `${trigger}\n<function_calls><function_call><tool>get_weather</tool><args_json><![CDATA[{"city":"Lisbon","extra":1}]]></args_json></function_call></function_calls>`;
        const schemaFailed = evaluatePlainTextToolCallTurn({ text: rawSchemaBad }, baseConfig);
        expect(schemaFailed.status).toBe('parse_failed');
        expect(schemaFailed.error).toContain('unexpected property');
        expect(schemaFailed.toolCalls).toEqual([]);
    });

    test('applyPlainTextResultToResponseParts preserves preceding reasoning and text in original order', () => {
        const trigger = '<Function_Ord1_Start/>';
        const callPart = `${trigger}\n<function_calls><function_call><tool>get_weather</tool><args_json><![CDATA[{"city":"Reykjavik"}]]></args_json></function_call></function_calls>`;
        const fullText = `Let me check the chart.\n${callPart}`;
        const ptResult = evaluatePlainTextToolCallTurn(
            { text: fullText },
            { mode: 'prompt_xml', tools: SAMPLE_TOOLS, toolChoice: 'auto', requiresToolCall: false, triggerSignal: trigger },
        );

        const parts = applyPlainTextResultToResponseParts([
            { type: 'reasoning', kind: 'thinking', text: 'First I think carefully.' },
            { type: 'text', text: fullText },
        ], ptResult, { triggerSignal: trigger, attempt: 1, maxAttempts: 1 });

        expect(parts.map(p => p.type)).toEqual(['reasoning', 'text', 'plain_text_tool_calls']);
        expect(parts[0].text).toBe('First I think carefully.');
        expect(parts[1].text).toBe('Let me check the chart.');
        expect(parts[2].status).toBe('parsed');
        expect(parts[2].callRegionRaw).toBe(callPart);
        expect(parts[2].calls[0]).toEqual(expect.objectContaining({ name: 'get_weather', args: { city: 'Reykjavik' } }));
    });
});

describe('Plain-text backend orchestration end-to-end (HTTP passthrough + WS meta + Inspector + retries)', () => {
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

    async function sendProxied(requestId, body) {
        const resp = await fakeWindow.fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                ...body,
                luker_generation: { job_id: requestId },
            }),
        });
        const rawBodyText = await resp.text();
        const meta = getLukerResponseMeta(resp);
        const job = getTaskByRequestId(requestId, HANDLE);
        if (job?.persistenceTimer) {
            clearTimeout(job.persistenceTimer);
            job.persistenceTimer = null;
        }
        return { resp, rawBodyText, meta, job };
    }

    test('streaming plain-text call: strips internal config upstream, preserves native SSE bytes, delivers parsed calls via WS meta, and preserves Inspector reasoning + text + call region', async () => {
        upstream.reset();
        const trigger = '<Function_Str1_Start/>';
        const sseBody = [
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'Need weather data.' } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Looking that up.\n' } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `${trigger}\n<function_calls><function_call><tool>get_weather</tool><args_json><![CDATA[{"city":"Bergen"}]]></args_json></function_call></function_calls>` }, finish_reason: 'stop' }] })}\n\n`,
            'data: [DONE]\n\n',
        ].join('');
        upstream.enqueue((_req, res) => {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end(sseBody);
        });

        const { rawBodyText, meta, job } = await sendProxied('pt-e2e-stream-ok', {
            chat_completion_source: 'openai',
            model: 'gpt-4o',
            stream: true,
            messages: [{ role: 'user', content: 'Weather in Bergen?' }],
            max_tokens: 128,
            luker_plain_text_tools: {
                mode: 'prompt_xml',
                tools: SAMPLE_TOOLS,
                toolChoice: 'auto',
                protocolStyle: 'json_schema',
                triggerSignal: trigger,
                retry: { enabled: false, maxAttempts: 1 },
            },
        });

        // Upstream received protocol prompt and ZERO internal/native tool fields.
        expect(upstream.capturedRequests).toHaveLength(1);
        const sent = upstream.capturedRequests[0].body;
        expect(sent.luker_plain_text_tools).toBeUndefined();
        expect(sent.tools).toBeUndefined();
        expect(sent.tool_choice).toBeUndefined();
        expect(sent.messages.some(m => m.role === 'system' && m.content.includes(trigger))).toBe(true);

        // Browser fetch observed untouched native upstream SSE bytes.
        expect(rawBodyText).toBe(sseBody);
        expect(rawBodyText).not.toContain('"luker"');

        // WS meta carries authoritative parsed calls.
        expect(meta.plain_text_function_call.status).toBe('parsed');
        expect(meta.plain_text_function_call.displayText).toBe('Looking that up.');
        expect(meta.plain_text_function_call.toolCalls).toHaveLength(1);
        expect(meta.plain_text_function_call.toolCalls[0].function).toEqual({
            name: 'get_weather',
            arguments: '{"city":"Bergen"}',
        });

        // Job text keeps only displayText (never raw XML).
        expect(job.text).toBe('Looking that up.');

        // Inspector entry preserves reasoning -> text -> plain_text_tool_calls order.
        const entry = getBufferForHandle(HANDLE).find(e => e.id === meta.plain_text_function_call.inspectorEntryId);
        expect(entry).toBeDefined();
        expect(entry.status).toBe('success');
        expect(entry.plainTextFunctionCall.status).toBe('parsed');
        expect(entry.responseParts.map(p => p.type)).toEqual(['reasoning', 'text', 'plain_text_tool_calls']);
        expect(entry.responseParts[0].text).toBe('Need weather data.');
        expect(entry.responseParts[1].text).toBe('Looking that up.');
        expect(entry.responseParts[2].callRegionRaw).toContain(trigger);
    });

    test('backend format-correction retry succeeds on attempt 2, links Inspector entries, and leaves attempt 1 HTTP bytes untouched', async () => {
        upstream.reset();
        const trigger = '<Function_Rty1_Start/>';
        const attempt1Body = JSON.stringify({
            id: 'cmpl_a1',
            object: 'chat.completion',
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: `Checking.\n${trigger}\n<function_calls><function_call><tool>get_weather</tool><args_json><![CDATA[{broken]]></args_json></function_call></function_calls>`,
                },
                finish_reason: 'stop',
            }],
        });
        const attempt2Body = JSON.stringify({
            id: 'cmpl_a2',
            object: 'chat.completion',
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: `Checking fixed.\n${trigger}\n<function_calls><function_call><tool>get_weather</tool><args_json><![CDATA[{"city":"Oslo"}]]></args_json></function_call></function_calls>`,
                },
                finish_reason: 'stop',
            }],
        });

        upstream.enqueue((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(attempt1Body);
        });
        upstream.enqueue((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(attempt2Body);
        });

        const { rawBodyText, meta, job } = await sendProxied('pt-e2e-retry-ok', {
            chat_completion_source: 'openai',
            model: 'gpt-4o',
            stream: false,
            messages: [{ role: 'user', content: 'Weather in Oslo?' }],
            max_tokens: 128,
            luker_plain_text_tools: {
                mode: 'prompt_xml',
                tools: SAMPLE_TOOLS,
                toolChoice: 'auto',
                triggerSignal: trigger,
                retry: { enabled: true, maxAttempts: 3 },
            },
        });

        // Two upstream requests ran server-side; attempt 1 HTTP body was relayed verbatim.
        expect(upstream.capturedRequests).toHaveLength(2);
        expect(rawBodyText).toBe(attempt1Body);

        // Authoritative result via WS meta comes from attempt 2.
        const ptMeta = meta.plain_text_function_call;
        expect(ptMeta.status).toBe('parsed');
        expect(ptMeta.attempt).toBe(2);
        expect(ptMeta.retryOf).toBeTruthy();
        expect(ptMeta.originalError).toContain('not valid JSON');
        expect(ptMeta.displayText).toBe('Checking fixed.');
        expect(ptMeta.toolCalls[0].function).toEqual({ name: 'get_weather', arguments: '{"city":"Oslo"}' });
        expect(job.text).toBe('Checking fixed.');

        // Request Inspector preserves BOTH original failure and linked retry entry.
        const buf = getBufferForHandle(HANDLE);
        const entry1 = buf.find(e => e.id === ptMeta.retryOf);
        const entry2 = buf.find(e => e.id === ptMeta.inspectorEntryId);
        expect(entry1).toBeDefined();
        expect(entry2).toBeDefined();
        expect(entry1.status).toBe('error');
        expect(entry1.plainTextFunctionCall.status).toBe('parse_failed');
        expect(entry1.plainTextFunctionCall.finalStatus).toBe('parsed');
        expect(entry1.retryEntryIds).toContain(entry2.id);
        expect(entry2.status).toBe('success');
        expect(entry2.retryOf).toBe(entry1.id);
        expect(entry2.attempt).toBe(2);
        expect(entry2.originalError).toContain('not valid JSON');
    });

    test('backend retry HTTP 500 error is never swallowed and never falls back to attempt 1 result', async () => {
        upstream.reset();
        const trigger = '<Function_RtyErr_Start/>';
        const attempt1Body = JSON.stringify({
            id: 'cmpl_e1',
            object: 'chat.completion',
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: `${trigger}\n<function_calls><function_call><tool>get_weather</tool><args_json>bad</args_json></function_call></function_calls>`,
                },
                finish_reason: 'stop',
            }],
        });

        upstream.enqueue((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(attempt1Body);
        });
        upstream.enqueue((_req, res) => {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'upstream retry exploded' } }));
        });

        const { meta, job } = await sendProxied('pt-e2e-retry-http500', {
            chat_completion_source: 'openai',
            model: 'gpt-4o',
            stream: false,
            messages: [{ role: 'user', content: 'Weather?' }],
            max_tokens: 128,
            luker_plain_text_tools: {
                mode: 'prompt_xml',
                tools: SAMPLE_TOOLS,
                toolChoice: 'auto',
                triggerSignal: trigger,
                retry: { enabled: true, maxAttempts: 2 },
            },
        });

        const ptMeta = meta.plain_text_function_call;
        expect(ptMeta.status).toBe('network_error');
        expect(ptMeta.failureReason).toBe('network');
        expect(ptMeta.error).toContain('HTTP 500');
        expect(ptMeta.error).toContain('upstream retry exploded');
        expect(ptMeta.originalError).toContain('not valid JSON');
        expect(ptMeta.toolCalls).toEqual([]);
        expect(job.text).toBe('');

        const buf = getBufferForHandle(HANDLE);
        const retryEntry = buf.find(e => e.id === ptMeta.inspectorEntryId);
        expect(retryEntry).toBeDefined();
        expect(retryEntry.plainTextFunctionCall.status).toBe('network_error');
    });

    test('backend retry returning normal prose (status=none) replaces job.text and replacedTurn instead of leaking broken XML', async () => {
        upstream.reset();
        const trigger = '<Function_ProseRty_Start/>';
        const attempt1Body = JSON.stringify({
            id: 'cmpl_p1',
            object: 'chat.completion',
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: `${trigger}\n<function_calls><function_call><tool>get_weather</tool><args_json>{"city":</args_json></function_call></function_calls>`,
                },
                finish_reason: 'stop',
            }],
        });
        const attempt2Prose = JSON.stringify({
            id: 'cmpl_p2',
            object: 'chat.completion',
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: 'I do not need a tool; the sky is clear.',
                },
                finish_reason: 'stop',
            }],
        });

        upstream.enqueue((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(attempt1Body);
        });
        upstream.enqueue((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(attempt2Prose);
        });

        const { meta, job } = await sendProxied('pt-e2e-retry-prose', {
            chat_completion_source: 'openai',
            model: 'gpt-4o',
            stream: false,
            messages: [{ role: 'user', content: 'Weather?' }],
            max_tokens: 128,
            luker_plain_text_tools: {
                mode: 'prompt_xml',
                tools: SAMPLE_TOOLS,
                toolChoice: 'auto',
                triggerSignal: trigger,
                retry: { enabled: true, maxAttempts: 2 },
            },
        });

        const ptMeta = meta.plain_text_function_call;
        expect(ptMeta.status).toBe('none');
        expect(ptMeta.attempt).toBe(2);
        expect(ptMeta.displayText).toBe('I do not need a tool; the sky is clear.');
        expect(ptMeta.replacedTurn).toEqual(expect.objectContaining({ finishReason: 'stop' }));
        expect(job.text).toBe('I do not need a tool; the sky is clear.');
    });

    test('preparePlainTextToolRequest strips native replay envelopes carrying tool calls or stale triggers while keeping normal thinking envelopes', () => {
        const prepared = preparePlainTextToolRequest({
            chat_completion_source: 'claude',
            model: 'claude-sonnet-4-5',
            messages: [
                { role: 'user', content: 'Hi' },
                {
                    role: 'assistant',
                    content: 'Normal reply',
                    native_content_blocks: [{ type: 'thinking', thinking: 'ok', signature: 'sig-keep' }, { type: 'text', text: 'Normal reply' }],
                },
                {
                    role: 'assistant',
                    content: 'Checking weather',
                    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } }],
                    native_content_blocks: [{ type: 'tool_use', id: 'c1', name: 'get_weather', input: { city: 'Oslo' } }],
                    native_parts: [{ functionCall: { name: 'get_weather', args: { city: 'Oslo' } } }],
                    responses_output_items: [{ type: 'function_call', call_id: 'c1', name: 'get_weather', arguments: '{}' }],
                },
                { role: 'tool', tool_call_id: 'c1', content: 'Clear 14C' },
            ],
            luker_plain_text_tools: {
                mode: 'prompt_xml',
                tools: SAMPLE_TOOLS,
                toolChoice: 'auto',
                triggerSignal: '<Function_Hist_Start/>',
            },
        });

        const normalTurn = prepared.dispatchBody.messages.find(m => m.role === 'assistant' && m.content === 'Normal reply');
        expect(normalTurn.native_content_blocks).toHaveLength(2);

        const toolTurn = prepared.dispatchBody.messages.find(m => m.role === 'assistant' && String(m.content).includes('<Function_Hist_Start/>'));
        expect(toolTurn).toBeDefined();
        expect(toolTurn.native_content_blocks).toBeUndefined();
        expect(toolTurn.native_parts).toBeUndefined();
        expect(toolTurn.responses_output_items).toBeUndefined();
    });

    test('preparePlainTextToolRequest ignores removed prompt_json alias', () => {
        const prepared = preparePlainTextToolRequest({
            chat_completion_source: 'openai',
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'Hi' }],
            luker_plain_text_tools: {
                mode: 'prompt_json',
                tools: SAMPLE_TOOLS,
                toolChoice: 'auto',
            },
        });
        expect(prepared.active).toBe(false);
        expect(prepared.dispatchBody.luker_plain_text_tools).toBeUndefined();
    });

    test('runs plain-text expansion BEFORE custom_prompt_post_processing on Attempt 1 and retries, and omits empty assistant turn on retry', async () => {
        const trigger = '<Function_PostProc_Start/>';
        const receivedPayloads = [];
        const { postProcessPrompt, PROMPT_PROCESSING_TYPE } = await import('../src/prompt-converters.js');
        const { runLukerDispatch } = await import('../src/luker-dispatch/runner.js');
        const { getTaskByRequestId } = await import('../src/endpoints/backends/luker-generation.js');

        let attemptIdx = 0;
        const req = {
            headers: { 'x-luker-request-id': 'pt-postproc-order-1' },
            user: { profile: { handle: 'alice' }, directories: {} },
            body: {
                chat_completion_source: 'openai',
                model: 'gpt-4o',
                stream: false,
                custom_prompt_post_processing: PROMPT_PROCESSING_TYPE.MERGE,
                messages: [
                    { role: 'system', content: 'Base system.' },
                    { role: 'user', content: 'Check weather' },
                    {
                        role: 'assistant',
                        content: '',
                        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }],
                    },
                    { role: 'tool', tool_call_id: 'c1', content: 'Sunny 20C' },
                    { role: 'user', content: 'Now check Oslo' },
                ],
                luker_plain_text_tools: {
                    mode: 'prompt_xml',
                    tools: SAMPLE_TOOLS,
                    toolChoice: 'required',
                    triggerSignal: trigger,
                    retry: { enabled: true, maxAttempts: 2 },
                },
            },
        };
        const res = {
            status() { return this; },
            setHeader() {},
            json() {},
            send() {},
        };

        await runLukerDispatch(req, res, {
            endpoint: 'chat-completions',
            postProcessMessages: (msgs) => postProcessPrompt(msgs, PROMPT_PROCESSING_TYPE.MERGE),
            select: () => async (ctx) => {
                attemptIdx += 1;
                receivedPayloads.push(structuredClone(ctx.body.messages));
                const content = attemptIdx === 1
                    ? ''
                    : `${trigger}\n<function_calls><function_call><tool>get_weather</tool><args_json><![CDATA[{"city":"Oslo"}]]></args_json></function_call></function_calls>`;
                ctx.emit.head({ status: 200, headers: { 'content-type': 'application/json' } });
                ctx.emit.chunk(new TextEncoder().encode(JSON.stringify({
                    id: `cmpl_${attemptIdx}`,
                    object: 'chat.completion',
                    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
                })));
                ctx.emit.end();
            },
        });
        await new Promise(r => setTimeout(r, 60));

        expect(receivedPayloads).toHaveLength(2);
        // Attempt 1: tool history normalized into user message BEFORE MERGE, so no `role: 'tool'` survives and consecutive user turns merged.
        expect(receivedPayloads[0].some(m => m.role === 'tool')).toBe(false);
        expect(receivedPayloads[0].some(m => m.role === 'user' && String(m.content).includes('Sunny 20C') && String(m.content).includes('Now check Oslo'))).toBe(true);
        // Attempt 2: empty Attempt 1 assistant response omitted (no empty `{ role: 'assistant', content: '' }`), and MERGE applied cleanly once.
        expect(receivedPayloads[1].some(m => m.role === 'assistant' && m.content === '')).toBe(false);
        expect(receivedPayloads[1].at(-1).role).toBe('user');
        expect(String(receivedPayloads[1].at(-1).content)).toContain('Now check Oslo');

        const job = getTaskByRequestId('pt-postproc-order-1', 'alice');
        if (job?.persistenceTimer) { clearTimeout(job.persistenceTimer); job.persistenceTimer = null; }
        const metaEvt = job.events.find(e => e.data?.kind === 'meta' && e.data?.data?.plain_text_function_call?.status === 'parsed');
        expect(metaEvt).toBeDefined();
        expect(metaEvt.data.data.plain_text_function_call.attempt).toBe(2);
    });
});
