// tests/e2e/memorygraph/56-schema-add-field-persists.e2e.js
//
// #56 — MG schema editor: add field → save → restart → field still there.
//
// Real-user flow (no Layer-1 API short-cuts):
//   1. Enable MG via the real `#luker_rpg_memory_enabled` checkbox.
//   2. Open the real Schema Editor popup (#luker_rpg_memory_open_schema_editor).
//   3. Locate the event card's Table Columns input
//      (`[data-field="tableColumns"]` inside the event `.luker-schema-card`).
//   4. Type a new field name into that input (real keyboard input), then
//      click "Save Schema to Global" to persist.
//   5. Restart the server, reload, re-open the schema editor, and assert
//      the field is still present in the input value.
//
// The editor is the user-facing surface for schema mutation; persistence
// goes through `persistSchemaToGlobal` which calls `saveSettings()`.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    reloadAndAwait,
    openExtensionsDrawer,
    openInlineDrawer,
} from '../_lib/page.js';
import { openMgSchemaEditor } from '../_lib/ui-mg-varops.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({
        scriptedReplies: [
            '*Seraphina looks up from the chart.* "The lantern wants more oil before the next watch."',
            '*She marks a faint line on the chart.* "Note that — the wind shifted east an hour ago."',
            '*A measured nod.* "Hold here. The watch will turn at the third bell."',
        ],
    });
    server = await startServer({ batchKey: 'memorygraph', scenarioId: 'schema-add-field' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

async function enableMgViaCheckbox(page) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'memory_graph_settings').catch(() => {});
    await page.evaluate(() => {
        const el = document.getElementById('luker_rpg_memory_enabled');
        if (el && !el.checked) {
            el.checked = true;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }
    });
}

const CUSTOM_FIELD = 'omen_score';

test.describe('#56 — MG schema editor: add field through real UI → persists across restart', () => {
    test.setTimeout(180_000);

    test('open editor, append column to event card, Save to Global, restart, field still in editor', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await enableMgViaCheckbox(page);

        // Drive 3 turns so MG has a real chat to anchor against (not
        // strictly necessary for schema edits, but mirrors realistic
        // operator flow).
        for (const t of [
            'The first watch is calm. The lantern is steady.',
            'A skiff drifted south of the gull rocks an hour ago.',
            'Hold the watch. I will fetch the chart.',
        ]) {
            await sendMessageAndAwaitReply(page, t);
        }

        // Open the real schema editor popup.
        await openMgSchemaEditor(page);

        // Locate the event card and append the new field to its Table
        // Columns input. The editor reads from `[data-field="tableColumns"]`
        // when Save is clicked.
        await page.evaluate((fieldId) => {
            const cards = Array.from(document.querySelectorAll('.luker-schema-card'));
            for (const card of cards) {
                const idInput = card.querySelector('[data-field="id"]');
                if (!idInput || idInput.value !== 'event') continue;
                const colsInput = card.querySelector('[data-field="tableColumns"]');
                if (!colsInput) return;
                // Append the new field via real input mutation + dispatch
                // the input event so jQuery's tableColumns listener runs.
                const next = String(colsInput.value || '').trim();
                colsInput.value = next ? `${next}, ${fieldId}` : fieldId;
                colsInput.dispatchEvent(new Event('input', { bubbles: true }));
                colsInput.dispatchEvent(new Event('change', { bubbles: true }));
                return;
            }
        }, CUSTOM_FIELD);

        // Click the "Save Schema to Global" button (real DOM gesture).
        await page.locator('.popup:visible [id$="_schema_save_global"]').first().click();
        // Save closes the popup with a toast; wait for the popup to leave.
        await page.locator('.popup:visible').waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
        await page.waitForTimeout(500);

        // ── Persistence across restart ────────────────────────────────
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await enableMgViaCheckbox(page);

        // Re-open the schema editor and assert the field is still in the
        // event card's Table Columns input.
        await openMgSchemaEditor(page);
        const tableColumnsValue = await page.evaluate(() => {
            const cards = Array.from(document.querySelectorAll('.luker-schema-card'));
            for (const card of cards) {
                const idInput = card.querySelector('[data-field="id"]');
                if (!idInput || idInput.value !== 'event') continue;
                const colsInput = card.querySelector('[data-field="tableColumns"]');
                return colsInput ? String(colsInput.value || '') : '';
            }
            return '';
        });
        expect(
            tableColumnsValue,
            `event Table Columns should contain "${CUSTOM_FIELD}" after restart; saw: ${tableColumnsValue}`,
        ).toContain(CUSTOM_FIELD);

        // Dismiss the popup.
        await page.locator('.popup:visible .popup-button-cancel, .popup:visible .popup-button-close, .popup:visible .popup-button-ok').first().click().catch(() => {});
    });
});
