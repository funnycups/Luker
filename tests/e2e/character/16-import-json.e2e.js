// #16 — Import a v2 JSON character card via the real UI file picker.
//
// Builds a JSON v2 card in /tmp during beforeAll, drives the import
// through the visible #character_import_button + setInputFiles on the
// hidden #character_import_file. Then clicks the new card and asserts
// the imported fields are visible on the character edit panel.

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, listCharacters } from '../_lib/fixtures.js';
import { disableTagImportPopup, dismissAnyPopup, openCharacterEditPanel, clickCharacterCard } from './_helpers.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { importCharacterFile } from '../_lib/ui-character.js';

let server, mock, tmpDir, jsonPath;

const NAME = 'Mira of the Salt Causeway';
const DESCRIPTION = 'A causeway watcher who has counted every plank between the village and the inland road for nine winters.';
const FIRST_MES = '*Mira lowers the wind-flag and meets your eyes.* "Plank 47 is loose again. Step over it, not on it. The water is loud tonight."';

const V2_DATA = {
    name: NAME,
    description: DESCRIPTION,
    personality: 'Reserved, precise, methodical. Believes the causeway speaks to those who listen.',
    scenario: 'A storm is pushing through and you have come to relieve Mira at the midpoint hut.',
    first_mes: FIRST_MES,
    mes_example: '',
    creator_notes: 'e2e fixture — import-json',
    system_prompt: 'You are Mira. Stay in scene. Reply with one or two paragraphs.',
    post_history_instructions: '',
    alternate_greetings: ['*Mira is already counting planks under her breath when you arrive.*'],
    tags: ['rp', 'fixture'],
    creator: 'luker-e2e',
    character_version: '1.0',
    extensions: { depth_prompt: { prompt: '', depth: 4, role: 'system' } },
};

const V2_PAYLOAD = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    ...V2_DATA,
    data: V2_DATA,
};

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({ batchKey: 'character', scenarioId: 'import-json' });
    markOnboarded({ dataRoot: server.dataRoot });
    disableTagImportPopup({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    tmpDir = mkdtempSync(resolve(tmpdir(), 'luker-e2e-json-'));
    jsonPath = resolve(tmpDir, 'mira.json');
    writeFileSync(jsonPath, JSON.stringify(V2_PAYLOAD, null, 2));
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
    if (tmpDir && existsSync(tmpDir)) {
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
});

test.describe('#16 — Import JSON character card via UI file picker', () => {
    test('v2 JSON card imports through the file picker, fields visible in edit panel, persists across restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        await importCharacterFile(page, { filePath: jsonPath, expectedName: NAME });
        await dismissAnyPopup(page);

        const cardCount = await page.locator('#rm_print_characters_block .character_select', { hasText: NAME }).count();
        expect(cardCount).toBeGreaterThanOrEqual(1);

        const onDisk = listCharacters({ dataRoot: server.dataRoot });
        expect(onDisk.some(f => /Mira/.test(f))).toBe(true);

        await clickCharacterCard(page, NAME);
        await dismissAnyPopup(page);
        await openCharacterEditPanel(page);

        expect(await page.locator('#character_name_pole').inputValue()).toBe(NAME);
        expect(await page.locator('#description_textarea').inputValue()).toContain('plank between the village');
        expect(await page.locator('#firstmessage_textarea').inputValue()).toContain('Plank 47');
        expect(await page.locator('#personality_textarea').inputValue()).toContain('methodical');

        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        const cardCountAfter = await page.locator('#rm_print_characters_block .character_select', { hasText: NAME }).count();
        expect(cardCountAfter).toBeGreaterThanOrEqual(1);

        await clickCharacterCard(page, NAME);
        await dismissAnyPopup(page);
        await openCharacterEditPanel(page);
        expect(await page.locator('#description_textarea').inputValue()).toContain('plank between the village');
        expect(await page.locator('#firstmessage_textarea').inputValue()).toContain('Plank 47');
    });
});
