// #86 — The director's unsaved-preset dialog, answered by the user.
//
// Before swapping to its synthetic prompt-composition preset, the director
// asks what to do with unsaved edits to the active chat-completion preset.
// Generation waits on the answer.
//
// REAL USER-GESTURE flow, once per branch:
//   1. In the orchestrator drawer: enable, switch to director mode.
//   2. In the AI Response Configuration drawer: change Max Response Length
//      without saving the preset.
//   3. Send one chat turn from the composer. The unsaved-preset dialog opens;
//      click "Discard and continue" or "Save and continue".
//   4. The director writes the reply and finalizes. Afterwards:
//      - Discard: the preset file on disk keeps the saved value and the
//        field shows the saved value again once the preset is restored.
//      - Save: the preset file on disk holds the edited value and the field
//        keeps showing it after the restore.

import { test, expect } from '../../harness/playwright.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply, closeAnyOpenTopSettingsDrawer } from '../_lib/page.js';
import { enableOrchestratorMode } from '../_lib/ui-orchestrator.js';

let server, mock;

function readDefaultPreset() {
    return JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'OpenAI Settings', 'Default.json'), 'utf8'));
}

function readUserSettings() {
    return JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'settings.json'), 'utf8'));
}

function scriptReply(text) {
    mock.scriptDirectorRun({
        route: ({ role, turn }) => {
            if (role !== 'director-main') return null;
            if (turn === 0) return { tool: 'write_message', arguments: { text, mode: 'replace' } };
            if (turn === 1) return { tool: 'finalize', arguments: {} };
            return null;
        },
    });
}

async function openResponseConfig(page) {
    const field = page.locator('#openai_max_tokens');
    if (!(await field.isVisible())) {
        await page.locator('#ai-config-button .drawer-toggle').click();
    }
    await field.waitFor({ state: 'visible', timeout: 10_000 });
    return field;
}

/**
 * Edit Max Response Length, send a turn, answer the unsaved-preset dialog
 * with `buttonText`, and return the reply.
 */
async function sendWithDirtyPreset(page, { maxTokens, buttonText, message, reply }) {
    const field = await openResponseConfig(page);
    await field.fill(String(maxTokens));
    await closeAnyOpenTopSettingsDrawer(page);
    scriptReply(reply);

    const sent = sendMessageAndAwaitReply(page, message, { timeoutMs: 60_000 });
    const dialog = page.locator('.popup:visible', { hasText: 'has unsaved changes' });
    await expect(dialog).toHaveCount(1, { timeout: 30_000 });
    await expect(dialog).toContainText('"Default"');
    await dialog.locator('.popup-controls .menu_button', { hasText: buttonText }).click();
    await expect(dialog).toHaveCount(0);
    return sent;
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope, batchKey: 'orchestrator', scenarioId: '86-director-unsaved-preset-dialog' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe.serial('#86 — director unsaved-preset dialog', () => {
    test.setTimeout(180_000);

    test('Discard and continue keeps the saved preset and runs the turn', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await enableOrchestratorMode(page, 'director');

        const savedMaxTokens = readDefaultPreset().openai_max_tokens;
        expect(savedMaxTokens).not.toBe(777);

        const replyText = '*Seraphina folds the chart.* "The channel stays closed tonight."';
        const { text } = await sendWithDirtyPreset(page, {
            maxTokens: 777,
            buttonText: 'Discard and continue',
            message: '*I tap the chart.* "Can we make the channel before the tide turns?"',
            reply: replyText,
        });
        expect(text).toContain('The channel stays closed tonight.');

        expect(readDefaultPreset().openai_max_tokens).toBe(savedMaxTokens);
        const field = await openResponseConfig(page);
        await expect(field).toHaveValue(String(savedMaxTokens));
        await closeAnyOpenTopSettingsDrawer(page);
        await expect.poll(() => readUserSettings()?.extension_settings?.orchestrator, { timeout: 15_000 })
            .toMatchObject({ enabled: true, executionMode: 'director' });
    });

    test('Save and continue writes the edit into the preset and runs the turn', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        const replyText = '*Seraphina lifts the lantern.* "Then we wait for the morning bell."';
        const { text } = await sendWithDirtyPreset(page, {
            maxTokens: 888,
            buttonText: 'Save and continue',
            message: '*I glance at the harbor bell.* "And if the tide never turns?"',
            reply: replyText,
        });
        expect(text).toContain('Then we wait for the morning bell.');

        await expect.poll(() => readDefaultPreset().openai_max_tokens, { timeout: 15_000 }).toBe(888);
        const field = await openResponseConfig(page);
        await expect(field).toHaveValue('888');
        await closeAnyOpenTopSettingsDrawer(page);
    });
});
