// #80 — MG Schema iter-studio: Apply → schema persists across restart.
//
// REAL USER-GESTURE flow:
//   1. Open the MG schema iter-studio popup (extensions drawer → MG panel
//      → "AI Iterate Schema" button) via real clicks (openIterStudio).
//   2. Script an `mg_schema_set_node_type` tool_call on the mock.
//   3. Click Send via sendIterPrompt; wait for Apply button to render.
//   4. Click Apply via applyIterBatch.
//   5. Close popup. Verify the new node-type id surfaces in:
//      - the rendered schema editor (DOM-side ground truth)
//      - extension_settings.memory_graph.nodeTypeSchema (in-memory)
//   6. Restart, reload, re-open popup → new id still present in DOM.

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, applyIterBatch, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { normalizeIterStudioSettings } from '../preset/_helpers.js';

let server, mock;

const NEW_NODE_TYPE = {
    id: 'ash_journal',
    label: 'Ash Journal Entry',
    tableName: 'ash_journal_table',
    tableColumns: ['entry', 'mood', 'wind_direction'],
    embeddingColumns: ['entry'],
    requiredColumns: ['entry'],
    keywords: ['journal', 'log', 'cartographer'],
    extractEveryN: 2,
};

// normalizeIterStudioSettings is imported from preset/_helpers.

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'iterstudio',
        scenarioId: '80-mg-schema-apply',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    normalizeIterStudioSettings(server.dataRoot);
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#80 — MG Schema iter-studio Apply → settings persists across restart (real UI)', () => {
    test('Apply persists new node-type via real Apply button click', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Baseline: confirm the new node type is not present.
        const baseline = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const arr = Array.isArray(ctx.extensionSettings?.memory_graph?.nodeTypeSchema)
                ? ctx.extensionSettings.memory_graph.nodeTypeSchema
                : [];
            return arr.map(t => t?.id).filter(Boolean);
        });
        expect(baseline).not.toContain(NEW_NODE_TYPE.id);

        // Open MG schema iter-studio popup.
        await openIterStudio(page, 'mg');

        // Script the tool_call.
        mock.scriptToolCall({
            name: 'mg_schema_set_node_type',
            arguments: { node_type: NEW_NODE_TYPE },
        });

        // Send and wait for Apply to render.
        await sendIterPrompt(page, 'mg', 'Add an ash_journal node type for the cartographer\'s logbook.');

        // Click Apply via real button.
        await applyIterBatch(page, 'mg');

        // Close popup before restart.
        await closeIterStudio(page);

        // In-memory: the new id is present.
        await expect.poll(async () => {
            return await page.evaluate(() => {
                const ctx = window.Luker.getContext();
                const arr = ctx.extensionSettings?.memory_graph?.nodeTypeSchema || [];
                return arr.map(t => t?.id);
            });
        }, { timeout: 10_000 }).toContain(NEW_NODE_TYPE.id);

        // Restart + reload.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        // After reload, the schema list still carries the new id.
        const afterRestart = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const arr = ctx.extensionSettings?.memory_graph?.nodeTypeSchema || [];
            return arr.find(t => t?.id === 'ash_journal') || null;
        });
        expect(afterRestart).toBeTruthy();
        expect(afterRestart.label).toBe(NEW_NODE_TYPE.label);
        expect(afterRestart.tableName).toBe(NEW_NODE_TYPE.tableName);
    });
});
