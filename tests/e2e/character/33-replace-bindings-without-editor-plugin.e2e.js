// #33 — Binding preservation is core-owned.
//
// Part 1: replacing a binding-free card with another binding-free card
// shows no conflict dialog and writes nothing.
// Part 2: with the Character Editor Assistant disabled through the
// extensions UI, replacing a card that carries a bound preset still keeps
// it — and the editor's world-book popup never appears.

import { test, expect } from '../../harness/playwright.js';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { disableTagImportPopup, dismissAnyPopup, clickCharacterCard, openCharacterEditPanel, writeEmbeddedCharacter, openReplaceWithFile } from './_helpers.js';
import { awaitMainUI, openExtensionsDrawer } from '../_lib/page.js';
import { write as writePngCard, read as readPngCard } from '../../../src/character-card-parser.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const OLD_NAME = 'Ash the Cartographer';
const NEW_NAME = 'Briallen the Lighthouse Keeper';
const BOUND_PRESET = 'Tidewatch';

function writeReplacementPng(outPath, extensions = {}) {
    const seed = readFileSync(resolve(REPO_ROOT, 'default/content/default_Seraphina.png'));
    const data = {
        name: NEW_NAME,
        description: 'A weathered keeper of the eastern light.',
        personality: 'Patient.',
        scenario: 'You climb the spiral stair.',
        first_mes: '*The wick hisses.*',
        mes_example: '',
        creator_notes: 'e2e',
        system_prompt: 'Stay in scene.',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: ['fixture'],
        creator: 'luker-e2e',
        character_version: '1.0',
        extensions,
    };
    const payload = { spec: 'chara_card_v2', spec_version: '2.0', ...data, data };
    writeFileSync(outPath, writePngCard(seed, JSON.stringify(payload)));
    return outPath;
}

function readReplacedCard(dataRoot) {
    const charsDir = resolve(dataRoot, 'default-user/characters');
    for (const file of readdirSync(charsDir).filter(name => name.endsWith('.png'))) {
        try {
            const meta = JSON.parse(readPngCard(readFileSync(resolve(charsDir, file))));
            if ((meta?.data?.name || meta?.name) === NEW_NAME) {
                return meta.data;
            }
        } catch { /* not a card */ }
    }
    throw new Error(`replacement card ${NEW_NAME} not found on disk`);
}

/**
 * Which side of the replace flow settled first: an open dialog, the
 * CHARACTER_REPLACED event, or neither yet.
 * @returns {Promise<'popup' | 'replaced' | 'pending'>}
 */
async function readReplaceOutcome(openPopups, replacedFired) {
    if (await openPopups.count() > 0) return 'popup';
    return replacedFired ? 'replaced' : 'pending';
}

let mock, tmpDir, plainReplacementPath;

test.describe('#33 — binding preservation without the editor plugin', () => {
    test.beforeAll(async ({ workerResources }, testInfo) => {
        const scope = await workerResources.scenario(testInfo.file);
        mock = await startMockLLM({});
        tmpDir = (await scope.directory('luker-e2e-33')).path;
        plainReplacementPath = writeReplacementPng(resolve(tmpDir, 'briallen-plain.png'));
    });

    test.afterAll(async () => {
        await mock?.stop();
    });

    test('a binding-free replacement shows no dialog and writes no binding data', async ({ resources, page }) => {
        const server = await startServer({ scope: resources, batchKey: 'character', scenarioId: 'binding-none' });
        {
            markOnboarded({ dataRoot: server.dataRoot });
            disableTagImportPopup({ dataRoot: server.dataRoot });
            bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: 'ash-binding-none.png' });

            await awaitMainUI(page, server.baseURL);
            await clickCharacterCard(page, OLD_NAME);
            await dismissAnyPopup(page);
            await openCharacterEditPanel(page);

            await openReplaceWithFile(page, plainReplacementPath);

            // The CEA world-book popup proves the flow ran to completion;
            // if the conflict dialog had appeared, this popup could not be
            // up yet. `dismissAnyPopup` alone cannot stand in for this
            // barrier — Playwright's `locator.isVisible()` does not wait —
            // so wait for the popup itself, then dismiss it.
            const worldBookPopup = page.locator('dialog.popup[open]', { hasText: /Replace:|替换角色卡|替換角色卡/ }).last();
            await worldBookPopup.waitFor({ state: 'visible', timeout: 15_000 });
            await dismissAnyPopup(page, { maxRounds: 5, perRoundTimeoutMs: 2500 });

            const disk = readReplacedCard(server.dataRoot).extensions;
            expect(disk.luker).toBeUndefined();
            expect(disk.orchestrator).toBeUndefined();
            expect(disk.memory_graph).toBeUndefined();
            expect(disk.card_app).toBeUndefined();
        }
    });

    test('disabling the Character Editor Assistant keeps binding protection alive', async ({ resources, page }) => {
        const server = await startServer({ scope: resources, batchKey: 'character', scenarioId: 'binding-no-cea' });
        try {
            markOnboarded({ dataRoot: server.dataRoot });
            disableTagImportPopup({ dataRoot: server.dataRoot });
            bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            writeEmbeddedCharacter({
                dataRoot: server.dataRoot,
                avatarFile: 'ash-binding-no-cea.png',
                overrides: {
                    extensions: {
                        luker: {
                            chat_completion_preset: {
                                presets: [{ name: BOUND_PRESET, preset: { temperature: 0.7 } }],
                                defaultPresetName: BOUND_PRESET,
                            },
                        },
                    },
                },
            });

            await awaitMainUI(page, server.baseURL);

            // Disable CEA through the real extensions UI.
            await openExtensionsDrawer(page);
            await page.locator('#extensions_details').click();
            const managePopup = page.locator('dialog.popup[open]', { hasText: /Installed Extensions|Built-in Extensions/ }).last();
            await managePopup.waitFor({ state: 'visible', timeout: 10_000 });
            await managePopup.locator('.extension_block[data-name="character-editor-assistant"] .extension_toggle input').click();
            // The delegated toggle handler is async; wait (read-only) until
            // the live settings reflect the push so the popup-close save +
            // reload path below is guaranteed to observe `stateChanged`.
            await expect.poll(() => page.evaluate(() =>
                window.Luker.getContext().extensionSettings.disabledExtensions.includes('character-editor-assistant'),
            ), { timeout: 5000 }).toBe(true);
            // Closing the popup runs the deferred save and triggers the reload.
            const reloaded = page.waitForEvent('load', { timeout: 30_000 });
            await page.keyboard.press('Escape');
            await reloaded;
            await awaitMainUI(page, server.baseURL);

            const disabled = await page.evaluate(() => window.Luker.getContext().extensionSettings.disabledExtensions.includes('character-editor-assistant'));
            expect(disabled).toBe(true);

            await clickCharacterCard(page, OLD_NAME);
            await openCharacterEditPanel(page);
            // Read-only listener: CHARACTER_REPLACED is emitted after the
            // binding write-back and the world-book step have both finished,
            // so any dialog either step would open exists by then.
            await page.evaluate(() => {
                const ctx = window.Luker.getContext();
                window.__e2eCharacterReplaced = false;
                const handler = () => { window.__e2eCharacterReplaced = true; };
                ctx.eventSource.on(ctx.eventTypes.CHARACTER_REPLACED, handler);
                window.__e2eReplacementCleanup = () => ctx.eventSource.removeListener(ctx.eventTypes.CHARACTER_REPLACED, handler);
            });
            await openReplaceWithFile(page, plainReplacementPath);

            // The replace + preservation chain is async; wait for the
            // preserved preset to land on disk before the final read.
            await expect.poll(() => {
                try {
                    return readReplacedCard(server.dataRoot).extensions?.luker?.chat_completion_preset?.presets?.[0]?.name || '';
                } catch {
                    return '';
                }
            }, { timeout: 30_000 }).toBe(BOUND_PRESET);

            // No world-book popup (CEA is disabled) and no binding dialog
            // (the silent path) may appear. Nothing auto-dismisses popups, so
            // one opened during the replace flow is still open here; a dialog
            // that blocks the flow settles the wait as 'popup' instead.
            const openPopups = page.locator('dialog.popup[open]');
            const replaceOutcome = async () => readReplaceOutcome(openPopups, await page.evaluate(() => window.__e2eCharacterReplaced));
            await expect.poll(replaceOutcome, { timeout: 30_000, message: 'CHARACTER_REPLACED or a replace dialog' }).not.toBe('pending');
            expect(await replaceOutcome()).toBe('replaced');
            await expect(openPopups).toHaveCount(0);

            const disk = readReplacedCard(server.dataRoot).extensions;
            expect(disk.luker?.chat_completion_preset?.presets?.[0]?.name).toBe(BOUND_PRESET);
        } finally {
            if (!page.isClosed()) await page.evaluate(() => { window.__e2eReplacementCleanup?.(); delete window.__e2eReplacementCleanup; });

        }
    });
});
