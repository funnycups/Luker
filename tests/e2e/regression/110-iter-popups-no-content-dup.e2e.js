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
import { awaitMainUI } from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { setOrchMode, setOrchEnabled } from '../_lib/ui-workbench.js';

let server, mock;

async function setOrchModeToDirector(page) {
    await setOrchMode(page, 'director');
    await setOrchEnabled(page, true);
}

async function openOrchIterStudio(page) {
    await openIterStudio(page, 'orch', { scope: 'global' });
}

async function sendOrchIterPromptAndAwaitProposal(page, text) {
    await sendIterPrompt(page, 'orch', text);
}

async function closeIterStudioPopup(page) {
    await closeIterStudio(page);
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

        const win1 = page.locator('.wbench .wb-win').first();
        await expect.poll(async () => {
            return await win1.locator('aside.wb-sess .wb-sess-item').count();
        }, {
            message: 'first session should land in Workbench sidebar after the send',
            timeout: 15_000,
        }).toBeGreaterThanOrEqual(1);

        const firstOpenCount = await win1.locator('aside.wb-sess .wb-sess-item').count();

        await closeIterStudioPopup(page);

        // Round 2: re-open Workbench AI Iteration (`orch`).
        await openOrchIterStudio(page);

        const win2 = page.locator('.wbench .wb-win').first();
        await expect.poll(async () => {
            return await win2.locator('aside.wb-sess .wb-sess-item').count();
        }, {
            message: 'second open should rehydrate the same history',
            timeout: 10_000,
        }).toBeGreaterThanOrEqual(firstOpenCount);

        const secondOpenItems = win2.locator('aside.wb-sess .wb-sess-item');

        await expect(secondOpenItems,
            `re-opening Workbench must not duplicate session items; first=${firstOpenCount}`,
        ).toHaveCount(firstOpenCount);

        const titleCounts = await secondOpenItems.evaluateAll((items) => {
            const counts = new Map();
            for (const it of items) {
                const label = (it.querySelector('.wb-sess-t')?.textContent || it.textContent || '').trim();
                counts.set(label, (counts.get(label) || 0) + 1);
            }
            return Array.from(counts.entries());
        });
        for (const [label, count] of titleCounts) {
            expect(count, `session item "${label}" rendered ${count} times — must be exactly 1`).toBe(1);
        }
    });
});
