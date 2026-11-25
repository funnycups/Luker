// #115 — The MG schema studio and the CEA editor studio mark the previewed
// target of a pending proposal before it is approved.
//
// REAL USER-GESTURE flow per studio:
//   1. Open the studio through its settings panel button.
//   2. Send a prompt. The mock LLM answers with edit tool calls: a new
//      column on the first existing node type, or a new card description
//      plus an Eldoria entry rewrite.
//   3. The proposal cards render with Approve buttons, and the preview pane
//      marks the edited node type row, card field and lorebook entry.

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { normalizeIterStudioSettings } from '../preset/_helpers.js';

let server, mock;

const NEW_COLUMN = 'lantern_hour';
const NEW_DESCRIPTION = 'Seraphina keeps a ledger of every traveller the glade has sheltered, written in moss-green ink.';
const NEW_ENTRY_CONTENT = 'The Eldoria wood shelters travellers; Seraphina records each one in her moss-green ledger.';

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope,
        batchKey: 'iterstudio',
        scenarioId: '115-workspace-preview-pending',
        extraConfig: { storage: { mode: 'fs' } },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    normalizeIterStudioSettings(server.dataRoot);
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#115 — iter-studio preview marks the pending change', () => {
    test('MG schema studio marks the edited node type row', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        const firstType = await page.evaluate(() => {
            const schema = window.Luker.getContext().extensionSettings?.memory_graph?.nodeTypeSchema;
            return Array.isArray(schema) && schema.length ? JSON.parse(JSON.stringify(schema[0])) : null;
        });
        expect(firstType?.id, 'default schema has a node type').toBeTruthy();
        await openIterStudio(page, 'mg');

        const popup = page.locator('.wbench .wb-win');
        const label = String(firstType.name || firstType.label || firstType.id);
        const row = popup.locator('.wb-iter-preview .wb-mg-preview-type', { hasText: label }).first();
        await expect(row).toBeVisible();
        await expect(row).not.toHaveClass(/is-change/);

        const edited = { id: firstType.id, tableColumns: [...(firstType.tableColumns || []), NEW_COLUMN] };
        mock.scriptToolCall({ name: 'mg_schema_set_node_type', arguments: { node_type: edited } });
        await sendIterPrompt(page, 'mg', `Track the lantern hour on every ${label} record of the night watch.`);

        await expect(row).toHaveClass(/is-change/, { timeout: 15_000 });
        await expect(row).toContainText(NEW_COLUMN);
        await closeIterStudio(page);
    });

    test('CEA editor studio marks the edited card field and lorebook entry', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await openIterStudio(page, 'cea');
        mock.scriptCompletion(({ turn }) => (turn === 0
            ? {
                toolCalls: [
                    { name: 'cea_set_card_field', arguments: { field: 'description', value: NEW_DESCRIPTION } },
                    { name: 'cea_update_lorebook_entry', arguments: { book_name: 'Eldoria', uid: 0, patch: { content: NEW_ENTRY_CONTENT } } },
                ],
            }
            : { text: 'Both edits are ready for review.' }));
        await sendIterPrompt(page, 'cea', 'Mention the ledger of travellers Seraphina keeps, and note it in the Eldoria entry.');

        const popup = page.locator('.wbench .wb-win');
        const preview = popup.locator('.wb-iter-preview');
        await expect(popup.locator('.wb-chg.is-pending .wb-chg-line')).toHaveCount(2);
        const description = preview.locator('[data-card-field="description"]');
        await expect(description).toHaveClass(/is-change/, { timeout: 15_000 });
        await description.locator('> summary').click();
        await expect(description.locator('pre')).toHaveText(NEW_DESCRIPTION);
        const book = preview.locator('[data-worldbook="Eldoria"]');
        await book.locator('> summary').click();
        const entry = book.locator('[data-entry-uid="0"]');
        await expect(entry).toHaveClass(/is-change/);
        await expect(book.locator('.is-change')).toHaveCount(1);
        await expect(entry).toContainText('#0');
        await expect(entry.locator('pre')).toHaveText(NEW_ENTRY_CONTENT);
        await closeIterStudio(page);
    });
});
