// #34 — World book decisions are core-owned.
//
// Part 1: with the Character Editor Assistant disabled, replacing a card
// that is bound to an existing world book with a card that carries an
// embedded book offers Import new book / Keep old book from the core
// popup — the merge action is absent — and importing creates and binds the
// new book while the old book survives on disk.
// Part 2: same setup, choosing Keep old book leaves the new book
// unmaterialized and keeps the previous binding.

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, writeWorldBook } from '../_lib/fixtures.js';
import { disableTagImportPopup, clickCharacterCard, openCharacterEditPanel, writeEmbeddedCharacter, openReplaceWithFile } from './_helpers.js';
import { awaitMainUI, openExtensionsDrawer } from '../_lib/page.js';
import { write as writePngCard, read as readPngCard } from '../../../src/character-card-parser.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const OLD_BOOK = 'bryn-headland-core-no-cea';
const NEW_NAME = 'Briallen the Lighthouse Keeper';
const NEW_BOOK = 'briallen-no-cea';
const NEW_ENTRY_CONTENT = 'The eastern light burns whale oil on a sixteen-hour cycle.';

function buildReplacementPng(outPath) {
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
        extensions: {},
        character_book: {
            name: NEW_BOOK,
            entries: [
                {
                    keys: ['eastern light', 'lantern'],
                    content: NEW_ENTRY_CONTENT,
                    extensions: {},
                    enabled: true,
                    insertion_order: 0,
                },
            ],
            extensions: {},
        },
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

async function disableCharacterEditorAssistant(page, server) {
    await openExtensionsDrawer(page);
    await page.locator('#extensions_details').click();
    const managePopup = page.locator('dialog.popup[open]', { hasText: /Installed Extensions|Built-in Extensions/ }).last();
    await managePopup.waitFor({ state: 'visible', timeout: 10_000 });
    await managePopup.locator('.extension_block[data-name="character-editor-assistant"] .extension_toggle input').click();
    // The delegated toggle handler is async; wait (read-only) until the live
    // settings reflect the push so the popup-close save + reload path
    // observes `stateChanged`.
    await expect.poll(() => page.evaluate(() =>
        window.Luker.getContext().extensionSettings.disabledExtensions.includes('character-editor-assistant'),
    ), { timeout: 5000 }).toBe(true);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await awaitMainUI(page, server.baseURL);
    const disabled = await page.evaluate(() => window.Luker.getContext().extensionSettings.disabledExtensions.includes('character-editor-assistant'));
    expect(disabled).toBe(true);
}

function writeBoundAsh(dataRoot, avatarFile) {
    writeWorldBook({
        dataRoot,
        name: OLD_BOOK,
        entries: [{ key: ['reef'], content: 'The reef shifts three feet a year.', comment: 'reef' }],
    });
    writeEmbeddedCharacter({
        dataRoot,
        avatarFile,
        overrides: { extensions: { world: OLD_BOOK } },
    });
}

let mock, tmpDir, replacementPath;

test.describe('#34 — world book decisions without the editor plugin', () => {
    test.beforeAll(async () => {
        mock = await startMockLLM({});
        tmpDir = mkdtempSync(resolve(tmpdir(), 'luker-e2e-34-'));
        replacementPath = buildReplacementPng(resolve(tmpDir, 'briallen-embedded.png'));
    });

    test.afterAll(async () => {
        await mock?.stop();
        if (tmpDir) {
            try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
        }
    });

    test('importing the new embedded book works with the editor plugin disabled', async ({ page }) => {
        const server = await startServer({ batchKey: 'character', scenarioId: 'worldbook-no-cea-import' });
        try {
            markOnboarded({ dataRoot: server.dataRoot });
            disableTagImportPopup({ dataRoot: server.dataRoot });
            bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            writeBoundAsh(server.dataRoot, 'ash-wb-no-cea.png');

            await awaitMainUI(page, server.baseURL);
            await disableCharacterEditorAssistant(page, server);
            // Seed data may contain same-named cards, so target the fixture by avatar.
            await clickCharacterCard(page, { avatar: 'ash-wb-no-cea.png' });
            await openCharacterEditPanel(page);
            await openReplaceWithFile(page, replacementPath);

            const popup = page.locator('dialog.popup[open]', { hasText: /Replace:|替换角色卡|替換角色卡/ }).last();
            await popup.waitFor({ state: 'visible', timeout: 20_000 });
            const importButton = popup.locator('.popup-button-custom', { hasText: /Import new book|导入新世界书|匯入新世界書/ });
            await expect(importButton).toBeVisible();
            await expect(popup.locator('.popup-button-custom', { hasText: /Keep old book|保留旧世界书|保留舊世界書/ })).toBeVisible();
            await expect(popup.locator('.popup-button-custom', { hasText: /Merge in editor|在编辑器中合并|在編輯器中合併/ })).toHaveCount(0);
            await importButton.click();

            const newBookPath = resolve(server.dataRoot, 'default-user', 'worlds', `${NEW_BOOK}.json`);
            const oldBookPath = resolve(server.dataRoot, 'default-user', 'worlds', `${OLD_BOOK}.json`);
            await expect.poll(() => existsSync(newBookPath), { timeout: 30_000 }).toBe(true);
            expect(readFileSync(newBookPath, 'utf8')).toContain(NEW_ENTRY_CONTENT);
            expect(existsSync(oldBookPath)).toBe(true);

            await expect.poll(() => {
                try {
                    return readReplacedCard(server.dataRoot).extensions?.world || '';
                } catch {
                    return '';
                }
            }, { timeout: 30_000 }).toBe(NEW_BOOK);

            // No lingering dialog: the legacy ST popup was suppressed and the
            // core popup closed with the click.
            await expect(page.locator('dialog.popup[open]')).toHaveCount(0);
        } finally {
            await tearDownServer(server);
        }
    });

    test('keeping the old book works with the editor plugin disabled', async ({ page }) => {
        const server = await startServer({ batchKey: 'character', scenarioId: 'worldbook-no-cea-keep' });
        try {
            markOnboarded({ dataRoot: server.dataRoot });
            disableTagImportPopup({ dataRoot: server.dataRoot });
            bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            writeBoundAsh(server.dataRoot, 'ash-wb-no-cea-keep.png');

            await awaitMainUI(page, server.baseURL);
            await disableCharacterEditorAssistant(page, server);
            await clickCharacterCard(page, { avatar: 'ash-wb-no-cea-keep.png' });
            await openCharacterEditPanel(page);
            await openReplaceWithFile(page, replacementPath);

            const popup = page.locator('dialog.popup[open]', { hasText: /Replace:|替换角色卡|替換角色卡/ }).last();
            await popup.waitFor({ state: 'visible', timeout: 20_000 });
            await popup.locator('.popup-button-custom', { hasText: /Keep old book|保留旧世界书|保留舊世界書/ }).click();

            const newBookPath = resolve(server.dataRoot, 'default-user', 'worlds', `${NEW_BOOK}.json`);
            const oldBookPath = resolve(server.dataRoot, 'default-user', 'worlds', `${OLD_BOOK}.json`);
            await expect.poll(() => {
                try {
                    return readReplacedCard(server.dataRoot).extensions?.world || '';
                } catch {
                    return '';
                }
            }, { timeout: 30_000 }).toBe(OLD_BOOK);
            expect(existsSync(newBookPath)).toBe(false);
            expect(existsSync(oldBookPath)).toBe(true);
            expect(readFileSync(oldBookPath, 'utf8')).toContain('The reef shifts three feet a year.');
            await expect(page.locator('dialog.popup[open]')).toHaveCount(0);
        } finally {
            await tearDownServer(server);
        }
    });
});
