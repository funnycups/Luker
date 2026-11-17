// SPDX-License-Identifier: AGPL-3.0-or-later
//
// #69 — Active preset name tracking across card-bound presets & clean cold-reload
// restoration of the selected global preset.
//
// Guards two contracts:
//   1. `oai_settings.preset_settings_openai` reflects the currently active
//      preset name across global ↔ card-bound and card-bound ↔ card-bound
//      switches so event listeners inspecting `preset_settings_openai` detect
//      every transition, while `oai_settings.global_preset_settings_openai`
//      retains the last selected global preset for character-switch fallback.
//   2. Reloading Luker when `auto_load_chat` is false after a session that
//      ended on a card-bound preset restores the selected global preset's
//      settings and `extensions.regex_scripts` instead of stranding the
//      card-bound body on the global preset and overwriting it on save.

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import {
    bootstrapCustomBackend,
    appendConnectionProfile,
    markOnboarded,
    writePreset,
} from '../_lib/fixtures.js';
import {
    awaitMainUI,
    reloadAndAwait,
    selectCharacterByName,
} from '../_lib/page.js';
import {
    normalizeIterStudioSettings,
    selectPresetByName,
    ensureOaiDrawerOpen,
} from './_helpers.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const DEFAULT_SEED_PATH = resolve(REPO_ROOT, 'default/content/presets/openai/Default.json');

const GLOBAL_HARBOR_PRESET = 'Harbor Watch Global';
const GLOBAL_HARBOR_TEMP = 0.62;
const GLOBAL_REGEX_ID = 'rx-harbor-global-001';

const CARD_ALPHA_PRESET = 'Signal Lantern Alpha';
const CARD_ALPHA_TEMP = 0.31;
const CARD_ALPHA_REGEX_ID = 'rx-signal-alpha-001';

const CARD_BETA_PRESET = 'Signal Lantern Beta';
const CARD_BETA_TEMP = 0.48;
const CARD_BETA_REGEX_ID = 'rx-signal-beta-001';

const BOUND_CHAR_NAME = 'Lira the Signalwoman';
const BOUND_CHAR_AVATAR = 'lira-the-signalwoman.png';

const PLAIN_CHAR_NAME = 'Rowan the Ferryman';
const PLAIN_CHAR_AVATAR = 'rowan-the-ferryman.png';

let server;
let mock;

function makeRegexScript(id, scriptName, findRegex, replaceString) {
    return {
        id,
        scriptName,
        findRegex,
        replaceString,
        trimStrings: [],
        placement: [2],
        disabled: false,
        markdownOnly: false,
        promptOnly: false,
        runOnEdit: false,
        substituteRegex: 0,
        minDepth: null,
        maxDepth: null,
    };
}

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'preset',
        scenarioId: 'card-bound-active-name-and-cold-reload',
        extraConfig: { 'storage.mode': 'fs' },
    });

    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL, stream: false });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    const seed = JSON.parse(readFileSync(DEFAULT_SEED_PATH, 'utf8'));

    writePreset({
        dataRoot: server.dataRoot,
        name: GLOBAL_HARBOR_PRESET,
        overrides: {
            temperature: GLOBAL_HARBOR_TEMP,
            extensions: {
                regex_scripts: [
                    makeRegexScript(GLOBAL_REGEX_ID, 'Harbor Global Rule', 'harbor', 'port'),
                ],
            },
        },
    });

    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: BOUND_CHAR_AVATAR,
        overrides: {
            name: BOUND_CHAR_NAME,
            extensions: {
                luker: {
                    chat_completion_preset: {
                        presets: [
                            {
                                name: CARD_ALPHA_PRESET,
                                preset: {
                                    temperature: CARD_ALPHA_TEMP,
                                    prompts: seed.prompts,
                                    prompt_order: seed.prompt_order,
                                    extensions: {
                                        regex_scripts: [
                                            makeRegexScript(CARD_ALPHA_REGEX_ID, 'Signal Alpha Rule', 'alpha', 'first'),
                                        ],
                                    },
                                },
                            },
                            {
                                name: CARD_BETA_PRESET,
                                preset: {
                                    temperature: CARD_BETA_TEMP,
                                    prompts: seed.prompts,
                                    prompt_order: seed.prompt_order,
                                    extensions: {
                                        regex_scripts: [
                                            makeRegexScript(CARD_BETA_REGEX_ID, 'Signal Beta Rule', 'beta', 'second'),
                                        ],
                                    },
                                },
                            },
                        ],
                        defaultPresetName: CARD_ALPHA_PRESET,
                    },
                },
            },
        },
    });

    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: PLAIN_CHAR_AVATAR,
        overrides: {
            name: PLAIN_CHAR_NAME,
        },
    });

    normalizeIterStudioSettings(server.dataRoot);

    const settingsPath = resolve(server.dataRoot, 'default-user', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    settings.extension_settings = settings.extension_settings || {};
    settings.extension_settings.preset_allowed_regex = {
        openai: [GLOBAL_HARBOR_PRESET, CARD_ALPHA_PRESET, CARD_BETA_PRESET],
    };
    writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#69 — card-bound active preset name & cold-reload restoration', () => {
    test('updates preset_settings_openai across card-bound switches while retaining global fallback and restoring cleanly on cold reload', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Select the global preset first.
        await selectPresetByName(page, GLOBAL_HARBOR_PRESET);
        await expect
            .poll(async () => Number(await page.locator('#temp_counter_openai').inputValue()), { timeout: 10_000 })
            .toBeCloseTo(GLOBAL_HARBOR_TEMP, 5);

        // Attach a read-only observer on OAI_PRESET_CHANGED_AFTER to record
        // `preset_settings_openai` across card-bound transitions.
        await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            window.__presetAfterLog = [];
            ctx.eventSource.on(ctx.eventTypes.OAI_PRESET_CHANGED_AFTER, () => {
                window.__presetAfterLog.push({
                    active: ctx.chatCompletionSettings.preset_settings_openai,
                    globalFallback: ctx.chatCompletionSettings.global_preset_settings_openai,
                });
            });
        });

        // Select Lira -> auto-applies Card Alpha.
        await selectCharacterByName(page, BOUND_CHAR_NAME);
        await expect
            .poll(async () => Number(await page.locator('#temp_counter_openai').inputValue()), { timeout: 10_000 })
            .toBeCloseTo(CARD_ALPHA_TEMP, 5);

        await expect.poll(async () => {
            return await page.evaluate(() => ({
                active: window.Luker.getContext().chatCompletionSettings.preset_settings_openai,
                globalFallback: window.Luker.getContext().chatCompletionSettings.global_preset_settings_openai,
                log: window.__presetAfterLog,
            }));
        }, { timeout: 10_000 }).toEqual({
            active: CARD_ALPHA_PRESET,
            globalFallback: GLOBAL_HARBOR_PRESET,
            log: expect.arrayContaining([
                { active: CARD_ALPHA_PRESET, globalFallback: GLOBAL_HARBOR_PRESET },
            ]),
        });

        // Switch between two card-bound presets on the same card (Alpha -> Beta).
        await selectPresetByName(page, CARD_BETA_PRESET);
        await expect
            .poll(async () => Number(await page.locator('#temp_counter_openai').inputValue()), { timeout: 10_000 })
            .toBeCloseTo(CARD_BETA_TEMP, 5);

        await expect.poll(async () => {
            return await page.evaluate(() => ({
                active: window.Luker.getContext().chatCompletionSettings.preset_settings_openai,
                globalFallback: window.Luker.getContext().chatCompletionSettings.global_preset_settings_openai,
                regexIds: (window.Luker.getContext().chatCompletionSettings.extensions?.regex_scripts || []).map(r => r.id),
                log: window.__presetAfterLog,
            }));
        }, { timeout: 10_000 }).toEqual({
            active: CARD_BETA_PRESET,
            globalFallback: GLOBAL_HARBOR_PRESET,
            regexIds: [CARD_BETA_REGEX_ID],
            log: expect.arrayContaining([
                { active: CARD_BETA_PRESET, globalFallback: GLOBAL_HARBOR_PRESET },
            ]),
        });

        // Switch to plain character Rowan -> restores GlobalHarbor.
        await selectCharacterByName(page, PLAIN_CHAR_NAME);
        await expect
            .poll(async () => Number(await page.locator('#temp_counter_openai').inputValue()), { timeout: 10_000 })
            .toBeCloseTo(GLOBAL_HARBOR_TEMP, 5);
        await expect.poll(async () => {
            return await page.evaluate(() => ({
                active: window.Luker.getContext().chatCompletionSettings.preset_settings_openai,
                globalFallback: window.Luker.getContext().chatCompletionSettings.global_preset_settings_openai,
                regexIds: (window.Luker.getContext().chatCompletionSettings.extensions?.regex_scripts || []).map(r => r.id),
            }));
        }, { timeout: 10_000 }).toEqual({
            active: GLOBAL_HARBOR_PRESET,
            globalFallback: GLOBAL_HARBOR_PRESET,
            regexIds: [GLOBAL_REGEX_ID],
        });

        // Now select Lira again so the session ends on Card Alpha, wait for settings.json
        // to flush on disk, then cold-reload Luker (auto_load_chat is false by default).
        await selectCharacterByName(page, BOUND_CHAR_NAME);
        await expect
            .poll(async () => Number(await page.locator('#temp_counter_openai').inputValue()), { timeout: 10_000 })
            .toBeCloseTo(CARD_ALPHA_TEMP, 5);

        const settingsPath = resolve(server.dataRoot, 'default-user', 'settings.json');
        await expect.poll(() => {
            const persisted = JSON.parse(readFileSync(settingsPath, 'utf8'));
            const ids = (persisted?.oai_settings?.extensions?.regex_scripts || []).map(r => r.id);
            return ids[0] || '';
        }, { timeout: 10_000 }).toBe(CARD_ALPHA_REGEX_ID);

        await reloadAndAwait(page, server.baseURL);

        // Cold reload with no open character must restore GlobalHarbor's body and regex_scripts,
        // NOT leave Card Alpha's regex_scripts stranded under GlobalHarbor!
        const coldBootState = await page.evaluate(() => {
            const oai = window.Luker.getContext().chatCompletionSettings;
            return {
                active: oai.preset_settings_openai,
                globalFallback: oai.global_preset_settings_openai,
                temp: oai.temp_openai,
                regexIds: (oai.extensions?.regex_scripts || []).map(r => r.id),
            };
        });
        expect(coldBootState.active).toBe(GLOBAL_HARBOR_PRESET);
        expect(coldBootState.globalFallback).toBe(GLOBAL_HARBOR_PRESET);
        expect(coldBootState.temp).toBeCloseTo(GLOBAL_HARBOR_TEMP, 5);
        expect(coldBootState.regexIds).toEqual([GLOBAL_REGEX_ID]);

        // Clicking Update Preset right after cold reload must keep GlobalHarbor's own regex_scripts intact on disk.
        await ensureOaiDrawerOpen(page);
        await page.locator('#update_oai_preset').click();
        await expect(page.locator('.toast.toastr-success, .toast-success').first()).toBeVisible({ timeout: 5_000 });

        const globalPresetPath = resolve(server.dataRoot, 'default-user', 'OpenAI Settings', `${GLOBAL_HARBOR_PRESET}.json`);
        const persistedGlobal = JSON.parse(readFileSync(globalPresetPath, 'utf8'));
        expect((persistedGlobal.extensions?.regex_scripts || []).map(r => r.id)).toEqual([GLOBAL_REGEX_ID]);
        expect(persistedGlobal.temperature).toBeCloseTo(GLOBAL_HARBOR_TEMP, 5);
    });
});
