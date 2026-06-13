// #80 — MG Schema iter-studio: Apply → schema persists across restart.
//
// Story:
//   1. Open MG Schema iter-studio (Extensions drawer → Memory Graph
//      drawer → "Schema iteration studio").
//   2. Drive the studio's Apply path with a new node-type schema field.
//      The MG schema iter-studio's tool catalog (mg_schema_set_node_type,
//      mg_schema_remove_node_type, mg_schema_reorder_node_types) ultimately
//      flows through `commitLiveToSchema()` which writes
//      `extension_settings.memory_graph.nodeTypeSchema` and triggers
//      `saveSettings()` (which persists to settings.json on disk).
//   3. Verify:
//        - In-memory schema reflects the new field.
//        - settings.json on disk carries the new schema.
//        - After server.restart() + page reload, the schema is rehydrated.
//
// We drive the Apply via the canonical commit path (writing
// `extension_settings.memory_graph.nodeTypeSchema` + saveSettings) — this
// is what `commitLiveToSchema` does internally. Driving via a synthetic
// tool call would still execute the same disk write but is contingent on
// running the LLM iter-studio loop, which is covered by IterWorkspaceSplit
// smoke. Our scope is the persistence side of Apply.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait, openExtensionsDrawer, openInlineDrawer } from '../_lib/page.js';

let server, mock;

// The new node type we'll inject. RP-immersive id (matches the rest of
// the corpus tone — "ash_journal" is the cartographer's logbook).
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

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: ['*Ash makes a note in the margin and sets the chart aside.*'] });
    server = await startServer({ batchKey: 'iterstudio', scenarioId: '80-mg-schema-apply' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

function settingsPath(dataRoot) {
    return resolve(dataRoot, 'default-user', 'settings.json');
}

test.describe('#80 — MG Schema iter-studio Apply → settings.json mutated → survives restart', () => {
    test('Apply persists new node-type to extension_settings.memory_graph.nodeTypeSchema', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Baseline: the seeded settings.json may or may not carry
        // `extension_settings.memory_graph.nodeTypeSchema` — MG ships a
        // factory schema that's loaded into memory at boot but NOT
        // necessarily written back to disk until something mutates it.
        // We snapshot the in-memory length (the source of truth the studio
        // mutates), and confirm our new id isn't already present.
        const baseline = await page.evaluate(() => {
            const ctx = window.SillyTavern.getContext();
            const arr = Array.isArray(ctx.extensionSettings?.memory_graph?.nodeTypeSchema)
                ? ctx.extensionSettings.memory_graph.nodeTypeSchema
                : [];
            return {
                length: arr.length,
                ids: arr.map(t => t?.id).filter(Boolean),
            };
        });
        expect(baseline.ids).not.toContain(NEW_NODE_TYPE.id);
        const baselineLen = baseline.length;

        // Open the MG Schema iter-studio popup so the studio module is
        // loaded and the user-visible workspace is mounted (mirrors a
        // real user flow even though the actual mutation goes through
        // the canonical commit path below).
        await openExtensionsDrawer(page);
        await openInlineDrawer(page, 'memory_graph_settings');
        const openBtn = page.locator('#luker_rpg_memory_open_schema_studio');
        await expect(openBtn).toBeVisible({ timeout: 10_000 });
        await openBtn.click();
        const popup = page.locator('.mg_schema_it_popup.luker-iter-workspace').first();
        await expect(popup).toBeVisible({ timeout: 15_000 });

        // Apply: drive the canonical commit (same write
        // `commitLiveToSchema` performs: mutate
        // extension_settings.memory_graph.nodeTypeSchema + saveSettings()).
        //
        // Use the positional `saveSettings(0, { directSave: true })` form
        // (per the e2e brief lessons): the JSON-Patch path silently
        // rejects `add` ops whose parent doesn't yet exist on disk, which
        // is exactly the case when extension_settings.memory_graph wasn't
        // serialized at boot. directSave forces a full settings.json
        // rewrite that doesn't depend on patch parentage.
        const applyResult = await page.evaluate(async (newType) => {
            const ctx = window.SillyTavern.getContext();
            const ext = ctx.extensionSettings.memory_graph;
            if (!ext) return { ok: false, reason: 'memory_graph ext settings missing' };
            const schema = Array.isArray(ext.nodeTypeSchema) ? ext.nodeTypeSchema.slice() : [];
            schema.push(newType);
            ext.nodeTypeSchema = schema;
            // Flush to disk (settings.json) — directSave bypasses the
            // JSON-Patch optimistic path that would reject missing parents.
            if (typeof ctx.saveSettings === 'function') {
                await ctx.saveSettings(0, { directSave: true });
            } else if (typeof ctx.saveSettingsDebounced === 'function') {
                ctx.saveSettingsDebounced();
            }
            return { ok: true, length: schema.length };
        }, NEW_NODE_TYPE);
        expect(applyResult.ok, applyResult.reason).toBe(true);
        expect(applyResult.length).toBe(baselineLen + 1);

        // Verify the disk write landed before restart. Poll briefly because
        // saveSettingsDebounced may flush asynchronously.
        await expect.poll(() => {
            const s = JSON.parse(readFileSync(settingsPath(server.dataRoot), 'utf8'));
            const arr = s?.extension_settings?.memory_graph?.nodeTypeSchema || [];
            return Array.isArray(arr) && arr.some(t => t?.id === NEW_NODE_TYPE.id);
        }, { timeout: 10_000 }).toBe(true);

        // Close the popup, then restart.
        await page.keyboard.press('Escape');

        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        // Disk still carries the new field.
        const afterRestartSettings = JSON.parse(readFileSync(settingsPath(server.dataRoot), 'utf8'));
        const afterRestartSchema = afterRestartSettings?.extension_settings?.memory_graph?.nodeTypeSchema || [];
        const persistedEntry = afterRestartSchema.find(t => t?.id === NEW_NODE_TYPE.id);
        expect(persistedEntry, 'new node-type missing from settings.json after restart').toBeTruthy();
        expect(persistedEntry?.label).toBe(NEW_NODE_TYPE.label);
        expect(persistedEntry?.tableName).toBe(NEW_NODE_TYPE.tableName);
        expect(persistedEntry?.tableColumns).toEqual(NEW_NODE_TYPE.tableColumns);
        expect(persistedEntry?.keywords).toEqual(NEW_NODE_TYPE.keywords);

        // In-memory rehydration: the MG settings registered the new schema.
        const inMem = await page.evaluate(() => {
            const ctx = window.SillyTavern.getContext();
            const schema = ctx.extensionSettings?.memory_graph?.nodeTypeSchema || [];
            return Array.isArray(schema)
                ? schema.map(t => ({ id: t?.id, label: t?.label }))
                : null;
        });
        expect(Array.isArray(inMem), 'in-memory schema missing after reload').toBe(true);
        const inMemEntry = inMem.find(t => t.id === NEW_NODE_TYPE.id);
        expect(inMemEntry, 'new node-type missing from in-memory schema after reload').toBeTruthy();
        expect(inMemEntry.label).toBe(NEW_NODE_TYPE.label);
    });
});
