// #84 — Host events keep unsaved Orchestra Lens drafts.

import { test, expect } from '../../harness/playwright.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, closeAnyOpenTopSettingsDrawer } from '../_lib/page.js';
import {
    clickOrchSetupBarButton,
    enableOrchestratorMode,
    saveOrchDrafts,
} from '../_lib/ui-orchestrator.js';
import { closeWorkbench, openOrchWorkspace } from '../_lib/ui-workbench.js';
import { openCharacterEditPanel } from '../character/_helpers.js';
import { read as readPngCard } from '../../../src/character-card-parser.js';

let server, mock;

const CHARACTER_NAME = 'Seraphina';
const PROFILE_A = 'glade-watch-a';
const PROFILE_B = 'glade-watch-b';
const SPEC_PROMPT = 'Keep the glade ward ledger, one line for every lantern lit at dusk.';
const DESCRIPTION_ADDITION = ' She lights the glade ward lanterns at every dusk.';
const CARD_PROMPT = 'Trim each glade ward lantern wick before the moon clears the canopy.';
const CARD_DESCRIPTION_ADDITION = ' She trims the lantern wicks by moonlight.';

function readSettings() {
    return JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'settings.json'), 'utf8'));
}

function readCardSpecEntry(avatar) {
    const png = readFileSync(resolve(server.dataRoot, 'default-user', 'characters', avatar));
    const orch = JSON.parse(readPngCard(png))?.data?.extensions?.orchestrator;
    const activeId = orch?.activePresetIds?.spec || '';
    return activeId ? (orch?.presetLibraries?.spec?.[activeId] || null) : null;
}

function readActiveSpecEntry() {
    const orch = readSettings()?.extension_settings?.orchestrator;
    const activeId = orch?.activePresetIds?.spec || '';
    return activeId ? (orch?.presetLibraries?.spec?.[activeId] || null) : null;
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({
        scope,
        batchKey: 'orchestrator',
        scenarioId: '84-host-refresh-keeps-editor-drafts',
        extraConfig: { storage: { mode: 'fs' } },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL, name: PROFILE_B });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL, name: PROFILE_A });
});

test.afterAll(async () => {
    await mock?.stop();
});

async function installHostEventRecorder(page) {
    await page.evaluate(() => {
        const ctx = window.Luker.getContext();
        window.__e2eHostEvents = [];
        for (const type of [ctx.eventTypes.CONNECTION_PROFILE_LOADED, ctx.eventTypes.CHARACTER_EDITED]) {
            ctx.eventSource.makeLast(type, () => { window.__e2eHostEvents.push(type); });
        }
    });
}

async function hostEventCount(page, key) {
    return page.evaluate((k) => {
        const type = window.Luker.getContext().eventTypes[k];
        return (window.__e2eHostEvents || []).filter(t => t === type).length;
    }, key);
}

async function openApiPanel(page) {
    const drawer = page.locator('#rm_api_block');
    if (await drawer.evaluate(el => el.classList.contains('openDrawer'))) return;
    await closeAnyOpenTopSettingsDrawer(page);
    await page.locator('#API-status-top').click();
    await expect(drawer).toHaveClass(/openDrawer/, { timeout: 10_000 });
}

async function selectConnectionProfileThroughDropdown(page, profileName) {
    await openApiPanel(page);
    const selection = page.locator('#connection_profiles + .select2-container .select2-selection').first();
    await selection.waitFor({ state: 'visible', timeout: 10_000 });
    await selection.click();
    const option = page.locator('.select2-container--open .select2-results__option').filter({ hasText: profileName }).first();
    await option.waitFor({ state: 'visible', timeout: 10_000 });
    await option.click();
}

async function editCardDescription(page, addition) {
    await closeAnyOpenTopSettingsDrawer(page);
    await openCharacterEditPanel(page);
    const description = page.locator('#description_textarea');
    await description.waitFor({ state: 'visible', timeout: 10_000 });
    await description.fill(`${await description.inputValue()}${addition}`);
    await description.blur();
}

async function openSpecPresetArea(page, presetId = '') {
    const lens = await openOrchWorkspace(page, 'setup');
    const details = presetId
        ? lens.locator(`details.ol-setup-node[data-detail-key="spec-preset:${presetId}"]`).first()
        : lens.locator('details.ol-setup-node[data-detail-key^="spec-preset:"]').first();
    await expect(details).toBeVisible({ timeout: 15_000 });
    const resolvedId = presetId || String(await details.getAttribute('data-detail-key')).replace(/^spec-preset:/, '');
    if (!(await details.evaluate(el => el.open))) {
        await details.locator('summary').first().click();
    }
    return {
        presetId: resolvedId,
        area: details.locator('textarea.ol-textarea').first(),
    };
}

test.describe('#84 — host events keep unsaved orchestration editor drafts', () => {
    test.setTimeout(150_000);

    test('switching connection profile and editing the card keep an unsaved spec prompt edit', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, CHARACTER_NAME);
        await enableOrchestratorMode(page, 'spec', { closeAfter: false });
        await expect.poll(() => readSettings()?.extension_settings?.orchestrator?.executionMode || '', { timeout: 10_000 }).toBe('spec');
        await installHostEventRecorder(page);

        const { presetId, area } = await openSpecPresetArea(page);
        const savedPrompt = String(readActiveSpecEntry()?.presets?.[presetId]?.systemPrompt ?? '');
        expect(savedPrompt).not.toBe(SPEC_PROMPT);
        await area.fill(SPEC_PROMPT);
        await area.press('Tab');
        await closeWorkbench(page);

        await selectConnectionProfileThroughDropdown(page, PROFILE_B);
        await expect.poll(() => hostEventCount(page, 'CONNECTION_PROFILE_LOADED'), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
        await expect((await openSpecPresetArea(page, presetId)).area, 'the unsaved edit survives a connection profile switch').toHaveValue(SPEC_PROMPT);
        await closeWorkbench(page);

        await editCardDescription(page, DESCRIPTION_ADDITION);
        await expect.poll(() => hostEventCount(page, 'CHARACTER_EDITED'), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
        await expect((await openSpecPresetArea(page, presetId)).area, 'the unsaved edit survives a character card edit').toHaveValue(SPEC_PROMPT);

        await saveOrchDrafts(page);
        await expect.poll(() => readActiveSpecEntry()?.presets?.[presetId]?.systemPrompt || '', { timeout: 15_000 }).toBe(SPEC_PROMPT);
    });

    test('a character draft keeps an unsaved edit through a card edit and reloads when Save To Global changes its global base', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, CHARACTER_NAME);
        await enableOrchestratorMode(page, 'spec', { closeAfter: false });
        await installHostEventRecorder(page);

        await clickOrchSetupBarButton(page, /Save To Character Override|保存为角色覆盖|儲存為角色覆寫/i);
        const avatar = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return String(ctx.characters?.[ctx.characterId]?.avatar || '');
        });
        const { presetId, area: cardArea } = await openSpecPresetArea(page);
        await expect.poll(() => readCardSpecEntry(avatar)?.presets?.[presetId]?.systemPrompt ?? null, { timeout: 15_000 }).not.toBeNull();
        const cardSavedPrompt = String(readCardSpecEntry(avatar).presets[presetId].systemPrompt);
        expect(cardSavedPrompt).not.toBe(CARD_PROMPT);
        await expect(cardArea).toHaveValue(cardSavedPrompt);
        await cardArea.fill(CARD_PROMPT);
        await cardArea.press('Tab');
        await closeWorkbench(page);

        await editCardDescription(page, CARD_DESCRIPTION_ADDITION);
        await expect.poll(() => hostEventCount(page, 'CHARACTER_EDITED'), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
        await expect((await openSpecPresetArea(page, presetId)).area, 'the unsaved card edit survives a character card edit').toHaveValue(CARD_PROMPT);

        await clickOrchSetupBarButton(page, /Save To Global|保存到全局|儲存到全域/i);
        await expect.poll(() => readActiveSpecEntry()?.presets?.[presetId]?.systemPrompt || '', { timeout: 15_000 }).toBe(CARD_PROMPT);
        await expect((await openSpecPresetArea(page, presetId)).area,
            'the character draft reloads after its global base changed').toHaveValue(cardSavedPrompt);
    });
});
