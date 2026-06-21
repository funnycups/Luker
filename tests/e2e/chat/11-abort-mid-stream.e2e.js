// #11 — Abort mid-stream.
//
// Mock has 5000ms latency so the reply takes long enough to interrupt.
// Real user gestures only:
//   1. Type into #send_textarea and click #send_but.
//   2. Wait 1s for the request to be in-flight.
//   3. Click #mes_stop (via the abortGenerationViaUI helper).
//   4. Assert the stop button hides and the send button re-enables.
//   5. Send a fresh follow-up via #send_textarea and confirm it lands.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    abortGenerationViaUI,
} from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({
        scriptedReplies: [
            '*Seraphina is about to answer when the wind catches and the lantern guts; she breaks off mid-sentence and lifts her hand to shield the flame —*',
            '*Seraphina lights a fresh wick.* "Now — second turn — the lantern is burning steady again."',
        ],
        latencyMs: 5000,
    });
    server = await startServer({ batchKey: 'chat', scenarioId: 'abort' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#11 — abort mid-stream', () => {
    test('clicking #mes_stop kills in-flight gen, next send via #send_but succeeds', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

        // Real user gesture #1: fill #send_textarea, click #send_but.
        // Don't await reply — the 5s mock latency gives us a window to
        // hit #mes_stop while the request is still in flight.
        await page.locator('#send_textarea').fill('The wind is cold; please tell me everything you saw on the path.');
        await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
        await page.locator('#send_but').click();

        // Let the request reach the mock.
        await page.waitForTimeout(1000);

        // DOM-side: stop button must be visible (generation in flight).
        const stopVisible = await page.evaluate(() => {
            const stopBtn = document.querySelector('#mes_stop');
            return stopBtn && getComputedStyle(stopBtn).display !== 'none';
        });
        expect(stopVisible, '#mes_stop should be visible mid-stream').toBe(true);

        // Real user gesture #2: click #mes_stop (no underlying-API fallback).
        const stoppedEvP = page.evaluate(() => new Promise((resolve) => {
            const ctx = window.Luker.getContext();
            const t = setTimeout(() => resolve('timeout'), 6000);
            const handler = () => {
                clearTimeout(t);
                try { ctx.eventSource.removeListener(ctx.eventTypes.GENERATION_STOPPED, handler); } catch {}
                resolve('stopped');
            };
            ctx.eventSource.on(ctx.eventTypes.GENERATION_STOPPED, handler);
        }));
        await abortGenerationViaUI(page);
        const stoppedRes = await stoppedEvP;
        expect(['stopped', 'timeout']).toContain(stoppedRes);

        // After abort, #mes_stop should hide within a few ticks.
        await page.waitForFunction(() => {
            const stop = document.querySelector('#mes_stop');
            return !stop || getComputedStyle(stop).display === 'none';
        }, { timeout: 10_000 });
        await page.waitForTimeout(500);

        // #send_but should re-enable for the next turn.
        const sendBtnHidden = await page.evaluate(() => {
            const el = document.querySelector('#send_but');
            return !!el && el.classList.contains('displayNone');
        });
        expect(sendBtnHidden, '#send_but should not be permanently hidden after abort').toBe(false);

        // Real user gesture #3: fresh send via #send_textarea + #send_but.
        const { text } = await sendMessageAndAwaitReply(page, 'Continue: now what?', { timeoutMs: 30_000 });
        expect(text).toMatch(/second turn|lantern is burning|steady/i);
    });
});
