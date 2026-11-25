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

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { openIterStudio } from '../_lib/ui-iter-studio.js';
import { setOrchMode, setOrchEnabled } from '../_lib/ui-workbench.js';

let server, mock;

async function setOrchModeToDirector(page) {
    await setOrchMode(page, 'director');
    await setOrchEnabled(page, true);
}

async function openOrchIterStudio(page) {
    await openIterStudio(page, 'orch', { scope: 'global' });
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    // 30s latency: mock holds chat/completions for 30s before replying.
    // Stop click must short-circuit that wait via AbortSignal.
    mock = await startMockLLM({ latencyMs: 30_000 });
    server = await startServer({ scope, batchKey: 'regression', scenarioId: '117-iter-studio-stop', extraConfig: { storage: { mode: 'fs' } } });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#117 — iter-studio Stop aborts the in-flight LLM request', () => {
    test('clicking Stop while busy returns the Send button to idle within a small window', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await setOrchModeToDirector(page);

        await openOrchIterStudio(page);
        const win = page.locator('.wbench .wb-win').first();

        const composer = win.locator('.wb-composer textarea.wb-input').first();
        await composer.waitFor({ state: 'attached', timeout: 5000 });
        await composer.fill('Author a sub-agent that handles post-draft image insertion. Think carefully before recommending.');

        const sendBtn = win.locator('.wb-composer button.wb-send').first();
        await sendBtn.click();

        // Wait for the live Stop button inside `.wb-reads.is-live` so we know
        // the request is in flight.
        const stopBtn = win.locator('.wb-msg-ai:has(.wb-reads.is-live) button').first();
        await expect(stopBtn).toBeVisible({ timeout: 10_000 });

        const tStopClicked = Date.now();
        await stopBtn.click();

        // AbortSignal propagates to fetch — well below 30s mock latency.
        await expect(win.locator('.wb-reads.is-live')).toHaveCount(0, { timeout: 6_000 });
        await expect(sendBtn).toBeEnabled({ timeout: 6_000 });
        const tElapsed = Date.now() - tStopClicked;

        const stillDisabled = await sendBtn.evaluate(el => el.hasAttribute('disabled'));
        expect(stillDisabled,
            `Send button still disabled after ${tElapsed}ms — aborting never cleared`,
        ).toBeFalsy();
    });
});
