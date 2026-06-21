// #18 — Import a byaf (Backyard Archive Format) character via the real
// UI file picker. BYAF is a zipped bundle with manifest.json + character
// + scenario JSON files + images.

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import AdmZip from 'adm-zip';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, listCharacters } from '../_lib/fixtures.js';
import { disableTagImportPopup, dismissAnyPopup, openCharacterEditPanel, clickCharacterCard } from './_helpers.js';
import { awaitMainUI, reloadAndAwait, closeRightNavDrawer } from '../_lib/page.js';
import { importCharacterFile } from '../_lib/ui-character.js';
import { openWorldInfoDrawer, selectWorldBook, getRenderedWorldEntries } from '../_lib/ui-worldinfo.js';

let server, mock, tmpDir, byafPath;

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const NAME = 'Halden the Quill-Keeper';

const MANIFEST = {
    formatVersion: 1,
    characters: ['character/halden.json'],
    scenarios: ['scenario/library-stairwell.json'],
    author: { name: 'luker-e2e', backyardURL: '' },
};

const CHARACTER = {
    name: NAME,
    displayName: NAME,
    persona: 'A quiet archivist who keeps a wax-sealed ledger of every borrowed lantern in the harbor library.',
    isNSFW: false,
    images: [{ path: '../image/halden.png', label: '' }],
    loreItems: [
        { key: 'lantern ledger', value: 'The ledger records every lantern that ever left the library and the names of those who took them.' },
    ],
};

const SCENARIO = {
    narrative: 'You meet Halden at the foot of the library stairwell with a lantern that does not yet have an entry in the ledger.',
    firstMessages: [{ text: '*Halden taps the spine of his ledger with the back of a pen.* "If you brought that lantern in here, friend, it needs a name and a seal. Step closer to the lamp."' }],
    exampleMessages: [],
    formattingInstructions: 'You are Halden. Stay in scene. Reply with one or two paragraphs.',
    messages: [],
};

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({ batchKey: 'character', scenarioId: 'import-byaf' });
    markOnboarded({ dataRoot: server.dataRoot });
    disableTagImportPopup({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    tmpDir = mkdtempSync(resolve(tmpdir(), 'luker-e2e-byaf-'));
    const iconPng = readFileSync(resolve(REPO_ROOT, 'default/content/default_Seraphina.png'));
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(MANIFEST), 'utf8'));
    zip.addFile('character/halden.json', Buffer.from(JSON.stringify(CHARACTER), 'utf8'));
    zip.addFile('scenario/library-stairwell.json', Buffer.from(JSON.stringify(SCENARIO), 'utf8'));
    zip.addFile('image/halden.png', iconPng);
    byafPath = resolve(tmpDir, 'halden.byaf');
    writeFileSync(byafPath, zip.toBuffer());
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
    if (tmpDir && existsSync(tmpDir)) {
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
});

test.describe('#18 — Import byaf character card via UI file picker', () => {
    test('byaf zip imports through the file picker, scenario + loreItems land in the card, embedded WI entries surface on the card', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        await importCharacterFile(page, { filePath: byafPath, expectedName: NAME });
        await dismissAnyPopup(page);

        const cardCount = await page.locator('#rm_print_characters_block .character_select', { hasText: NAME }).count();
        expect(cardCount).toBeGreaterThanOrEqual(1);

        const onDisk = listCharacters({ dataRoot: server.dataRoot });
        expect(onDisk.length).toBeGreaterThan(0);

        await clickCharacterCard(page, NAME);
        await dismissAnyPopup(page);
        await openCharacterEditPanel(page);

        expect(await page.locator('#character_name_pole').inputValue()).toBe(NAME);
        expect(await page.locator('#description_textarea').inputValue()).toContain('archivist');
        expect(await page.locator('#firstmessage_textarea').inputValue()).toContain('ledger');

        // ── Embedded loreItems → character_book. Whether ST auto-imports
        //    the embedded book into the WI library list depends on
        //    power_user.world_import_dialog. The load-bearing assertion
        //    is that the BYAF loreItems landed in data.character_book on
        //    the saved card — read it via ctx so the test doesn't depend
        //    on the import-popup outcome.
        const embedded = await page.evaluate((name) => {
            const ctx = window.Luker.getContext();
            const ch = (ctx.characters || []).find(c => c?.name === name);
            const book = ch?.data?.character_book;
            return {
                hasBook: !!book,
                entryCount: Array.isArray(book?.entries) ? book.entries.length : 0,
                hasLedger: Array.isArray(book?.entries) && book.entries.some(e =>
                    /ledger|lantern/i.test(JSON.stringify(e || {}))),
            };
        }, NAME);
        expect(embedded.hasBook, 'embedded character_book present on card').toBe(true);
        expect(embedded.entryCount, 'entry count > 0').toBeGreaterThan(0);
        expect(embedded.hasLedger, 'lantern-ledger entry survived BYAF → character_book conversion').toBe(true);

        // Best-effort: also try to open the WI editor and see if the
        // auto-imported book is there. If not, that's just a UX setting.
        await closeRightNavDrawer(page);
        await dismissAnyPopup(page);
        await openWorldInfoDrawer(page);
        const bookOptionLabel = await page.evaluate(() => {
            const sel = document.querySelector('#world_editor_select');
            if (!sel) return null;
            const opt = Array.from(sel.options).find(o => /halden|ledger|lantern/i.test(o.textContent || ''));
            return opt?.textContent || null;
        });
        if (bookOptionLabel) {
            await selectWorldBook(page, bookOptionLabel);
            const rendered = await getRenderedWorldEntries(page);
            const hasLedger = rendered.some(r => /ledger|lantern/i.test((r.content || '') + ' ' + (r.key || '')));
            expect(hasLedger, `auto-imported lorebook contains ledger entry; got=${JSON.stringify(rendered)}`).toBe(true);
        } else {
            test.info().annotations.push({ type: 'note', description: 'BYAF loreItems stayed embedded on the card (no auto-import to WI library) — character_book entries verified via ctx instead' });
        }

        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        const cardCountAfter = await page.locator('#rm_print_characters_block .character_select', { hasText: NAME }).count();
        expect(cardCountAfter).toBeGreaterThanOrEqual(1);

        await clickCharacterCard(page, NAME);
        await dismissAnyPopup(page);
        await openCharacterEditPanel(page);
        expect(await page.locator('#description_textarea').inputValue()).toContain('archivist');
    });
});
