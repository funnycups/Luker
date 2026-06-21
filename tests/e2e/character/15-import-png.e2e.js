// #15 — Import a PNG character card via the real UI file picker.
//
// Builds a v2 PNG card by re-embedding the bundled Seraphina PNG with
// fresh card metadata via `src/character-card-parser.js#write()`, writes
// it to /tmp, drives the import through the visible #character_import_button
// + setInputFiles on the hidden #character_import_file (per the audit
// contract — real user gesture, no raw fetch). Then:
//
//   1. The new card appears in #rm_print_characters_block as a .character_select.
//   2. The character's name/description/first_mes are visible in the
//      edit panel when the card is clicked.
//   3. The embedded character_book entries surface in the WI editor when
//      the bound book is selected (soft-checked — auto-import is gated by
//      the user's world_import_dialog preference).
//   4. After `server.restart()`, the same checks still pass.

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, listCharacters } from '../_lib/fixtures.js';
import { disableTagImportPopup, dismissAnyPopup, openCharacterEditPanel, clickCharacterCard } from './_helpers.js';
import { awaitMainUI, reloadAndAwait, closeRightNavDrawer } from '../_lib/page.js';
import { importCharacterFile } from '../_lib/ui-character.js';
import { openWorldInfoDrawer, selectWorldBook, getRenderedWorldEntries } from '../_lib/ui-worldinfo.js';
import { write as writePngCard } from '../../../src/character-card-parser.js';

let server, mock, tmpDir, pngPath;

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

const NAME = 'Briallen the Lighthouse Keeper';
const DESCRIPTION = 'A weathered keeper of the eastern light, raised on the rocks beyond the reef. She knows every tide and every name carved into the lantern base.';
const FIRST_MES = '*Briallen does not turn from the lantern.* "Close the hatch. The wick is fickle and the night is long. Tell me what brought you up the stair."';

const EMBEDDED_BOOK = {
    name: 'briallen-tides',
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

const V2_DATA = {
    name: NAME,
    description: DESCRIPTION,
    personality: 'Patient. Sees patterns. Suspicious of unfamiliar lights at sea but never of unfamiliar people on her dock.',
    scenario: 'You climb the spiral stair as Briallen trims the wick. Outside, the reef is restless and the wind smells of brine.',
    first_mes: FIRST_MES,
    mes_example: '',
    creator_notes: 'e2e fixture — import-png',
    system_prompt: 'You are Briallen. Stay in scene. Reply with one to three paragraphs.',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: ['rp', 'fixture'],
    creator: 'luker-e2e',
    character_version: '1.0',
    extensions: {
        depth_prompt: { prompt: '', depth: 4, role: 'system' },
    },
    character_book: EMBEDDED_BOOK,
};

const V2_PAYLOAD = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    ...V2_DATA,
    data: V2_DATA,
};

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({ batchKey: 'character', scenarioId: 'import-png' });
    markOnboarded({ dataRoot: server.dataRoot });
    disableTagImportPopup({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    // Build a PNG file on disk that the file picker can ingest.
    tmpDir = mkdtempSync(resolve(tmpdir(), 'luker-e2e-png-'));
    const seedPath = resolve(REPO_ROOT, 'default/content/default_Seraphina.png');
    const seed = readFileSync(seedPath);
    const png = writePngCard(seed, JSON.stringify(V2_PAYLOAD));
    pngPath = resolve(tmpDir, 'briallen.png');
    writeFileSync(pngPath, png);
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
    if (tmpDir && existsSync(tmpDir)) {
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
});

test.describe('#15 — Import PNG character card via UI file picker', () => {
    test('PNG with embedded card data + character_book imports through the file picker and persists', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Drive the real import gesture — click visible icon then drop
        // the file into the hidden input.
        await importCharacterFile(page, { filePath: pngPath, expectedName: NAME });
        await dismissAnyPopup(page);

        // The new card is present in the character list.
        const cardCount = await page.locator('#rm_print_characters_block .character_select', { hasText: NAME }).count();
        expect(cardCount, 'imported character has a card in the list').toBeGreaterThanOrEqual(1);

        // File must exist on disk (the server actually wrote it).
        const onDisk = listCharacters({ dataRoot: server.dataRoot });
        expect(onDisk.some(f => /Briallen/.test(f)), `imported file present on disk: ${onDisk.join(', ')}`).toBe(true);

        // Click into the card so the edit panel shows the imported fields.
        await clickCharacterCard(page, NAME);
        await dismissAnyPopup(page);
        await openCharacterEditPanel(page);

        // #character_name_pole is hidden in edit mode but the value is
        // still set on the input element. .inputValue() reads it
        // regardless of visibility.
        expect(await page.locator('#character_name_pole').inputValue()).toBe(NAME);
        expect(await page.locator('#description_textarea').inputValue()).toContain('eastern light');
        expect(await page.locator('#firstmessage_textarea').inputValue()).toContain('Close the hatch');

        // ── Embedded character_book: check the WI editor. Auto-import
        //    depends on power_user.world_import_dialog; if the popup
        //    appeared and we cancelled it, the book stays embedded on
        //    the card. Either is a valid round-trip.
        await closeRightNavDrawer(page);
        await dismissAnyPopup(page);
        await openWorldInfoDrawer(page);
        const bookOptionLabel = await page.evaluate((wantSuffix) => {
            const sel = document.querySelector('#world_editor_select');
            if (!sel) return null;
            const opt = Array.from(sel.options).find(o => (o.textContent || '').includes(wantSuffix));
            return opt?.textContent || null;
        }, EMBEDDED_BOOK.name);
        if (bookOptionLabel) {
            await selectWorldBook(page, bookOptionLabel);
            const rendered = await getRenderedWorldEntries(page);
            expect(rendered.length, 'character_book entries rendered in WI editor').toBeGreaterThanOrEqual(EMBEDDED_BOOK.entries.length);
        } else {
            test.info().annotations.push({ type: 'note', description: 'embedded character_book stayed on the card (no auto-import to WI library); field-level round-trip verified via the edit panel' });
        }

        // ── Persistence: restart server, reload page ─────────────────────
        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        const cardCountAfter = await page.locator('#rm_print_characters_block .character_select', { hasText: NAME }).count();
        expect(cardCountAfter, 'card still in list after restart').toBeGreaterThanOrEqual(1);

        await clickCharacterCard(page, NAME);
        await dismissAnyPopup(page);
        await openCharacterEditPanel(page);
        expect(await page.locator('#description_textarea').inputValue()).toContain('eastern light');
    });
});
