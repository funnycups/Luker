// #27 — importEmbeddedWorldInfo MUST persist the binding to the character's
// data.extensions.world (not just the visible #character_world select).
//
// REAL bug behind the user's report ("I imported the card and accepted
// the embedded-book popup; world button looked green; reload + click the
// card → button is gray, no binding"):
//
//   `world-info.js#importEmbeddedWorldInfo` only set
//   `$('#character_world').val(bookName).trigger('change')` — that
//   updates the visible select element, so the button briefly looks
//   "world_set" (forced via setWorldInfoButtonClass(chid, true)). But
//   `characters[chid].data.extensions.world` was NEVER written. The
//   ONLY callers that survived a reload were the two that follow up
//   with `saveCharacterDebounced()` (world_button click + More→Import
//   Card Lore), because the form's hidden #character_world input
//   round-trips through `createOrEditCharacter`'s form POST. The
//   AUTO-popup (the legacy "This character has an embedded
//   World/Lorebook. Would you like to import it now?") does NOT call
//   saveCharacterDebounced — its checkResult just runs
//   `importEmbeddedWorldInfo(true)` and returns.
//
// Result: a user who imports a card and clicks Yes on the auto-popup
// thinks the book is bound (visible select shows it, button green), but
// on reload the binding is empty — the on-disk PNG was never updated.
//
// Fix: write characters[chid].data.extensions.world synchronously +
// call writeExtensionField(chid, 'world', bookName) inside
// importEmbeddedWorldInfo. Then ALL three caller paths persist
// correctly.
//
// This test simulates the user's real-flow gesture-for-gesture, asserts
// the binding persisted in-memory AND survived a server restart + page
// reload, then continues into a replace to confirm the world button on
// the replaced card still works.

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { disableTagImportPopup, dismissAnyPopup, clickCharacterCard, openCharacterEditPanel } from './_helpers.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { importCharacterFile } from '../_lib/ui-character.js';
import { write as writePngCard, read as readPngCard } from '../../../src/character-card-parser.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

function buildCardPng(seedPng, { name, bookName }) {
    const data = {
        name, description: `${name}'s description.`,
        personality: '.', scenario: '.', first_mes: '.',
        mes_example: '', creator_notes: 'e2e', system_prompt: '.', post_history_instructions: '',
        alternate_greetings: [], tags: [], creator: 'e2e', character_version: '1.0',
        extensions: {},
        character_book: {
            name: bookName,
            entries: [{ keys: [bookName], content: `${bookName} entry.`, extensions: {}, enabled: true, insertion_order: 0 }],
            extensions: {},
        },
    };
    return writePngCard(seedPng, JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', ...data, data }));
}

function readCardDataFromDisk(charsDir, expectedName) {
    const pngs = readdirSync(charsDir).filter(f => f.endsWith('.png'));
    for (const png of pngs) {
        try {
            const meta = JSON.parse(readPngCard(readFileSync(resolve(charsDir, png))));
            const name = meta?.data?.name || meta?.name || '';
            if (name === expectedName) return { filename: png, meta };
        } catch { /* skip non-card PNGs */ }
    }
    return null;
}

test.describe('#27 — import-embedded persists the binding', () => {
    let mock, tmpDir, cardAPath, cardBPath;

    test.beforeAll(async () => {
        mock = await startMockLLM({});
        tmpDir = mkdtempSync(resolve(tmpdir(), 'luker-e2e-27-'));
        const seed = readFileSync(resolve(REPO_ROOT, 'default/content/default_Seraphina.png'));
        cardAPath = resolve(tmpDir, 'card-a.png');
        cardBPath = resolve(tmpDir, 'card-b.png');
        writeFileSync(cardAPath, buildCardPng(seed, { name: 'Card A', bookName: 'book-a' }));
        writeFileSync(cardBPath, buildCardPng(seed, { name: 'Card B', bookName: 'book-b' }));
    });

    test.afterAll(async () => {
        await mock?.stop();
        if (tmpDir) {
            try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
        }
    });

    test('legacy "import embedded world?" popup → Yes writes data.extensions.world that survives reload + replace', async ({ page }) => {
        const server = await startServer({ batchKey: 'character', scenarioId: '27-persists' });
        try {
            markOnboarded({ dataRoot: server.dataRoot });
            disableTagImportPopup({ dataRoot: server.dataRoot });
            bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            await awaitMainUI(page, server.baseURL);

            // ── Step 1: import Card A via real file picker.
            await importCharacterFile(page, { filePath: cardAPath, expectedName: 'Card A' });
            await clickCharacterCard(page, 'Card A');
            // DO NOT dismissAnyPopup here — it would close the legacy
            // "import embedded?" popup before we can click Yes on it.
            await openCharacterEditPanel(page);

            // ── Step 2: legacy popup auto-fires "import embedded book?", click Yes.
            const legacyPopup = page.locator('dialog.popup[open]', { hasText: /character has an embedded/ }).last();
            await legacyPopup.waitFor({ state: 'visible', timeout: 5000 });
            await legacyPopup.locator('.popup-button-ok').first().click();
            await legacyPopup.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
            await dismissAnyPopup(page, { maxRounds: 5 });
            await page.waitForTimeout(1000);

            // ── REGRESSION ASSERTION 1: in-memory binding persisted.
            // Without the fix, importEmbeddedWorldInfo only sets the visible
            // select — characters[chid].data.extensions.world stays empty,
            // and any subsequent state read (or reload) shows no binding.
            const afterImport = await page.evaluate(() => {
                const ctx = window.Luker?.getContext?.();
                const idx = ctx?.characterId;
                const ch = idx !== undefined ? ctx.characters[idx] : null;
                return {
                    inMemory_ext_world: ch?.data?.extensions?.world || '',
                    visible_world_field: document.querySelector('#character_world')?.value || '',
                    buttonGreen: document.querySelector('#world_button')?.classList.contains('world_set'),
                };
            });
            expect(afterImport.visible_world_field, 'visible select reflects bookName').toBe('book-a');
            expect(afterImport.inMemory_ext_world, 'in-memory data.extensions.world equals bookName').toBe('book-a');
            expect(afterImport.buttonGreen, 'world button is green').toBe(true);

            // ── REGRESSION ASSERTION 2: on-disk PNG has the binding.
            // This is what survives a reload. The legacy code's import
            // path NEVER touched the PNG's extensions.world.
            const charsDir = resolve(server.dataRoot, 'default-user', 'characters');
            const onDisk = readCardDataFromDisk(charsDir, 'Card A');
            expect(onDisk, 'Card A PNG present on disk').not.toBeNull();
            expect(onDisk.meta?.data?.extensions?.world, 'on-disk extensions.world equals bookName').toBe('book-a');

            // ── REGRESSION ASSERTION 3: binding survives full restart + reload.
            // This is the user's "reload exposes the lie" scenario.
            await server.restart();
            await reloadAndAwait(page, server.baseURL);
            await clickCharacterCard(page, 'Card A');
            await dismissAnyPopup(page);
            await openCharacterEditPanel(page);
            await page.waitForTimeout(500);
            const afterReload = await page.evaluate(() => {
                const ctx = window.Luker?.getContext?.();
                const idx = ctx?.characterId;
                const ch = idx !== undefined ? ctx.characters[idx] : null;
                return {
                    inMemory_ext_world: ch?.data?.extensions?.world || '',
                    visible_world_field: document.querySelector('#character_world')?.value || '',
                    buttonGreen: document.querySelector('#world_button')?.classList.contains('world_set'),
                };
            });
            expect(afterReload.inMemory_ext_world, 'binding survives restart + reload').toBe('book-a');
            expect(afterReload.visible_world_field).toBe('book-a');
            expect(afterReload.buttonGreen).toBe(true);

            // ── Now REPLACE Card A with Card B (which has its own embedded book).
            await page.evaluate(() => {
                const sel = document.querySelector('#char-management-dropdown');
                sel.querySelector('#replace_update').selected = true;
                window.jQuery(sel).trigger('change');
            });
            const replacePopup = page.locator('dialog.popup[open]').last();
            await replacePopup.waitFor({ state: 'visible', timeout: 5000 });
            await replacePopup.locator('.popup-button-custom', { hasText: /Replace with File/i }).first().click();
            await replacePopup.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
            await page.locator('#character_replace_file').setInputFiles(cardBPath);

            // CEA 3-button popup — click "Keep the previous book bound" to
            // preserve book-a binding (the user's most-likely safe choice).
            const ceaPopup = page.locator('dialog.popup[open]', { hasText: /Replace lorebook|替换角色卡|替換角色卡/ }).last();
            await ceaPopup.waitFor({ state: 'visible', timeout: 20_000 });
            const keepBtn = ceaPopup.locator('.popup-button-custom', {
                hasText: /Skip and keep the previous book bound|保留原绑定的世界书|保留原綁定的世界書/,
            }).first();
            await keepBtn.click();
            await ceaPopup.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
            await dismissAnyPopup(page, { maxRounds: 5 });
            await page.waitForTimeout(500);

            // ── REGRESSION ASSERTION 4: replaced card retains book-a binding.
            await page.waitForFunction(() => {
                const ctx = window.Luker?.getContext?.();
                const idx = ctx?.characterId;
                const ch = idx !== undefined ? ctx.characters[idx] : null;
                return String(ch?.data?.extensions?.world || '').trim() === 'book-a';
            }, null, { timeout: 10_000 });
        } finally {
            await tearDownServer(server);
        }
    });
});
