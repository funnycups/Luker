// tests/e2e/memorygraph/64-legacy-recall-method-migration.e2e.js
//
// #64 — Legacy recall-method migration: when settings.json holds a pre-collapse
// value (`hybrid_rerank`), the boot pipeline rewrites it to `rag` with the
// `ragUseRerank` toggle on, and Memory Lens Settings reflects the new shape.

import { test, expect } from '../../harness/playwright.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import {
    bootstrapCustomBackend,
    appendConnectionProfile,
    bootstrapVectorsBackend,
    markOnboarded,
} from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { closeWorkbench } from '../_lib/ui-workbench.js';
import { openMemoryWorkspace } from '../_lib/ui-mg-varops.js';

let server, mock;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({ scriptedReplies: ['*Ack.*'] });
    server = await startServer({ scope, batchKey: 'memorygraph', scenarioId: 'legacy-migration' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    bootstrapVectorsBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    const settingsPath = resolve(server.dataRoot, 'default-user', 'settings.json');
    if (!existsSync(settingsPath)) {
        throw new Error(`settings.json missing at ${settingsPath}`);
    }
    const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
    s.extension_settings = s.extension_settings || {};
    s.extension_settings.memory_graph = {
        ...(s.extension_settings.memory_graph || {}),
        recallMethod: 'hybrid_rerank',
        diffusionSteps: 3,
        diffusionDecay: 0.7,
        diffusionTopK: 80,
        diffusionTeleportAlpha: 0.1,
        enableRerank: true,
    };
    writeFileSync(settingsPath, JSON.stringify(s, null, 4));
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#64 — legacy hybrid_rerank settings migrate to RAG with rerank on', () => {
    test.setTimeout(120_000);

    test('on boot, Memory Lens Settings shows RAG, rerank is on, diffusion fields are gone', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        const lens = await openMemoryWorkspace(page, { subview: 'settings' });
        const settings = lens.locator('.ml-settings').first();

        const methodSelect = settings.locator('[data-field-key="recallMethod"] select').first();
        await expect(methodSelect).toHaveValue('rag', { timeout: 10_000 });

        await expect(settings.locator('[data-field-key="embeddingProfileId"]')).toBeVisible();

        const rerankSwitch = settings.locator('[data-field-key="ragUseRerank"]').first();
        await expect(rerankSwitch).toHaveAttribute('aria-checked', 'true');
        await expect(settings.locator('[data-field-key="rerankProfileId"]')).toBeVisible();

        const rewriteSwitch = settings.locator('[data-field-key="ragUseQueryRewrite"]').first();
        await expect(rewriteSwitch).toHaveAttribute('aria-checked', 'false');

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

        await closeWorkbench(page);
    });
});
