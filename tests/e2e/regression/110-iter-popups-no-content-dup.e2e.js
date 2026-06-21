// #110 — re-opening an iter-studio does not duplicate session-history items
//
// Bug shape (sibling to the dedup hint #110 stem): when the iter-studio
// popup is opened, closed, then re-opened in the same page session, the
// history rail should list each persisted session exactly once. A
// regression in the session-store dedupe / hydrate path would re-append
// the same session every time the popup mounts.
//
// REAL USER FLOW: open the iter-studio, send a prompt to script ONE
// session into history. Close the popup. Re-open it. Count the items
// in the history rail — must equal 1, not 2.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, openExtensionsDrawer, openInlineDrawer } from '../_lib/page.js';

let server, mock;

// Local inline helpers — iter-studio helpers in _lib/ are stale (see #109).

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
    // bootstrapCustomBackend already cleared requestApi/LlmPresetName.
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

async function sendOrchIterPromptAndAwaitProposal(page, text) {
    const popup = page.locator('.popup:visible').last();
    const composer = popup.locator('textarea[data-orch-it-input]').first();
    await composer.waitFor({ state: 'visible', timeout: 10_000 });
    await composer.fill(text);
    const sendBtn = popup.locator('button[data-orch-it-action="send"]').first();
    await sendBtn.click();
    const approveBtn = popup.locator('[data-proposal-action="approve"]').first();
    await approveBtn.waitFor({ state: 'visible', timeout: 60_000 });
}

async function closeIterStudioPopup(page) {
    const popup = page.locator('.popup:visible:has(.orch_it_popup)').last();
    const close = popup.locator('.popup-button-close').first();
    if (await close.isVisible({ timeout: 500 }).catch(() => false)) {
        await close.click();
    } else {
        await page.keyboard.press('Escape');
    }
    await popup.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
}

test.beforeAll(async () => {
    mock = await startMockLLM();
    server = await startServer({ batchKey: 'regression', scenarioId: '110-iter-popup-dup', extraConfig: { 'storage.mode': 'fs' } });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#110 — re-opening iter-studio does not duplicate session-history items', () => {
    test.setTimeout(120_000);

    test('opening the orch iter-studio twice in one page session lists each saved session exactly once', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await setOrchModeToDirector(page);

        // Round 1: open the studio, script a tool call so a real session
        // gets persisted (the studio only saves sessions that produced
        // output — a no-op session stays transient).
        mock.scriptToolCall({
            name: 'luker_orch_set_director_main_agent',
            arguments: { systemPrompt: '*Ash watches the reef.* Hold the in-scene voice.' },
        });
        await openOrchIterStudio(page);
        await sendOrchIterPromptAndAwaitProposal(page,
            'Update the director main agent to the cartographer voice.');

        // Open the history details so the items render.
        const popup1 = page.locator('.popup:visible').last();
        const history1 = popup1.locator('[data-orch-it-history]').first();
        if (!(await history1.evaluate(el => el.open).catch(() => false))) {
            await history1.locator('summary').first().click().catch(() => {});
        }

        await expect.poll(async () => {
            return await popup1.locator('.orch_it_history_item').count();
        }, {
            message: 'first session should land in history after the send',
            timeout: 15_000,
        }).toBeGreaterThanOrEqual(1);

        const firstOpenCount = await popup1.locator('.orch_it_history_item').count();

        await closeIterStudioPopup(page);

        // Round 2: re-open the SAME studio.
        await openOrchIterStudio(page);

        const popup2 = page.locator('.popup:visible').last();
        const history2 = popup2.locator('[data-orch-it-history]').first();
        if (!(await history2.evaluate(el => el.open).catch(() => false))) {
            await history2.locator('summary').first().click().catch(() => {});
        }

        await expect.poll(async () => {
            return await popup2.locator('.orch_it_history_item').count();
        }, {
            message: 'second open should rehydrate the same history',
            timeout: 10_000,
        }).toBeGreaterThanOrEqual(firstOpenCount);

        const secondOpenCount = await popup2.locator('.orch_it_history_item').count();

        expect(secondOpenCount,
            `re-opening the iter-studio must not duplicate history items; first=${firstOpenCount} second=${secondOpenCount}`,
        ).toBe(firstOpenCount);

        const idCounts = await popup2.locator('.orch_it_history_item').evaluateAll((items) => {
            const counts = new Map();
            for (const it of items) {
                const id = it.getAttribute('data-orch-it-id') || '';
                counts.set(id, (counts.get(id) || 0) + 1);
            }
            return Array.from(counts.entries());
        });
        for (const [id, count] of idCounts) {
            expect(count, `history item id="${id}" rendered ${count} times — must be exactly 1`).toBe(1);
        }
    });
});
