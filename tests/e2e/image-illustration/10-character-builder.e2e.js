// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI, closeAnyOpenTopSettingsDrawer, fillTopmostPopupAndAccept, openExtensionsDrawer, openInlineDrawer } from '../_lib/page.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { openChangeHistory, selectWorkbenchTab, undoLatestHistoryEntry } from '../_lib/ui-workbench.js';
import { importWorldDocument } from '../_lib/ui-worldinfo.js';
import { openCharacterList } from '../_lib/ui-character.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const SAMPLE_PNG_PATH = resolve(REPO_ROOT, 'default/content/default_Seraphina.png');
const COMFY_URL = 'http://127.0.0.1:8188';

let server;
let llm;

test.beforeAll(async () => {
    llm = await startMockLLM();
    server = await startServer({
        batchKey: 'image-illustration',
        scenarioId: '10-character-builder',
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

async function readProfiles(page) {
    const response = await page.request.get(`${server.baseURL}/api/state/get?account=default-user&namespace=sd_character_profiles`);
    if (!response.ok()) {
        throw new Error(`Read character profiles: HTTP ${response.status()} ${await response.text()}`);
    }
    const body = await response.json();
    expect(body.ok).toBe(true);
    return body.data?.profiles ?? {};
}

function builderRequests() {
    return llm.requests.filter(request => request.url.includes('/chat/completions')
        && request.body.tools?.some(tool => tool.function?.name === 'stage_character_profile'));
}

async function configureConnectionAndComfy(page, { visualInspection = true } = {}) {
    await page.locator('#API-status-top').click();
    await page.locator('#main_api').selectOption('openai');
    await page.locator('#chat_completion_source').selectOption('custom');
    await page.locator('#custom_api_url_text').fill(llm.baseURL);
    await page.locator('#custom_api_url_text').press('Tab');
    await page.locator('#api_button_openai').click();
    await expect(page.locator('#model_custom_select option[value="mock-gpt-4o"]')).toHaveCount(1);
    await page.locator('#model_custom_select').selectOption('mock-gpt-4o');
    const completionPreset = (await page.locator('#settings_preset_openai option:checked').textContent()).trim();
    const profileName = `Builder conn ${randomUUID()}`;
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

async function openArchive(page) {
    const workbench = await selectWorkbenchTab(page, 'sd');
    await workbench.locator('[data-sd-nav="characters"]').click();
    await expect(workbench.locator('[data-sd-role="open-ai-builder"]').first()).toBeVisible();
    return workbench.locator('[data-sd-view="characters"]');
}

async function importSourceCard(page, name, primaryBook) {
    await openCharacterList(page);
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#character_import_button').click();
    const imported = page.waitForResponse(response => new URL(response.url()).pathname === '/api/characters/import');
    await (await chooser).setFiles({
        name: `${name}.json`,
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({
            spec: 'chara_card_v2',
            spec_version: '2.0',
            data: {
                name,
                description: 'A harbor cartographer with braided copper hair and green eyes.',
                first_mes: 'She spreads a nautical chart across the desk.',
                extensions: { world: primaryBook },
            },
        })),
    });
    expect((await imported).ok()).toBeTruthy();
    await page.locator('#rm_print_characters_block .character_select').filter({ hasText: name }).click();
    await expect(page.locator('#character_name_pole')).toHaveValue(name);
    return page.evaluate(value => window.Luker.getContext().characters.find(card => card.name === value).avatar, name);
}

test.describe.serial('conversational character builder dialog', () => {
    test('multi-turn build with real ComfyUI, manual conflict resolution, confirm transaction, and history undo', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await configureConnectionAndComfy(page, { visualInspection: true });

        const reqBefore = builderRequests().length;
        let turnStep = 'turn1_gen';
        let generatedPath = '';
        llm.scriptCompletion(({ body }) => {
            if (turnStep === 'turn1_gen') {
                turnStep = 'turn1_stage';
                return {
                    tool: 'generate_image',
                    arguments: {
                        prompt: '1girl, braided copper hair, emerald eyes, coastal coat, simple background',
                    },
                };
            }
            if (turnStep === 'turn1_stage') {
                turnStep = 'turn1_done';
                const toolMsg = body.messages.findLast(m => m.role === 'tool');
                generatedPath = JSON.parse(toolMsg.content).imagePath;
                return {
                    tool: 'stage_character_profile',
                    arguments: {
                        name: 'AI Draft Name',
                        aliases: ['Navigator'],
                        canonical_tags: ['copper_hair', 'green_eyes'],
                        prose_description: 'Braided copper hair and emerald eyes.',
                        outfits: [
                            {
                                id: 'outfit_default',
                                name: 'Coastal Coat',
                                tags: ['dark_coat'],
                                prose: 'Heavy coastal coat.',
                                reference_images: [generatedPath],
                            },
                        ],
                        default_outfit_id: 'outfit_default',
                    },
                };
            }
            if (turnStep === 'turn1_done') {
                return { text: 'Initial portrait generated and staged.' };
            }
            if (turnStep === 'turn2_stage') {
                turnStep = 'turn2_done';
                return {
                    tool: 'stage_character_profile',
                    arguments: {
                        name: 'Conflicting AI Name',
                        source_work: 'Harbor Chronicles',
                    },
                };
            }
            return { text: 'Proposed additional work details.' };
        });

        const archive = await openArchive(page);
        await archive.locator('[data-sd-role="open-ai-builder"]').first().click();
        const dialog = page.locator('[data-sd-role="character-builder-dialog"]').last();
        await expect(dialog).toBeVisible();

        // Source dropdown is labeled and defaults to 'none'.
        const sourceSelect = dialog.locator('[data-sd-role="builder-source-select"]');
        await expect(sourceSelect).toHaveValue('none');

        // Turn 1: real ComfyUI generation + visual inspection preview + draft staging.
        await dialog.locator('[data-sd-role="builder-input"]').fill('Design a harbor cartographer portrait.');
        await dialog.locator('[data-sd-role="builder-send"]').click();
        await expect.poll(() => builderRequests().length, { timeout: 90_000 }).toBe(reqBefore + 3);
        await expect(dialog.locator('[data-sd-builder-field="name"]')).toHaveValue('AI Draft Name', { timeout: 15_000 });

        const reqs = builderRequests().slice(reqBefore);
        const toolNames = reqs[0].body.tools.map(t => t.function.name);
        expect(toolNames).toContain('generate_image');
        expect(toolNames).toContain('stage_character_profile');
        expect(toolNames).not.toContain('save_character_profile');
        expect(toolNames).not.toContain('read_character_card');
        expect(toolNames).not.toContain('read_user_persona');
        expect(toolNames).not.toContain('world_book_list');

        // Multimodal visual preview reached round 2 because visualInspection is enabled.
        const round2ImageParts = reqs[1].body.messages
            .filter(m => m.role === 'user' && Array.isArray(m.content))
            .flatMap(m => m.content)
            .filter(p => p.type === 'image_url' && p.image_url?.url?.startsWith('data:image/'));
        expect(round2ImageParts.length).toBeGreaterThan(0);

        // Turn 2: delay LLM response so user edits 'name' mid-turn, creating a real conflict.
        const manualName = `Manual Keeper ${randomUUID()}`;
        turnStep = 'turn2_stage';
        llm.setLatencyMs(1200);
        try {
            await dialog.locator('[data-sd-role="builder-input"]').fill('Add source work metadata.');
            await dialog.locator('[data-sd-role="builder-send"]').click();
            await dialog.locator('[data-sd-builder-field="name"]').fill(manualName);
            await expect(dialog.locator('[data-sd-role="builder-conflict"][data-conflict-path="name"]')).toBeVisible({ timeout: 20_000 });
        } finally {
            llm.setLatencyMs(0);
        }

        // Manual edit preserved while non-conflicting sourceWork merged.
        await expect(dialog.locator('[data-sd-builder-field="name"]')).toHaveValue(manualName);
        await expect(dialog.locator('[data-sd-builder-field="sourceWork"]')).toHaveValue('Harbor Chronicles');

        // Confirm refuses while conflict is unresolved.
        await dialog.locator('[data-sd-role="builder-confirm"]').click();
        await expect(dialog.locator('[data-sd-role="builder-error"]')).toBeVisible();
        await expect(dialog).toBeVisible();

        // Resolve conflict keeping manual edit, then confirm save.
        await dialog.locator('[data-sd-role="builder-conflict"][data-conflict-path="name"] [data-sd-choice="keep_manual"]').click();
        await expect(dialog.locator('[data-sd-role="builder-conflicts"]')).toHaveCount(0);

        const sessionId = generatedPath.split('/')[4];
        await dialog.locator('[data-sd-role="builder-confirm"]').click();
        await expect(dialog).toBeHidden({ timeout: 15_000 });

        // Formal profile persisted with promoted _references image and zero _sandbox_tmp residue.
        expect(listSandboxSessionDirs()).not.toContain(sessionId);
        const savedProfiles = await readProfiles(page);
        const saved = Object.values(savedProfiles).find(p => p.name === manualName);
        expect(saved).toBeTruthy();
        expect(saved.sourceWork).toBe('Harbor Chronicles');
        const formalImg = saved.outfits[0].referenceImages[0];
        expect(formalImg).toMatch(/^\/user\/images\/_references\//);
        expect(existsSync(join(server.dataRoot, 'default-user', formalImg.replace(/^\//, '')))).toBe(true);

        // Undo from Workbench Change history removes the newly saved profile.
        await openChangeHistory(page);
        await undoLatestHistoryEntry(page);
        await expect.poll(async () => Boolean((await readProfiles(page))[saved.id]), { timeout: 15_000 }).toBe(false);
    });

    test('explicit card source exposes card and worldbook readers, refines an existing profile, and stacks on narrow viewports', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await configureConnectionAndComfy(page, { visualInspection: false });

        const suffix = randomUUID();
        const bookName = `Builder World ${suffix}`;
        await importWorldDocument(page, bookName, {
            entries: {
                0: {
                    uid: 0,
                    key: ['uniform'],
                    comment: 'Uniform note',
                    content: 'Wears a deep teal navigator cloak.',
                    constant: false,
                    disable: false,
                    order: 100,
                },
            },
        });
        const cardAvatar = await importSourceCard(page, `Builder Card ${suffix}`, bookName);

        // Create an existing profile manually first, verifying manual create/upload/save works.
        const archive = await openArchive(page);
        await archive.locator('[data-sd-role="new-profile"]').first().click();
        const baseName = `Manual Base ${suffix}`;
        await archive.locator('[data-sd-field="profile-name"]').fill(baseName);
        const uploadChooser = page.waitForEvent('filechooser');
        await archive.getByRole('button', { name: /Upload local reference image|上传本地参考图|上傳本機參考圖/ }).click();
        await (await uploadChooser).setFiles(SAMPLE_PNG_PATH);
        await expect(archive.locator('.sdlens-chars-detail .sdlens-ref-item')).toHaveCount(1, { timeout: 15_000 });
        await archive.locator('[data-sd-role="save-profile"]').click();
        await expect.poll(async () => Object.values(await readProfiles(page)).some(p => p.name === baseName)).toBe(true);
        const existingProfile = Object.values(await readProfiles(page)).find(p => p.name === baseName);

        // Refine with AI on narrow viewport (<= 720px).
        await page.setViewportSize({ width: 390, height: 844 });
        const reqBefore = builderRequests().length;
        let step = 0;
        llm.scriptCompletion(({ body }) => {
            step += 1;
            if (step === 1) {
                return {
                    toolCalls: [
                        { name: 'read_character_card', arguments: {} },
                        { name: 'world_book_list', arguments: {} },
                        { name: 'fetch_reference_image', arguments: { image_url: `/characters/${cardAvatar}`, profile_id: existingProfile.id } },
                    ],
                };
            }
            if (step === 2) {
                const fetchRes = JSON.parse(body.messages.findLast(m => m.role === 'tool').content);
                return {
                    tool: 'stage_character_profile',
                    arguments: {
                        canonical_tags: ['copper_hair', 'teal_cloak'],
                        outfits: [
                            {
                                id: existingProfile.outfits[0].id,
                                name: 'Navigator Cloak',
                                tags: ['teal_cloak'],
                                reference_images: [fetchRes.imagePath],
                            },
                        ],
                    },
                };
            }
            return { text: 'Refined existing profile from card source.' };
        });

        await archive.locator('[data-sd-role="refine-with-ai"]').click();
        const dialog = page.locator('[data-sd-role="character-builder-dialog"]').last();
        await expect(dialog).toBeVisible();

        // Check narrow stacked layout (chat pane above draft pane).
        const layout = await dialog.evaluate(el => {
            const chat = el.querySelector('.sdlens-builder-chat-pane')?.getBoundingClientRect();
            const draft = el.querySelector('.sdlens-builder-draft-pane')?.getBoundingClientRect();
            return {
                chatBottom: chat?.bottom ?? 0,
                draftTop: draft?.top ?? 0,
                overflowX: el.scrollWidth - el.clientWidth,
            };
        });
        expect(layout.draftTop).toBeGreaterThanOrEqual(layout.chatBottom - 2);
        expect(layout.overflowX).toBeLessThanOrEqual(2);

        await dialog.locator('[data-sd-role="builder-source-select"]').selectOption(`card:${cardAvatar}`);
        await dialog.locator('[data-sd-role="builder-input"]').fill('Read the card and update cloak details.');
        await dialog.locator('[data-sd-role="builder-send"]').click();
        await expect.poll(() => builderRequests().length, { timeout: 30_000 }).toBe(reqBefore + 3);

        const reqs = builderRequests().slice(reqBefore);
        const tools = reqs[0].body.tools.map(t => t.function.name);
        expect(tools).toContain('read_character_card');
        expect(tools).toContain('world_book_list');
        expect(tools).not.toContain('read_user_persona');

        await dialog.locator('[data-sd-role="builder-confirm"]').click();
        await expect(dialog).toBeHidden({ timeout: 15_000 });

        const updated = (await readProfiles(page))[existingProfile.id];
        expect(updated.canonicalTags).toEqual(['copper_hair', 'teal_cloak']);
        expect(updated.outfits[0].name).toBe('Navigator Cloak');
        expect(updated.outfits[0].referenceImages[0]).toMatch(/^\/user\/images\/_references\//);

        // Restore desktop viewport and verify manual Delete still works.
        await page.setViewportSize({ width: 1280, height: 800 });
        await archive.locator('[data-sd-role="delete-profile"]').click();
        await page.getByRole('alertdialog').getByRole('button', { name: /^(Confirm|确认|確認)$/ }).click();
        await expect.poll(async () => Boolean((await readProfiles(page))[existingProfile.id])).toBe(false);
    });
});
