// #117 — iter-studio Stop button must actually abort an in-flight LLM request.
//
// Bug shape: user reports clicking Stop in the iter-studio composer
// does not halt the in-flight chat-completions request. The button
// label flips to "Stop" while busy and clicking it calls
// `state.abortController?.abort()`, which threads through the runner's
// `abortSignal` opt into generateTask / generateTaskStream's underlying
// fetch. In practice the popup keeps streaming until the request returns
// naturally.
//
// REAL USER FLOW: hold the mock LLM open with a long latency, click
// Send, then click Stop. Assert the popup's Send button flips back to
// its idle label within a small window. Catches the canonical "abort
// signal not propagated to fetch" case.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, openExtensionsDrawer, openInlineDrawer } from '../_lib/page.js';

let server, mock;

async function setOrchModeToDirector(page) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'orchestrator_settings').catch(() => {});
    const modeSelect = page.locator('#luker_orch_execution_mode');
    await modeSelect.waitFor({ state: 'visible', timeout: 10_000 });
    if ((await modeSelect.inputValue()) !== 'director') {
        await modeSelect.selectOption('director');
        await modeSelect.evaluate(el => {
            el.dispatchEvent(new Event('change', { bubbles: true }));
            if (window.jQuery) window.jQuery(el).trigger('change');
        });
        await page.waitForFunction(() => {
            const board = document.querySelector('#luker_orch_director_board');
            return board && board.offsetParent !== null;
        }, { timeout: 5000 });
    }
    // Flip the Enabled checkbox via the real settings panel — no
    // internal-state mutation. The drawer is already open (we just
    // toggled execution mode above), so the checkbox is visible.
    // bootstrapCustomBackend already cleared requestApi/LlmPresetName
    // and set oai_settings.stream_openai = true, so the streaming
    // dispatcher path the bug requires is already armed.
    const enabled = page.locator('#luker_orch_enabled');
    await enabled.waitFor({ state: 'visible', timeout: 5000 });
    if (!(await enabled.isChecked())) {
        await enabled.check();
    }
}

async function openOrchIterStudio(page) {
    const openBtn = page.locator('#luker_orch_director_board [data-luker-action="ai-iterate-open"]:visible').first();
    await openBtn.waitFor({ state: 'visible', timeout: 15_000 });
    await openBtn.click();
    const sendBtn = page.locator('[data-orch-it-action="send"]').last();
    await sendBtn.waitFor({ state: 'visible', timeout: 15_000 });
}

test.beforeAll(async () => {
    // 30s latency: mock holds chat/completions for 30s before replying.
    // Stop click must short-circuit that wait via AbortSignal.
    mock = await startMockLLM({ latencyMs: 30_000 });
    server = await startServer({ batchKey: 'regression', scenarioId: '117-iter-studio-stop', extraConfig: { 'storage.mode': 'fs' } });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#117 — iter-studio Stop aborts the in-flight LLM request', () => {
    test('clicking Stop while busy returns the Send button to idle within a small window', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await setOrchModeToDirector(page);

        await openOrchIterStudio(page);
        const popup = page.locator('.popup:visible:has(.orch_it_popup)').last();

        const composer = popup.locator('textarea[data-orch-it-input]').first();
        await composer.waitFor({ state: 'attached', timeout: 5000 });
        await composer.fill('Author a sub-agent that handles post-draft image insertion. Think carefully before recommending.');

        const sendBtn = popup.locator('button[data-orch-it-action="send"]').first();
        await sendBtn.click();

        // Wait for the label to flip to Stop so we know the request is
        // in flight (otherwise Stop is testing a no-op).
        await expect.poll(async () => await sendBtn.textContent(), {
            message: 'Send button should switch to "Stop" once the request is in flight',
            timeout: 10_000,
        }).toMatch(/Stop|停止/);

        const tStopClicked = Date.now();
        await sendBtn.click();

        // The fix: AbortSignal propagates from state.abortController →
        // generateTask → sendOpenAIRequest → fetch. We allow 6s — well
        // below the 30s mock latency, so a missed abort blocks until the
        // assertion fires rather than masquerading as a slow success.
        await expect.poll(async () => await sendBtn.textContent(), {
            message: 'Send button must return to "Send" within 6s of Stop click — if Stop does not propagate the abort, this assertion blocks until the 30s mock latency expires',
            timeout: 6_000,
        }).toMatch(/Send|发送|送出/);
        const tElapsed = Date.now() - tStopClicked;

        // The button isn't stuck disabled — `aborting` cleared via catch+finally.
        const stillDisabled = await sendBtn.evaluate(el => el.hasAttribute('disabled'));
        expect(stillDisabled,
            `Send button still disabled after ${tElapsed}ms — aborting flag never cleared, suggests the catch+finally in handleSendMessage never ran`,
        ).toBeFalsy();
    });
});
