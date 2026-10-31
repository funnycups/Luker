// #66 — CPA Apply on a card-bound preset updates the live runtime without a
// page reload. The public `ctx.presets.save` character branch used to persist
// the card slot and return, leaving the runtime option cache, oai_settings,
// and the rendered controls on the pre-edit body. The assistant's Apply then
// looked like it did nothing until the tab was refreshed.

import { test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { writePreset } from '../_lib/fixtures.js';
import { openExtensionsDrawer, openInlineDrawer } from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, applyIterBatch, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';
import { read as readPngCard } from '../../../src/character-card-parser.js';

const CHAR_NAME = 'Cora the Cartographer';
const CHAR_AVATAR = 'cpa-live-sync-cora.png';
const CARD_PRESET = 'CardLive';
const GLOBAL_PRESET = 'GlobalLive';
const PROFILE_NAME = 'CPA live sync';
const CARD_TEMPERATURE_SEED = 0.27;
const GLOBAL_TEMPERATURE = 0.55;
const APPLIED_TEMPERATURE = 0.53;

let scratchRoot, mock, server;

function readCardPresetTemperature() {
    const png = readFileSync(join(server.dataRoot, 'default-user', 'characters', CHAR_AVATAR));
    const card = JSON.parse(readPngCard(png));
    return card.data.extensions.luker.chat_completion_preset.presets[0].preset.temperature;
}

async function selectPreset(page, name) {
    const drawer = page.locator('#leftNavDrawerIcon');
    if (await drawer.evaluate(el => el.classList.contains('closedIcon'))) {
        await drawer.click();
    }
    await page.locator('#settings_preset_openai + .select2 .select2-selection').click();
    const search = page.locator('.select2-container--open .select2-search__field');
    if (await search.isVisible()) {
        await search.fill(name);
    }
    await page.locator('.select2-results__option .luker-action-select2-option__label')
        .filter({ hasText: name })
        .last()
        .click();
}

async function readLiveState(page) {
    return page.evaluate(() => {
        const ctx = window.Luker.getContext();
        const ref = ctx.presets.getSelected('openai');
        const stored = ctx.presets.getStored(ref);
        const selectedValue = String(document.querySelector('#settings_preset_openai')?.value ?? '');
        const cached = window.__characterBoundPresetState?.runtimeOptions?.get(selectedValue)?.body;
        return {
            ref,
            storedTemperature: stored?.body?.temperature,
            cachedTemperature: cached?.temperature ?? null,
            activeTemperature: ctx.chatCompletionSettings?.temp_openai,
            displayedTemperature: Number(document.querySelector('#temp_counter_openai')?.value),
        };
    });
}

async function applyTemperatureThroughAssistant(page, temperature) {
    await openIterStudio(page, 'cpa');
    mock.scriptToolCall({
        name: 'preset_set_field',
        arguments: {
            path: 'temperature',
            value_json: JSON.stringify(temperature),
            reason: 'Hold the narrative voice steady.',
        },
    });
    await sendIterPrompt(page, 'cpa', `Set the temperature to ${temperature} for a steadier narrative voice.`);
    await applyIterBatch(page, 'cpa');
    await closeIterStudio(page);
}

test.beforeAll(async () => {
    scratchRoot = mkdtempSync(resolve(import.meta.dirname, '../../.e2e-scratch/cpa-card-bound-live-sync-'));
    const dataRoot = join(scratchRoot, 'data');
    mkdirSync(dataRoot);
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'preset',
        scenarioId: 'cpa-card-bound-live-sync',
        useExistingDataRoot: dataRoot,
        extraConfig: { 'storage.mode': 'fs', enableUserAccounts: false },
    });
    const basePreset = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../default/content/presets/openai/Default.json'), 'utf8'));
    writePreset({ dataRoot: server.dataRoot, name: GLOBAL_PRESET, overrides: { temperature: GLOBAL_TEMPERATURE } });
    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: CHAR_AVATAR,
        overrides: {
            name: CHAR_NAME,
            extensions: {
                luker: {
                    chat_completion_preset: {
                        presets: [{ name: CARD_PRESET, preset: { ...basePreset, temperature: CARD_TEMPERATURE_SEED } }],
                        defaultPresetName: CARD_PRESET,
                    },
                },
            },
        },
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
    rmSync(scratchRoot, { recursive: true, force: true });
});

test.describe('#66 — CPA Apply on a card-bound preset updates live state immediately', () => {
    test('card, runtime cache, active settings, and rendered control all show the applied value before reload', async ({ page }) => {
        await page.goto(server.baseURL);
        const welcome = page.locator('dialog[open]').filter({ has: page.locator('.onboarding') });
        await welcome.locator('.popup-input').fill('Mira');
        await welcome.locator('.popup-button-ok').click();
        await page.waitForFunction(() => performance.getEntriesByName('[init] complete').length > 0);

        await page.locator('#API-status-top').click();
        await page.locator('#main_api').selectOption('openai');
        await page.locator('#chat_completion_source').selectOption('custom');
        await page.locator('#custom_api_url_text').fill(mock.baseURL);
        await page.locator('#custom_model_id').fill('mock-gpt-4o');
        await page.locator('#api_button_openai').click();
        await page.locator('#create_connection_profile').click();
        const profilePopup = page.locator('dialog[open]').last();
        await profilePopup.locator('.popup-input').fill(PROFILE_NAME);
        await profilePopup.locator('.popup-button-ok').click();
        await page.locator('#API-status-top').click();

        await openExtensionsDrawer(page);
        await openInlineDrawer(page, 'completion_preset_assistant_settings');
        await page.locator('#cpa_request_llm_preset').selectOption({ label: 'Default' });
        await page.locator('#cpa_request_api_preset').selectOption({ label: PROFILE_NAME });

        await selectPreset(page, GLOBAL_PRESET);
        await expect.poll(async () => (await readLiveState(page)).activeTemperature).toBe(GLOBAL_TEMPERATURE);

        await applyTemperatureThroughAssistant(page, 0.42);
        await expect.poll(async () => (await readLiveState(page)).displayedTemperature).toBe(0.42);
        expect((await readLiveState(page)).activeTemperature).toBe(0.42);

        await page.locator('#rightNavDrawerIcon').click();
        await page.locator('#rm_print_characters_block .character_select').filter({ hasText: CHAR_NAME }).first().click();
        await page.locator('#rightNavDrawerIcon').click();
        await expect.poll(async () => (await readLiveState(page)).activeTemperature).toBe(CARD_TEMPERATURE_SEED);

        await applyTemperatureThroughAssistant(page, APPLIED_TEMPERATURE);

        await expect.poll(() => readCardPresetTemperature(), { timeout: 10_000 }).toBe(APPLIED_TEMPERATURE);
        await expect.poll(async () => (await readLiveState(page)).storedTemperature, { timeout: 10_000 }).toBe(APPLIED_TEMPERATURE);
        await expect.poll(async () => (await readLiveState(page)).cachedTemperature, { timeout: 10_000 }).toBe(APPLIED_TEMPERATURE);
        await expect.poll(async () => (await readLiveState(page)).activeTemperature, { timeout: 10_000 }).toBe(APPLIED_TEMPERATURE);
        await expect.poll(async () => (await readLiveState(page)).displayedTemperature, { timeout: 10_000 }).toBe(APPLIED_TEMPERATURE);
    });
});
