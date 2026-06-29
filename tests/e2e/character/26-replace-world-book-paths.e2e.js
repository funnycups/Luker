// Test ALL replace scenarios end-to-end:
//  - Scenario A: Old binding lost, new card has embedded book → World button click should
//    import the embedded book and bind it.
//  - Scenario B: After CEA popup Cancel, More → Import Card Lore should also import.
//  - Scenario C: Second replace (no page reload) should work.
//  - Scenario D: New card's extensions.world points to existing local book → button green,
//    world button opens that book.
//  - Scenario E: New card's extensions.world points to a NEW book name (doesn't exist locally) →
//    button gray, world button should import the embedded book.

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, writeWorldBook, BRYN_ENTRIES } from '../_lib/fixtures.js';
import { disableTagImportPopup, dismissAnyPopup, clickCharacterCard, openCharacterEditPanel, writeEmbeddedCharacter } from './_helpers.js';
import { awaitMainUI } from '../_lib/page.js';
import { write as writePngCard } from '../../../src/character-card-parser.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const ASH_NAME = 'Ash the Cartographer';
const BRIALLEN_NAME = 'Briallen the Lighthouse Keeper';
const BRIALLEN_BOOK_NAME = 'briallen-tides';

function buildBriallenPng(seedPng, overrides = {}) {
    const baseData = {
        name: BRIALLEN_NAME,
        description: 'Lighthouse keeper.',
        personality: '.', scenario: '.', first_mes: '.',
        mes_example: '', creator_notes: 'e2e', system_prompt: '.', post_history_instructions: '',
        alternate_greetings: [], tags: [], creator: 'e2e', character_version: '1.0',
        extensions: {},
        character_book: {
            name: BRIALLEN_BOOK_NAME,
            entries: [{ keys: ['lantern'], content: 'lantern.', extensions: {}, enabled: true, insertion_order: 0 }],
            extensions: {},
        },
        ...overrides,
    };
    return writePngCard(seedPng, JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', ...baseData, data: baseData }));
}

async function clickReplaceWithFile(page, pngPath) {
    await page.evaluate(() => {
        const sel = document.querySelector('#char-management-dropdown');
        sel.querySelector('#replace_update').selected = true;
        window.jQuery(sel).trigger('change');
    });
    const firstPopup = page.locator('dialog.popup[open]').last();
    await firstPopup.waitFor({ state: 'visible', timeout: 5000 });
    await firstPopup.locator('.popup-button-custom', { hasText: /Replace with File/i }).first().click();
    await firstPopup.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    await page.locator('#character_replace_file').setInputFiles(pngPath);
}

async function waitForCeaReplaceLorebookPopup(page) {
    const popup = page.locator('dialog.popup[open]', { hasText: /Replace lorebook|替换角色卡|替換角色卡/ }).last();
    await popup.waitFor({ state: 'visible', timeout: 20_000 });
    return popup;
}

async function inspectState(page) {
    return page.evaluate(() => {
        const ctx = window.Luker?.getContext?.();
        const idx = ctx?.characterId;
        const ch = idx !== undefined ? ctx.characters[idx] : null;
        return {
            worldField: document.querySelector('#character_world')?.value,
            buttonGreen: document.querySelector('#world_button')?.classList.contains('world_set'),
            hasCharacterBook: !!ch?.data?.character_book,
            ext_world: String(ch?.data?.extensions?.world || ''),
            importInfoChid: document.querySelector('#import_character_info') ? window.jQuery('#import_character_info').data('chid') : null,
            importInfoVisible: document.querySelector('#import_character_info') ? window.getComputedStyle(document.querySelector('#import_character_info')).display !== 'none' : null,
        };
    });
}

let mock, tmpDir, briallenPath, briallenWithExtWorldPath, briallenWithGhostBookPath;

test.describe('#26 — post-replace world-book paths actually work', () => {
    test.beforeAll(async () => {
        mock = await startMockLLM({});
        tmpDir = mkdtempSync(resolve(tmpdir(), 'luker-e2e-26-'));
        const seed = readFileSync(resolve(REPO_ROOT, 'default/content/default_Seraphina.png'));
        briallenPath = resolve(tmpDir, 'briallen.png');
        writeFileSync(briallenPath, buildBriallenPng(seed));
        // Variant: new card already has extensions.world pointing to its OWN book
        briallenWithExtWorldPath = resolve(tmpDir, 'briallen-with-ext-world.png');
        writeFileSync(briallenWithExtWorldPath, buildBriallenPng(seed, {
            extensions: { world: BRIALLEN_BOOK_NAME },
        }));
        // Variant: new card has extensions.world pointing to a name that won't exist locally
        briallenWithGhostBookPath = resolve(tmpDir, 'briallen-with-ghost-book.png');
        writeFileSync(briallenWithGhostBookPath, buildBriallenPng(seed, {
            extensions: { world: 'some-other-book-that-does-not-exist' },
        }));
    });

    test.afterAll(async () => {
        await mock?.stop();
        if (tmpDir && existsSync(tmpDir)) {
            try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        }
    });

    test('A: after CEA Cancel, world_button click imports the embedded book and binds it', async ({ page }) => {
        const server = await startServer({ batchKey: 'character', scenarioId: '26-A' });
        try {
            markOnboarded({ dataRoot: server.dataRoot });
            disableTagImportPopup({ dataRoot: server.dataRoot });
            bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            const ashBook = writeWorldBook({ dataRoot: server.dataRoot, name: 'ash-26a-book', entries: BRYN_ENTRIES });
            writeEmbeddedCharacter({
                dataRoot: server.dataRoot,
                avatarFile: 'ash-26a.png',
                overrides: { extensions: { world: ashBook } },
            });

            await awaitMainUI(page, server.baseURL);
            await clickCharacterCard(page, ASH_NAME);
            await dismissAnyPopup(page);
            await openCharacterEditPanel(page);

            await clickReplaceWithFile(page, briallenPath);
            const popup = await waitForCeaReplaceLorebookPopup(page);
            await popup.locator('.popup-button-cancel').first().click();
            await popup.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(500);

            const after = await inspectState(page);
            expect(after.hasCharacterBook, 'character_book present after replace + Cancel').toBe(true);
            expect(after.ext_world, 'no binding after Cancel (this matches the gray button)').toBe('');
            expect(after.buttonGreen, 'world button is gray').toBe(false);
            expect(after.importInfoVisible, 'More→Import Card Lore option visible').toBe(true);

            // Click world button — should pop the import confirm
            await page.locator('#world_button').click({ timeout: 5000 });
            const importConfirm = page.locator('dialog.popup[open]', { hasText: new RegExp(`import '${BRIALLEN_BOOK_NAME}'|要导入.*${BRIALLEN_BOOK_NAME}|要匯入.*${BRIALLEN_BOOK_NAME}`) }).last();
            await importConfirm.waitFor({ state: 'visible', timeout: 5000 });
            await importConfirm.locator('.popup-button-ok').first().click();
            await importConfirm.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(2500);

            // Verify book is on disk + binding persists in-memory
            const newBookPath = resolve(server.dataRoot, 'default-user', 'worlds', `${BRIALLEN_BOOK_NAME}.json`);
            expect(existsSync(newBookPath), `${BRIALLEN_BOOK_NAME}.json on disk`).toBe(true);
            // Wait for the binding to land (writeExtensionField + saveCharacterDebounced)
            await page.waitForFunction(({ want }) => {
                const ctx = window.Luker?.getContext?.();
                const idx = ctx?.characterId;
                const ch = idx !== undefined ? ctx.characters[idx] : null;
                return String(ch?.data?.extensions?.world || '').trim() === want;
            }, { want: BRIALLEN_BOOK_NAME }, { timeout: 10_000 });

            // CRITICAL — verify the binding actually persisted to DISK.
            // The legacy bug was: importEmbeddedWorldInfo only updated the
            // visible select, never `characters[chid].data.extensions.world`,
            // so the next /edit POST silently wiped the binding on disk and
            // the user saw "gray world button after reload" + "have to
            // replace again". Restart the server + reload the page and
            // require the binding to still be there.
            await server.restart();
            await page.reload();
            await awaitMainUI(page, server.baseURL);
            await clickCharacterCard(page, BRIALLEN_NAME, { timeoutMs: 20_000 });
            await dismissAnyPopup(page);
            await openCharacterEditPanel(page);
            await page.waitForFunction(({ want }) => {
                const ctx = window.Luker?.getContext?.();
                const idx = ctx?.characterId;
                const ch = idx !== undefined ? ctx.characters[idx] : null;
                return String(ch?.data?.extensions?.world || '').trim() === want;
            }, { want: BRIALLEN_BOOK_NAME }, { timeout: 10_000 });
            const persisted = await inspectState(page);
            expect(persisted.buttonGreen, 'world button is green after restart').toBe(true);
            expect(persisted.ext_world).toBe(BRIALLEN_BOOK_NAME);
        } finally {
            await tearDownServer(server);
        }
    });

    test('B: after CEA Cancel, More→Import Card Lore also imports', async ({ page }) => {
        const server = await startServer({ batchKey: 'character', scenarioId: '26-B' });
        try {
            markOnboarded({ dataRoot: server.dataRoot });
            disableTagImportPopup({ dataRoot: server.dataRoot });
            bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            const ashBook = writeWorldBook({ dataRoot: server.dataRoot, name: 'ash-26b-book', entries: BRYN_ENTRIES });
            writeEmbeddedCharacter({
                dataRoot: server.dataRoot,
                avatarFile: 'ash-26b.png',
                overrides: { extensions: { world: ashBook } },
            });

            await awaitMainUI(page, server.baseURL);
            await clickCharacterCard(page, ASH_NAME);
            await dismissAnyPopup(page);
            await openCharacterEditPanel(page);

            await clickReplaceWithFile(page, briallenPath);
            const popup = await waitForCeaReplaceLorebookPopup(page);
            await popup.locator('.popup-button-cancel').first().click();
            await popup.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(500);

            // Use More→Import Card Lore
            await page.evaluate(() => {
                const sel = document.querySelector('#char-management-dropdown');
                sel.querySelector('#import_character_info').selected = true;
                window.jQuery(sel).trigger('change');
            });
            const importConfirm = page.locator('dialog.popup[open]', { hasText: new RegExp(`import '${BRIALLEN_BOOK_NAME}'|要导入.*${BRIALLEN_BOOK_NAME}|要匯入.*${BRIALLEN_BOOK_NAME}`) }).last();
            await importConfirm.waitFor({ state: 'visible', timeout: 5000 });
            await importConfirm.locator('.popup-button-ok').first().click();
            await importConfirm.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(2000);

            const newBookPath = resolve(server.dataRoot, 'default-user', 'worlds', `${BRIALLEN_BOOK_NAME}.json`);
            expect(existsSync(newBookPath), `${BRIALLEN_BOOK_NAME}.json on disk`).toBe(true);
        } finally {
            await tearDownServer(server);
        }
    });

    test('C: second replace on the same page works (no reload needed)', async ({ page }) => {
        const server = await startServer({ batchKey: 'character', scenarioId: '26-C' });
        try {
            markOnboarded({ dataRoot: server.dataRoot });
            disableTagImportPopup({ dataRoot: server.dataRoot });
            bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            const ashBook = writeWorldBook({ dataRoot: server.dataRoot, name: 'ash-26c-book', entries: BRYN_ENTRIES });
            writeEmbeddedCharacter({
                dataRoot: server.dataRoot,
                avatarFile: 'ash-26c.png',
                overrides: { extensions: { world: ashBook } },
            });

            await awaitMainUI(page, server.baseURL);
            await clickCharacterCard(page, ASH_NAME);
            await dismissAnyPopup(page);
            await openCharacterEditPanel(page);

            // First replace — cancel CEA
            await clickReplaceWithFile(page, briallenPath);
            const popup1 = await waitForCeaReplaceLorebookPopup(page);
            await popup1.locator('.popup-button-cancel').first().click();
            await popup1.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(500);

            // Second replace (same file)
            await clickReplaceWithFile(page, briallenPath);
            const popup2 = await waitForCeaReplaceLorebookPopup(page);
            expect(await popup2.isVisible()).toBe(true);
            await popup2.locator('.popup-button-cancel').first().click();
            await popup2.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
        } finally {
            await tearDownServer(server);
        }
    });

    test('D: new card with extensions.world pointing to existing local book → binding preserved', async ({ page }) => {
        const server = await startServer({ batchKey: 'character', scenarioId: '26-D' });
        try {
            markOnboarded({ dataRoot: server.dataRoot });
            disableTagImportPopup({ dataRoot: server.dataRoot });
            bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            // Pre-create the book the new card points to.
            writeWorldBook({ dataRoot: server.dataRoot, name: BRIALLEN_BOOK_NAME, entries: BRYN_ENTRIES });
            const ashBook = writeWorldBook({ dataRoot: server.dataRoot, name: 'ash-26d-book', entries: BRYN_ENTRIES });
            writeEmbeddedCharacter({
                dataRoot: server.dataRoot,
                avatarFile: 'ash-26d.png',
                overrides: { extensions: { world: ashBook } },
            });

            await awaitMainUI(page, server.baseURL);
            await clickCharacterCard(page, ASH_NAME);
            await dismissAnyPopup(page);
            await openCharacterEditPanel(page);

            await clickReplaceWithFile(page, briallenWithExtWorldPath);
            const popup = await waitForCeaReplaceLorebookPopup(page);
            await popup.locator('.popup-button-cancel').first().click();
            await popup.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(500);

            // The new card was distributed with extensions.world = briallen-tides
            // AND that book exists locally → button should be GREEN.
            await page.waitForFunction(() => {
                return document.querySelector('#world_button')?.classList.contains('world_set');
            }, null, { timeout: 5000 });
        } finally {
            await tearDownServer(server);
        }
    });

    test('E: new card with extensions.world pointing to a ghost name → world button can still import the embedded book', async ({ page }) => {
        const server = await startServer({ batchKey: 'character', scenarioId: '26-E' });
        try {
            markOnboarded({ dataRoot: server.dataRoot });
            disableTagImportPopup({ dataRoot: server.dataRoot });
            bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            const ashBook = writeWorldBook({ dataRoot: server.dataRoot, name: 'ash-26e-book', entries: BRYN_ENTRIES });
            writeEmbeddedCharacter({
                dataRoot: server.dataRoot,
                avatarFile: 'ash-26e.png',
                overrides: { extensions: { world: ashBook } },
            });

            await awaitMainUI(page, server.baseURL);
            await clickCharacterCard(page, ASH_NAME);
            await dismissAnyPopup(page);
            await openCharacterEditPanel(page);

            await clickReplaceWithFile(page, briallenWithGhostBookPath);
            const popup = await waitForCeaReplaceLorebookPopup(page);
            await popup.locator('.popup-button-cancel').first().click();
            await popup.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(500);

            // ghost binding → button gray
            const after = await inspectState(page);
            expect(after.buttonGreen).toBe(false);
            expect(after.hasCharacterBook).toBe(true);

            // World button click → should import the embedded book
            await page.locator('#world_button').click({ timeout: 5000 });
            const importConfirm = page.locator('dialog.popup[open]', { hasText: new RegExp(`import '${BRIALLEN_BOOK_NAME}'|要导入.*${BRIALLEN_BOOK_NAME}|要匯入.*${BRIALLEN_BOOK_NAME}`) }).last();
            await importConfirm.waitFor({ state: 'visible', timeout: 5000 });
        } finally {
            await tearDownServer(server);
        }
    });
});
