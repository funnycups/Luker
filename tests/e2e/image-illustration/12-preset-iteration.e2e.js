// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    closeAnyOpenTopSettingsDrawer,
    openExtensionsDrawer,
    openInlineDrawer,
} from '../_lib/page.js';
import {
    applyIterateChanges,
    closeWorkbench,
    openWorkbenchIterate,
    sendIteratePrompt,
    switchWorkbenchTab,
    undoWorkbenchChangeCard,
    workbenchWindow,
} from '../_lib/ui-workbench.js';

let server;
let mock;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM();
    server = await startServer({
        scope,
        batchKey: 'image-illustration',
        scenarioId: '12-preset-iteration',
        extraConfig: { enableUserAccounts: false, disableUpdateCheck: true },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL, api: 'custom' });
});

test.afterAll(async () => {
    await mock?.stop();
});

function readIllustrationSettings() {
    const raw = JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'settings.json'), 'utf8'));
    return raw.extension_settings?.sd?.illustration || {};
}

test.describe('Workbench SD AI iteration prompt preset management', () => {
    test('creates and deletes illustration prompt presets via AI iteration, refreshes UI selectors, persists, and supports undo', async ({ page }) => {
        let round = 0;
        let deletedPresetId = '';

        mock.scriptCompletion(({ body }) => {
            const messages = Array.isArray(body?.messages) ? body.messages : [];
            round += 1;
            if (round === 1) {
                return { tool: 'sd_list_presets', arguments: {} };
            }
            if (round === 2) {
                const lastToolMsg = [...messages].reverse().find(m => m.role === 'tool');
                const listed = JSON.parse(String(lastToolMsg?.content || '[]'));
                const naturalPreset = listed.find(p => p.promptStyle === 'natural') || listed[1];
                deletedPresetId = String(naturalPreset?.id || '');
                return {
                    toolCalls: [
                        {
                            name: 'sd_create_preset',
                            arguments: {
                                preset_id: 'preset_watercolor_iter',
                                name: 'Watercolor Natural',
                                prompt_style: 'natural',
                                illustration_prompt: 'Describe each moment as a soft watercolor vignette in two sentences.',
                                studio_prompt: 'Write calm watercolor prompts when the user asks for an image.',
                                visual_inspection: true,
                            },
                        },
                        {
                            name: 'sd_delete_preset',
                            arguments: { preset_id: deletedPresetId },
                        },
                    ],
                };
            }
            return { text: 'Created Watercolor Natural and removed the unused preset.' };
        });

        await awaitMainUI(page, server.baseURL);

        // Inspect initial presets in Extensions -> Image Generation -> AI Illustration.
        await openExtensionsDrawer(page);
        await openInlineDrawer(page, 'sd_container');
        await openInlineDrawer(page, 'sd_illustration_container');
        await expect(page.locator('#sd_illustration_preset option')).toHaveCount(2);
        await closeAnyOpenTopSettingsDrawer(page);

        // Open Workbench -> AI iteration -> Image Generation and run preset create + delete.
        await openWorkbenchIterate(page, 'sd');
        await sendIteratePrompt(page, 'Create a Watercolor Natural preset and delete the default natural preset.', { waitFor: 'changes' });
        await applyIterateChanges(page);

        // Verify persisted settings on disk.
        await expect.poll(() => {
            const ill = readIllustrationSettings();
            return (ill.presets || []).map(p => p.id);
        }, { timeout: 15_000 }).toContain('preset_watercolor_iter');

        const persisted = readIllustrationSettings();
        expect(persisted.presets.some(p => p.id === deletedPresetId)).toBe(false);
        const created = persisted.presets.find(p => p.id === 'preset_watercolor_iter');
        expect(created).toMatchObject({
            name: 'Watercolor Natural',
            promptStyle: 'natural',
            illustrationPrompt: 'Describe each moment as a soft watercolor vignette in two sentences.',
            studioPrompt: 'Write calm watercolor prompts when the user asks for an image.',
            visualInspection: true,
        });

        // Switch to Image Generation -> Image Studio inside Workbench: toolbar preset dropdown updates immediately.
        await switchWorkbenchTab(page, 'sd');
        const win = workbenchWindow(page);
        const studioPresetSelect = win.locator('.sdlens-studio-toolbar [data-sd-role="studio-preset"]');
        await expect(studioPresetSelect).toBeVisible({ timeout: 10_000 });
        await expect(studioPresetSelect.locator('option[value="preset_watercolor_iter"]')).toHaveText('Watercolor Natural');
        await expect(studioPresetSelect.locator(`option[value="${deletedPresetId}"]`)).toHaveCount(0);

        // Close Workbench and verify Extensions -> AI Illustration dropdown was refreshed without page reload.
        await closeWorkbench(page);
        await openExtensionsDrawer(page);
        await expect(page.locator('#sd_illustration_preset option[value="preset_watercolor_iter"]')).toHaveText('Watercolor Natural');
        await expect(page.locator(`#sd_illustration_preset option[value="${deletedPresetId}"]`)).toHaveCount(0);
        await closeAnyOpenTopSettingsDrawer(page);

        // Reopen AI iteration and undo the applied card -> original presets return on disk and in the settings dropdown.
        await openWorkbenchIterate(page, 'sd');
        await undoWorkbenchChangeCard(page);

        await expect.poll(() => {
            const ill = readIllustrationSettings();
            return (ill.presets || []).map(p => p.id);
        }, { timeout: 15_000 }).toContain(deletedPresetId);
        expect(readIllustrationSettings().presets.some(p => p.id === 'preset_watercolor_iter')).toBe(false);

        await closeWorkbench(page);
        await openExtensionsDrawer(page);
        await expect(page.locator('#sd_illustration_preset option[value="preset_watercolor_iter"]')).toHaveCount(0);
        await expect(page.locator(`#sd_illustration_preset option[value="${deletedPresetId}"]`)).toHaveCount(1);
    });
});
