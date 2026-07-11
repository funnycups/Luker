// generation-basic #3 — mid-stream abort via #mes_stop.
//
// User clicks the stop button while chunks are still landing:
//   - the ws-delivery fetch proxy POSTs `/api/generation/:id/abort`
//     as its side-effect on the caller-supplied AbortSignal
//   - #send_but re-enables, #mes_stop hides (no permanent hang)
//   - the assistant bubble keeps the partial reply already rendered
//   - no error toast is shown

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    abortGenerationViaUI,
} from '../_lib/page.js';

let server, mock;

// A slow drip so we have time to abort mid-stream and still see partial
// output in the assistant bubble.
const CHUNKS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const REPLY_TEXT = CHUNKS.join(' ');
const CHUNK_DELAY_MS = 300;

test.beforeAll(async () => {
    mock = await startMockLLM({
        scriptedReplies: [REPLY_TEXT],
        streamChunkDelayMs: CHUNK_DELAY_MS,
    });
    server = await startServer({ batchKey: 'generation', scenarioId: 'abort' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test('generation-basic: #mes_stop fires POST /api/generation/:id/abort, keeps partial reply, no error toast', async ({ page }) => {
    // Capture every POST to the abort endpoint AND its response so we can
    // assert (a) it fired and (b) server accepted it (not 403/401/404).
    const abortRequests = [];
    const abortResponses = [];
    page.on('request', (req) => {
        const url = req.url();
        if (url.includes('/api/generation/') && url.endsWith('/abort') && req.method() === 'POST') {
            abortRequests.push({ url, method: req.method() });
        }
    });
    page.on('response', async (resp) => {
        const url = resp.url();
        if (url.includes('/api/generation/') && url.endsWith('/abort')) {
            abortResponses.push({ url, status: resp.status() });
        }
    });

    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, 'Seraphina');
    await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

    // Fire the send but don't await reply — we intend to abort mid-flight.
    await page.locator('#send_textarea').fill('Please stream the reply slowly for me.');
    await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
    await page.evaluate(() => document.querySelector('#send_but').click());

    // Wait until at least the first scripted chunk is in the assistant
    // bubble. Only then is there something partial to preserve.
    await page.waitForFunction(() => {
        const bubbles = document.querySelectorAll('#chat .mes:not([is_user="true"])');
        for (const b of bubbles) {
            const t = b.querySelector('.mes_text')?.innerText || '';
            if (t.includes('first')) return true;
        }
        return false;
    }, { timeout: 20_000 });

    // Snapshot the partial text before we abort.
    const partialText = await page.evaluate(() => {
        const bubbles = document.querySelectorAll('#chat .mes:not([is_user="true"])');
        const last = bubbles[bubbles.length - 1];
        return last?.querySelector('.mes_text')?.innerText || '';
    });
    expect(partialText).toContain('first');
    expect(partialText.length).toBeGreaterThan(0);

    // Real user gesture: click #mes_stop.
    await abortGenerationViaUI(page);

    // #mes_stop hides.
    await page.waitForFunction(() => {
        const stop = document.querySelector('#mes_stop');
        return !stop || getComputedStyle(stop).display === 'none';
    }, { timeout: 10_000 });

    // #send_but re-enables.
    const sendReenabled = await page.evaluate(() => {
        const el = document.querySelector('#send_but');
        return !!el && !el.classList.contains('displayNone');
    });
    expect(sendReenabled, '#send_but should be re-enabled after abort').toBe(true);

    // Give the ws-delivery abort signal a beat to fire; the sendAbortNotification
    // is `try/catch` best-effort so it flushes very quickly.
    await page.waitForTimeout(500);

    // The abort HTTP notification must have gone out at least once.
    expect(abortRequests.length, `expected POST /api/generation/:id/abort to fire; observed=${JSON.stringify(abortRequests)}`).toBeGreaterThanOrEqual(1);
    // The URL shape must be /api/generation/<uuid>/abort — asserts the
    // request-id round-trip (header → client → notification path).
    expect(abortRequests[0].url).toMatch(/\/api\/generation\/[0-9a-f-]{8,}\/abort$/i);

    // Server MUST have accepted the abort. Any 4xx here is a regression:
    // - 401/403 → CSRF or auth middleware rejected the POST (headers bug)
    // - 404     → task lookup missed (owner or request_id mismatch)
    // Historically bug 9aa2c26dd caused 403 in production because the
    // notification skipped the CSRF header; this assertion locks it in.
    expect(abortResponses.length, 'server must respond to abort notification').toBeGreaterThanOrEqual(1);
    expect(abortResponses[0].status, `abort should return 2xx; got status=${abortResponses[0].status}`).toBeGreaterThanOrEqual(200);
    expect(abortResponses[0].status).toBeLessThan(300);

    // The partial reply that was already visible must still be visible.
    const postAbortText = await page.evaluate(() => {
        const bubbles = document.querySelectorAll('#chat .mes:not([is_user="true"])');
        const last = bubbles[bubbles.length - 1];
        return last?.querySelector('.mes_text')?.innerText || '';
    });
    expect(postAbortText, 'partial reply text should survive the abort').toContain('first');

    // No error toast surfaced. `toastr` renders into #toast-container; we
    // filter to error-severity toasts and require zero.
    const errorToasts = await page.evaluate(() => {
        const container = document.querySelector('#toast-container');
        if (!container) return [];
        return Array.from(container.querySelectorAll('.toast-error')).map(el => el.innerText.slice(0, 200));
    });
    expect(errorToasts, `expected no error toast after abort; got: ${JSON.stringify(errorToasts)}`).toEqual([]);
});
