// generation-basic #5 — plugin-issued generation requests.
//
// The transport-agnostic dispatch layer proxies every window.fetch to
// /api/backends/chat-completions/generate through ws-delivery. That proxy
// was written to serve the chat UI (Generate() → sendOpenAIRequest), but
// every plugin extension (memory-graph extraction, CEA, orchestrator,
// CPA, etc.) reaches the same endpoint via ChatCompletionService.sendRequest
// from public/scripts/custom-request.js — which internally calls
// `fetch('/api/backends/chat-completions/generate', ...)`. Because the
// proxy monkey-patches window.fetch globally, these plugin-issued calls
// MUST also work: HTTP 200 immediately, real payload delivered over
// ws-delivery, and the client-visible Response body must reconstitute
// the upstream reply (JSON for non-stream, SSE frames for stream).
//
// Both sub-scenarios are exercised in one run:
//   (a) non-stream — caller awaits `Response.json()` and expects the full
//       upstream chat-completion JSON.
//   (b) stream — caller pipes response.body through an SSE parser and
//       expects to receive every scripted chunk.
//
// The reply is asserted to have arrived via ws-delivery (a WebSocket to
// /api/ws-delivery was opened during the call). We also assert the
// x-luker-generation-id header rides on the initial HTTP response.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';

let server, mock;

// Two distinct payloads so we can prove the non-stream vs stream calls
// each received their own reply and not a leftover from the other.
const NONSTREAM_REPLY = 'This is a plugin-triggered non-stream reply.';
const STREAM_CHUNKS = ['plugin', 'stream', 'chunk', 'one', 'two', 'three'];
const STREAM_REPLY = STREAM_CHUNKS.join(' ');

test.beforeAll(async () => {
    mock = await startMockLLM({
        scriptedReplies: [NONSTREAM_REPLY, STREAM_REPLY],
        // Small drip so the stream case actually goes over multiple SSE
        // frames rather than a single burst; the ws-delivery contract is
        // "N chunks in → N chunks out" and we want that path exercised.
        streamChunkDelayMs: 30,
    });
    server = await startServer({ batchKey: 'generation', scenarioId: 'plugin-request' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test('generation-basic: plugin ChatCompletionService.sendRequest — non-stream + stream both routed via ws-delivery', async ({ page }) => {
    // Observe every WebSocket the page opens so we can prove the plugin
    // calls flowed over /api/ws-delivery. The ws-delivery client keeps a
    // single long-lived socket across all proxied fetches, so we don't
    // need per-request WS opens — we just need at least one.
    const wsOpens = [];
    page.on('websocket', (ws) => { wsOpens.push(ws.url()); });

    // Observe every /generate HTTP response so we can assert status 200
    // + x-luker-generation-id header on each plugin-issued call.
    const generateResponses = [];
    page.on('response', (resp) => {
        const url = resp.url();
        if (url.includes('/api/backends/chat-completions/generate')) {
            generateResponses.push({
                status: resp.status(),
                generationId: resp.headers()['x-luker-generation-id'] || '',
            });
        }
    });

    // Surface browser errors so a plugin-side JSON parse fail shows up in
    // the test log rather than being swallowed.
    page.on('console', (msg) => {
        if (msg.type() === 'error') console.log('[browser-error]', msg.text());
    });
    page.on('pageerror', (err) => console.log('[browser-pageerror]', err.message));

    await awaitMainUI(page, server.baseURL);

    // (a) NON-STREAM plugin call. ChatCompletionService.sendRequest with
    // extractData=true returns { content, reasoning } — we assert content
    // includes the scripted reply text. Custom URL is passed explicitly
    // in the payload because the plugin path doesn't rely on the active
    // oai_settings; every consumer builds its own request payload.
    const nonStreamResult = await page.evaluate(async ({ customUrl, model }) => {
        const { ChatCompletionService } = await import('/scripts/custom-request.js');
        try {
            const result = await ChatCompletionService.sendRequest({
                chat_completion_source: 'custom',
                custom_url: customUrl,
                model,
                messages: [{ role: 'user', content: 'Ping.' }],
                stream: false,
                max_tokens: 200,
            }, /* extractData */ true, new AbortController().signal);
            return { ok: true, result };
        } catch (err) {
            return { ok: false, error: String(err?.message || err) };
        }
    }, { customUrl: mock.baseURL, model: 'mock-gpt-4o' });

    expect(nonStreamResult.ok, `non-stream plugin call must not throw: ${nonStreamResult.error}`).toBe(true);
    expect(nonStreamResult.result?.content, `non-stream plugin reply must include scripted text; got: ${JSON.stringify(nonStreamResult.result)}`).toContain(NONSTREAM_REPLY);

    // (b) STREAM plugin call. sendRequest returns an async-generator
    // factory when stream:true — the caller invokes it and drains the
    // yielded { text, swipes, state } snapshots. We accumulate `text`
    // into a single string and assert every chunk word landed.
    const streamResult = await page.evaluate(async ({ customUrl, model }) => {
        const { ChatCompletionService } = await import('/scripts/custom-request.js');
        try {
            const generatorFactory = await ChatCompletionService.sendRequest({
                chat_completion_source: 'custom',
                custom_url: customUrl,
                model,
                messages: [{ role: 'user', content: 'Stream please.' }],
                stream: true,
                max_tokens: 200,
            }, /* extractData */ true, new AbortController().signal);
            if (typeof generatorFactory !== 'function') {
                return { ok: false, error: 'expected async-generator factory for stream:true' };
            }
            let finalText = '';
            for await (const snapshot of generatorFactory()) {
                finalText = String(snapshot?.text || '');
            }
            return { ok: true, text: finalText };
        } catch (err) {
            return { ok: false, error: String(err?.message || err) };
        }
    }, { customUrl: mock.baseURL, model: 'mock-gpt-4o' });

    expect(streamResult.ok, `stream plugin call must not throw: ${streamResult.error}`).toBe(true);
    for (const chunk of STREAM_CHUNKS) {
        expect(streamResult.text, `stream plugin reply missing chunk "${chunk}"; got: ${JSON.stringify(streamResult.text)}`).toContain(chunk);
    }

    // Both plugin calls must have produced a POST to /generate that
    // returned 200 + x-luker-generation-id. (The awaitMainUI call may
    // fire a probe /generate too — we just require our two calls are in
    // there.)
    expect(generateResponses.length, `expected at least 2 /generate responses; observed ${generateResponses.length}`).toBeGreaterThanOrEqual(2);
    for (const resp of generateResponses) {
        expect(resp.status, `every /generate response must be 200; got ${resp.status}`).toBe(200);
        expect(resp.generationId, 'every /generate response must carry x-luker-generation-id').toMatch(/^[0-9a-f-]{8,}/i);
    }

    // A WebSocket to /api/ws-delivery must have been opened. Without it
    // the ws-delivery-fed Response body could never have populated, so
    // both plugin assertions above prove the WS was there — but we make
    // the socket observation explicit to guard against a future
    // regression where the client fabricates the body some other way.
    const deliveryWs = wsOpens.find(u => u.includes('/api/ws-delivery'));
    expect(deliveryWs, `expected a ws to /api/ws-delivery; observed: ${JSON.stringify(wsOpens)}`).toBeTruthy();

    // The mock LLM should have logged two upstream calls — one per
    // plugin request. If the ws-delivery proxy short-circuited, we'd see
    // zero. If it double-dispatched, we'd see four.
    const chatCalls = mock.requests.filter(r => (r.url || '').includes('/chat/completions'));
    expect(chatCalls.length, `mock LLM should have received 2 plugin-triggered chat calls; got ${chatCalls.length}: ${JSON.stringify(chatCalls.map(c => c.url))}`).toBe(2);
});
