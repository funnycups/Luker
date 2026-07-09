// generation-basic #6 — plugin streaming call survives a mid-stream
// ws-delivery disconnect + reconnect with zero chunk loss.
//
// The ChatCompletionService.sendRequest(stream:true) plugin path lives
// on the same window.fetch → ws-delivery proxy as the chat UI. Every
// chunk yielded from its async-generator is fed by the ws-delivery
// ReadableStream, which the client side re-subscribes to on reconnect
// (resume {from_seq: lastSeq+1}). The server buffers every event on the
// job irrespective of client connectivity, so the replay MUST reproduce
// every scripted chunk end-to-end even when the WS is closed mid-stream
// and the browser has to reconnect.
//
// The plugin-consumed final `text` snapshot from the generator is what
// downstream consumers (memory-graph extraction, CEA, orchestrator, etc.)
// build their reply from — so the "no loss on reconnect" invariant is
// as important on the plugin path as it is on the chat-UI path.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';

let server, mock;

// 10 unique tokens so we can prove no chunk was dropped across the
// offline blip. 400ms between frames × 10 tokens ≈ 4s upstream time —
// plenty of room to interrupt after chunk 2-3 and still have half the
// stream to deliver post-reconnect.
const CHUNKS = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10'];
const SCRIPTED_REPLY = CHUNKS.join(' ');
const CHUNK_DELAY_MS = 400;
const OFFLINE_MS = 900;

test.beforeAll(async () => {
    mock = await startMockLLM({
        scriptedReplies: [SCRIPTED_REPLY],
        streamChunkDelayMs: CHUNK_DELAY_MS,
    });
    server = await startServer({ batchKey: 'generation', scenarioId: 'plugin-reconnect' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test('generation-basic: plugin stream call replays every chunk across a mid-stream ws-delivery reconnect', async ({ page, context }) => {
    // Install the WebSocket-tracking hook before any page script runs so
    // we can force-close the ws-delivery socket mid-stream from the test
    // side. Same pattern as the chat-UI reconnect spec — Playwright's
    // setOffline(true) alone doesn't reliably tear down already-open
    // sockets on Chromium; an explicit .close() from the page does.
    await context.addInitScript(() => {
        window.__lukerObservedSockets = [];
        const OrigWS = window.WebSocket;
        window.WebSocket = function PatchedWebSocket(...args) {
            const s = new OrigWS(...args);
            try { window.__lukerObservedSockets.push(s); } catch {}
            return s;
        };
        Object.setPrototypeOf(window.WebSocket, OrigWS);
        window.WebSocket.prototype = OrigWS.prototype;
        window.WebSocket.CONNECTING = OrigWS.CONNECTING;
        window.WebSocket.OPEN = OrigWS.OPEN;
        window.WebSocket.CLOSING = OrigWS.CLOSING;
        window.WebSocket.CLOSED = OrigWS.CLOSED;
    });

    // Track ws-delivery lifetime so we can prove a reconnect happened.
    const wsEvents = [];
    page.on('websocket', (ws) => {
        if (!ws.url().includes('/api/ws-delivery')) return;
        wsEvents.push({ event: 'open', at: Date.now() });
        ws.on('close', () => wsEvents.push({ event: 'close', at: Date.now() }));
    });
    page.on('console', (msg) => {
        if (msg.type() === 'error') console.log('[browser-error]', msg.text());
    });
    page.on('pageerror', (err) => console.log('[browser-pageerror]', err.message));

    await awaitMainUI(page, server.baseURL);

    // Kick off the plugin stream call in the background. The generator
    // is drained inside the page and its final `text` snapshot is
    // stashed on window.__pluginStreamResult so we can rendezvous with
    // it from the test side after the offline blip.
    //
    // We track incremental progress via window.__pluginStreamCount so
    // the outer test can wait until at least one chunk has landed
    // BEFORE cutting the WS — otherwise the whole stream could complete
    // before we get a chance to interrupt.
    await page.evaluate(({ customUrl, model }) => {
        window.__pluginStreamResult = null;
        window.__pluginStreamError = null;
        window.__pluginStreamCount = 0;
        window.__pluginStreamLastText = '';
        (async () => {
            try {
                const { ChatCompletionService } = await import('/scripts/custom-request.js');
                const generatorFactory = await ChatCompletionService.sendRequest({
                    chat_completion_source: 'custom',
                    custom_url: customUrl,
                    model,
                    messages: [{ role: 'user', content: 'Stream slowly, please.' }],
                    stream: true,
                    max_tokens: 200,
                }, /* extractData */ true, new AbortController().signal);
                if (typeof generatorFactory !== 'function') {
                    window.__pluginStreamError = 'expected async-generator factory';
                    return;
                }
                let text = '';
                for await (const snapshot of generatorFactory()) {
                    text = String(snapshot?.text || '');
                    window.__pluginStreamCount += 1;
                    window.__pluginStreamLastText = text;
                }
                window.__pluginStreamResult = { text };
            } catch (err) {
                window.__pluginStreamError = String(err?.message || err);
            }
        })();
    }, { customUrl: mock.baseURL, model: 'mock-gpt-4o' });

    // Wait until at least one chunk has landed. The generator yields
    // per-SSE-frame so window.__pluginStreamCount ≥ 1 means the
    // ws-delivery stream is live and delivering to the plugin caller.
    await page.waitForFunction(() => window.__pluginStreamCount > 0, { timeout: 15_000 });
    const preOfflineCount = await page.evaluate(() => window.__pluginStreamCount);
    const preOfflineText = await page.evaluate(() => window.__pluginStreamLastText);
    expect(preOfflineText, `should have some chunk text before we cut the WS; count=${preOfflineCount}`).toMatch(/c\d/);

    // Cut network + force-close every open WebSocket so the ws-delivery
    // client's onclose → scheduleReconnect path actually fires. The
    // offline blip on top ensures the reconnect itself has to fail once
    // before succeeding.
    await context.setOffline(true);
    await page.evaluate(() => {
        (window.__lukerObservedSockets || []).forEach(s => {
            try { s.close(); } catch {}
        });
    });
    await page.waitForTimeout(OFFLINE_MS);
    await context.setOffline(false);

    // Wait for the plugin generator to complete (or error).
    await page.waitForFunction(() => window.__pluginStreamResult !== null || window.__pluginStreamError !== null, { timeout: 60_000 });

    const result = await page.evaluate(() => ({
        result: window.__pluginStreamResult,
        error: window.__pluginStreamError,
        finalCount: window.__pluginStreamCount,
    }));
    expect(result.error, `plugin stream must not error: ${result.error}`).toBeFalsy();
    expect(result.result, `plugin stream must produce a final result; count=${result.finalCount}`).toBeTruthy();

    // The final accumulated text must contain every chunk word.
    for (const chunk of CHUNKS) {
        expect(result.result.text, `chunk "${chunk}" missing from plugin-consumed reply: ${JSON.stringify(result.result.text)}`).toContain(chunk);
    }

    // Reconnect check: we should have observed at least one close/reopen
    // beyond the initial open. If neither, the offline flip didn't
    // actually disturb the WS and the "no loss on reconnect" assertion
    // above is vacuous — fail loudly.
    const opens = wsEvents.filter(e => e.event === 'open').length;
    const closes = wsEvents.filter(e => e.event === 'close').length;
    expect(opens + closes, `ws-delivery lifetime should show at least one close/reopen; events=${JSON.stringify(wsEvents)}`).toBeGreaterThan(1);
});
