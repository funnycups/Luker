// tests/e2e/workbench/06-preset-switch-guard.e2e.js
//
// A Workbench preset change is applied as a set of field edits against the
// live preset. Its undo must refuse to run after another preset became
// selected, or the inverse would land in the wrong live body. Switching
// back keeps the undo usable.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import {
    bootstrapCustomBackend,
    appendConnectionProfile,
    markOnboarded,
    writePreset,
} from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { disableTagImportPopup } from '../character/_helpers.js';
import { normalizeIterStudioSettings, selectPresetByName } from '../preset/_helpers.js';
import {
    applyIterateChanges,
    closeWorkbench,
    openChangeHistory,
    openWorkbenchIterate,
    sendIteratePrompt,
    workbenchWindow,
} from '../_lib/ui-workbench.js';

let server, mock;

const PRESET_A = 'Guard Preset A';
const PRESET_B = 'Guard Preset B';

function readPreset(name) {
    return JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'OpenAI Settings', `${name}.json`), 'utf8'));
}

function presetOverrides(temperature) {
    return {
        temperature,
        prompts: [
            { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'Be helpful and stay in character.' },
        ],
        prompt_order: [],
    };
}

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'workbench',
        scenarioId: '06-preset-switch-guard',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    normalizeIterStudioSettings(server.dataRoot);
    disableTagImportPopup({ dataRoot: server.dataRoot });

    writePreset({ dataRoot: server.dataRoot, name: PRESET_A, overrides: presetOverrides(0.7) });
    writePreset({ dataRoot: server.dataRoot, name: PRESET_B, overrides: presetOverrides(1.2) });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('Workbench preset undo after the selected preset changed', () => {
    test.setTimeout(240_000);

    test('refuses the undo on another preset and accepts it after switching back', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectPresetByName(page, PRESET_A);

        mock.scriptCompletion((req) => {
            if (req.turn === 0) {
                return {
                    toolCalls: [{
                        name: 'preset_upsert_prompt_entry',
                        arguments: {
                            identifier: 'guard_rule',
                            name: 'Guard Rule',
                            role: 'system',
                            content: 'Hold the line.',
                            enabled: true,
                            position: 1,
                        },
                    }],
                };
            }
            return { text: 'Added guard_rule.' };
        });

        await openWorkbenchIterate(page, 'preset');
        await sendIteratePrompt(page, 'Add guard_rule.');
        mock.clearScriptedCompletion();

        await applyIterateChanges(page);
        await expect.poll(() => readPreset(PRESET_A).prompts.some((p) => p.identifier === 'guard_rule'), { timeout: 10_000 })
            .toBe(true);
        const appliedA = readPreset(PRESET_A);

        await selectPresetByName(page, PRESET_B);
        await openChangeHistory(page);

        const win = workbenchWindow(page);
        const undoButton = () => win.locator('.wb-hist-item:not(.is-undone)').first()
            .locator('button').filter({ hasText: /^Undo$/ }).first();

        await undoButton().click();
        await expect(page.locator('.wbench .wb-toast.is-error')).toContainText('no longer selected', { timeout: 10_000 });
        expect(readPreset(PRESET_A)).toEqual(appliedA);
        expect(readPreset(PRESET_B).prompts.some((p) => p.identifier === 'guard_rule')).toBe(false);

        await selectPresetByName(page, PRESET_A);
        await undoButton().click();
        await expect.poll(() => readPreset(PRESET_A).prompts.some((p) => p.identifier === 'guard_rule'), { timeout: 10_000 })
            .toBe(false);

        await closeWorkbench(page);
    });
});
