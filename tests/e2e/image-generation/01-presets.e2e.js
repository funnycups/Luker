// Generation presets: create from the current configuration, switch through
// the settings dropdown, switch through /imagine-preset, and survive a server
// restart. Every gesture below is a real DOM interaction; page.evaluate is
// only used to read persisted state.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI, openExtensionsDrawer, openInlineDrawer, selectCharacterByName,
    closeAnyOpenTopSettingsDrawer,
} from '../_lib/page.js';
import { startSdWebUiMock } from '../_lib/sdMock.js';

let server, mock, sdMock;

test.beforeAll(async () => {
    sdMock = await startSdWebUiMock();
    mock = await startMockLLM({ scriptedReplies: ['*Ash trims the lantern wick and waits for the tide.*'] });
    server = await startServer({ batchKey: 'image-illustration', scenarioId: '01-presets' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
    await sdMock?.stop();
});

async function openGenerationSettings(page) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'sd_container');
}

async function setSteps(page, steps) {
    const input = page.locator('#sd_steps_value');
    await input.fill(String(steps));
    await input.press('Enter');
    // Committing the field is what pushes the number into the range slider and
    // fires the input event the settings sync listens to.
    await input.blur();
    await page.waitForTimeout(1500);
}

async function openPresetDialog(page) {
    await page.locator('#sd_generation_preset_new').click();
    const input = page.locator('dialog.popup[open] .popup-input');
    await expect(input).toBeVisible();
    return input;
}

test.describe('generation presets', () => {
    test('switches presets from the settings panel and the slash command', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.locator('#sys-settings-button > .drawer-toggle').click();
        await page.locator('#api_button_openai').click();
        await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
        await closeAnyOpenTopSettingsDrawer(page);

        await openGenerationSettings(page);

        // Configure the image backend with the visible controls.
        await page.locator('#sd_source').selectOption('auto');
        await page.locator('#sd_auto_url').fill(sdMock.baseURL);
        await page.locator('#sd_auto_validate').click();
        await expect(page.locator('#sd_model option').first()).toBeAttached({ timeout: 15_000 });

        // The option reload auto-selects backend defaults, but that is not a
        // user edit: the preset keeps its own option fields.
        const readPresetConfig = () => page.evaluate(() => {
            const bucket = window.Luker.getContext().extensionSettings.sd.generationPresets;
            return bucket.presets.find(preset => preset.id === bucket.currentId).config;
        });
        const configAfterReload = await readPresetConfig();
        expect(configAfterReload.model).toBe('');
        expect(configAfterReload.sampler).toBe('DDIM');
        expect(configAfterReload.scheduler).toBe('normal');
        expect(configAfterReload.vae).toBe('');

        // Directly editing the model control is the one path that writes it.
        await page.locator('#sd_model').selectOption({ index: 0 });
        const selectedModel = await page.locator('#sd_model').inputValue();
        expect(selectedModel).toBe('mock-model [abc]');
        expect((await readPresetConfig()).model).toBe(selectedModel);

        const presetSelect = page.locator('#sd_generation_preset');
        await expect(presetSelect).toBeVisible();
        await expect(presetSelect.locator('option')).toHaveCount(1);
        await expect(presetSelect.locator('option:checked')).toHaveText('Default');

        // Default preset records the edited step count.
        await setSteps(page, 11);

        // A new preset copies the current configuration.
        const nameInput = await openPresetDialog(page);
        await nameInput.fill('Second');
        await page.locator('dialog.popup[open] .popup-button-ok').click();
        await expect(page.locator('dialog.popup[open]')).toHaveCount(0);
        await expect(presetSelect.locator('option')).toHaveCount(2);
        await expect(presetSelect.locator('option:checked')).toHaveText('Second');

        // Second preset records its own step count.
        await setSteps(page, 22);

        // Switching by hand restores each preset's own configuration.
        await presetSelect.selectOption({ label: 'Default' });
        await expect(page.locator('#sd_steps_value')).toHaveValue('11');
        // Backend-dependent options reload instead of staying empty.
        await expect(page.locator('#sd_model')).toHaveValue(/mock-model/);
        await expect(page.locator('#sd_sampler')).toHaveValue('DDIM');

        await presetSelect.selectOption({ label: 'Second' });
        await expect(page.locator('#sd_steps_value')).toHaveValue('22');

        // The slash command selects a preset by name through the chat input.
        await closeAnyOpenTopSettingsDrawer(page);
        const textarea = page.locator('#send_textarea');
        await textarea.fill('/imagine-preset Default');
        await page.locator('#send_but').click();
        await expect(presetSelect.locator('option:checked')).toHaveText('Default', { timeout: 15_000 });
        await expect(page.locator('#sd_steps_value')).toHaveValue('11');
        // Settings are saved on a debounce; let it flush before the restart.
        await page.waitForTimeout(1500);

        // The selection and both preset configurations survive a restart.
        await server.restart();
        await awaitMainUI(page, server.baseURL);
        await openGenerationSettings(page);
        const reopenedSelect = page.locator('#sd_generation_preset');
        await expect(reopenedSelect.locator('option:checked')).toHaveText('Default');
        await expect(page.locator('#sd_steps_value')).toHaveValue('11');

        const presets = await page.evaluate(() => window.Luker.getContext().extensionSettings.sd.generationPresets);
        const byName = Object.fromEntries(presets.presets.map(preset => [preset.name, preset.config.steps]));
        expect(byName.Default).toBe(11);
        expect(byName.Second).toBe(22);
    });
});
