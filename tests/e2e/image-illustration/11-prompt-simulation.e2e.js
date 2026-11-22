// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import {
    awaitMainUI,
    closeAnyOpenTopSettingsDrawer,
    fillTopmostPopupAndAccept,
    openExtensionsDrawer,
    openInlineDrawer,
    selectCharacterByName,
} from '../_lib/page.js';
import {
    annotateSimulationReviewText,
    applyIterateChanges,
    cancelSimulationReview,
    closeWorkbench,
    openChangeHistory,
    openWorkbenchIterate,
    rerunSimulationReview,
    submitSimulationReview,
    switchWorkbenchTab,
    waitForSimulationReview,
    workbenchWindow,
} from '../_lib/ui-workbench.js';

const COMFY_URL = 'http://127.0.0.1:8188';

let server;
let llm;

test.beforeAll(async () => {
    llm = await startMockLLM();
    server = await startServer({
        batchKey: 'image-illustration',
        scenarioId: '11-prompt-simulation',
        extraConfig: { enableUserAccounts: false, disableUpdateCheck: true },
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await llm.stop();
});

function readSettingsJson() {
    return JSON.parse(readFileSync(join(server.dataRoot, 'default-user/settings.json'), 'utf8'));
}

function readIllustrationSettings() {
    return readSettingsJson().extension_settings.sd.illustration;
}

function listDirFiles(relativePath) {
    const dir = join(server.dataRoot, 'default-user', relativePath);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).sort();
}

function listChatFilesSnapshot() {
    const chatsRoot = join(server.dataRoot, 'default-user/chats');
    if (!existsSync(chatsRoot)) return {};
    const out = {};
    for (const entry of readdirSync(chatsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const sub = join(chatsRoot, entry.name);
        for (const file of readdirSync(sub).sort()) {
            const full = join(sub, file);
            out[`${entry.name}/${file}`] = readFileSync(full, 'utf8');
        }
    }
    return out;
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

async function selectMainOpenAiPreset(page, presetName) {
    const drawerIcon = page.locator('#leftNavDrawerIcon');
    const isOpen = await drawerIcon.evaluate(el => el.classList.contains('openIcon'));
    if (!isOpen) {
        await drawerIcon.click();
    }
    const nativeSelect = page.locator('#settings_preset_openai');
    if (await nativeSelect.isVisible().catch(() => false)) {
        await nativeSelect.selectOption({ label: presetName });
    } else {
        const s2Trigger = page.locator('#settings_preset_openai + .select2 .select2-selection').first();
        await expect(s2Trigger).toBeVisible({ timeout: 10_000 });
        await s2Trigger.click();
        const option = page.locator('.select2-results__option').filter({ hasText: new RegExp(`^${presetName}$`) }).first();
        await expect(option).toBeVisible({ timeout: 10_000 });
        await option.click();
    }
    await expect.poll(
        () => page.evaluate(() => window.Luker.getContext().chatCompletionSettings?.preset_settings_openai),
        { timeout: 10_000 },
    ).toBe(presetName);
}

async function configureConnectionAndComfy(page) {
    await page.locator('#API-status-top').click();
    await page.locator('#main_api').selectOption('openai');
    await page.locator('#chat_completion_source').selectOption('custom');
    await page.locator('#custom_api_url_text').fill(llm.baseURL);
    await page.locator('#custom_api_url_text').press('Tab');
    await page.locator('#api_button_openai').click();
    await expect(page.locator('#model_custom_select option[value="mock-gpt-4o"]')).toHaveCount(1);
    await page.locator('#model_custom_select').selectOption('mock-gpt-4o');
    const completionPreset = 'Default';
    const profileName = `Sim conn ${randomUUID()}`;
    await page.locator('#create_connection_profile').click();
    await fillTopmostPopupAndAccept(page, profileName);
    await expect(page.locator('#connection_profiles option', { hasText: profileName })).toHaveCount(1);
    await page.locator('#API-status-top').click();
    await selectMainOpenAiPreset(page, completionPreset);

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
    await page.locator('#sd_illustration_api_preset').selectOption({ label: profileName });
    await page.locator('#sd_illustration_llm_preset').selectOption({ label: completionPreset });
    const expConn = page.locator('#sd_illustration_exploration_api_preset');
    if (!(await expConn.isVisible())) {
        await expConn.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " inline-drawer ")][1]')
            .locator('> .inline-drawer-toggle').click();
    }
    await expConn.selectOption({ label: profileName });
    await page.locator('#sd_illustration_exploration_llm_preset').selectOption({ label: completionPreset });
    await page.locator('#sd_illustration_visual_inspection').uncheck();

    await expect.poll(() => {
        const settings = readIllustrationSettings();
        const cur = settings.presets.find(p => p.id === settings.currentPresetId);
        return {
            llm: cur?.llm,
            explorationLlm: cur?.explorationLlm,
        };
    }).toEqual({
        llm: { apiPresetName: profileName, llmPresetName: completionPreset },
        explorationLlm: { apiPresetName: profileName, llmPresetName: completionPreset },
    });
    await closeAnyOpenTopSettingsDrawer(page);

    // Point Workbench shared AI connection and generation preset to the test connection & Default preset via UI.
    const wbWin = await switchWorkbenchTab(page, 'settings');
    const sharedBlock = wbWin.locator('.wb-ai-shared');
    await expect(sharedBlock.locator('select')).toHaveCount(2, { timeout: 15_000 });
    await sharedBlock.locator('select').nth(0).selectOption(profileName);
    await sharedBlock.locator('select').nth(1).selectOption(completionPreset);
    await closeWorkbench(page);
    return { profileName, completionPreset };
}

test.describe.serial('Workbench SD prompt simulation review loop', () => {
    test.setTimeout(240_000);

    test('simulates unsaved illustration, background exploration, and multi-turn dialog prompts with annotations, re-run, and zero leaked state', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await configureConnectionAndComfy(page);

        await selectCharacterByName(page, 'Seraphina');
        const firstMessageText = await page.evaluate(() => String(window.Luker.getContext().chat?.[0]?.mes || ''));
        expect(firstMessageText.length).toBeGreaterThan(20);
        const anchorMid = Math.floor(firstMessageText.length / 2);
        const insertAfter = firstMessageText.slice(Math.max(0, anchorMid - 18), anchorMid);
        const insertBefore = firstMessageText.slice(anchorMid, anchorMid + 18);

        // Open Workbench AI iteration first so one-time Workbench/chat metadata initialization settles before baseline capture.
        const win = await openWorkbenchIterate(page, 'sd', { newSession: true });
        await expect.poll(
            () => Object.values(listChatFilesSnapshot()).some(txt => txt.includes('last_user_persona')),
            { timeout: 10_000 },
        ).toBe(true);

        // Snapshot all persistent & runtime surfaces right before sending the iteration + simulation turn.
        const beforeIllustrationSettings = readIllustrationSettings();
        const activePreset = beforeIllustrationSettings.presets.find(p => p.id === beforeIllustrationSettings.currentPresetId);
        expect(activePreset).toBeTruthy();
        const beforeProfiles = await readProfiles(page);
        const beforeChatsOnDisk = listChatFilesSnapshot();
        const beforeReferences = listDirFiles('user/images/_references');
        const beforeSandboxDirs = listDirFiles('user/images/_sandbox_tmp');
        const beforeSdRunsCount = await page.evaluate(() => {
            const rec = window.Luker.getContext().runPanel?.getRunRecorder?.();
            return (rec?.getHistory?.() || []).filter(r => r.source === 'sd').length;
        });
        const beforeInspectorIds = await page.evaluate(async () => {
            const res = await fetch('/api/request-inspector/list');
            return (await res.json()).map(entry => entry.id);
        });

        const DRAFT_ILL_MARKER = `DRAFT_ILL_PROMPT_${randomUUID()}`;
        const DRAFT_EXP_MARKER = `DRAFT_EXP_PROMPT_${randomUUID()}`;
        const REFINED_ILL_MARKER = `MISTY_DAWN_REFINED_${randomUUID()}`;

        let iterateTurn = 0;
        let illAttempt = 0;
        let dialogStep = 0;
        let lastSimIllustrationToolMsg = '';
        let lastSimBgToolMsg = '';
        let lastSimDialogToolMsg = '';
        const observedIllPrompts = [];
        const observedExpPrompts = [];

        const flattenMessagesText = (messages) => (Array.isArray(messages) ? messages : [])
            .map(m => (typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '')))
            .join('\n');

        llm.scriptCompletion(({ body }) => {
            const toolNames = (body.tools || []).map(t => t.function?.name).filter(Boolean);

            // 1. Workbench SD AI iteration model.
            if (toolNames.includes('sd_simulate_illustration')) {
                iterateTurn += 1;
                if (iterateTurn === 1) {
                    return {
                        toolCalls: [{
                            name: 'sd_update_preset',
                            arguments: {
                                preset_id: activePreset.id,
                                illustration_prompt: `${activePreset.illustrationPrompt}\n${DRAFT_ILL_MARKER}`,
                                exploration_prompt: `${activePreset.explorationPrompt}\n${DRAFT_EXP_MARKER}`,
                            },
                        }],
                    };
                }
                if (iterateTurn === 2) {
                    return {
                        toolCalls: [{
                            name: 'sd_simulate_illustration',
                            arguments: {
                                preset_id: activePreset.id,
                                message_index: 0,
                                allow_exploration: true,
                            },
                        }],
                    };
                }
                if (iterateTurn === 3) {
                    const toolMsg = body.messages.findLast(m => m.role === 'tool');
                    lastSimIllustrationToolMsg = String(toolMsg?.content || '');
                    return {
                        toolCalls: [
                            {
                                name: 'sd_update_preset',
                                arguments: {
                                    preset_id: activePreset.id,
                                    illustration_prompt: `${activePreset.illustrationPrompt}\n${DRAFT_ILL_MARKER}\n${REFINED_ILL_MARKER}`,
                                },
                            },
                            {
                                name: 'sd_simulate_exploration',
                                arguments: {
                                    preset_id: activePreset.id,
                                    mode: 'background',
                                    targets: [{ name: 'Harbor Signalman', work: 'Coastal Tale' }],
                                    user_hint: 'Focus on signal coat details.',
                                },
                            },
                        ],
                    };
                }
                if (iterateTurn === 4) {
                    const toolMsg = body.messages.findLast(m => m.role === 'tool');
                    lastSimBgToolMsg = String(toolMsg?.content || '');
                    return {
                        toolCalls: [{
                            name: 'sd_simulate_exploration',
                            arguments: {
                                preset_id: activePreset.id,
                                mode: 'dialog',
                                user_turns: [
                                    'Create a portrait of a lighthouse keeper in a storm coat.',
                                    'Add brass spectacles to the canonical tags.',
                                ],
                                source: { kind: 'none' },
                            },
                        }],
                    };
                }
                const toolMsg = body.messages.findLast(m => m.role === 'tool');
                lastSimDialogToolMsg = String(toolMsg?.content || '');
                return {
                    text: `Updated illustration prompt with ${REFINED_ILL_MARKER} after reviewing your simulation annotations.`,
                };
            }

            // 2. Illustration agent inside sd_simulate_illustration.
            if (toolNames.includes('add_image_prompt')) {
                observedIllPrompts.push(flattenMessagesText(body.messages));
                const hasExplored = body.messages.some(m => m.role === 'tool');
                if (!hasExplored) {
                    illAttempt += 1;
                    return {
                        reasoning: `Illustration attempt #${illAttempt}: exploring guest figure first.`,
                        toolCalls: [{
                            name: 'explore_characters',
                            arguments: {
                                targets: [{ name: `Pier Witness ${illAttempt}` }],
                            },
                        }],
                    };
                }
                const scenePhrase = illAttempt === 1
                    ? 'golden sunset pier'
                    : 'moonlit harbor pier';
                return {
                    reasoning: `Illustration attempt #${illAttempt}: emitting scene prompt.`,
                    toolCalls: [{
                        name: 'add_image_prompt',
                        arguments: {
                            prompt: `1girl, ${scenePhrase}, sea mist, detailed illustration`,
                            negative_prompt: 'blurry, lowres',
                            aspect_ratio: '1:1',
                            insert_after: insertAfter,
                            insert_before: insertBefore,
                        },
                    }],
                };
            }

            // 3. Background exploration agent (both nested in illustration & standalone background simulation).
            if (toolNames.includes('save_character_profile')) {
                const fullText = flattenMessagesText(body.messages);
                observedExpPrompts.push(fullText);
                const hasSaved = body.messages.some(m => m.role === 'tool');
                if (!hasSaved) {
                    const isStandalone = fullText.includes('Harbor Signalman');
                    const id = isStandalone ? 'char_sim_signalman' : `char_sim_witness_${illAttempt}`;
                    const name = isStandalone ? 'Harbor Signalman' : `Pier Witness ${illAttempt}`;
                    return {
                        reasoning: `Archiving ${name} into sandbox store.`,
                        toolCalls: [{
                            name: 'save_character_profile',
                            arguments: {
                                id,
                                name,
                                canonical_tags: ['storm_coat', 'brass_lantern'],
                                prose_description: 'Weathered coastal watchman.',
                                outfits: [{ id: 'outfit_default', name: 'Storm Coat', tags: ['navy_oilskin'] }],
                                default_outfit_id: 'outfit_default',
                            },
                        }],
                    };
                }
                return { text: 'Sandbox character profile archived.' };
            }

            // 4. Conversational character builder inside sd_simulate_exploration(mode="dialog").
            if (toolNames.includes('stage_character_profile')) {
                observedExpPrompts.push(flattenMessagesText(body.messages));
                dialogStep += 1;

                if (dialogStep === 1) {
                    return {
                        reasoning: 'Generating candidate keeper portrait with ComfyUI.',
                        toolCalls: [{
                            name: 'generate_image',
                            arguments: {
                                prompt: '1boy, lighthouse keeper, dark storm coat, lantern light, portrait',
                            },
                        }],
                    };
                }
                if (dialogStep === 2) {
                    const genResult = JSON.parse(body.messages.findLast(m => m.role === 'tool').content);
                    return {
                        toolCalls: [{
                            name: 'stage_character_profile',
                            arguments: {
                                name: 'Lighthouse Keeper',
                                canonical_tags: ['weathered_face', 'dark_storm_coat'],
                                outfits: [{
                                    id: 'outfit_keeper',
                                    name: 'Storm Watch',
                                    tags: ['dark_storm_coat'],
                                    reference_images: [genResult.imagePath],
                                }],
                                default_outfit_id: 'outfit_keeper',
                            },
                        }],
                    };
                }
                if (dialogStep === 3) {
                    return { text: 'Generated portrait and staged Lighthouse Keeper draft.' };
                }
                if (dialogStep === 4) {
                    return {
                        toolCalls: [{
                            name: 'stage_character_profile',
                            arguments: {
                                canonical_tags: ['weathered_face', 'dark_storm_coat', 'brass_spectacles'],
                            },
                        }],
                    };
                }
                return { text: 'Added brass spectacles to the Lighthouse Keeper draft.' };
            }

            return { text: 'Unexpected request.' };
        });

        // Send the iteration prompt inside the already-open Workbench AI iteration view.
        await win.locator('.wb-chat .wb-input').first().fill(
            'Tune illustration and exploration prompts, simulate illustration, background archive, and multi-turn dialog builder, then refine based on my annotations.',
        );
        await win.locator('.wb-chat .wb-send').first().click();

        // Popup 1: Simulation Review — AI Illustration (with real ComfyUI image).
        const illDialog = await waitForSimulationReview(page, {
            titlePattern: /Simulation Review — AI Illustration|模拟回顾 — AI 插图|模擬回顧 — AI 插圖/,
            timeoutMs: 90_000,
        });
        await expect(illDialog.locator('.luker-sim-review')).toContainText('golden sunset pier');
        const firstImg = illDialog.locator('img.luker-sim-image[data-sim-ignore="true"]').first();
        await expect(firstImg).toBeVisible();
        await expect.poll(async () => firstImg.evaluate(el => el.complete && el.naturalWidth > 0)).toBe(true);

        // Re-run inside the open Simulation Review popup; attempt 2 starts from the original snapshot.
        await rerunSimulationReview(illDialog, { timeoutMs: 90_000 });
        await expect(illDialog.locator('.luker-sim-review')).toContainText('moonlit harbor pier');
        await expect(illDialog.locator('.luker-sim-review')).not.toContainText('Pier Witness 1');
        await expect(illDialog.locator('.luker-sim-review')).toContainText('Pier Witness 2');

        // Turn on Annotation mode, drag-select snippet with real mouse events, comment, and Submit.
        await annotateSimulationReviewText(page, illDialog, 'moonlit harbor pier', 'Prefer misty dawn lighting');
        await submitSimulationReview(illDialog);

        // Popup 2: Simulation Review — Character Profile Agent (background mode).
        const bgDialog = await waitForSimulationReview(page, {
            titlePattern: /Simulation Review — Character Profile Agent|模拟回顾 — 角色建档 Agent|模擬回顧 — 角色建檔 Agent/,
            timeoutMs: 60_000,
        });
        await expect(bgDialog.locator('.luker-sim-review')).toContainText('Harbor Signalman');
        await submitSimulationReview(bgDialog);

        // Popup 3: Simulation Review — Character Profile Agent (dialog multi-turn mode with real ComfyUI image).
        const dlgDialog = await waitForSimulationReview(page, {
            titlePattern: /Simulation Review — Character Profile Agent|模拟回顾 — 角色建档 Agent|模擬回顧 — 角色建檔 Agent/,
            timeoutMs: 90_000,
        });
        await expect(dlgDialog.locator('.luker-sim-review')).toContainText('Lighthouse Keeper');
        await expect(dlgDialog.locator('.luker-sim-review')).toContainText('brass_spectacles');
        const dlgImg = dlgDialog.locator('img.luker-sim-image[data-sim-ignore="true"]').first();
        await expect(dlgImg).toBeVisible();
        await expect.poll(async () => dlgImg.evaluate(el => el.complete && el.naturalWidth > 0)).toBe(true);
        await cancelSimulationReview(dlgDialog);

        // Wait for the iteration turn to settle and show the pending change card.
        const applyBtn = win.locator('.wb-chg.is-pending .wb-chg-foot button.is-primary').last();
        await expect(applyBtn).toBeVisible({ timeout: 30_000 });

        // Verify unsaved draft prompts were sent to the simulated agents and annotations fed back cleanly.
        expect(observedIllPrompts.some(p => p.includes(DRAFT_ILL_MARKER))).toBe(true);
        expect(observedExpPrompts.some(p => p.includes(DRAFT_EXP_MARKER))).toBe(true);
        expect(lastSimIllustrationToolMsg).toContain('<simulation_result kind="sd-illustration" ok="true"');
        expect(lastSimIllustrationToolMsg).toContain('Prefer misty dawn lighting');
        expect(lastSimIllustrationToolMsg).toContain('<<<ANNOTATION id=1>>>moonlit harbor pier<<</ANNOTATION>>>');
        expect(lastSimIllustrationToolMsg).not.toContain('data:image/');
        expect(lastSimBgToolMsg).toContain('<simulation_result kind="sd-exploration" ok="true"');
        expect(lastSimBgToolMsg).toContain('Harbor Signalman');
        expect(lastSimDialogToolMsg).toContain('<simulation_result kind="sd-exploration" ok="false" cancelled="true"');
        expect(lastSimDialogToolMsg).not.toContain('data:image/');

        // Verify ZERO state leakage before Apply across disk, GlobalState, chat, media, runs, history, inspector, and jobs.
        const midIllustrationSettings = readIllustrationSettings();
        const midActivePreset = midIllustrationSettings.presets.find(p => p.id === activePreset.id);
        expect(midActivePreset.illustrationPrompt).toBe(activePreset.illustrationPrompt);
        expect(midActivePreset.explorationPrompt).toBe(activePreset.explorationPrompt);

        expect(await readProfiles(page)).toEqual(beforeProfiles);
        expect(listChatFilesSnapshot()).toEqual(beforeChatsOnDisk);
        expect(listDirFiles('user/images/_references')).toEqual(beforeReferences);
        expect(listDirFiles('user/images/_sandbox_tmp')).toEqual(beforeSandboxDirs);

        const afterSdRunsCount = await page.evaluate(() => {
            const rec = window.Luker.getContext().runPanel?.getRunRecorder?.();
            return (rec?.getHistory?.() || []).filter(r => r.source === 'sd').length;
        });
        expect(afterSdRunsCount).toBe(beforeSdRunsCount);

        const inspectorCheck = await page.evaluate(async (prevIds) => {
            const prevSet = new Set(prevIds);
            const list = await (await fetch('/api/request-inspector/list')).json();
            const added = list.filter(entry => !prevSet.has(entry.id));
            const details = await Promise.all(added.map(async entry => (await fetch(`/api/request-inspector/${entry.id}`)).json()));
            return { addedCount: added.length, details };
        }, beforeInspectorIds);
        // Only the Workbench AI iteration requests themselves were recorded; zero simulation LLM or ComfyUI requests leaked.
        expect(inspectorCheck.addedCount).toBe(iterateTurn);
        for (const entry of inspectorCheck.details) {
            expect(entry.type || 'chat').toBe('chat');
            const systemTexts = (Array.isArray(entry.fullMessages) ? entry.fullMessages : [])
                .filter(m => m?.role === 'system')
                .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
                .join('\n');
            expect(systemTexts).not.toContain(DRAFT_ILL_MARKER);
            expect(systemTexts).not.toContain(DRAFT_EXP_MARKER);
            const reqTools = Array.isArray(entry.requestBody?.tools)
                ? entry.requestBody.tools.map(t => t?.function?.name)
                : [];
            expect(reqTools).not.toContain('add_image_prompt');
            expect(reqTools).not.toContain('save_character_profile');
            expect(reqTools).not.toContain('stage_character_profile');
        }

        const activeJobs = await page.evaluate(async () => {
            const res = await fetch('/api/backends/chat-completions/jobs/active', {
                method: 'POST',
                headers: window.Luker.getContext().getRequestHeaders(),
                body: JSON.stringify({}),
            });
            const data = await res.json();
            return Array.isArray(data?.jobs) ? data.jobs : data;
        });
        expect(activeJobs).toEqual([]);

        // Change history has 0 entries prior to Apply.
        await openChangeHistory(page);
        await expect(workbenchWindow(page).locator('.wb-hist-item')).toHaveCount(0);

        // Return to AI iteration, confirm the refined draft is in the pending diff, apply it, and confirm persistence.
        await openWorkbenchIterate(page, 'sd');
        await expect(win.locator('.wb-msg-ai').last()).toContainText(REFINED_ILL_MARKER);
        await applyIterateChanges(page);

        await expect.poll(() => {
            const saved = readIllustrationSettings();
            return saved.presets.find(p => p.id === activePreset.id)?.illustrationPrompt || '';
        }, { timeout: 15_000 }).toContain(REFINED_ILL_MARKER);
    });
});
