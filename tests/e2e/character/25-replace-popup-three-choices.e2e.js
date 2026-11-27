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
// way to import the new card's embedded world from the popup. The popup
// now comes from the core post-replace action registry:
// public/scripts/character/post-replace-actions.js.
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

import { test, expect } from '../../harness/playwright.js';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, writeWorldBook, BRYN_ENTRIES } from '../_lib/fixtures.js';
import { disableTagImportPopup, dismissAnyPopup, clickCharacterCard, openCharacterEditPanel, writeEmbeddedCharacter } from './_helpers.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { read as readPngCard, write as writePngCard } from '../../../src/character-card-parser.js';
import { applyWorkbenchChanges, sendWorkbenchIterationPrompt } from '../_lib/ui-workbench.js';

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

function buildBriallenPng(seedPng, characterBook = BRIALLEN_EMBEDDED_BOOK) {
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
        character_book: characterBook,
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
    const label = (await page.locator('#replace_update').textContent()).trim();
    await page.locator('#char-management-dropdown').selectOption({ label });
    // First popup: choose "Replace with File".
    const firstPopup = page.locator('dialog.popup[open]').last();
    await firstPopup.waitFor({ state: 'visible', timeout: 5000 });
    const fileBtn = firstPopup.locator('.popup-button-custom', { hasText: /Replace with File/i }).first();
    await fileBtn.click();
    await firstPopup.waitFor({ state: 'detached', timeout: 5000 });
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
    test.beforeAll(async ({ workerResources }, testInfo) => {
        const scope = await workerResources.scenario(testInfo.file);
        mock = await startMockLLM({});
        tmpDir = (await scope.directory('luker-e2e-replace-popup')).path;
        const seed = readFileSync(resolve(REPO_ROOT, 'default/content/default_Seraphina.png'));
        briallenPngPath = resolve(tmpDir, 'briallen.png');
        writeFileSync(briallenPngPath, buildBriallenPng(seed));
    });

    test.afterAll(async () => {
        await mock?.stop();
    });

    test('switching to another character rolls back an unapplied replacement review and applying that character draft keeps it rolled back', async ({ resources, page }) => {
        await page.setViewportSize({ width: 1920, height: 1080 });
        const server = await startServer({ scope: resources, batchKey: 'character', scenarioId: 'replace-editor-cancel-owner' });
        markOnboarded({ dataRoot: server.dataRoot });
        disableTagImportPopup({ dataRoot: server.dataRoot });
        bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
        appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
        const oldBook = writeWorldBook({ dataRoot: server.dataRoot, name: ASH_BOOK, entries: BRYN_ENTRIES });
        let avatar = 'ash-cancel-owner.png';
        writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: avatar, overrides: { extensions: { world: oldBook } } });
        const card = () => JSON.parse(readPngCard(readFileSync(resolve(server.dataRoot, 'default-user', 'characters', avatar))));
        await awaitMainUI(page, server.baseURL);
        await clickCharacterCard(page, ASH_NAME);
        await dismissAnyPopup(page);
        await openCharacterEditPanel(page);
        await openReplaceWithFile(page, briallenPngPath);
        const popup = await waitForReplaceChoicePopup(page);
        avatar = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return ctx.characters[ctx.characterId].avatar;
        });
        mock.scriptReply('The replacement review remains pending without edits.');
        await popup.locator('.popup-button-custom', { hasText: /Merge in editor|在编辑器中合并|在編輯器中合併/ }).click();
        const win = page.locator('.wbench .wb-win').first();
        await expect(win.locator('.wb-msg-ai')).toContainText('The replacement review remains pending without edits.');
        const newBook = resolve(server.dataRoot, 'default-user', 'worlds', `${BRIALLEN_BOOK_NAME}.json`);
        expect(existsSync(newBook)).toBe(true);
        await clickCharacterCard(page, 'Seraphina');
        await dismissAnyPopup(page);
        await expect(page.locator('#character_name_pole')).toHaveValue('Seraphina');
        await expect.poll(() => existsSync(newBook)).toBe(false);
        await expect.poll(() => card().data.extensions.world).toBe(oldBook);
        const description = 'Seraphina records the relief watch in a blue tide ledger.';
        mock.scriptToolCall({ name: 'cea_set_card_field', arguments: { field: 'description', value: description } });
        mock.scriptReply('The relief watch description is ready.');
        await sendWorkbenchIterationPrompt(page, 'Describe the relief watch tide ledger.');
        await applyWorkbenchChanges(page);
        await expect.poll(() => page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return ctx.characters[ctx.characterId].description;
        })).toBe(description);
        await win.locator('.wb-titlebar .is-close').click();
        expect(existsSync(newBook)).toBe(false);
        expect(card().data.extensions.world).toBe(oldBook);
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        expect(existsSync(newBook)).toBe(false);
        expect(card().data.extensions.world).toBe(oldBook);
        await clickCharacterCard(page, 'Seraphina');
        await dismissAnyPopup(page);
        await expect(page.locator('#description_textarea')).toHaveValue(description);
    });

    test('a character change during book materialization cannot retarget the merge review', async ({ resources, page, context }) => {
        const server = await startServer({ scope: resources, batchKey: 'character', scenarioId: 'replace-editor-owner-change' });
        markOnboarded({ dataRoot: server.dataRoot });
        disableTagImportPopup({ dataRoot: server.dataRoot });
        bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
        appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
        const oldBook = writeWorldBook({ dataRoot: server.dataRoot, name: ASH_BOOK, entries: BRYN_ENTRIES });
        writeEmbeddedCharacter({
            dataRoot: server.dataRoot,
            avatarFile: 'ash-owner-branch.png',
            overrides: { extensions: { world: oldBook } },
        });
        await awaitMainUI(page, server.baseURL);
        await clickCharacterCard(page, ASH_NAME);
        await dismissAnyPopup(page);
        await openCharacterEditPanel(page);
        await openReplaceWithFile(page, briallenPngPath);
        const popup = await waitForReplaceChoicePopup(page);
        const replacedAvatar = await page.evaluate(() => {
            const c = window.Luker.getContext();
            return c.characters[c.characterId].avatar;
        });
        const completions = () => mock.requests.filter(r => r.url.includes('/chat/completions')).length;
        const before = completions();
        const foreignWrites = [];
        const cdp = await context.newCDPSession(page);
        await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/worldinfo/edit', requestStage: 'Response' }] });
        try {
            const paused = new Promise(resolve => cdp.once('Fetch.requestPaused', resolve));
            await popup.locator('.popup-button-custom', { hasText: /Merge in editor|在编辑器中合并|在編輯器中合併/ }).click();
            const pending = await paused;
            expect(pending.responseStatusCode).toBe(200);
            expect(JSON.parse(pending.request.postData).name).toBe(BRIALLEN_BOOK_NAME);
            await expect(popup).toHaveCount(0);
            await clickCharacterCard(page, 'Seraphina');
            await dismissAnyPopup(page);
            await expect(page.locator('#character_name_pole')).toHaveValue('Seraphina');
            const avatar = await page.evaluate(() => {
                const c = window.Luker.getContext();
                return c.characters[c.characterId].avatar;
            });
            const cardPath = resolve(server.dataRoot, 'default-user', 'characters', avatar);
            const selectedCard = readFileSync(cardPath);
            page.on('request', request => {
                if (request.url().endsWith('/api/characters/state/patch')) {
                    const body = request.postDataJSON();
                    if (body.avatar_url === avatar && body.operations.some(op => /^\/sessions\/\d+(?:\/|$)/.test(op.path))) {
                        foreignWrites.push(body);
                    }
                }
            });
            await cdp.send('Fetch.continueRequest', { requestId: pending.requestId });
            await cdp.send('Fetch.disable');
            await expect(page.locator('.wbench .wb-toast')).toContainText('The iteration target changed before the editor opened.');
            await expect.poll(() => existsSync(resolve(server.dataRoot, 'default-user', 'worlds', `${BRIALLEN_BOOK_NAME}.json`))).toBe(false);
            await expect.poll(() => page.evaluate(avatar => {
                const c = window.Luker.getContext();
                return c.characters.find(character => character.avatar === avatar)?.data?.extensions?.world;
            }, replacedAvatar)).toBe(oldBook);
            expect(completions()).toBe(before);
            expect(foreignWrites).toEqual([]);
            expect(readFileSync(cardPath)).toEqual(selectedCard);
            await expect(page.locator('#character_name_pole')).toHaveValue('Seraphina');
        } finally {
            await cdp.detach();
        }
    });

    test('IMPORT path: clicking "Import the new card\'s embedded world book" creates the new world file, binds it as primary, and the old book stays on disk untouched', async ({ resources, page }) => {
        const server = await startServer({ scope: resources, batchKey: 'character', scenarioId: 'replace-popup-import' });
        {
            markOnboarded({ dataRoot: server.dataRoot });
            disableTagImportPopup({ dataRoot: server.dataRoot });
            bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            const ashBook = writeWorldBook({ dataRoot: server.dataRoot, name: ASH_BOOK, entries: BRYN_ENTRIES });
            writeEmbeddedCharacter({
                dataRoot: server.dataRoot,
                avatarFile: 'ash-import-branch.png',
                overrides: { extensions: { world: ashBook } },
            });

            await awaitMainUI(page, server.baseURL);
            await clickCharacterCard(page, ASH_NAME);
            await dismissAnyPopup(page);
            await openCharacterEditPanel(page);

            // Sanity: Ash is bound to the bryn book.
            const beforeBinding = page.locator('#character_world');
            await expect(beforeBinding).toHaveValue(ashBook);

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

            const savedBook = page.waitForResponse(response => response.url().endsWith('/api/worldinfo/edit') && response.request().postDataJSON().name === BRIALLEN_BOOK_NAME);
            await importBtn.click();
            expect((await savedBook).ok()).toBe(true);
            await expect(popup).toHaveCount(0);

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
            await page.waitForFunction(({ name, want }) => {
                const ctx = window.Luker?.getContext?.();
                const idx = ctx?.characters?.findIndex?.(c => (c?.data?.name || c?.name) === name) ?? -1;
                const bound = idx >= 0 ? ctx.characters[idx]?.data?.extensions?.world : '';
                return String(bound || '').trim() === want;
            }, { name: BRIALLEN_NAME, want: BRIALLEN_BOOK_NAME }, { timeout: 10_000 });

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
            await page.waitForFunction(({ name, want }) => {
                const ctx = window.Luker?.getContext?.();
                const idx = ctx?.characters?.findIndex?.(c => (c?.data?.name || c?.name) === name) ?? -1;
                const bound = idx >= 0 ? ctx.characters[idx]?.data?.extensions?.world : '';
                return String(bound || '').trim() === want;
            }, { name: BRIALLEN_NAME, want: BRIALLEN_BOOK_NAME }, { timeout: 10_000 });
        }
    });

    test('KEEP path: clicking "Keep old book" preserves the old binding and does NOT create the new card\'s embedded book', async ({ resources, page }) => {
        const server = await startServer({ scope: resources, batchKey: 'character', scenarioId: 'replace-popup-keep' });
        {
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
            await expect(page.locator('#character_world')).toHaveValue(ashBook);

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
            await page.waitForFunction(({ name, want }) => {
                const ctx = window.Luker?.getContext?.();
                const idx = ctx?.characters?.findIndex?.(c => (c?.data?.name || c?.name) === name) ?? -1;
                const bound = idx >= 0 ? ctx.characters[idx]?.data?.extensions?.world : '';
                return String(bound || '').trim() === want;
            }, { name: BRIALLEN_NAME, want: ashBook }, { timeout: 10_000 });

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
            await page.waitForFunction(({ name, want }) => {
                const ctx = window.Luker?.getContext?.();
                const idx = ctx?.characters?.findIndex?.(c => (c?.data?.name || c?.name) === name) ?? -1;
                const bound = idx >= 0 ? ctx.characters[idx]?.data?.extensions?.world : '';
                return String(bound || '').trim() === want;
            }, { name: BRIALLEN_NAME, want: ashBook }, { timeout: 10_000 });
            expect(existsSync(newBookPath), 'still no embedded book file after restart').toBe(false);
        }
    });

    test('OPEN_EDITOR path: materializes new book to disk FIRST, then opens studio with a seed whose diff has both prev removals AND next additions', async ({ resources, page }) => {
        const server = await startServer({ scope: resources, batchKey: 'character', scenarioId: 'replace-popup-editor' });
        {
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
            const importedBook = structuredClone(BRIALLEN_EMBEDDED_BOOK);
            const completeEntry = `${'The keeper records the entire night watch. '.repeat(30)}Final ledger entry.`;
            importedBook.entries[0].content = completeEntry;
            const importDirectory = await resources.directory('complete replacement preview');
            const completeCardPath = resolve(importDirectory.path, 'complete-card.png');
            writeFileSync(completeCardPath, buildBriallenPng(
                readFileSync(resolve(REPO_ROOT, 'default/content/default_Seraphina.png')),
                importedBook,
            ));

            await awaitMainUI(page, server.baseURL);
            await clickCharacterCard(page, ASH_NAME);
            await dismissAnyPopup(page);
            await openCharacterEditPanel(page);

            // Sanity: before replace, briallen-tides MUST NOT exist on disk.
            // The OPEN_EDITOR branch is responsible for materializing it.
            const newBookPath = resolve(server.dataRoot, 'default-user', 'worlds', `${BRIALLEN_BOOK_NAME}.json`);
            expect(existsSync(newBookPath), `${BRIALLEN_BOOK_NAME}.json must NOT exist before replace`).toBe(false);

            await openReplaceWithFile(page, completeCardPath);
            const popup = await waitForReplaceChoicePopup(page);
            const editorBtn = popup.locator('.popup-button-custom', {
                hasText: /Merge in editor|在编辑器中合并|在編輯器中合併/,
            }).first();
            await editorBtn.click();
            await popup.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});

            // Wait for unified Workbench AI Iteration (`card` target) to open.
            const win = page.locator('.wbench .wb-win').first();
            await expect(win).toBeVisible({ timeout: 30_000 });
            await expect(
                win.locator('.wb-ws-seg button.lw-seg-btn:has(.lw-dot[style*="--lw-t-card"])'),
            ).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });

            // REGRESSION 1: by the time Workbench is visible, the new card's
            // embedded book MUST already be on disk.
            await page.waitForFunction(({ name }) => {
                const ctx = window.Luker?.getContext?.();
                const names = typeof ctx?.getWorldInfoNames === 'function' ? ctx.getWorldInfoNames() : [];
                return Array.isArray(names) && names.includes(name);
            }, { name: BRIALLEN_BOOK_NAME }, { timeout: 10_000 });
            expect(existsSync(newBookPath), `${BRIALLEN_BOOK_NAME}.json present on disk AFTER OPEN_EDITOR fires`).toBe(true);

            // REGRESSION 2: the hidden autoSend seed brief sent to the AI
            // carries the structured replace diff (prev vs current card
            // description + book rename), without cluttering the user chat pane.
            await expect.poll(() => {
                return mock.requests.some((r) => {
                    const text = JSON.stringify(r?.body?.messages || []);
                    return text.includes('description') && text.includes(BRIALLEN_BOOK_NAME);
                });
            }, { timeout: 30_000 }).toBe(true);
            await expect(win.locator('.wb-msg-user')).toHaveCount(0);

            await page.setViewportSize({ width: 600, height: 960 });
            await expect(page.locator('.wbench')).toHaveClass(/is-compact/);
            const previewButton = win.getByRole('button', { name: /^(Preview|预览|預覽)$/ });
            await expect(previewButton).toBeVisible();
            await previewButton.click();
            const preview = win.locator('.wb-iter-preview');
            await expect(preview).toBeVisible();
            await preview.getByText(/^(View full replace diff|查看完整替换差异|檢視完整替換差異)$/).click();
            const overview = preview.locator('.wb-replace-diff');
            await expect(overview).toBeVisible();
            await expect(overview).toContainText('description');
            await expect(overview).toContainText(ashBook);
            await expect(overview).toContainText(BRIALLEN_BOOK_NAME);
            await expect(overview).toContainText(completeEntry);
            const currentBook = preview.locator(`[data-worldbook="${BRIALLEN_BOOK_NAME}"]`);
            await currentBook.locator('summary').click();
            await expect(currentBook.locator('pre').first()).toHaveText(completeEntry);
            await previewButton.click();

            // Wait for auto-turn to settle, then collapse Workbench.
            await expect(win.locator('.wb-reads.is-live')).toHaveCount(0, { timeout: 30_000 });
            const closeBtn = win.locator('.wb-titlebar .is-close').first();
            await closeBtn.click();
            await expect(win).toBeHidden({ timeout: 10_000 });
        }
    });

    test('NO PREVIOUS BOOK: when the replaced card had no bound world book, the "Skip and keep" button is hidden', async ({ resources, page }) => {
        const server = await startServer({ scope: resources, batchKey: 'character', scenarioId: 'replace-popup-nobound' });
        {
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
        }
    });

    test('OPEN_EDITOR + close-without-apply: rolls back the pre-materialized new book (delete file + restore previous binding)', async ({ resources, page }) => {
        // Regression for the bug where picking OPEN_EDITOR and then
        // closing the studio without proposing anything left the
        // character silently bound to the new book and the new file
        // sitting on disk — indistinguishable from having picked
        // Import New Book. With the rollback wired, "opened and did
        // nothing" restores the exact pre-replace disk state.
        const server = await startServer({ scope: resources, batchKey: 'character', scenarioId: 'replace-editor-rollback' });
        {
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
            mock.scriptReply('Reviewed the replacement. No edits were requested.');
            await editorBtn.click();
            await expect(popup).toHaveCount(0);

            // Workbench appears with the new book materialized.
            const win = page.locator('.wbench .wb-win').first();
            await expect(win).toBeVisible({ timeout: 30_000 });
            // Wait for materialize to complete before we close.
            await page.waitForFunction(({ name }) => {
                const ctx = window.Luker?.getContext?.();
                const names = typeof ctx?.getWorldInfoNames === 'function' ? ctx.getWorldInfoNames() : [];
                return Array.isArray(names) && names.includes(name);
            }, { name: BRIALLEN_BOOK_NAME }, { timeout: 10_000 });
            expect(existsSync(newBookPath), 'new book file present on disk while Workbench is open').toBe(true);

            // Let the autoSend seed review turn settle, then collapse Workbench
            // WITHOUT applying changes — triggers `onCancelWithoutApply` rollback.
            await expect(win.locator('.wb-reads.is-live')).toHaveCount(0, { timeout: 30_000 });
            await expect(win.locator('.wb-msg-ai')).toContainText('Reviewed the replacement. No edits were requested.', { timeout: 30_000 });
            await win.locator('.wb-titlebar .is-close').first().click();
            await expect(win).toBeHidden({ timeout: 10_000 });

            // Rollback: new book file must be deleted from disk AND the
            // character's binding restored to the previous book.
            await page.waitForFunction(({ name }) => {
                const ctx = window.Luker?.getContext?.();
                const names = typeof ctx?.getWorldInfoNames === 'function' ? ctx.getWorldInfoNames() : [];
                return !(Array.isArray(names) && names.includes(name));
            }, { name: BRIALLEN_BOOK_NAME }, { timeout: 10_000 });
            expect(existsSync(newBookPath), 'new book file must be deleted after close-without-apply').toBe(false);
            expect((await page.locator('#character_world').inputValue()) || '').toBe(ashBook);
        }
    });
});
