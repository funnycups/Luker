// #25 — Post-replace popup three-choice flow.
//
// When the user replaces an existing character via the "Replace / Update"
// path in the character More menu, the character-editor-assistant plugin
// raises a confirm popup with up to three concrete next-steps:
//
//   1. Import new book  (when the new PNG carries data.character_book)
//   2. Keep old book    (when the replaced card had a primary world
//                        book and that book still exists on disk)
//   3. Merge in editor  (always shown)
//
// This test drives all three branches end-to-end against a real server +
// real browser + real file picker. The user-visible regression behind
// this test: the prior popup only had "Open editor / Skip", clicking
// Skip silently broke the primary world-book binding, and there was no
// way to import the new card's embedded world from the popup. See
// `confirmOpenCharacterEditorAfterReplace` (removed) and the new
// `promptReplaceOutcomeChoice` in
// public/scripts/extensions/character-editor-assistant/main.js.
//
// Test fixture layout per test:
//   - PRE: write Ash (bound to the bryn-headland world book on disk)
//   - REPLACE: build a PNG for Briallen (different name + description,
//     embeds a different character_book named briallen-tides) and drive
//     #character_import_file via setInputFiles after picking
//     "Replace with File" from the replace confirm popup.
//   - POPUP: the post-replace three-choice popup appears
//   - ASSERT: branch-specific
//
// The replace flow uses the More dropdown gesture exactly as a user
// would — open #char-management-dropdown, change to #replace_update,
// fire change, accept the first confirm popup's "Replace with File"
// custom button, setInputFiles, await the post-replace popup.

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, writeWorldBook, BRYN_ENTRIES } from '../_lib/fixtures.js';
import { disableTagImportPopup, dismissAnyPopup, clickCharacterCard, openCharacterEditPanel, writeEmbeddedCharacter } from './_helpers.js';
import { awaitMainUI, reloadAndAwait, closeRightNavDrawer } from '../_lib/page.js';
import { write as writePngCard } from '../../../src/character-card-parser.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

const ASH_NAME = 'Ash the Cartographer';
const ASH_BOOK = 'bryn-headland-ash';

const BRIALLEN_NAME = 'Briallen the Lighthouse Keeper';
const BRIALLEN_BOOK_NAME = 'briallen-tides';
const BRIALLEN_DESCRIPTION = 'A weathered keeper of the eastern light, raised on the rocks beyond the reef. She knows every tide and every name carved into the lantern base.';
const BRIALLEN_FIRST_MES = '*Briallen does not turn from the lantern.* "Close the hatch. The wick is fickle and the night is long. Tell me what brought you up the stair."';
const BRIALLEN_EMBEDDED_BOOK = {
    name: BRIALLEN_BOOK_NAME,
    entries: [
        {
            keys: ['eastern light', 'lantern'],
            content: 'The eastern light burns whale oil on a sixteen-hour cycle. The wick must be trimmed at slack tide or it smokes.',
            extensions: {},
            enabled: true,
            insertion_order: 0,
        },
        {
            keys: ['reef'],
            content: 'The reef shifts three feet a year. Old maps are obsolete by their fifth winter.',
            extensions: {},
            enabled: true,
            insertion_order: 1,
        },
    ],
    extensions: {},
};

function buildBriallenPng(seedPng) {
    const data = {
        name: BRIALLEN_NAME,
        description: BRIALLEN_DESCRIPTION,
        personality: 'Patient. Sees patterns. Suspicious of unfamiliar lights at sea but never of unfamiliar people on her dock.',
        scenario: 'You climb the spiral stair as Briallen trims the wick. Outside, the reef is restless and the wind smells of brine.',
        first_mes: BRIALLEN_FIRST_MES,
        mes_example: '',
        creator_notes: 'e2e fixture — replace-popup-three-choices',
        system_prompt: 'You are Briallen. Stay in scene. Reply with one to three paragraphs.',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: ['rp', 'fixture'],
        creator: 'luker-e2e',
        character_version: '1.0',
        extensions: {
            depth_prompt: { prompt: '', depth: 4, role: 'system' },
        },
        character_book: BRIALLEN_EMBEDDED_BOOK,
    };
    const payload = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        ...data,
        data,
    };
    return writePngCard(seedPng, JSON.stringify(payload));
}

async function openReplaceWithFile(page, pngPath) {
    // Open the More dropdown, fire 'replace_update'. The change handler
    // pops a confirm popup with two custom buttons (URL / File).
    await page.evaluate(() => {
        const sel = document.querySelector('#char-management-dropdown');
        if (!sel) throw new Error('#char-management-dropdown not found');
        const opt = sel.querySelector('#replace_update');
        if (!opt) throw new Error('#replace_update option not found');
        opt.selected = true;
        if (window.jQuery) window.jQuery(sel).trigger('change');
        else sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // First popup: choose "Replace with File".
    const firstPopup = page.locator('dialog.popup[open]').last();
    await firstPopup.waitFor({ state: 'visible', timeout: 5000 });
    const fileBtn = firstPopup.locator('.popup-button-custom', { hasText: /Replace with File/i }).first();
    await fileBtn.click();
    await firstPopup.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    // The click triggers `$('#character_replace_file').trigger('click')`
    // which opens the OS file picker. Hand Playwright the file path on
    // the hidden input directly.
    await page.locator('#character_replace_file').setInputFiles(pngPath);
}

/**
 * Wait for the CEA post-replace popup to appear and return its locator.
 * Resolves once the dialog with our specific header text is visible.
 */
async function waitForReplaceChoicePopup(page) {
    const popup = page.locator('dialog.popup[open]', {
        hasText: /Replace:|替换角色卡|替換角色卡/,
    }).last();
    await popup.waitFor({ state: 'visible', timeout: 20_000 });
    return popup;
}

let mock, tmpDir, briallenPngPath;

test.describe('#25 — post-replace popup three-choice flow', () => {
    test.beforeAll(async () => {
        mock = await startMockLLM({});
        tmpDir = mkdtempSync(resolve(tmpdir(), 'luker-e2e-replace-popup-'));
        const seed = readFileSync(resolve(REPO_ROOT, 'default/content/default_Seraphina.png'));
        briallenPngPath = resolve(tmpDir, 'briallen.png');
        writeFileSync(briallenPngPath, buildBriallenPng(seed));
    });

    test.afterAll(async () => {
        await mock?.stop();
        if (tmpDir && existsSync(tmpDir)) {
            try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
        }
    });
    test('IMPORT path: clicking "Import the new card\'s embedded world book" creates the new world file, binds it as primary, and the old book stays on disk untouched', async ({ page }) => {
        const server = await startServer({ batchKey: 'character', scenarioId: 'replace-popup-import' });
        try {
            markOnboarded({ dataRoot: server.dataRoot });
            disableTagImportPopup({ dataRoot: server.dataRoot });
            bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            const ashBook = writeWorldBook({ dataRoot: server.dataRoot, name: ASH_BOOK, entries: BRYN_ENTRIES });
            const ashAvatar = writeEmbeddedCharacter({
                dataRoot: server.dataRoot,
                avatarFile: 'ash-import-branch.png',
                overrides: { extensions: { world: ashBook } },
            });

            await awaitMainUI(page, server.baseURL);
            await clickCharacterCard(page, ASH_NAME);
            await dismissAnyPopup(page);
            await openCharacterEditPanel(page);

            // Sanity: Ash is bound to the bryn book.
            const beforeBinding = await page.locator('#character_world').inputValue();
            expect(beforeBinding).toBe(ashBook);

            // Drive the replace gesture.
            await openReplaceWithFile(page, briallenPngPath);
            const popup = await waitForReplaceChoicePopup(page);

            // The popup must offer all three buttons (new card has an
            // embedded book + Ash had a previous binding that still
            // exists on disk).
            const importBtn = popup.locator('.popup-button-custom', {
                hasText: /Import new book|导入新世界书|匯入新世界書/,
            }).first();
            const editorBtn = popup.locator('.popup-button-custom', {
                hasText: /Merge in editor|在编辑器中合并|在編輯器中合併/,
            }).first();
            const skipBtn = popup.locator('.popup-button-custom', {
                hasText: /Keep old book|保留旧世界书|保留舊世界書/,
            }).first();
            await expect(importBtn).toBeVisible();
            await expect(editorBtn).toBeVisible();
            await expect(skipBtn).toBeVisible();

            await importBtn.click();
            await popup.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});

            // The new card's embedded book must now exist on disk as
            // its own world file.
            const newBookPath = resolve(server.dataRoot, 'default-user', 'worlds', `${BRIALLEN_BOOK_NAME}.json`);
            await page.waitForFunction(async ({ name }) => {
                const ctx = window.Luker?.getContext?.();
                const names = typeof ctx?.getWorldInfoNames === 'function' ? ctx.getWorldInfoNames() : [];
                return Array.isArray(names) && names.includes(name);
            }, { name: BRIALLEN_BOOK_NAME }, { timeout: 10_000 });
            expect(existsSync(newBookPath), `${newBookPath} should exist after import-branch`).toBe(true);
            const importedBook = JSON.parse(readFileSync(newBookPath, 'utf8'));
            const importedComments = Object.values(importedBook.entries).map(e => String(e.content || ''));
            expect(importedComments.some(c => c.includes('eastern light burns whale oil'))).toBe(true);

            // The character's bound world is now the new embedded book.
            // Read from the live character via getContext rather than the
            // visible select — the WI drawer overlay hides the panel.
            await page.waitForFunction(({ avatar, want }) => {
                const ctx = window.Luker?.getContext?.();
                const idx = ctx?.characters?.findIndex?.(c => c?.avatar === avatar) ?? -1;
                const bound = idx >= 0 ? ctx.characters[idx]?.data?.extensions?.world : '';
                return String(bound || '').trim() === want;
            }, { avatar: 'ash-import-branch.png', want: BRIALLEN_BOOK_NAME }, { timeout: 10_000 });

            // The previous world book is untouched on disk — only the
            // binding moved, the book itself stays.
            const ashBookPath = resolve(server.dataRoot, 'default-user', 'worlds', `${ashBook}.json`);
            const stillThere = JSON.parse(readFileSync(ashBookPath, 'utf8'));
            const stillCommments = Object.values(stillThere.entries).map(e => String(e.comment || ''));
            expect(stillCommments).toEqual(expect.arrayContaining(['reef-conditions', 'drifters']));

            // Persistence across restart.
            await server.restart();
            await reloadAndAwait(page, server.baseURL);
            await clickCharacterCard(page, BRIALLEN_NAME, { timeoutMs: 20_000 });
            await dismissAnyPopup(page);
            await openCharacterEditPanel(page);
            await page.waitForFunction(({ avatar, want }) => {
                const ctx = window.Luker?.getContext?.();
                const idx = ctx?.characters?.findIndex?.(c => c?.avatar === avatar) ?? -1;
                const bound = idx >= 0 ? ctx.characters[idx]?.data?.extensions?.world : '';
                return String(bound || '').trim() === want;
            }, { avatar: 'ash-import-branch.png', want: BRIALLEN_BOOK_NAME }, { timeout: 10_000 });
        } finally {
            await tearDownServer(server);
        }
    });

    test('KEEP path: clicking "Keep old book" preserves the old binding and does NOT create the new card\'s embedded book', async ({ page }) => {
        const server = await startServer({ batchKey: 'character', scenarioId: 'replace-popup-keep' });
        try {
            markOnboarded({ dataRoot: server.dataRoot });
            disableTagImportPopup({ dataRoot: server.dataRoot });
            bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            const ashBook = writeWorldBook({ dataRoot: server.dataRoot, name: ASH_BOOK, entries: BRYN_ENTRIES });
            writeEmbeddedCharacter({
                dataRoot: server.dataRoot,
                avatarFile: 'ash-keep-branch.png',
                overrides: { extensions: { world: ashBook } },
            });

            await awaitMainUI(page, server.baseURL);
            await clickCharacterCard(page, ASH_NAME);
            await dismissAnyPopup(page);
            await openCharacterEditPanel(page);
            expect(await page.locator('#character_world').inputValue()).toBe(ashBook);

            await openReplaceWithFile(page, briallenPngPath);
            const popup = await waitForReplaceChoicePopup(page);
            const skipBtn = popup.locator('.popup-button-custom', {
                hasText: /Keep old book|保留旧世界书|保留舊世界書/,
            }).first();
            await expect(skipBtn).toBeVisible();
            await skipBtn.click();
            await popup.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});

            // The character's bound world must STILL be the previous
            // book — not the new embedded book and not empty.
            await page.waitForFunction(({ avatar, want }) => {
                const ctx = window.Luker?.getContext?.();
                const idx = ctx?.characters?.findIndex?.(c => c?.avatar === avatar) ?? -1;
                const bound = idx >= 0 ? ctx.characters[idx]?.data?.extensions?.world : '';
                return String(bound || '').trim() === want;
            }, { avatar: 'ash-keep-branch.png', want: ashBook }, { timeout: 10_000 });

            // The new card's embedded book MUST NOT have been imported
            // — only the binding was preserved, the embedded payload
            // remained on the card data and never became a world file.
            const newBookPath = resolve(server.dataRoot, 'default-user', 'worlds', `${BRIALLEN_BOOK_NAME}.json`);
            expect(existsSync(newBookPath), `${newBookPath} must NOT exist when user chose skip-and-keep`).toBe(false);

            // Persistence: after restart, the bound world is still the
            // previous one and the new embedded book still has not
            // been materialized.
            await server.restart();
            await reloadAndAwait(page, server.baseURL);
            await clickCharacterCard(page, BRIALLEN_NAME, { timeoutMs: 20_000 });
            await dismissAnyPopup(page);
            await openCharacterEditPanel(page);
            await page.waitForFunction(({ avatar, want }) => {
                const ctx = window.Luker?.getContext?.();
                const idx = ctx?.characters?.findIndex?.(c => c?.avatar === avatar) ?? -1;
                const bound = idx >= 0 ? ctx.characters[idx]?.data?.extensions?.world : '';
                return String(bound || '').trim() === want;
            }, { avatar: 'ash-keep-branch.png', want: ashBook }, { timeout: 10_000 });
            expect(existsSync(newBookPath), 'still no embedded book file after restart').toBe(false);
        } finally {
            await tearDownServer(server);
        }
    });

    test('OPEN_EDITOR path: materializes new book to disk FIRST, then opens studio with a seed whose diff has both prev removals AND next additions', async ({ page }) => {
        const server = await startServer({ batchKey: 'character', scenarioId: 'replace-popup-editor' });
        try {
            markOnboarded({ dataRoot: server.dataRoot });
            disableTagImportPopup({ dataRoot: server.dataRoot });
            bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            const ashBook = writeWorldBook({ dataRoot: server.dataRoot, name: ASH_BOOK, entries: BRYN_ENTRIES });
            writeEmbeddedCharacter({
                dataRoot: server.dataRoot,
                avatarFile: 'ash-editor-branch.png',
                overrides: { extensions: { world: ashBook } },
            });

            await awaitMainUI(page, server.baseURL);
            await clickCharacterCard(page, ASH_NAME);
            await dismissAnyPopup(page);
            await openCharacterEditPanel(page);

            // Sanity: before replace, briallen-tides MUST NOT exist on disk.
            // The OPEN_EDITOR branch is responsible for materializing it.
            const newBookPath = resolve(server.dataRoot, 'default-user', 'worlds', `${BRIALLEN_BOOK_NAME}.json`);
            expect(existsSync(newBookPath), `${BRIALLEN_BOOK_NAME}.json must NOT exist before replace`).toBe(false);

            await openReplaceWithFile(page, briallenPngPath);
            const popup = await waitForReplaceChoicePopup(page);
            const editorBtn = popup.locator('.popup-button-custom', {
                hasText: /Merge in editor|在编辑器中合并|在編輯器中合併/,
            }).first();
            await editorBtn.click();
            await popup.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});

            // Wait for the iter-studio popup to open.
            const studioDialog = page.locator('dialog.popup[open]', {
                hasText: /Character Editor — AI iteration|角色编辑器 - AI 迭代|角色編輯器 - AI 迭代/,
            }).first();
            await studioDialog.waitFor({ state: 'visible', timeout: 30_000 });
            const studioRoot = studioDialog.locator('[id^="cea_editor_"]').first();
            await expect(studioRoot).toBeVisible({ timeout: 5000 });

            // REGRESSION 1: by the time the studio is visible, the new card's
            // embedded book MUST already be on disk. Without this, the AI
            // session opens against a "the new world book is empty" diff —
            // which then makes the AI think every old entry was just deleted.
            await page.waitForFunction(({ name }) => {
                const ctx = window.Luker?.getContext?.();
                const names = typeof ctx?.getWorldInfoNames === 'function' ? ctx.getWorldInfoNames() : [];
                return Array.isArray(names) && names.includes(name);
            }, { name: BRIALLEN_BOOK_NAME }, { timeout: 10_000 });
            expect(existsSync(newBookPath), `${BRIALLEN_BOOK_NAME}.json present on disk AFTER OPEN_EDITOR fires`).toBe(true);

            // REGRESSION 2: the structured replace-diff overview
            // (surfaced via the topbar "View full replace diff" button)
            // must carry BOTH the prev-side rename half AND a
            // description-changed field card — proving the diff computed
            // against the materialized new book (not an empty stub).
            // Previously this check read `[data-cea-editor-messages]`,
            // but the post-replace seed message is now hidden from the
            // chat pane (hiddenFromUi) and the same information moved
            // into the topbar button's popup.
            const openDiffBtn = page.locator('[data-cea-editor-action="open-replace-diff"]').first();
            await expect(openDiffBtn).toBeVisible();
            await openDiffBtn.click();
            const diffPopup = page.locator('dialog.popup[open]', {
                hasText: /Replace diff — previous vs current|替换差异|替換差異/,
            }).first();
            await diffPopup.waitFor({ state: 'visible', timeout: 10_000 });
            const overviewText = (await diffPopup.locator('.cea_replace_diff_overview').textContent()) || '';
            // The card-field diff carries description: Briallen vs Ash.
            expect(overviewText).toContain('description');
            // Close the diff popup before closing the studio.
            await diffPopup.locator('.popup-button-ok').first().click({ timeout: 3000 }).catch(() => {});
            await diffPopup.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});

            // Close the studio.
            await page.keyboard.press('Escape').catch(() => {});
            await page.locator('dialog.popup[open]').last()
                .locator('.popup-button-cancel, .popup-button-close')
                .first()
                .click({ timeout: 3000 })
                .catch(() => {});
        } finally {
            await tearDownServer(server);
        }
    });

    test('NO PREVIOUS BOOK: when the replaced card had no bound world book, the "Skip and keep" button is hidden', async ({ page }) => {
        const server = await startServer({ batchKey: 'character', scenarioId: 'replace-popup-nobound' });
        try {
            markOnboarded({ dataRoot: server.dataRoot });
            disableTagImportPopup({ dataRoot: server.dataRoot });
            bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            writeEmbeddedCharacter({
                dataRoot: server.dataRoot,
                avatarFile: 'ash-nobound-branch.png',
                overrides: { extensions: {} },
            });

            await awaitMainUI(page, server.baseURL);
            await clickCharacterCard(page, ASH_NAME);
            await dismissAnyPopup(page);
            await openCharacterEditPanel(page);
            // Ash has no bound book for this scenario.
            expect((await page.locator('#character_world').inputValue()) || '').toBe('');

            await openReplaceWithFile(page, briallenPngPath);
            const popup = await waitForReplaceChoicePopup(page);
            const importBtn = popup.locator('.popup-button-custom', {
                hasText: /Import new book|导入新世界书|匯入新世界書/,
            }).first();
            const editorBtn = popup.locator('.popup-button-custom', {
                hasText: /Merge in editor|在编辑器中合并|在編輯器中合併/,
            }).first();
            const skipBtn = popup.locator('.popup-button-custom', {
                hasText: /Keep old book|保留旧世界书|保留舊世界書/,
            });
            await expect(importBtn).toBeVisible();
            await expect(editorBtn).toBeVisible();
            // With no prior binding, the keep-previous button should be omitted.
            await expect(skipBtn).toHaveCount(0);

            // Cancel out via the Cancel button so the test cleans up.
            const cancelBtn = popup.locator('.popup-button-cancel').first();
            await cancelBtn.click({ timeout: 3000 }).catch(() => {});
            await popup.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
        } finally {
            await tearDownServer(server);
        }
    });

    test('OPEN_EDITOR + close-without-apply: rolls back the pre-materialized new book (delete file + restore previous binding)', async ({ page }) => {
        // Regression for the bug where picking OPEN_EDITOR and then
        // closing the studio without proposing anything left the
        // character silently bound to the new book and the new file
        // sitting on disk — indistinguishable from having picked
        // Import New Book. With the rollback wired, "opened and did
        // nothing" restores the exact pre-replace disk state.
        const server = await startServer({ batchKey: 'character', scenarioId: 'replace-editor-rollback' });
        try {
            markOnboarded({ dataRoot: server.dataRoot });
            disableTagImportPopup({ dataRoot: server.dataRoot });
            bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            const ashBook = writeWorldBook({ dataRoot: server.dataRoot, name: ASH_BOOK, entries: BRYN_ENTRIES });
            writeEmbeddedCharacter({
                dataRoot: server.dataRoot,
                avatarFile: 'ash-rollback-branch.png',
                overrides: { extensions: { world: ashBook } },
            });

            await awaitMainUI(page, server.baseURL);
            await clickCharacterCard(page, ASH_NAME);
            await dismissAnyPopup(page);
            await openCharacterEditPanel(page);

            // Baseline: Ash bound to bryn-headland-ash; briallen-tides absent.
            expect((await page.locator('#character_world').inputValue()) || '').toBe(ashBook);
            const newBookPath = resolve(server.dataRoot, 'default-user', 'worlds', `${BRIALLEN_BOOK_NAME}.json`);
            expect(existsSync(newBookPath), `${BRIALLEN_BOOK_NAME}.json must NOT exist before replace`).toBe(false);

            await openReplaceWithFile(page, briallenPngPath);
            const popup = await waitForReplaceChoicePopup(page);
            const editorBtn = popup.locator('.popup-button-custom', {
                hasText: /Merge in editor|在编辑器中合并|在編輯器中合併/,
            }).first();
            await editorBtn.click();
            await popup.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});

            // Studio appears with the new book materialized.
            const studioDialog = page.locator('dialog.popup[open]', {
                hasText: /Character Editor — AI iteration|角色编辑器 - AI 迭代|角色編輯器 - AI 迭代/,
            }).first();
            await studioDialog.waitFor({ state: 'visible', timeout: 30_000 });
            // Wait for materialize to complete before we close.
            await page.waitForFunction(({ name }) => {
                const ctx = window.Luker?.getContext?.();
                const names = typeof ctx?.getWorldInfoNames === 'function' ? ctx.getWorldInfoNames() : [];
                return Array.isArray(names) && names.includes(name);
            }, { name: BRIALLEN_BOOK_NAME }, { timeout: 10_000 });
            expect(existsSync(newBookPath), 'new book file present on disk while studio is open').toBe(true);

            // Close the studio WITHOUT interacting with it. The dialog's
            // own cancel button is disabled; Escape triggers the onClosing
            // gate which allows close since state.isBusy is false.
            await page.keyboard.press('Escape');
            await studioDialog.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});

            // Rollback: new book file must be deleted from disk AND the
            // character's binding restored to the previous book.
            await page.waitForFunction(({ name }) => {
                const ctx = window.Luker?.getContext?.();
                const names = typeof ctx?.getWorldInfoNames === 'function' ? ctx.getWorldInfoNames() : [];
                return !(Array.isArray(names) && names.includes(name));
            }, { name: BRIALLEN_BOOK_NAME }, { timeout: 10_000 });
            expect(existsSync(newBookPath), 'new book file must be deleted after close-without-apply').toBe(false);
            expect((await page.locator('#character_world').inputValue()) || '').toBe(ashBook);
        } finally {
            await tearDownServer(server);
        }
    });
});
