import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { write as writePngCard } from '../../../src/character-card-parser.js';
import { writeEmbeddedCharacter } from './_helpers.js';
import { writeWorldBook } from '../_lib/fixtures.js';
import { awaitMainUI, closeTopDrawer, openUserSettingsDrawer, selectCharacterByName } from '../_lib/page.js';
import { startServer, tearDownServer } from '../_lib/server.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const ORIGINAL_NAME = 'Ash the Cartographer';
const ORIGINAL_AVATAR = 'ash-tag-replace.png';
const WORLD_NAME = 'The Headland Watch';
const TAGS = ['navigation', 'coastal'];

for (const rename of [false, true]) {
    const replacementName = rename ? 'Ash the Headland Keeper' : ORIGINAL_NAME;

    test(`replacement imports tags and offers world-book choices ${rename ? 'with' : 'without'} renaming`, async ({ page }) => {
        const server = await startServer({
            batchKey: 'character',
            scenarioId: `replace-tags-${rename}`,
            extraConfig: { 'performance.lazyLoadCharacters': true },
        });
        const directory = mkdtempSync(resolve(tmpdir(), 'luker-replace-tags-'));
        try {
            writeWorldBook({
                dataRoot: server.dataRoot,
                name: WORLD_NAME,
                entries: [{ key: ['headland'], content: 'The watch keeps a lantern above the eastern reef.' }],
            });
            writeEmbeddedCharacter({
                dataRoot: server.dataRoot,
                avatarFile: ORIGINAL_AVATAR,
                overrides: { extensions: { world: WORLD_NAME } },
            });
            const payload = {
                spec: 'chara_card_v2',
                spec_version: '2.0',
                data: {
                    name: replacementName,
                    description: 'A coastal cartographer who tends the headland light.',
                    first_mes: '*Ash studies the harbour chart.* "The tide has changed."',
                    tags: TAGS,
                    extensions: {},
                    character_book: {
                        name: 'The Lantern Ledger',
                        entries: [{
                            id: 0,
                            keys: ['lantern'],
                            content: 'The lantern is lit before the boats return.',
                            enabled: true,
                            insertion_order: 100,
                            extensions: { position: 0 },
                        }],
                    },
                },
            };
            const replacementFile = resolve(directory, 'replacement.png');
            writeFileSync(replacementFile, writePngCard(
                readFileSync(resolve(REPO_ROOT, 'default/content/default_Seraphina.png')),
                JSON.stringify(payload),
            ));

            const errors = [];
            page.on('console', message => {
                if (message.type() === 'error' && message.text().includes('Failed to replace the character card')) {
                    errors.push(message.text());
                }
            });
            await awaitMainUI(page, server.baseURL);
            await openUserSettingsDrawer(page);
            await page.locator('#themes').selectOption({ label: 'Dark Lite' });
            await page.locator('#tag_import_setting').selectOption('3');
            await closeTopDrawer(page, 'user-settings-button');
            await selectCharacterByName(page, ORIGINAL_NAME);
            await page.locator('#rightNavDrawerIcon').click();
            await expect(page.locator('#description_textarea')).toBeVisible();
            await page.locator('#char-management-dropdown').selectOption({ label: 'Replace / Update' });
            const replacePopup = page.locator('dialog.popup[open]').last();
            const fileChooser = page.waitForEvent('filechooser');
            await replacePopup.locator('.popup-button-custom', { hasText: 'Replace with File' }).click();
            await (await fileChooser).setFiles(replacementFile);

            const worldPopup = page.locator('dialog.popup[open]', { hasText: 'Replace: what should happen to the world book?' });
            await expect(worldPopup).toBeVisible({ timeout: 30_000 });
            await expect(worldPopup.locator('.popup-button-custom', { hasText: 'Import new book' })).toBeVisible();
            await expect(worldPopup.locator('.popup-button-custom', { hasText: 'Keep old book' })).toBeVisible();
            expect(errors).toEqual([]);

            const character = await page.evaluate(name => {
                const context = window.Luker.getContext();
                const card = context.characters.find(candidate => candidate.name === name);
                return {
                    tags: card.tags,
                    dataTags: card.data.tags,
                    importedTags: context.tagMap[card.avatar].map(id => context.tags.find(tag => tag.id === id).name),
                };
            }, replacementName);
            expect(character.tags).toEqual(TAGS);
            expect(character.dataTags).toEqual(TAGS);
            expect(character.importedTags).toEqual(expect.arrayContaining(TAGS));

            await worldPopup.locator('.popup-button-custom', { hasText: 'Keep old book' }).click();
            await expect(worldPopup).toBeHidden();
            expect(errors).toEqual([]);
        } finally {
            await tearDownServer(server);
            rmSync(directory, { recursive: true, force: true });
        }
    });
}
