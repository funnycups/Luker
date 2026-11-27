import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';

test.describe.configure({ mode: 'serial' });

let server;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    server = await startServer({
        scope,
        batchKey: 'server',
        scenarioId: 'resource-settings',
        extraConfig: { storage: { mode: 'fs' } },
    });
});

test.afterAll(async () => {
});

test('revalidates unchanged settings fields after a real toggle', async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    const network = [];
    const requestHeaders = new Map();
    cdp.on('Network.requestWillBeSentExtraInfo', event => {
        requestHeaders.set(event.requestId, event.headers);
    });
    cdp.on('Network.responseReceived', event => {
        network.push({
            url: event.response.url,
            requestId: event.requestId,
            status: event.response.status,
            fromDiskCache: event.response.fromDiskCache,
        });
    });

    await awaitMainUI(page, server.baseURL);
    await page.locator('dialog.popup[open] .popup-button-ok').first().click({ timeout: 2000 }).catch(() => {});

    const drawer = page.locator('#advanced-formatting-button');
    if (await drawer.locator('.drawer-icon.closedIcon').count()) {
        await drawer.locator('.drawer-toggle').click();
    }
    const toggle = page.locator('#trim_spaces');
    await toggle.scrollIntoViewIfNeeded();

    const initiallyChecked = await toggle.isChecked();
    const firstSaveResponse = page.waitForResponse(response =>
        response.url().includes('/api/settings/') && response.request().method() === 'POST');
    await toggle.setChecked(!initiallyChecked);
    expect((await firstSaveResponse).ok()).toBe(true);

    const secondSaveResponse = page.waitForResponse(response =>
        response.url().includes('/api/settings/patch') && response.request().method() === 'POST');
    await toggle.setChecked(initiallyChecked);
    expect((await secondSaveResponse).ok()).toBe(true);

    const thirdSaveResponse = page.waitForResponse(response =>
        response.url().includes('/api/settings/patch') && response.request().method() === 'POST');
    await toggle.setChecked(!initiallyChecked);
    expect((await thirdSaveResponse).ok()).toBe(true);

    const reloadMarker = network.length;
    await reloadAndAwait(page, server.baseURL);

    await expect(toggle).toBeChecked({ checked: !initiallyChecked });
    const reloadNetwork = network.slice(reloadMarker);
    expect(reloadNetwork.some(entry => entry.url.includes('/api/settings/fields?'))).toBe(true);
    const reloadFields = reloadNetwork.filter(entry => entry.url.includes('/api/settings/field?'));
    expect(reloadFields.length).toBeGreaterThan(0);
    expect(reloadFields.some(entry => {
        const headers = requestHeaders.get(entry.requestId) || {};
        return entry.fromDiskCache || Boolean(headers['If-None-Match']);
    })).toBe(true);
    expect(reloadNetwork.some(entry => entry.url.endsWith('/api/settings/get'))).toBe(false);
});

test('defers non-selected preset preload past welcome screen without re-fetching the active preset', async ({ page }) => {
    const presetDir = join(server.dataRoot, 'default-user', 'OpenAI Settings');
    mkdirSync(presetDir, { recursive: true });
    writeFileSync(join(presetDir, 'Secondary_A.json'), JSON.stringify({
        temperature: 1.23,
        openai_max_context: 4096,
        openai_max_tokens: 300,
    }));

    const requestOrder = [];
    page.on('request', request => {
        requestOrder.push(request.url());
    });

    await awaitMainUI(page, server.baseURL);
    await expect.poll(() => requestOrder.filter(url =>
        url.includes('/api/presets/get?') && url.includes('apiId=openai') && url.includes('name=Secondary_A')).length,
    { timeout: 15_000 }).toBe(1);

    const activePresetFetches = requestOrder.filter(url =>
        url.includes('/api/presets/get?') && url.includes('apiId=openai') && url.includes('name=Default'));
    expect(activePresetFetches).toHaveLength(1);

    const welcomePanelIndex = requestOrder.findIndex(url => url.includes('welcomePanel.html'));
    const secondaryPresetIndex = requestOrder.findIndex(url =>
        url.includes('/api/presets/get?') && url.includes('apiId=openai') && url.includes('name=Secondary_A'));
    expect(welcomePanelIndex).toBeGreaterThanOrEqual(0);
    expect(secondaryPresetIndex).toBeGreaterThan(welcomePanelIndex);
});

test('recovers cleanly at cold bootstrap when the saved OpenAI preset was deleted externally', async ({ page }) => {
    const presetDir = join(server.dataRoot, 'default-user', 'OpenAI Settings');
    const settingsPath = join(server.dataRoot, 'default-user', 'settings.json');
    mkdirSync(presetDir, { recursive: true });
    writeFileSync(join(presetDir, 'Surviving_Preset.json'), JSON.stringify({
        temperature: 0.66,
        openai_max_context: 4096,
        openai_max_tokens: 300,
    }));

    const currentSettings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    currentSettings.main_api = 'openai';
    currentSettings.oai_settings = {
        ...(currentSettings.oai_settings || {}),
        preset_settings_openai: 'Deleted_External_Preset',
        global_preset_settings_openai: 'Deleted_External_Preset',
    };
    writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 4));
    rmSync(join(presetDir, 'Deleted_External_Preset.json'), { force: true });

    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err));

    await awaitMainUI(page, server.baseURL);

    const state = await page.evaluate(async () => {
        const { getPresetManager } = await import('/scripts/preset-manager.js');
        const pm = getPresetManager('openai');
        const selectedName = pm.getSelectedPresetName();
        const list = pm.getPresetList();
        const idx = list.preset_names[selectedName];
        return {
            selectedName,
            hasHydratedBody: Boolean(Number.isInteger(idx) && list.presets[idx] && typeof list.presets[idx] === 'object'),
        };
    });

    expect(pageErrors).toEqual([]);
    expect(state.selectedName).toBeTruthy();
    expect(state.selectedName).not.toBe('Deleted_External_Preset');
    expect(state.hasHydratedBody).toBe(true);
});
