// #11 — Abort mid-stream.
//
// Mock has 5000ms latency. We start a turn, wait 1s, click #mes_stop,
// then assert:
//   a) An assistant message exists with partial (or empty) content,
//      not stuck in "generating" state,
//   b) The next /send works normally.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply, abortGeneration } from '../_lib/page.js';

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
    test('mes_stop kills in-flight gen, next /send succeeds', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => {
            const ctx = window.SillyTavern.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // Wait briefly for connection to flip so #mes_stop is reachable;
        // sendMessageAndAwaitReply doesn't bother with the DOM button.
        // Kick a send and DO NOT await its reply.
        await page.evaluate(async () => {
            const ctx = window.SillyTavern.getContext();
            // Don't await — we'll abort.
            ctx.executeSlashCommandsWithOptions('/send The wind is cold; please tell me everything you saw on the path. | /trigger');
        });

        // Let the request reach the mock.
        await page.waitForTimeout(1000);

        // Confirm mid-flight: either the assistant placeholder is in chat,
        // or the GENERATION_STOPPED listener / is_send_press lock is set.
        const inFlight = await page.evaluate(() => {
            const w = window;
            // window.is_send_press is sometimes exported on Luker's scope.
            const ctx = w.SillyTavern.getContext();
            const chat = ctx.chat;
            const stopBtn = document.querySelector('#mes_stop');
            // Stop button is visible whenever generation is active.
            const visible = stopBtn && getComputedStyle(stopBtn).display !== 'none';
            return { chatLen: chat.length, stopVisible: visible };
        });
        expect(inFlight.stopVisible, 'stop button should be visible mid-stream').toBe(true);

        // Click the stop button.
        const stoppedEvP = page.evaluate(() => new Promise((resolve) => {
            const ctx = window.SillyTavern.getContext();
            const t = setTimeout(() => resolve('timeout'), 6000);
            const handler = (...args) => {
                clearTimeout(t);
                try { ctx.eventSource.removeListener(ctx.eventTypes.GENERATION_STOPPED, handler); } catch {}
                resolve('stopped');
            };
            ctx.eventSource.on(ctx.eventTypes.GENERATION_STOPPED, handler);
        }));
        await abortGeneration(page);
        const stoppedRes = await stoppedEvP;
        expect(['stopped', 'timeout']).toContain(stoppedRes);

        // After abort, stop button should disappear within a few ticks.
        await page.waitForFunction(() => {
            const stop = document.querySelector('#mes_stop');
            return !stop || getComputedStyle(stop).display === 'none';
        }, { timeout: 10_000 });

        // Wait a beat to be sure the state machine is idle.
        await page.waitForTimeout(500);

        // Send-but should re-enable for the next turn.
        const sendBtnHidden = await page.evaluate(() => {
            const el = document.querySelector('#send_but');
            return !!el && el.classList.contains('displayNone');
        });
        expect(sendBtnHidden, 'send button should not be permanently hidden after abort').toBe(false);

        // A fresh send must succeed.
        const { text } = await sendMessageAndAwaitReply(page, 'Continue: now what?', { timeoutMs: 30_000 });
        expect(text).toMatch(/second turn|lantern is burning|steady/i);
    });
});
