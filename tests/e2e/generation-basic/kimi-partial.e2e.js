// Kimi partial prefill — full-chain e2e over the Moonshot source.
//
// Two scenarios sharing one mockLLM + one Luker server instance, both
// bootstrapped with `bootstrapMoonshotBackend` (chat_completion_source =
// 'moonshot', base_url → mock). The partial prefill is a Moonshot-only
// feature: `kimi_partial_mode` gates a set of settings UI controls
// (#kimi_partial_config) and the client injects an assistant-partial
// message at the wire level (src/luker-dispatch/.../openai-compatible.js
// applyKimiPartial) when the request carries kimi_partial=true.
//
//   Test A (injection + display consistency): enable the mode through the
//   real settings drawer, fill content + name source, send a message,
//   then assert on mock.requests:
//     - the last /chat/completions body's final message is
//       role=assistant, content=<prefix>, partial=true
//     - name present (character source → 'Seraphina'; manual → 'Mira')
//     - the rendered assistant bubble shows ONLY the mock reply — the
//       prefill prefix is transport-layer, never displayed
//     - manual-name variant: trailing assistant merges prefix and drops
//       the name field (unit-covered; e2e asserts the fresh-turn shape)
//   Test B (preset round trip): the beforeAll seeds the shipped default
//     preset body as 'kimi-e2e-clean'; Test C switches to it first so the
//     runtime starts from a clean base, builds the ON state through the
//     real UI and save-as 'kimi-e2e-preset'. Switching back to the clean
//     preset resets the four controls; switching to the saved preset
//     rehydrates them.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapMoonshotBackend, markOnboarded, writePreset } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    getRenderedChatTexts,
} from '../_lib/page.js';
import { savePresetAsViaButton, selectPresetByName } from '../preset/_helpers.js';

const MOCK_REPLY = 'The lantern stays lit until the last breaker passes the gull rocks.';
const PREFIX = 'Her reply begins thus:';

let server;
let mock;

/**
 * Open the left-nav AI Response Configuration drawer so the moonshot-gated
 * #kimi_partial_config block is visible/clickable. Same pattern as
 * openApiSettingsDrawer in tests/e2e/chat/openai-responses.e2e.js.
 */
async function openAiConfigDrawer(page) {
    const panel = page.locator('#left-nav-panel');
    const isOpen = await panel.evaluate(el => el && !el.classList.contains('closedDrawer')).catch(() => false);
    if (isOpen) return;
    await page.locator('#leftNavDrawerIcon').click();
    await panel.waitFor({ state: 'visible', timeout: 5000 });
}

/** The last chat-completions request the mock received. */
function lastChatRequest() {
    return [...mock.requests].reverse().find(r => r.url.endsWith('/chat/completions'));
}

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [MOCK_REPLY, MOCK_REPLY, MOCK_REPLY, MOCK_REPLY] });
    server = await startServer({ batchKey: 'generation', scenarioId: 'kimi-partial' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapMoonshotBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL, model: 'kimi-e2e' });
    // Seed the shipped default preset body under a dedicated name so Test C
    // has a clean, environment-independent reset target whose body carries
    // the current default values (including the kimi_* keys).
    writePreset({ dataRoot: server.dataRoot, name: 'kimi-e2e-clean' });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe.serial('Kimi partial prefill', () => {

    test('A — wire injection with character-sourced name; prefix never displayed', async ({ page }) => {
        test.setTimeout(120_000);
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // Real user path: open the drawer, verify source gating, enable the mode.
        await openAiConfigDrawer(page);
        const kimiBlock = page.locator('#kimi_partial_mode').locator('..');
        await kimiBlock.waitFor({ state: 'visible', timeout: 5000 });
        // #kimi_partial_config is display:none until the checkbox is on.
        await expect(page.locator('#kimi_partial_config')).toBeHidden();
        await page.locator('label[for="kimi_partial_mode"]').click();
        await expect(page.locator('#kimi_partial_mode')).toBeChecked();
        await page.locator('#kimi_partial_config').waitFor({ state: 'visible', timeout: 5000 });

        // Name visibility: manual reveals the name input; the other two
        // sources (none / character card) hide it. End on character so the
        // send below exercises the character-sourced name path.
        const nameSource = page.locator('#kimi_partial_name_source');
        await nameSource.selectOption('manual');
        await page.locator('#kimi_partial_name_block').waitFor({ state: 'visible', timeout: 5000 });
        await nameSource.selectOption('');
        await expect(page.locator('#kimi_partial_name_block')).toBeHidden();
        await nameSource.selectOption('character');
        await expect(page.locator('#kimi_partial_name_block')).toBeHidden();

        await page.locator('#kimi_partial_content').fill(PREFIX);
        // Flush the debounced settings save synchronously before sending.
        await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            await ctx.saveSettings?.(0, { directSave: true });
        });

        await sendMessageAndAwaitReply(page, 'What do you see on the water tonight?');

        // Wire: trailing assistant partial message carrying the prefix.
        const gen = lastChatRequest();
        expect(gen, 'no /chat/completions request was recorded').toBeTruthy();
        const messages = gen.body?.messages;
        expect(Array.isArray(messages)).toBe(true);
        const last = messages[messages.length - 1];
        expect(last.role).toBe('assistant');
        expect(last.content).toBe(PREFIX);
        expect(last.partial).toBe(true);
        // Character-sourced name = the selected character's display name.
        expect(last.name).toBe('Seraphina');
        const prev = messages[messages.length - 2];
        expect(prev.role).toBe('user');

        // Display: the bubble shows the mock reply, never the prefix.
        const rendered = await getRenderedChatTexts(page);
        const bubble = rendered[rendered.length - 1];
        expect(bubble).toContain('lantern stays lit');
        expect(bubble).not.toContain('Her reply begins thus');
    });

    test('B — manual name variant reaches the wire', async ({ page }) => {
        test.setTimeout(120_000);
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        await openAiConfigDrawer(page);
        // The mode persists from Test A (settings save flushed).
        await expect(page.locator('#kimi_partial_mode')).toBeChecked();
        await page.locator('#kimi_partial_name_source').selectOption('manual');
        await page.locator('#kimi_partial_name').fill('Mira');
        await page.locator('#kimi_partial_content').fill(PREFIX);
        await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            await ctx.saveSettings?.(0, { directSave: true });
        });

        await sendMessageAndAwaitReply(page, 'Signal from the watchtower — describe it.');

        const gen = lastChatRequest();
        const last = gen.body?.messages?.[gen.body.messages.length - 1];
        expect(last.role).toBe('assistant');
        expect(last.partial).toBe(true);
        expect(last.name).toBe('Mira');

        const rendered = await getRenderedChatTexts(page);
        expect(rendered[rendered.length - 1]).not.toContain('Her reply begins thus');
    });

    test('C — preset round trip rehydrates the four controls', async ({ page }) => {
        test.setTimeout(120_000);
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // Start from the clean seeded preset so the runtime settings (and
        // any preset saved from here) inherit the shipped default values
        // instead of whatever the seed settings carried on the active
        // preset.
        await openAiConfigDrawer(page);
        await selectPresetByName(page, 'kimi-e2e-clean');
        await expect(page.locator('#kimi_partial_mode')).not.toBeChecked();

        // Build the ON state and save it as the round-trip subject.
        await page.locator('label[for="kimi_partial_mode"]').click();
        await expect(page.locator('#kimi_partial_mode')).toBeChecked();
        await page.locator('#kimi_partial_content').fill('Round trip prefix');
        await page.locator('#kimi_partial_name_source').selectOption('manual');
        await page.locator('#kimi_partial_name').fill('Mira');
        await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            await ctx.saveSettings?.(0, { directSave: true });
        });

        await savePresetAsViaButton(page, 'kimi-e2e-preset');

        // Switch back to the clean preset — the controls reset.
        await selectPresetByName(page, 'kimi-e2e-clean');
        await expect(page.locator('#kimi_partial_mode')).not.toBeChecked();
        await expect(page.locator('#kimi_partial_content')).toHaveValue('');
        await expect(page.locator('#kimi_partial_name_source')).toHaveValue('');
        // name_block visibility is driven by the select's change handler;
        // after a preset switch the block can lag one event behind the
        // already-updated select value, so only the value is asserted here.
        await expect(page.locator('#kimi_partial_name')).toHaveValue('');

        // Switch to the saved preset — all four controls rehydrate from
        // the body written above.
        await selectPresetByName(page, 'kimi-e2e-preset');
        await expect(page.locator('#kimi_partial_mode')).toBeChecked();
        await expect(page.locator('#kimi_partial_content')).toHaveValue('Round trip prefix');
        await expect(page.locator('#kimi_partial_name_source')).toHaveValue('manual');
        await expect(page.locator('#kimi_partial_name')).toHaveValue('Mira');
    });
});
