// #67 — Chat completion preset runtime parity & event message identity.
//
// Guards five runtime contracts relied upon by external preset/request
// consumers:
//   1. Prompt message object references emitted in CHAT_COMPLETION_PROMPT_READY
//      and GENERATE_AFTER_DATA remain identical in CHAT_COMPLETION_SETTINGS_READY
//      when plain-text tool-protocol rewriting is inactive.
//   2. Loading a preset into oai_settings / PromptManager does not eagerly
//      materialize `extensions.luker` or `prompt.plugin_extra` onto plain
//      presets, nor mutate `chatCompletionDefaultPrompts.prompts` in place
//      when backfilling omitted built-in system prompts.
//   3. `oai_settings.reasoning_effort` mirrors legacy `preset.reasoning_effort`
//      on preset load, tracks `reasoning_effort_by_source[source]` when no
//      legacy field is stored on the preset, and updates on `#openai_reasoning_effort`
//      input.
//   4. `PresetManager.getAllPresets()` returns unique preset names even when
//      the active character carries a card-bound preset colliding with a
//      global preset name.
//   5. `POST /api/settings/get` delegates to negotiated GET resource reads
//      without maintaining a client-side snapshot cache, reflecting both
//      `savePreset` writes and out-of-band server file updates immediately.

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
import {
    awaitMainUI,
    selectCharacterByName,
    closeRightNavDrawer,
    sendMessageAndAwaitReply,
} from '../_lib/page.js';
import {
    normalizeIterStudioSettings,
    selectPresetByName,
    ensureOaiDrawerOpen,
} from './_helpers.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const DEFAULT_SEED_PATH = resolve(REPO_ROOT, 'default/content/presets/openai/Default.json');

const CHAR_PLAIN_NAME = 'Ash the Reef Watcher';
const CHAR_PLAIN_AVATAR = 'ash-the-reef-watcher.png';

const CHAR_COLLIDE_NAME = 'Maren of Tidegate';
const CHAR_COLLIDE_AVATAR = 'maren-of-tidegate.png';

const SHARED_PRESET_NAME = 'Tidegate Shared';
const CARD_ONLY_PRESET_NAME = 'Tidegate Card Slot';
const PLAIN_PRESET_NAME = 'Plain Omitted Builtin';
const PARTIAL_LUKER_EXT_PRESET_NAME = 'Partial Layout Extension';
const LEGACY_EFFORT_PRESET_NAME = 'Legacy Effort Min';
const PER_SOURCE_EFFORT_PRESET_NAME = 'Per Source Effort Map';

let server;
let mock;

test.beforeAll(async () => {
    mock = await startMockLLM({
        scriptedReplies: [
            '*Ash lowers the brass spyglass and taps the northern soundings.* "Two cables past the black buoy. Watch the foam line when the swell draws back."',
        ],
    });
    server = await startServer({
        batchKey: 'preset',
        scenarioId: 'chat-completion-preset-runtime-parity',
        extraConfig: { 'storage.mode': 'fs' },
    });

    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL, stream: false });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    const seed = JSON.parse(readFileSync(DEFAULT_SEED_PATH, 'utf8'));

    // Preset omitting `enhanceDefinitions` and carrying neither `extensions`
    // nor `plugin_extra` on any prompt.
    const promptsWithoutEnhance = seed.prompts.filter(p => p.identifier !== 'enhanceDefinitions');
    writePreset({
        dataRoot: server.dataRoot,
        name: PLAIN_PRESET_NAME,
        overrides: {
            prompts: promptsWithoutEnhance,
        },
    });

    // Preset carrying `extensions.luker.prompt_layout` without `prompt_groups`.
    writePreset({
        dataRoot: server.dataRoot,
        name: PARTIAL_LUKER_EXT_PRESET_NAME,
        overrides: {
            extensions: {
                luker: {
                    prompt_layout: [],
                },
            },
        },
    });

    // Preset carrying legacy single-field `reasoning_effort: "min"`.
    writePreset({
        dataRoot: server.dataRoot,
        name: LEGACY_EFFORT_PRESET_NAME,
        overrides: {
            reasoning_effort: 'min',
        },
    });

    // Preset carrying per-source `reasoning_effort_by_source` without legacy `reasoning_effort`.
    writePreset({
        dataRoot: server.dataRoot,
        name: PER_SOURCE_EFFORT_PRESET_NAME,
        overrides: {
            reasoning_effort_by_source: {
                custom: 'medium',
                moonshot: 'max',
                deepseek: 'low',
            },
        },
    });

    // Global preset whose name collides with a card-bound preset on Maren.
    writePreset({
        dataRoot: server.dataRoot,
        name: SHARED_PRESET_NAME,
        overrides: {
            temperature: 0.75,
        },
    });

    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: CHAR_PLAIN_AVATAR,
        overrides: {
            name: CHAR_PLAIN_NAME,
        },
    });

    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: CHAR_COLLIDE_AVATAR,
        overrides: {
            name: CHAR_COLLIDE_NAME,
            extensions: {
                luker: {
                    chat_completion_preset: {
                        presets: [
                            {
                                name: SHARED_PRESET_NAME,
                                preset: {
                                    temperature: 0.45,
                                    prompts: seed.prompts,
                                    prompt_order: seed.prompt_order,
                                },
                            },
                            {
                                name: CARD_ONLY_PRESET_NAME,
                                preset: {
                                    temperature: 0.55,
                                    prompts: seed.prompts,
                                    prompt_order: seed.prompt_order,
                                },
                            },
                        ],
                        defaultPresetName: SHARED_PRESET_NAME,
                    },
                },
            },
        },
    });

    normalizeIterStudioSettings(server.dataRoot);
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#67 — chat completion preset runtime parity', () => {
    test('preserves prompt message object references across chat completion ready events', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, CHAR_PLAIN_NAME);
        await closeRightNavDrawer(page);

        await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const probe = {
                promptReadyChat: null,
                afterDataPrompt: null,
                settingsReadyMessages: null,
            };
            window.__msgIdentityProbe = probe;
            ctx.eventSource.on(ctx.eventTypes.CHAT_COMPLETION_PROMPT_READY, (event) => {
                if (!event?.dryRun) {
                    probe.promptReadyChat = event?.chat ?? null;
                }
            });
            ctx.eventSource.on(ctx.eventTypes.GENERATE_AFTER_DATA, (data) => {
                if (!data?.dryRun) {
                    probe.afterDataPrompt = data?.prompt ?? null;
                }
            });
            ctx.eventSource.on(ctx.eventTypes.CHAT_COMPLETION_SETTINGS_READY, (request) => {
                probe.settingsReadyMessages = request?.messages ?? null;
            });
        });

        const { text } = await sendMessageAndAwaitReply(
            page,
            '*I steady the brass lantern against the salt wind.* "Where did the third breaker cross the chart?"',
        );
        expect(text).toContain('Two cables past the black buoy');

        const identityReport = await page.evaluate(() => {
            const probe = window.__msgIdentityProbe;
            const chat = probe?.promptReadyChat;
            const prompt = probe?.afterDataPrompt;
            const messages = probe?.settingsReadyMessages;
            if (!Array.isArray(chat) || !Array.isArray(prompt) || !Array.isArray(messages)) {
                return { captured: false };
            }
            return {
                captured: true,
                length: messages.length,
                sameLengthAsPrompt: messages.length === prompt.length && messages.length === chat.length,
                allMatchPromptRefs: messages.length > 0 && messages.every((m, idx) => m === prompt[idx]),
                allMatchChatRefs: messages.length > 0 && messages.every((m, idx) => m === chat[idx]),
            };
        });

        expect(identityReport.captured).toBe(true);
        expect(identityReport.length).toBeGreaterThan(0);
        expect(identityReport.sameLengthAsPrompt).toBe(true);
        expect(identityReport.allMatchPromptRefs).toBe(true);
        expect(identityReport.allMatchChatRefs).toBe(true);
    });

    test('loading a preset does not inject default extension containers or prompt fields nor mutate default prompt templates', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectPresetByName(page, PLAIN_PRESET_NAME);

        const plainInspection = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const { chatCompletionDefaultPrompts } = await import('/scripts/PromptManager.js');
            const live = ctx.chatCompletionSettings;
            const enhanceLive = live.prompts.find(p => p.identifier === 'enhanceDefinitions');
            const enhanceTemplate = chatCompletionDefaultPrompts.prompts.find(p => p.identifier === 'enhanceDefinitions');
            return {
                extensionsKeys: Object.keys(live.extensions ?? {}),
                anyPromptHasOwnPluginExtra: live.prompts.some(p => Object.hasOwn(p, 'plugin_extra')),
                enhanceBackfilled: Boolean(enhanceLive),
                enhanceSharedReferenceWithTemplate: enhanceLive === enhanceTemplate,
                templateHasOwnPluginExtra: Object.hasOwn(enhanceTemplate, 'plugin_extra'),
            };
        });

        expect(plainInspection.extensionsKeys).toEqual([]);
        expect(plainInspection.anyPromptHasOwnPluginExtra).toBe(false);
        expect(plainInspection.enhanceBackfilled).toBe(true);
        expect(plainInspection.enhanceSharedReferenceWithTemplate).toBe(false);
        expect(plainInspection.templateHasOwnPluginExtra).toBe(false);

        await selectPresetByName(page, PARTIAL_LUKER_EXT_PRESET_NAME);

        const partialExtInspection = await page.evaluate(() => {
            const live = window.Luker.getContext().chatCompletionSettings;
            return {
                extensions: live.extensions,
                lukerKeys: Object.keys(live.extensions?.luker ?? {}),
            };
        });

        expect(partialExtInspection.lukerKeys).toEqual(['prompt_layout']);
        expect(partialExtInspection.extensions).toEqual({ luker: { prompt_layout: [] } });
    });

    test('keeps live reasoning_effort synchronized across preset load, source switch, and UI input', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // 1. Preset carrying legacy `reasoning_effort: "min"` mirrors the exact preset value.
        await selectPresetByName(page, LEGACY_EFFORT_PRESET_NAME);
        const legacyEffort = await page.evaluate(() => window.Luker.getContext().chatCompletionSettings.reasoning_effort);
        expect(legacyEffort).toBe('min');

        // 2. Preset carrying per-source map without legacy `reasoning_effort` tracks active source.
        await selectPresetByName(page, PER_SOURCE_EFFORT_PRESET_NAME);
        const customSourceEffort = await page.evaluate(() => window.Luker.getContext().chatCompletionSettings.reasoning_effort);
        expect(customSourceEffort).toBe('medium');

        // Switch source via API drawer to moonshot -> live `reasoning_effort` becomes 'max'.
        await page.locator('#API-status-top').click();
        await expect(page.locator('#chat_completion_source')).toBeVisible();
        await page.locator('#chat_completion_source').selectOption('moonshot');
        await expect.poll(
            () => page.evaluate(() => window.Luker.getContext().chatCompletionSettings.reasoning_effort),
        ).toBe('max');

        // Switch source via API drawer to deepseek -> live `reasoning_effort` becomes 'low'.
        await page.locator('#chat_completion_source').selectOption('deepseek');
        await expect.poll(
            () => page.evaluate(() => window.Luker.getContext().chatCompletionSettings.reasoning_effort),
        ).toBe('low');

        // Change `#openai_reasoning_effort` via real UI select -> updates both per-source map and live alias.
        const viewport = page.viewportSize();
        await page.mouse.click(viewport.width - 10, Math.floor(viewport.height / 2));
        await ensureOaiDrawerOpen(page);
        await expect(page.locator('#openai_reasoning_effort')).toBeVisible();
        await page.locator('#openai_reasoning_effort').selectOption('high');

        const afterInput = await page.evaluate(() => {
            const live = window.Luker.getContext().chatCompletionSettings;
            return {
                reasoningEffort: live.reasoning_effort,
                deepseekEffort: live.reasoning_effort_by_source?.deepseek,
            };
        });
        expect(afterInput.reasoningEffort).toBe('high');
        expect(afterInput.deepseekEffort).toBe('high');
    });

    test('getAllPresets deduplicates names when a card-bound preset shares a global preset name', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, CHAR_COLLIDE_NAME);

        await page.waitForFunction(() => {
            const opt = document.querySelector('#settings_preset_openai option[data-luker-char-bound="1"]');
            return Boolean(opt);
        }, { timeout: 15_000 });

        const listInspection = await page.evaluate(async () => {
            const { getPresetManager } = await import('/scripts/preset-manager.js');
            const listed = getPresetManager('openai').getAllPresets();
            return {
                listed,
                uniqueCount: new Set(listed).size,
            };
        });

        expect(listInspection.listed).toContain(SHARED_PRESET_NAME);
        expect(listInspection.listed).toContain(CARD_ONLY_PRESET_NAME);
        expect(listInspection.listed).toHaveLength(listInspection.uniqueCount);
    });

    test('delegates POST /api/settings/get to revalidated resource reads without stale client cache', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        const observedRequests = [];
        page.on('request', req => {
            observedRequests.push({ method: req.method(), url: req.url() });
        });

        const readPresetTempViaSettingsGet = (presetName) => page.evaluate(async (targetName) => {
            const ctx = window.Luker.getContext();
            const res = await window.fetch('/api/settings/get', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: '{}',
            });
            if (!res.ok) {
                throw new Error(`POST /api/settings/get failed with HTTP ${res.status}`);
            }
            const payload = await res.json();
            const idx = payload.openai_setting_names.indexOf(targetName);
            const raw = payload.openai_settings[idx];
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return parsed?.temperature;
        }, presetName);

        const beforeTemp = await readPresetTempViaSettingsGet(PLAIN_PRESET_NAME);
        expect(beforeTemp).not.toBe(0.63);

        await page.evaluate(async (targetName) => {
            const { getPresetManager } = await import('/scripts/preset-manager.js');
            const pm = getPresetManager('openai');
            const current = structuredClone(pm.getCompletionPresetByName(targetName));
            current.temperature = 0.63;
            await pm.savePreset(targetName, current, { skipUpdate: true });
        }, PLAIN_PRESET_NAME);

        const afterSaveTemp = await readPresetTempViaSettingsGet(PLAIN_PRESET_NAME);
        expect(afterSaveTemp).toBe(0.63);

        // Out-of-band server-side update (no client write fetch) must also be
        // observed on the next read via HTTP ETag revalidation.
        writePreset({
            dataRoot: server.dataRoot,
            name: PLAIN_PRESET_NAME,
            overrides: {
                temperature: 0.41,
            },
        });

        const afterDiskUpdateTemp = await readPresetTempViaSettingsGet(PLAIN_PRESET_NAME);
        expect(afterDiskUpdateTemp).toBe(0.41);

        expect(observedRequests.some(r => r.method === 'POST' && r.url.endsWith('/api/settings/get'))).toBe(false);
        expect(observedRequests.some(r => r.method === 'GET' && r.url.includes('/api/settings/fields?'))).toBe(true);
        expect(observedRequests.some(r => r.method === 'GET' && r.url.includes('/api/presets/get?'))).toBe(true);
    });
});
