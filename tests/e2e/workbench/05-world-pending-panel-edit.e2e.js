// tests/e2e/workbench/05-world-pending-panel-edit.e2e.js
//
// A world book edit typed in the World Info panel and a Workbench edit to
// another entry must both land. The panel keeps its change in memory until
// the debounced save runs, so the Workbench read has to use that in-memory
// book; reading the file on disk would either refuse the write or discard
// the panel edit.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import {
    bootstrapCustomBackend,
    appendConnectionProfile,
    markOnboarded,
    writeWorldBook,
} from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { disableTagImportPopup, writeEmbeddedCharacter } from '../character/_helpers.js';
import { normalizeIterStudioSettings } from '../preset/_helpers.js';
import { openWorldInfoDrawer, selectWorldBook } from '../_lib/ui-worldinfo.js';
import {
    applyIterateChanges,
    closeWorkbench,
    openWorkbench,
    openWorkbenchIterate,
    sendIteratePrompt,
} from '../_lib/ui-workbench.js';

let server, mock;

const BOOK_NAME = 'PendingPanelBook';
const CHARACTER_NAME = 'Panel Pending';

function readWorldBook(dataRoot) {
    return JSON.parse(readFileSync(resolve(dataRoot, 'default-user', 'worlds', `${BOOK_NAME}.json`), 'utf8'));
}

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'workbench',
        scenarioId: '05-world-pending-panel-edit',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    normalizeIterStudioSettings(server.dataRoot);
    disableTagImportPopup({ dataRoot: server.dataRoot });

    writeWorldBook({
        dataRoot: server.dataRoot,
        name: BOOK_NAME,
        entries: [
            { key: ['alpha'], content: 'Alpha original', comment: 'Alpha' },
            { key: ['beta'], content: 'Beta original', comment: 'Beta' },
        ],
    });
    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: 'panel-pending.png',
        overrides: {
            name: CHARACTER_NAME,
            extensions: { world: BOOK_NAME },
        },
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('World book edit pending in the panel and a Workbench edit', () => {
    test.setTimeout(240_000);

    test('both entries land while the panel save is still in flight', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, CHARACTER_NAME);

        const panelText = 'Alpha edited in the panel.';
        const aiText = 'Beta revised by the workbench.';

        mock.scriptCompletion((req) => {
            if (req.turn === 0) {
                return {
                    toolCalls: [{
                        name: 'cea_update_lorebook_entry',
                        arguments: { book_name: BOOK_NAME, uid: 1, patch: { content: aiText } },
                    }],
                };
            }
            return { text: 'Updated Beta.' };
        });

        await openWorkbenchIterate(page, 'world', { scope: 'character' });
        await sendIteratePrompt(page, 'Revise Beta.');
        mock.clearScriptedCompletion();

        // Fold the window so the World Info drawer is reachable, then reopen
        // it with the staged draft still in place.
        await closeWorkbench(page);

        // Hold the first world book save so the panel edit stays in memory
        // while Workbench reads the book.
        let release;
        const gate = new Promise((resolveGate) => { release = resolveGate; });
        let markHeld;
        const held = new Promise((resolveHeld) => { markHeld = resolveHeld; });
        let patchCount = 0;
        await page.route('**/api/worldinfo/patch', async (route) => {
            patchCount += 1;
            if (patchCount === 1) {
                markHeld();
                await gate;
            }
            await route.continue();
        });

        await openWorldInfoDrawer(page);
        await selectWorldBook(page, BOOK_NAME);
        const entry = page.locator('#world_popup_entries_list .world_entry[uid="0"]');
        await entry.waitFor({ state: 'visible', timeout: 10_000 });
        const content = entry.locator('textarea[name="content"]').first();
        if (!(await content.isVisible())) {
            await entry.locator('.wi-entry-toggle').first().click();
        }
        await content.fill(panelText);
        await content.blur();

        await held;

        const drawerIcon = page.locator('#WIDrawerIcon');
        if (!(await drawerIcon.evaluate(el => el.classList.contains('closedIcon')))) {
            await drawerIcon.click();
        }
        await openWorkbench(page);

        const applying = applyIterateChanges(page);
        await page.waitForTimeout(500);
        release();
        await applying;

        await expect.poll(() => readWorldBook(server.dataRoot).entries['0'].content, { timeout: 10_000 })
            .toBe(panelText);
        await expect.poll(() => readWorldBook(server.dataRoot).entries['1'].content, { timeout: 10_000 })
            .toBe(aiText);
        await closeWorkbench(page);
    });
});
