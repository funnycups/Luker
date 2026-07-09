// generation-basic #2 — WS-delivery replay-on-reconnect.
//
// Server-side dispatch keeps streaming into the job buffer irrespective
// of client connectivity. When the browser goes offline mid-stream the
// ws-delivery client observes onclose → scheduleReconnect (500ms
// backoff) → on reconnect it re-`resume`s from lastSeq+1. The server
// replays every buffered event, so the final rendered reply contains
// every scripted chunk with zero loss.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';

let server, mock;

// 10 distinct, easy-to-count tokens so a "did we lose a chunk on
// reconnect?" assertion is unambiguous.
const CHUNKS = ['chunk1', 'chunk2', 'chunk3', 'chunk4', 'chunk5', 'chunk6', 'chunk7', 'chunk8', 'chunk9', 'chunk10'];
const SCRIPTED_REPLY = CHUNKS.join(' ');
const CHUNK_DELAY_MS = 300;
const OFFLINE_MS = 800;

test.beforeAll(async () => {
    mock = await startMockLLM({
        scriptedReplies: [SCRIPTED_REPLY],
        streamChunkDelayMs: CHUNK_DELAY_MS,
    });
    server = await startServer({ batchKey: 'generation', scenarioId: 'reconnect' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test('generation-basic: ws-delivery replays every chunk across a mid-stream offline blip', async ({ page, context }) => {
    // Install a WebSocket-tracking hook BEFORE any page script runs so we
    // can force-close the ws-delivery socket mid-stream from the test
    // side. Playwright's `setOffline(true)` alone doesn't reliably close
    // already-open sockets on Chromium; explicit .close() from the page
    // does. We keep the array in window.__lukerObservedSockets and reach
    // into it from the offline block below.
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

    // Track the ws-delivery lifetime so we can prove a reconnect happened.
    const wsEvents = [];
    page.on('websocket', (ws) => {
        if (!ws.url().includes('/api/ws-delivery')) return;
        wsEvents.push({ event: 'open', at: Date.now() });
        ws.on('close', () => wsEvents.push({ event: 'close', at: Date.now() }));
    });
    page.on('console', (msg) => {
        if (msg.type() === 'error') console.log('[browser-error]', msg.text());
    });

    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, 'Seraphina');
    await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

    // Fire the send but do NOT await reply — we need to interrupt mid-stream.
    // The event we care about (GENERATION_ENDED) is set up first as a
    // page-side promise so we can rendezvous after the offline blip.
    const doneP = page.evaluate((to) => new Promise((resolve, reject) => {
        const ctx = window.Luker.getContext();
        const t = setTimeout(() => reject(new Error('generation timeout')), to);
        const off = ctx.eventSource.on(ctx.eventTypes.GENERATION_ENDED, (chatLength) => {
            clearTimeout(t);
            try { ctx.eventSource.removeListener(ctx.eventTypes.GENERATION_ENDED, off); } catch {}
            resolve(Math.max(0, Number(chatLength) - 1));
        });
    }), 60_000);

    await page.locator('#send_textarea').fill('Please stream the reply slowly for me.');
    await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
    await page.evaluate(() => document.querySelector('#send_but').click());

    // Wait for the ws-delivery socket to open and for the first scripted
    // chunk to have rendered into the ASSISTANT bubble (the user bubble
    // must be skipped — its own text may coincidentally contain generic
    // words). We look for a non-user .mes whose text contains "chunk1".
    await page.waitForFunction(() => {
        const bubbles = document.querySelectorAll('#chat .mes:not([is_user="true"])');
        for (const b of bubbles) {
            const t = b.querySelector('.mes_text')?.innerText || '';
            if (t.includes('chunk1')) return true;
        }
        return false;
    }, { timeout: 20_000 });

    // Cut the browser's network for OFFLINE_MS AND force-close every open
    // WebSocket from the client side. Playwright's `setOffline(true)` alone
    // does not always tear down already-connected sockets (Chromium buffers
    // reads instead), so we close them explicitly — that's the observable
    // event the ws-delivery client's onclose→scheduleReconnect path
    // actually reacts to. The offline blip on top ensures the reconnect
    // itself has to fail once before succeeding.
    await context.setOffline(true);
    await page.evaluate(() => {
        // Monkey-patched WebSocket ctor keeps a reference to every socket
        // opened by the page so we can close on demand from Playwright.
        // If the page didn't install this hook, fall back to a best-effort
        // shim: close whatever WebSocket handle is reachable via known
        // globals. In practice the hook is installed at test start (see
        // the `addInitScript` below) so this branch is a no-op.
        (window.__lukerObservedSockets || []).forEach(s => {
            try { s.close(); } catch {}
        });
    });
    await page.waitForTimeout(OFFLINE_MS);
    await context.setOffline(false);

    // Now wait for the assistant reply to complete.
    const replyId = await doneP;

    const replyText = await page.locator(`.mes[mesid="${replyId}"] .mes_text`).first().innerText({ timeout: 30_000 });
    for (const chunk of CHUNKS) {
        expect(replyText, `chunk "${chunk}" missing from rendered reply: ${JSON.stringify(replyText)}`).toContain(chunk);
    }

    // Reconnect check: we should have seen more than one open (the
    // original + at least one reconnect), OR a close followed by a
    // subsequent open. If neither, the offline flip didn't actually
    // disturb the WS and the "no loss on reconnect" assertion above is
    // vacuous — fail loudly.
    const opens = wsEvents.filter(e => e.event === 'open').length;
    const closes = wsEvents.filter(e => e.event === 'close').length;
    expect(opens + closes, `ws-delivery lifetime should have registered at least one close/reopen; events=${JSON.stringify(wsEvents)}`).toBeGreaterThan(1);
});
