// #37 — Post-replace "View full replace diff" overview: world-info entry
// fields and the shared text diff.
//
// Ash (bound to bryn-headland-ash) is replaced by Briallen, whose card embeds
// briallen-tides. "Merge in editor" opens the CEA editor; its topbar button
// opens the structured overview. The new book's entries carry no comment, so
// their titles come from their keys, and key changes appear in the changed
// field list. Field diffs render with the shared iteration-library text diff;
// its expand button opens the zoom overlay inside the overview popup.

import { test, expect } from '../../harness/playwright.js';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, writeWorldBook, BRYN_ENTRIES } from '../_lib/fixtures.js';
import { disableTagImportPopup, dismissAnyPopup, clickCharacterCard, openCharacterEditPanel, openReplaceWithFile, writeEmbeddedCharacter } from './_helpers.js';
import { awaitMainUI } from '../_lib/page.js';
import { write as writePngCard } from '../../../src/character-card-parser.js';
import { takeDocScreenshot } from '../_lib/doc-screenshots.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

const ASH_NAME = 'Ash the Cartographer';
const ASH_BOOK = 'bryn-headland-ash';
const BRIALLEN_NAME = 'Briallen the Lighthouse Keeper';
const BRIALLEN_BOOK_NAME = 'briallen-tides';

function buildBriallenPng(seedPng) {
    const data = {
        name: BRIALLEN_NAME,
        description: 'A weathered keeper of the eastern light, raised on the rocks beyond the reef. She knows every tide and every name carved into the lantern base.',
        personality: 'Patient. Sees patterns. Suspicious of unfamiliar lights at sea but never of unfamiliar people on her dock.',
        scenario: 'You climb the spiral stair as Briallen trims the wick. Outside, the reef is restless and the wind smells of brine.',
        first_mes: '*Briallen does not turn from the lantern.* "Close the hatch. The wick is fickle and the night is long. Tell me what brought you up the stair."',
        mes_example: '',
        creator_notes: 'Play her slow and weather-wise; the tide sets the pace of every scene.',
        system_prompt: 'You are Briallen. Stay in scene. Reply with one to three paragraphs.',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: ['coast', 'lighthouse'],
        creator: 'luker-e2e',
        character_version: '1.0',
        extensions: { depth_prompt: { prompt: '', depth: 4, role: 'system' } },
        character_book: {
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
        },
    };
    return writePngCard(seedPng, JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', ...data, data }));
}

let mock, tmpDir, briallenPngPath;

test.describe('#37 — replace-diff overview renders world-info fields with the shared text diff', () => {
    test.beforeAll(async ({ workerResources }, testInfo) => {
        const scope = await workerResources.scenario(testInfo.file);
        mock = await startMockLLM({});
        tmpDir = (await scope.directory('luker-e2e-replace-diff')).path;
        briallenPngPath = resolve(tmpDir, 'briallen.png');
        writeFileSync(briallenPngPath, buildBriallenPng(readFileSync(resolve(REPO_ROOT, 'default/content/default_Seraphina.png'))));
    });

    test.afterAll(async () => {
        await mock?.stop();
    });

    test('changed entries carry key titles and key changes; expand opens the zoom overlay', async ({ resources, page }) => {
        const server = await startServer({ scope: resources, batchKey: 'character', scenarioId: 'replace-diff-line-diff' });
        {
            markOnboarded({ dataRoot: server.dataRoot });
            disableTagImportPopup({ dataRoot: server.dataRoot });
            bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            const ashBook = writeWorldBook({ dataRoot: server.dataRoot, name: ASH_BOOK, entries: BRYN_ENTRIES });
            writeEmbeddedCharacter({
                dataRoot: server.dataRoot,
                avatarFile: 'ash-replace-diff.png',
                overrides: {
                    creator_notes: 'A headland cartographer for slow, watchful night scenes on the Bryn coast.',
                    tags: ['coast', 'cartographer'],
                    extensions: { world: ashBook },
                },
            });

            await awaitMainUI(page, server.baseURL);
            await clickCharacterCard(page, ASH_NAME);
            await dismissAnyPopup(page);
            await openCharacterEditPanel(page);

            await openReplaceWithFile(page, briallenPngPath);
            const choice = page.locator('dialog.popup[open]', { hasText: /Replace:|替换角色卡|替換角色卡/ }).last();
            await choice.waitFor({ state: 'visible', timeout: 20_000 });
            await choice.locator('.popup-button-custom', { hasText: /Merge in editor|在编辑器中合并|在編輯器中合併/ }).first().click();
            await choice.waitFor({ state: 'detached', timeout: 10_000 });

            const studio = page.locator('.wbench .wb-win');
            await studio.waitFor({ state: 'visible', timeout: 30_000 });
            await studio.locator('.wb-iter-preview').getByText('View full replace diff', { exact: true }).click();

            const diffPopup = studio.locator('.wb-replace-diff');
            await diffPopup.waitFor({ state: 'visible', timeout: 10_000 });
            await takeDocScreenshot(diffPopup, resolve(REPO_ROOT, 'docs/public/images/card-editor-popup/cea-replace-diff.png'));

            // World-info entry fields: the new book's uncommented entries are
            // titled by their keys and their key change is listed.
            const changedGroup = diffPopup.locator('[data-change-kind="mod"]');
            const titles = (await changedGroup.locator(':scope > section > h4').allTextContents())
                .map(text => text.replace(/^\d+ · /, '').trim());
            expect(titles).toEqual(expect.arrayContaining(['eastern light, lantern', 'reef']));
            const changedFieldLabels = (await changedGroup.locator('.wb-replace-field > h4').allTextContents()).map(s => s.trim());
            expect(changedFieldLabels).toEqual(expect.arrayContaining(['entry.0.key', 'entry.1.key']));

            await expect(diffPopup.locator('.luker_lib_diff').first()).toBeAttached();

            await diffPopup.locator('[data-luker-lib-action="expand-line-diff"]').first().click();
            const overlay = studio.locator('.luker_lib_diff_zoom_overlay');
            await expect(overlay).toBeVisible();
            await overlay.locator('.luker_lib_diff_zoom_close[data-luker-lib-action="close-line-diff-zoom"]').click();
            await expect(overlay).toHaveCount(0);
            await expect(diffPopup).toBeVisible();
        }
    });
});
