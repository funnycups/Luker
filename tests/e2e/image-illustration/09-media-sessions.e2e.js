// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI, closeAnyOpenTopSettingsDrawer, fillTopmostPopupAndAccept, openExtensionsDrawer, openInlineDrawer } from '../_lib/page.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { selectWorkbenchTab } from '../_lib/ui-workbench.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const SAMPLE_PNG_PATH = resolve(REPO_ROOT, 'default/content/default_Seraphina.png');
const COMFY_URL = 'http://127.0.0.1:8188';

let server;
let llm;

test.beforeAll(async () => {
    llm = await startMockLLM();
    server = await startServer({
        batchKey: 'image-illustration',
        scenarioId: '09-media-sessions',
        extraConfig: { enableUserAccounts: false, disableUpdateCheck: true },
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await llm.stop();
});

function readIllustrationSettings() {
    return JSON.parse(readFileSync(join(server.dataRoot, 'default-user/settings.json'), 'utf8')).extension_settings.sd.illustration;
}

function listSandboxSessionDirs() {
    const dir = join(server.dataRoot, 'default-user/user/images/_sandbox_tmp');
    if (!existsSync(dir)) return [];
    return readdirSync(dir);
}

function listReferenceFiles() {
    const dir = join(server.dataRoot, 'default-user/user/images/_references');
    if (!existsSync(dir)) return [];
    return readdirSync(dir);
}

async function readProfiles(page) {
    const response = await page.request.get(`${server.baseURL}/api/state/get?account=default-user&namespace=sd_character_profiles`);
    if (!response.ok()) {
        throw new Error(`Read character profiles: HTTP ${response.status()} ${await response.text()}`);
    }
    const body = await response.json();
    expect(body.ok).toBe(true);
    return body.data?.profiles ?? {};
}

async function configureConnectionAndComfy(page, { visualInspection = false } = {}) {
    await page.locator('#API-status-top').click();
    await page.locator('#main_api').selectOption('openai');
    await page.locator('#chat_completion_source').selectOption('custom');
    await page.locator('#custom_api_url_text').fill(llm.baseURL);
    await page.locator('#custom_api_url_text').press('Tab');
    await page.locator('#api_button_openai').click();
    await expect(page.locator('#model_custom_select option[value="mock-gpt-4o"]')).toHaveCount(1);
    await page.locator('#model_custom_select').selectOption('mock-gpt-4o');
    const completionPreset = (await page.locator('#settings_preset_openai option:checked').textContent()).trim();
    const profileName = `Media session conn ${randomUUID()}`;
    await page.locator('#create_connection_profile').click();
    await fillTopmostPopupAndAccept(page, profileName);
    await expect(page.locator('#connection_profiles option', { hasText: profileName })).toHaveCount(1);
    await page.locator('#API-status-top').click();

    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'sd_container');
    await page.locator('#sd_source').selectOption('comfy');
    await page.locator('#sd_comfy_url').fill(COMFY_URL);
    await page.locator('#sd_comfy_url').dispatchEvent('input');
    await page.locator('#sd_comfy_validate').click();
    await expect.poll(async () => page.locator('#sd_model option').count(), { timeout: 20_000 }).toBeGreaterThan(0);
    await page.locator('#sd_comfy_workflow').selectOption('Default_Comfy_Workflow.json');
    await page.locator('#sd_steps_value').fill('2');
    await page.locator('#sd_steps_value').dispatchEvent('input');
    await page.locator('#sd_width_value').fill('256');
    await page.locator('#sd_width_value').dispatchEvent('input');
    await page.locator('#sd_height_value').fill('256');
    await page.locator('#sd_height_value').dispatchEvent('input');

    await openInlineDrawer(page, 'sd_illustration_container');
    await page.locator('#sd_illustration_enabled').uncheck();
    const connection = page.locator('#sd_illustration_exploration_api_preset');
    if (!(await connection.isVisible())) {
        await connection.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " inline-drawer ")][1]')
            .locator('> .inline-drawer-toggle').click();
    }
    await connection.selectOption({ label: profileName });
    await page.locator('#sd_illustration_exploration_llm_preset').selectOption({ label: completionPreset });
    await page.locator('#sd_illustration_visual_inspection').setChecked(visualInspection);
    await expect.poll(() => {
        const settings = readIllustrationSettings();
        return settings.presets.find(preset => preset.id === settings.currentPresetId).explorationLlm;
    }).toEqual({ apiPresetName: profileName, llmPresetName: completionPreset });
    await closeAnyOpenTopSettingsDrawer(page);
}

async function openBuilderDialog(page) {
    const workbench = await selectWorkbenchTab(page, 'sd');
    await workbench.locator('[data-sd-nav="characters"]').click();
    const openBtn = workbench.locator('[data-sd-role="open-ai-builder"]').first();
    await expect(openBtn).toBeVisible();
    await openBtn.click();
    const dialog = page.locator('[data-sd-role="character-builder-dialog"]').last();
    await expect(dialog).toBeVisible();
    return dialog;
}

async function uploadTempReference(page, dialog) {
    const chooserPromise = page.waitForEvent('filechooser');
    await dialog.locator('[data-sd-role="builder-upload-ref"]').first().click();
    const chooser = await chooserPromise;
    await chooser.setFiles(SAMPLE_PNG_PATH);
    const refItem = dialog.locator('[data-sd-role="builder-ref-item"]').last();
    await expect(refItem).toBeVisible({ timeout: 15_000 });
    const imagePath = await refItem.getAttribute('data-image-path');
    expect(imagePath).toMatch(/^\/user\/images\/_sandbox_tmp\//);
    await expect(refItem.locator('img')).toHaveAttribute('src', /^data:image\//, { timeout: 15_000 });
    return imagePath;
}

test.describe.serial('transient media sessions via character builder dialog', () => {
    test('parallel builder dialogs isolate temporary directories and cancelling one preserves the other', async ({ page, context }) => {
        await awaitMainUI(page, server.baseURL);
        const dialogA = await openBuilderDialog(page);
        const pathA = await uploadTempReference(page, dialogA);
        const sessionA = pathA.split('/')[4];

        const pageB = await context.newPage();
        try {
            await awaitMainUI(pageB, server.baseURL);
            const dialogB = await openBuilderDialog(pageB);
            const pathB = await uploadTempReference(pageB, dialogB);
            const sessionB = pathB.split('/')[4];
            expect(sessionB).not.toBe(sessionA);
            expect(listSandboxSessionDirs()).toEqual(expect.arrayContaining([sessionA, sessionB]));

            // Cancel dialog A: only session A disappears.
            await dialogA.locator('[data-sd-role="builder-cancel"]').click();
            await expect(dialogA).toBeHidden({ timeout: 15_000 });
            expect(listSandboxSessionDirs()).not.toContain(sessionA);
            expect(listSandboxSessionDirs()).toContain(sessionB);

            // Dialog B confirms and promotes its retained image cleanly.
            const profileName = `Parallel Builder ${randomUUID()}`;
            await dialogB.locator('[data-sd-builder-field="name"]').fill(profileName);
            await dialogB.locator('[data-sd-role="builder-confirm"]').click();
            await expect(dialogB).toBeHidden({ timeout: 15_000 });
            expect(listSandboxSessionDirs()).not.toContain(sessionB);

            const profiles = await readProfiles(pageB);
            const saved = Object.values(profiles).find(p => p.name === profileName);
            expect(saved).toBeTruthy();
            const promotedPath = saved.outfits[0].referenceImages[0];
            expect(promotedPath).toMatch(/^\/user\/images\/_references\//);
            expect(existsSync(join(server.dataRoot, 'default-user', promotedPath.replace(/^\//, '')))).toBe(true);
        } finally {
            await pageB.close();
        }
    });

    test('real ComfyUI generated candidate images stay in _sandbox_tmp and are removed on cancel without touching GlobalState', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await configureConnectionAndComfy(page, { visualInspection: false });

        const profilesBefore = await readProfiles(page);
        const refsBefore = listReferenceFiles();

        let round = 0;
        llm.scriptCompletion(({ body }) => {
            round += 1;
            if (round === 1) {
                return {
                    tool: 'generate_image',
                    arguments: {
                        prompt: '1girl, silver hair, simple studio portrait, white background',
                    },
                };
            }
            if (round === 2) {
                const toolMsg = body.messages.findLast(m => m.role === 'tool');
                const parsed = JSON.parse(toolMsg.content);
                return {
                    tool: 'stage_character_profile',
                    arguments: {
                        name: 'Cancelled Comfy Candidate',
                        outfits: [
                            {
                                id: 'outfit_default',
                                name: 'Default',
                                reference_images: [parsed.imagePath],
                            },
                        ],
                    },
                };
            }
            return { text: 'Staged generated candidate.' };
        });

        const dialog = await openBuilderDialog(page);
        await dialog.locator('[data-sd-role="builder-input"]').fill('Generate a studio portrait candidate.');
        await dialog.locator('[data-sd-role="builder-send"]').click();

        const refItem = dialog.locator('[data-sd-role="builder-ref-item"]').first();
        await expect(refItem).toBeVisible({ timeout: 90_000 });
        const stagedPath = await refItem.getAttribute('data-image-path');
        expect(stagedPath).toMatch(/^\/user\/images\/_sandbox_tmp\//);
        const sessionId = stagedPath.split('/')[4];
        expect(listSandboxSessionDirs()).toContain(sessionId);
        await expect(refItem.locator('img')).toHaveAttribute('src', /^data:image\//, { timeout: 15_000 });

        await dialog.locator('[data-sd-role="builder-cancel"]').click();
        await expect(dialog).toBeHidden({ timeout: 15_000 });

        expect(listSandboxSessionDirs()).not.toContain(sessionId);
        expect(await readProfiles(page)).toEqual(profilesBefore);
        expect(listReferenceFiles()).toEqual(refsBefore);
    });

    test('failed save rolls back promoted files, preserves draft and temp image, and succeeds on retry', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        const dialog = await openBuilderDialog(page);
        const stagedPath = await uploadTempReference(page, dialog);
        const sessionId = stagedPath.split('/')[4];
        const profileName = `Retry Save Profile ${randomUUID()}`;
        await dialog.locator('[data-sd-builder-field="name"]').fill(profileName);

        const stateDir = join(server.dataRoot, 'default-user/states');
        const stateFile = join(stateDir, 'sd_character_profiles.json');
        const refsBefore = listReferenceFiles();

        chmodSync(stateDir, 0o500);
        if (existsSync(stateFile)) chmodSync(stateFile, 0o400);
        try {
            await dialog.locator('[data-sd-role="builder-confirm"]').click();
            await expect(dialog.locator('[data-sd-role="builder-error"]')).toBeVisible({ timeout: 15_000 });
            // Dialog stays open, draft and temp file remain intact, promoted copy was rolled back.
            await expect(dialog.locator('[data-sd-builder-field="name"]')).toHaveValue(profileName);
            expect(listSandboxSessionDirs()).toContain(sessionId);
            expect(existsSync(join(server.dataRoot, 'default-user', stagedPath.replace(/^\//, '')))).toBe(true);
            expect(listReferenceFiles()).toEqual(refsBefore);
        } finally {
            chmodSync(stateDir, 0o700);
            if (existsSync(stateFile)) chmodSync(stateFile, 0o600);
        }

        // Retry save after restoring permissions.
        await dialog.locator('[data-sd-role="builder-confirm"]').click();
        await expect(dialog).toBeHidden({ timeout: 15_000 });
        expect(listSandboxSessionDirs()).not.toContain(sessionId);

        const saved = Object.values(await readProfiles(page)).find(p => p.name === profileName);
        expect(saved).toBeTruthy();
        expect(saved.outfits[0].referenceImages[0]).toMatch(/^\/user\/images\/_references\//);
    });

    test('cleanup failure displays retryable error and closes cleanly once retried', async ({ page }) => {
        const forbiddenTempReads = [];
        page.on('response', response => {
            if (response.status() === 403) {
                forbiddenTempReads.push({
                    method: response.request().method(),
                    url: response.url(),
                    resourceType: response.request().resourceType(),
                    hasSessionHeader: Boolean(response.request().headers()['x-luker-transient-session']),
                });
            }
        });
        await awaitMainUI(page, server.baseURL);
        const dialog = await openBuilderDialog(page);
        const stagedPath = await uploadTempReference(page, dialog);
        const sessionId = stagedPath.split('/')[4];
        const sandboxRoot = join(server.dataRoot, 'default-user/user/images/_sandbox_tmp');
        const sessionDir = join(sandboxRoot, sessionId);

        chmodSync(sessionDir, 0o500);
        chmodSync(sandboxRoot, 0o500);
        try {
            await dialog.locator('[data-sd-role="builder-cancel"]').click();
            await expect(dialog.locator('[data-sd-role="builder-error"]')).toBeVisible({ timeout: 15_000 });
            await expect(dialog.locator('[data-sd-role="builder-retry-cleanup"]')).toBeVisible();
            await expect(dialog).toBeVisible();
        } finally {
            chmodSync(sandboxRoot, 0o700);
            chmodSync(sessionDir, 0o700);
        }

        await dialog.locator('[data-sd-role="builder-retry-cleanup"]').click();
        await expect(dialog).toBeHidden({ timeout: 15_000 });
        expect(listSandboxSessionDirs()).not.toContain(sessionId);
        expect(forbiddenTempReads).toEqual([]);
    });
});
