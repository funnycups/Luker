// tests/e2e/workbench/03-world-book-after-panel-open.e2e.js
//
// A world book opened in the World Info panel before any chat uses it must
// still be editable from Workbench. The panel's render pass backfills entry
// template fields and `displayIndex`; those runtime-only fields must not leak
// into the shared read cache, or the next Workbench Apply refuses the write
// with "has unsaved edits in the world info panel".

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import {
    bootstrapCustomBackend,
    appendConnectionProfile,
    markOnboarded,
} from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { disableTagImportPopup } from '../character/_helpers.js';
import { normalizeIterStudioSettings } from '../preset/_helpers.js';
import { openWorldInfoDrawer, selectWorldBook } from '../_lib/ui-worldinfo.js';
import {
    applyIterateChanges,
    closeWorkbench,
    openWorkbenchIterate,
    sendIteratePrompt,
} from '../_lib/ui-workbench.js';

let server, mock;

const BOOK_NAME = 'Eldoria';

function readWorldBook(dataRoot) {
    return JSON.parse(readFileSync(resolve(dataRoot, 'default-user', 'worlds', `${BOOK_NAME}.json`), 'utf8'));
}

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'workbench',
        scenarioId: '03-world-book-after-panel-open',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    normalizeIterStudioSettings(server.dataRoot);
    disableTagImportPopup({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('World book edited in Workbench after the panel showed it', () => {
    test.setTimeout(240_000);

    test('applies the entry edit even though the panel rendered the book first', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Open the book in the World Info panel before any chat binds it, so
        // the panel is the first reader and its render pass fills the cache.
        await openWorldInfoDrawer(page);
        await selectWorldBook(page, BOOK_NAME);
        await page.locator('#world_popup_entries_list .world_entry').first().waitFor({ state: 'visible', timeout: 10_000 });

        const drawerIcon = page.locator('#WIDrawerIcon');
        if (!(await drawerIcon.evaluate(el => el.classList.contains('closedIcon')))) {
            await drawerIcon.click();
        }

        await selectCharacterByName(page, 'Seraphina');

        const beforeContent = readWorldBook(server.dataRoot)?.entries?.['0']?.content || '';
        const appended = `${beforeContent}\nSignal bell tolls twice at dusk.`;

        mock.scriptCompletion((req) => {
            if (req.turn === 0) {
                return {
                    toolCalls: [{
                        name: 'cea_update_lorebook_entry',
                        arguments: { book_name: BOOK_NAME, uid: 0, patch: { content: appended } },
                    }],
                };
            }
            return { text: 'Updated Eldoria entry 0.' };
        });

        await openWorkbenchIterate(page, 'world', { scope: 'character' });
        await sendIteratePrompt(page, 'Append the dusk signal bell note to Eldoria entry 0.');
        mock.clearScriptedCompletion();

        await applyIterateChanges(page);

        await expect.poll(() => readWorldBook(server.dataRoot)?.entries?.['0']?.content || '', { timeout: 10_000 })
            .toBe(appended);
        await closeWorkbench(page);
    });
});
