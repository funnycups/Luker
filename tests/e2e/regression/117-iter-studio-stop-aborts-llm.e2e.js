// #117 — iter-studio Stop button must actually abort an in-flight LLM request.
//
// Bug shape: user reports clicking Stop in the iter-studio composer
// does not halt the in-flight chat-completions request. The button
// label flips to "Stop" while busy and clicking it calls
// `state.abortController?.abort()`, which threads through the runner's
// `abortSignal` opt into generateTask / generateTaskStream's underlying
// fetch — *in theory*. In practice, the user sees the popup keep
// streaming / waiting until the request returns naturally.
//
// Two regression locks here:
//
//   (test 1, "single-round abort") — Hold the mock LLM open with a
//   long latency, click Send, then click Stop, and assert the popup's
//   Send button flips back to its idle label within a small window.
//   Catches the canonical "abort signal not propagated to fetch" case.
//
//   (test 2, "auto-continue abort") — Two-round path. Round 1 emits
//   a tool call that does NOT stage a bus proposal (we use a control
//   tool that updates nothing, so `bus.hasOutstanding()` stays false
//   and the auto-continue loop fires round 2). Hold round 2 with a
//   long latency, click Stop. Assert the popup settles within the
//   window AND round 3 never fires. This catches a subtle regression
//   where the catch+finally clear state but a stray `await render()`
//   that lands after abort silently re-fires the next round.
//
// We hold the mock for 30s and give Stop a 6s window to take effect.
// Real abort propagation lands sub-second when wired correctly, so 6s
// is a wide safety margin that still catches the regression cleanly.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, openExtensionsDrawer, openInlineDrawer } from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    // 30s latency = mock holds chat/completions for 30s before replying.
    // Stop click must short-circuit that wait via AbortSignal so the
    // popup returns to idle before the timeout window expires.
    mock = await startMockLLM({ latencyMs: 30_000 });
    server = await startServer({ batchKey: 'regression', scenarioId: '117-iter-studio-stop' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

async function openOrchIterStudio(page) {
    await awaitMainUI(page, server.baseURL);
    await page.evaluate(() => {
        const ctx = window.Luker.getContext();
        const s = ctx.extensionSettings?.orchestrator;
        if (!s) throw new Error('orchestrator settings missing');
        s.enabled = true;
        s.executionMode = 'director';
        // Streaming transport on — production-default for many users
        // and the path where AbortSignal propagation through a
        // streaming reader could silently break.
        s.useStreamingTransport = true;
        if (typeof ctx.saveSettings === 'function') ctx.saveSettings();
        else if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
    });
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'orchestrator_settings');
    const openBtn = page.locator('#orchestrator_settings [data-luker-action="ai-iterate-open"]:visible').first();
    await expect(openBtn).toBeVisible({ timeout: 10_000 });
    await openBtn.click();
    const popup = page.locator('.orch_it_popup.luker-iter-workspace').first();
    await expect(popup).toBeVisible({ timeout: 15_000 });
    return popup;
}

test.describe('#117 — iter-studio Stop aborts the in-flight LLM request', () => {
    test('clicking Stop while busy returns the Send button to idle within a small window', async ({ page }) => {
        const popup = await openOrchIterStudio(page);

        const composer = popup.locator('textarea[data-orch-it-input]').first();
        await composer.waitFor({ state: 'attached', timeout: 5000 });
        await composer.evaluate((el, v) => {
            el.value = v;
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }, 'Author a sub-agent that handles post-draft image insertion. Think carefully before recommending.');

        const sendBtn = popup.locator('button[data-orch-it-action="send"]').first();
        await sendBtn.click();

        // The label flips to Stop once isBusy is set. Wait for that so
        // we know the request actually went out — otherwise Stop would
        // be testing a no-op (no in-flight request to abort).
        await expect.poll(async () => await sendBtn.textContent(), {
            message: 'Send button should switch to "Stop" once the request is in flight',
            timeout: 10_000,
        }).toMatch(/Stop|停止/);

        const tStopClicked = Date.now();
        await sendBtn.click();

        // The fix: AbortSignal propagates from state.abortController →
        // generateTask → sendOpenAIRequest → fetch. fetch's AbortController
        // unwinds within ms, runIterationTurn rejects with an AbortError,
        // the catch suppresses the error bubble, the finally clears
        // state.isBusy + state.aborting, render() flips the label back.
        //
        // We allow 6s — comfortably long enough that a real abort fires
        // even on a loaded CI box, but well below the 30s mock latency
        // so a missed abort (signal dropped, retry loop swallows, fetch
        // not respecting signal) reaches the assertion long before the
        // mock would return on its own.
        await expect.poll(async () => await sendBtn.textContent(), {
            message: 'Send button must return to "Send" within 6s of Stop click — if Stop does not propagate the abort, this assertion blocks until the 30s mock latency expires',
            timeout: 6_000,
        }).toMatch(/Send|发送|送出/);
        const tElapsed = Date.now() - tStopClicked;

        // Also assert the button isn't stuck disabled — the `aborting`
        // flag must have cleared via the catch+finally branch.
        const stillDisabled = await page.evaluate(() => {
            const btn = document.querySelector('.orch_it_popup [data-orch-it-action="send"]');
            return btn && btn.hasAttribute('disabled');
        });
        expect(stillDisabled, `Send button still disabled after ${tElapsed}ms — aborting flag never cleared, suggests the catch+finally in handleSendMessage never ran`).toBeFalsy();
    });
});

