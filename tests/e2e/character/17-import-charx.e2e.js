// #17 — Import a charx character card via the real UI file picker.
//
// CharX is the CCv3 zip format with a `card.json` at root + asset files.
// Builds a tiny charx zip in /tmp during beforeAll, then drives the
// import through the visible #character_import_button + setInputFiles
// on the hidden #character_import_file.

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import AdmZip from 'adm-zip';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, listCharacters } from '../_lib/fixtures.js';
import { disableTagImportPopup, dismissAnyPopup, openCharacterEditPanel, clickCharacterCard } from './_helpers.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { importCharacterFile } from '../_lib/ui-character.js';

let server, mock, tmpDir, charxPath;

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const NAME = 'Riven of the Inland Marsh';
const DESCRIPTION = 'A reedmaster who maps tide channels by their voice. Carries a brass tuning fork tied to a string at her belt.';
const FIRST_MES = '*Riven holds up a finger without looking at you.* "Wait. The reeds are about to tell me something."';

const CARD = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
        name: NAME,
        description: DESCRIPTION,
        personality: 'Curious. Methodical. Will out-wait a heron if it helps her hear the marsh better.',
        scenario: 'You find Riven crouched at the edge of the salt-marsh, listening for the spring tide.',
        first_mes: FIRST_MES,
        mes_example: '',
        creator_notes: 'e2e fixture — import-charx',
        system_prompt: 'You are Riven. Stay in scene. Reply with one or two paragraphs.',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: ['rp', 'fixture'],
        creator: 'luker-e2e',
        character_version: '1.0',
        extensions: {},
        assets: [
            { type: 'icon', name: 'main', uri: 'embeded://main.png', ext: 'png' },
        ],
    },
};

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({ batchKey: 'character', scenarioId: 'import-charx' });
    markOnboarded({ dataRoot: server.dataRoot });
    disableTagImportPopup({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    // Build a tiny charx (zip) in /tmp.
    tmpDir = mkdtempSync(resolve(tmpdir(), 'luker-e2e-charx-'));
    const iconPng = readFileSync(resolve(REPO_ROOT, 'default/content/default_Seraphina.png'));
    const zip = new AdmZip();
    zip.addFile('card.json', Buffer.from(JSON.stringify(CARD), 'utf8'));
    zip.addFile('main.png', iconPng);
    charxPath = resolve(tmpDir, 'riven.charx');
    writeFileSync(charxPath, zip.toBuffer());
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
    if (tmpDir && existsSync(tmpDir)) {
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
});

test.describe('#17 — Import charx character card via UI file picker', () => {
    test('charx zip with card.json + icon imports through the file picker and persists', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        await importCharacterFile(page, { filePath: charxPath, expectedName: NAME });
        await dismissAnyPopup(page);

        const cardCount = await page.locator('#rm_print_characters_block .character_select', { hasText: NAME }).count();
        expect(cardCount).toBeGreaterThanOrEqual(1);

        const onDisk = listCharacters({ dataRoot: server.dataRoot });
        expect(onDisk.some(f => /Riven/.test(f))).toBe(true);

        await clickCharacterCard(page, NAME);
        await dismissAnyPopup(page);
        await openCharacterEditPanel(page);

        expect(await page.locator('#character_name_pole').inputValue()).toBe(NAME);
        expect(await page.locator('#description_textarea').inputValue()).toContain('reedmaster');
        expect(await page.locator('#firstmessage_textarea').inputValue()).toContain('reeds are about to tell me');

        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        const after = await page.locator('#rm_print_characters_block .character_select', { hasText: NAME }).count();
        expect(after).toBeGreaterThanOrEqual(1);

        await clickCharacterCard(page, NAME);
        await dismissAnyPopup(page);
        await openCharacterEditPanel(page);
        expect(await page.locator('#description_textarea').inputValue()).toContain('reedmaster');
    });
});
