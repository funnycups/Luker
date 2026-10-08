import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';
import { savePresetAsViaButton, selectPresetByName } from '../e2e/preset/_helpers.js';

/**
 * The reasoning controls live in two mutually exclusive drawers:
 * - `#openai_reasoning_effort` and `#openai_show_thoughts` are in the AI
 *   Response Configuration drawer, opened by `#leftNavDrawerIcon`;
 * - `#chat_completion_source` is in the API Connections drawer, opened by
 *   `#API-status-top`.
 *
 * Opening one closes the other, so the test toggles between them.
 * @param {import('@playwright/test').Page} page
 */
async function openApiDrawer(page) {
    // The open configuration drawer overlaps the API drawer icon, so close it
    // first by clicking the app background (the global handler auto-closes
    // non-pinned drawers on outside clicks).
    if (await page.locator('#openai_reasoning_effort').isVisible()) {
        const viewport = page.viewportSize();
        await page.mouse.click(viewport.width - 10, Math.floor(viewport.height / 2));
        await expect(page.locator('#openai_reasoning_effort')).toBeHidden();
    }
    await page.locator('#API-status-top').click();
    await expect(page.locator('#rm_api_block')).toBeVisible();
    await expect(page.locator('#chat_completion_source')).toBeVisible();
}

/**
 * @param {import('@playwright/test').Page} page
 */
async function openReasoningDrawer(page) {
    await page.locator('#leftNavDrawerIcon').click();
    await expect(page.locator('#left-nav-panel')).toBeVisible();
    await expect(page.locator('#openai_reasoning_effort')).toBeVisible();
}

/**
 * Read the live per-source reasoning effort map from the openai module.
 * @param {import('@playwright/test').Page} page
 * @param {string} source
 * @returns {Promise<string|undefined>}
 */
async function readStoredEffort(page, source) {
    return await page.evaluate(async (key) => {
        const module = await import('/scripts/openai.js');
        return module.oai_settings.reasoning_effort_by_source?.[key];
    }, source);
}

test.describe('Reasoning effort decoupling', () => {
    test.beforeEach(testSetup.awaitST);

    test('moonshot shows its own effort options and persists per source', async ({ page }) => {
        await openApiDrawer(page);
        await page.locator('#chat_completion_source').selectOption('moonshot');

        await openReasoningDrawer(page);
        const options = await page.locator('#openai_reasoning_effort option').evaluateAll(els => els.map(el => el.value));
        expect(options).toEqual(['auto', 'off', 'low', 'high', 'max']);

        await page.locator('#openai_reasoning_effort').selectOption('max');
        expect(await readStoredEffort(page, 'moonshot')).toBe('max');
    });

    test('display toggle is independent and disables on off', async ({ page }) => {
        await openApiDrawer(page);
        await page.locator('#chat_completion_source').selectOption('moonshot');

        await openReasoningDrawer(page);
        await page.locator('#openai_reasoning_effort').selectOption('low');
        await expect(page.locator('#openai_show_thoughts')).toBeEnabled();

        await page.locator('#openai_reasoning_effort').selectOption('off');
        await expect(page.locator('#openai_show_thoughts')).toBeDisabled();

        await page.locator('#openai_reasoning_effort').selectOption('high');
        await expect(page.locator('#openai_show_thoughts')).toBeEnabled();
    });

    test('effort is stored per source and restored when switching back', async ({ page }) => {
        await openApiDrawer(page);
        await page.locator('#chat_completion_source').selectOption('moonshot');
        await openReasoningDrawer(page);
        await page.locator('#openai_reasoning_effort').selectOption('high');

        await openApiDrawer(page);
        await page.locator('#chat_completion_source').selectOption('deepseek');
        await openReasoningDrawer(page);
        await page.locator('#openai_reasoning_effort').selectOption('low');

        await openApiDrawer(page);
        await page.locator('#chat_completion_source').selectOption('moonshot');
        await openReasoningDrawer(page);
        await expect(page.locator('#openai_reasoning_effort')).toHaveValue('high');

        await openApiDrawer(page);
        await page.locator('#chat_completion_source').selectOption('deepseek');
        await openReasoningDrawer(page);
        await expect(page.locator('#openai_reasoning_effort')).toHaveValue('low');

        expect(await readStoredEffort(page, 'moonshot')).toBe('high');
        expect(await readStoredEffort(page, 'deepseek')).toBe('low');
    });

    test('per-source effort round-trips through a saved chat completion preset', async ({ page }) => {
        const presetName = 'reasoning-effort-roundtrip';

        await openApiDrawer(page);
        await page.locator('#chat_completion_source').selectOption('moonshot');
        await openReasoningDrawer(page);
        await page.locator('#openai_reasoning_effort').selectOption('max');

        // Save the current settings (including the per-source map) as a new preset.
        await savePresetAsViaButton(page, presetName);

        // Mutate the live map away from the saved value.
        await expect(page.locator('#openai_reasoning_effort')).toBeVisible();
        await page.locator('#openai_reasoning_effort').selectOption('off');
        expect(await readStoredEffort(page, 'moonshot')).toBe('off');

        // Switching away and back must restore the map from the saved preset.
        await selectPresetByName(page, 'Default');
        await selectPresetByName(page, presetName);

        await expect(page.locator('#openai_reasoning_effort')).toBeVisible();
        await expect(page.locator('#openai_reasoning_effort')).toHaveValue('max');
        expect(await readStoredEffort(page, 'moonshot')).toBe('max');
    });
});
