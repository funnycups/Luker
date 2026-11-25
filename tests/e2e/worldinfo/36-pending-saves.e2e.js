// tests/e2e/worldinfo/36-pending-saves.e2e.js
//
// A debounced save for one book must survive an immediate save of another
// book. The old scheduler kept one global debounce slot and cancelled it
// before every immediate save, so editing book B and then deleting an entry
// in book A dropped B's pending write. This drives both actions through the
// real editor and asserts the second book lands on disk after the debounce.

import { test, expect } from '../../harness/playwright.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, writeWorldBook } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { openWorldInfoDrawer } from '../_lib/ui-worldinfo.js';

let server, mock;

const BOOK_A = 'pending-save-a';
const BOOK_B = 'pending-save-b';

function readBook(name) {
    return JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'worlds', `${name}.json`), 'utf8'));
}

async function selectBook(page, name, uid, comment) {
    await openWorldInfoDrawer(page);
    const select = page.locator('#world_editor_select');
    await select.waitFor({ state: 'visible', timeout: 5000 });
    await select.selectOption({ label: name });
    await expect(page.locator(`#world_popup_entries_list .world_entry[uid="${uid}"] textarea[name="comment"]`))
        .toHaveValue(comment, { timeout: 10_000 });
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM();
    server = await startServer({ scope, batchKey: 'worldinfo', scenarioId: 'cross-book' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    writeWorldBook({
        dataRoot: server.dataRoot,
        name: BOOK_A,
        entries: [
            { key: ['a-keep'], comment: 'a-keep', content: 'A keep' },
            { key: ['a-delete'], comment: 'a-delete', content: 'A delete' },
        ],
    });
    writeWorldBook({
        dataRoot: server.dataRoot,
        name: BOOK_B,
        entries: [
            { key: ['b'], comment: 'b', content: 'B original' },
        ],
    });
});

test.afterAll(async () => {
    await mock?.stop();
});

test.describe('World info pending save survives another book saving immediately', () => {
    test.setTimeout(120_000);

    test('flushes the pending book after an immediate save of another book', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Leave a debounced save pending on B.
        await selectBook(page, BOOK_B, '0', 'b');
        const bRow = page.locator('#world_popup_entries_list .world_entry[uid="0"]');
        const bContent = bRow.locator('textarea[name="content"]').first();
        if (!(await bContent.isVisible())) {
            await bRow.locator('.wi-entry-toggle').click();
        }
        await bContent.fill('B edited while pending');
        await bContent.blur();

        // Switch to A and delete an entry. This path saves A immediately and
        // used to cancel every pending debounced save.
        await selectBook(page, BOOK_A, '1', 'a-delete');

        // The precondition is load-bearing: if B's debounce already fired,
        // the test can no longer prove the immediate save cancelled it.
        expect(readBook(BOOK_B).entries['0'].content).toBe('B original');

        const deleteButton = page.locator('#world_popup_entries_list .world_entry[uid="1"] .delete_entry_button');
        await deleteButton.click({ force: true });
        const popup = page.locator('.popup:visible').last();
        await popup.waitFor({ state: 'visible', timeout: 5000 });
        await popup.locator('.popup-button-ok').first().click();
        await popup.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});

        // A's immediate save completed.
        await expect.poll(() => Object.keys(readBook(BOOK_A).entries).length, { timeout: 10_000 }).toBe(1);
        expect(readBook(BOOK_A).entries['1']).toBeUndefined();

        // B's pending save must still flush after the debounce.
        await expect.poll(() => readBook(BOOK_B).entries['0'].content, { timeout: 10_000 })
            .toBe('B edited while pending');
    });
});
