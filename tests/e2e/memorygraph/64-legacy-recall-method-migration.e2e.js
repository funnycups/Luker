// tests/e2e/memorygraph/64-legacy-recall-method-migration.e2e.js
//
// #64 — Legacy recall-method migration: when settings.json holds a pre-collapse
// value (`hybrid_rerank`), the boot pipeline rewrites it to `rag` with the
// `ragUseRerank` toggle on, and the UI dropdown reflects the new shape.
//
// Real-user flow:
//   1. Pre-seed settings.json with `recallMethod: 'hybrid_rerank'` and the
//      now-removed `diffusionSteps` field (simulating an upgrade from the
//      4-mode hybrid recall era).
//   2. Boot the server, open the MG inline drawer.
//   3. Read the dropdown <select>: must show value="rag".
//   4. Read the Enable rerank checkbox: must be checked.
//   5. Read the Enable query rewrite checkbox: must be unchecked.
//   6. Read settings via window.Luker.getContext().extensionSettings — must
//      no longer contain diffusionSteps.

import { test, expect } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import {
    bootstrapCustomBackend,
    appendConnectionProfile,
    bootstrapVectorsBackend,
    markOnboarded,
} from '../_lib/fixtures.js';
import {
    awaitMainUI,
    openExtensionsDrawer,
    openInlineDrawer,
} from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: ['*Ack.*'] });
    server = await startServer({ batchKey: 'memorygraph', scenarioId: 'legacy-migration' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    bootstrapVectorsBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    // Seed legacy values directly into settings.json under extension_settings.
    // ensureSettings() runs `normalizeLegacyRecallSettings` on every load,
    // so this is the only knob we need to plant.
    const settingsPath = resolve(server.dataRoot, 'default-user', 'settings.json');
    if (!existsSync(settingsPath)) {
        throw new Error(`settings.json missing at ${settingsPath}`);
    }
    const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
    s.extension_settings = s.extension_settings || {};
    s.extension_settings.memory_graph = {
        ...(s.extension_settings.memory_graph || {}),
        recallMethod: 'hybrid_rerank',
        // Pre-collapse fields the new normalizer must strip.
        diffusionSteps: 3,
        diffusionDecay: 0.7,
        diffusionTopK: 80,
        diffusionTeleportAlpha: 0.1,
        enableRerank: true,
    };
    writeFileSync(settingsPath, JSON.stringify(s, null, 4));
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#64 — legacy hybrid_rerank settings migrate to RAG with rerank on', () => {
    test.setTimeout(120_000);

    test('on boot, the recall dropdown shows RAG, rerank checkbox is checked, diffusion fields are gone', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await openExtensionsDrawer(page);
        await openInlineDrawer(page, 'memory_graph_settings').catch(() => {});

        // Wait for the select to be populated.
        await page.waitForSelector('#luker_rpg_memory_recall_method', { timeout: 10_000 });

        // 1. UI dropdown reflects the migration target.
        const methodValue = await page.evaluate(() => {
            return document.getElementById('luker_rpg_memory_recall_method')?.value || '';
        });
        expect(methodValue, 'recall method dropdown should show rag after migrating hybrid_rerank').toBe('rag');

        // 2. The RAG sub-block is visible (visibility helper ran post-migration).
        const ragSettingsVisible = await page.evaluate(() => {
            const el = document.getElementById('luker_rpg_memory_rag_settings');
            if (!el) return false;
            return window.getComputedStyle(el).display !== 'none';
        });
        expect(ragSettingsVisible, '#luker_rpg_memory_rag_settings should be visible when method=rag').toBe(true);

        // 3. Rerank checkbox is checked (carried over from hybrid_rerank).
        const rerankChecked = await page.evaluate(() => {
            return Boolean(document.getElementById('luker_rpg_memory_rag_use_rerank')?.checked);
        });
        expect(rerankChecked, 'rerank checkbox should be checked after migrating hybrid_rerank').toBe(true);

        // 4. The rerank-profile sub-block is visible because the checkbox is on.
        const rerankBlockVisible = await page.evaluate(() => {
            const el = document.getElementById('luker_rpg_memory_rag_rerank_block');
            if (!el) return false;
            return window.getComputedStyle(el).display !== 'none';
        });
        expect(rerankBlockVisible, 'rag rerank block should be visible when checkbox is on').toBe(true);

        // 5. Query-rewrite checkbox is NOT checked (legacy hybrid_rerank did not imply rewrite).
        const rewriteChecked = await page.evaluate(() => {
            return Boolean(document.getElementById('luker_rpg_memory_rag_use_query_rewrite')?.checked);
        });
        expect(rewriteChecked, 'query rewrite checkbox must NOT be on after migration').toBe(false);

        // 6. In-memory settings reflect the normalized shape, and the legacy
        // diffusion / enableRerank fields are gone.
        const migrated = await page.evaluate(() => {
            const s = window.Luker.getContext().extensionSettings?.memory_graph || {};
            return {
                recallMethod: s.recallMethod,
                ragUseRerank: s.ragUseRerank,
                ragUseQueryRewrite: s.ragUseQueryRewrite,
                hasDiffusionSteps: Object.prototype.hasOwnProperty.call(s, 'diffusionSteps'),
                hasDiffusionDecay: Object.prototype.hasOwnProperty.call(s, 'diffusionDecay'),
                hasDiffusionTopK: Object.prototype.hasOwnProperty.call(s, 'diffusionTopK'),
                hasDiffusionTeleportAlpha: Object.prototype.hasOwnProperty.call(s, 'diffusionTeleportAlpha'),
                hasEnableRerank: Object.prototype.hasOwnProperty.call(s, 'enableRerank'),
            };
        });
        expect(migrated.recallMethod).toBe('rag');
        expect(migrated.ragUseRerank).toBe(true);
        expect(migrated.ragUseQueryRewrite).toBe(false);
        expect(migrated.hasDiffusionSteps, 'diffusionSteps must be stripped').toBe(false);
        expect(migrated.hasDiffusionDecay, 'diffusionDecay must be stripped').toBe(false);
        expect(migrated.hasDiffusionTopK, 'diffusionTopK must be stripped').toBe(false);
        expect(migrated.hasDiffusionTeleportAlpha, 'diffusionTeleportAlpha must be stripped').toBe(false);
        expect(migrated.hasEnableRerank, 'legacy enableRerank stub must be stripped').toBe(false);
    });
});
