// #93 — Memory Graph configuration workbench in unified Workbench:
// the Memory Lens Settings entry, commit round-trip for global parameters /
// template text, sparse character overrides, and the dirty guard over
// unsaved Advanced edits.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait, selectCharacterByName } from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, applyIterBatch, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { sendIteratePrompt, workbenchWindow } from '../_lib/ui-workbench.js';
import { openMemoryWorkspace } from '../_lib/ui-mg-varops.js';
import { normalizeIterStudioSettings } from '../preset/_helpers.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';
import { read as readPngCard } from '../../../src/character-card-parser.js';

let server, mock;

const ASH_AVATAR = 'ash-the-cartographer.png';
const ASH_NAME = 'Ash the Cartographer';

function readAshCard(dataRoot) {
    const buf = readFileSync(resolve(dataRoot, 'default-user', 'characters', ASH_AVATAR));
    const meta = JSON.parse(readPngCard(buf));
    return meta?.data || meta || {};
}

async function openTechnicalSettings(page) {
    const lens = await openMemoryWorkspace(page, { subview: 'settings' });
    const technical = lens.locator('[data-settings-section="technical"]').first();
    await technical.waitFor({ state: 'visible', timeout: 10_000 });
    const isOpen = await technical.evaluate((el) => el.hasAttribute('open'));
    if (!isOpen) {
        await technical.locator('summary.ml-settings-summary').first().click();
    }
    return lens;
}

async function sendAndReadToolResult(page, promptText) {
    await sendIteratePrompt(page, promptText, { waitFor: 'settled' });
    const win = workbenchWindow(page);
    const trace = win.locator('details.wb-tool-trace').last();
    await trace.waitFor({ state: 'visible', timeout: 30_000 });
    await trace.locator('summary').first().click();
    return trace.locator('.wb-tool-entry').last();
}

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'iterstudio',
        scenarioId: '93-mg-config-workbench',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    normalizeIterStudioSettings(server.dataRoot);
    writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: ASH_AVATAR });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#93 — Memory Graph configuration workbench (real UI)', () => {
    test('global parameter and template edits commit, hydrate Memory Lens Settings, and persist across restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        const avatar = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return ctx.characters?.[ctx.characterId]?.avatar || '';
        });
        expect(avatar).toBe('');

        const lens = await openTechnicalSettings(page);
        const aiConfigBtn = lens.locator('[data-settings-section="operations"] button')
            .filter({ hasText: /^(AI Configure Memory Graph|AI 配置记忆图|AI 配置記憶圖)$/ })
            .first();
        await expect(aiConfigBtn).toBeVisible();

        const promptBox = lens.locator('[data-field-key="configIterSystemPrompt"] textarea').first();
        await expect(promptBox).toBeVisible();
        const uiPrompt = await promptBox.inputValue();
        expect(uiPrompt.length).toBeGreaterThan(0);
        const promptState = await page.evaluate(() => {
            const s = window.Luker.getContext().extensionSettings?.memory_graph || {};
            return {
                version: Number(s.configPromptSchemaVersion || 0),
                stored: String(s.configIterSystemPrompt || ''),
            };
        });
        expect(promptState.version).toBeGreaterThanOrEqual(1);
        expect(promptState.stored ? uiPrompt === promptState.stored : uiPrompt.includes('mg_config_')).toBe(true);

        // Open Workbench AI iteration via the Memory Lens Operations button.
        await aiConfigBtn.click();
        const win = workbenchWindow(page);
        await expect(win.locator('.wb-ws-seg .lw-seg-btn[aria-pressed="true"]')).toHaveText(/^(Memory graph|记忆图|記憶圖)$/);

        // Batch 1: discovery → read → set recallMaxIterations = 5.
        mock.scriptToolCall({ name: 'mg_config_list_fields', arguments: {} });
        mock.scriptToolCall({ name: 'mg_config_read_fields', arguments: { paths: ['settings.extractTemplate'] } });
        mock.scriptToolCall({ name: 'mg_config_set_fields', arguments: { set: { 'settings.recallMaxIterations': 5 } } });
        await sendIterPrompt(page, 'mg', 'Raise the recall iteration cap to 5.');
        await expect(win).toContainText('Recall max iterations');
        await applyIterBatch(page, 'mg');

        // Batch 2: patch settings.extractTemplate.
        mock.scriptToolCall({
            name: 'mg_config_patch_prompt',
            arguments: {
                path: 'settings.extractTemplate',
                oldString: 'Be analytical, terse, and disciplined.',
                newString: 'Be analytical, concise, and disciplined.',
            },
        });
        await sendIterPrompt(page, 'mg', 'Now make the extraction template ask for concise reasoning.');
        await expect(win).toContainText(/Extraction [Tt]emplate/);
        await applyIterBatch(page, 'mg');

        await expect.poll(async () => {
            return await page.evaluate(() => {
                const s = window.Luker.getContext().extensionSettings?.memory_graph || {};
                return { recall: s.recallMaxIterations ?? null, template: String(s.extractTemplate || '') };
            });
        }, { timeout: 10_000 }).toEqual(expect.objectContaining({ recall: 5 }));
        const committed = await page.evaluate(() => String(window.Luker.getContext().extensionSettings?.memory_graph?.extractTemplate || ''));
        expect(committed).toContain('concise');
        expect(committed).toContain('{{nodes}}');
        expect(committed).toContain('{{edges}}');

        // Returning to Memory Lens Settings hydrates the committed value.
        const refreshedLens = await openTechnicalSettings(page);
        await expect(refreshedLens.locator('[data-field-key="recallMaxIterations"] input')).toHaveValue('5');
        await closeIterStudio(page);

        // Restart → reload → reopen → read both values back through mg_config_read_fields.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await openIterStudio(page, 'mg');
        mock.scriptToolCall({
            name: 'mg_config_read_fields',
            arguments: { paths: ['settings.recallMaxIterations', 'settings.extractTemplate'] },
        });
        const resultBody = await sendAndReadToolResult(page, 'Read back the recall iteration cap and the extraction template.');
        await expect(resultBody).toContainText('"settings.recallMaxIterations": 5');
        await expect(resultBody).toContainText('concise');
        await expect(resultBody).toContainText('{{nodes}}');
        await expect(resultBody).toContainText('{{edges}}');
        await closeIterStudio(page);
    });

    test('character-scope commit stores only the sparse persistentInjectionMaxSeqDistance override and survives restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, ASH_NAME);

        const avatar = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return ctx.characters?.[ctx.characterId]?.avatar || '';
        });
        expect(avatar).toBe(ASH_AVATAR);

        await openIterStudio(page, 'mg', { scope: 'character' });
        mock.scriptToolCall({ name: 'mg_config_set_fields', arguments: { set: { 'settings.persistentInjectionMaxSeqDistance': 9 } } });
        await sendIterPrompt(page, 'mg', 'Limit persistent injection lookback to 9 assistant turns for this character.');
        await applyIterBatch(page, 'mg');

        await expect.poll(async () => {
            return await page.evaluate(() => {
                const ctx = window.Luker.getContext();
                const character = ctx?.characters?.[ctx?.characterId];
                return character?.data?.extensions?.memory_graph?.advancedOverride ?? null;
            });
        }, { timeout: 10_000 }).toEqual({ persistentInjectionMaxSeqDistance: 9 });
        await expect.poll(async () => {
            return readAshCard(server.dataRoot)?.extensions?.memory_graph?.advancedOverride ?? null;
        }, { timeout: 10_000 }).toEqual({ persistentInjectionMaxSeqDistance: 9 });

        const globalHorizon = await page.evaluate(() => {
            return window.Luker.getContext().extensionSettings?.memory_graph?.persistentInjectionMaxSeqDistance ?? null;
        });
        expect(globalHorizon).toBe(0);

        const lens = await openMemoryWorkspace(page, { subview: 'settings' });
        await expect(lens.locator('[data-field-key="persistentInjectionMaxSeqDistance"] input')).toHaveValue('9');
        await closeIterStudio(page);

        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, ASH_NAME);

        const afterRestart = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const character = ctx?.characters?.[ctx?.characterId];
            return character?.data?.extensions?.memory_graph?.advancedOverride ?? null;
        });
        expect(afterRestart).toEqual({ persistentInjectionMaxSeqDistance: 9 });
        expect(readAshCard(server.dataRoot)?.extensions?.memory_graph?.advancedOverride ?? null).toEqual({ persistentInjectionMaxSeqDistance: 9 });
    });

    test('unsaved Advanced edits survive a workbench commit round-trip', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, ASH_NAME);
        const lens = await openMemoryWorkspace(page, { subview: 'settings' });

        const horizonInput = lens.locator('[data-field-key="persistentInjectionMaxSeqDistance"] input').first();
        await expect(horizonInput).toHaveValue('0');

        await horizonInput.fill('13');

        await openIterStudio(page, 'mg', { scope: 'character' });
        mock.scriptToolCall({ name: 'mg_config_set_fields', arguments: { set: { 'settings.recallMaxIterations': 4 } } });
        await sendIterPrompt(page, 'mg', 'Lower the recall iteration cap to 4 for this character.');
        await applyIterBatch(page, 'mg');

        await openMemoryWorkspace(page, { subview: 'settings' });
        await expect(lens.locator('[data-field-key="persistentInjectionMaxSeqDistance"] input').first()).toHaveValue('13');
        await closeIterStudio(page);
    });
});
