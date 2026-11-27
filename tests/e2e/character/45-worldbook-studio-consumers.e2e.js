import { test, expect } from '../../harness/playwright.js';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { markOnboarded, bootstrapCustomBackend, appendConnectionProfile, writeWorldBook } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, openExtensionsDrawer, openInlineDrawer, closeExtensionsDrawer } from '../_lib/page.js';
import { writeEmbeddedCharacter } from './_helpers.js';
import { read as readPngCard, write as writePngCard } from '../../../src/character-card-parser.js';

const AVATAR = 'studio-world-ledger.png';
const OTHER = 'studio-other-ledger.png';
const NAME = 'Keeper of the Studio Ledger';
const OTHER_NAME = 'Keeper of the Unchanged Studio Ledger';
const BOOK = {
    name: 'studio-imported-ledger',
    extensions: {},
    entries: [{ id: 3, uid: 3, keys: ['bell'], content: 'The brass bell marks the low tide.', enabled: true, insertion_order: 51, extensions: {} }],
};
const EXT = { world: 'not-a-stored-book', retained: { tide: ['unchanged'] } };
const OTHER_EXT = { world: '', retained: { bell: 'other character' } };
let server, mock;
const path = (avatar = AVATAR) => resolve(server.dataRoot, 'default-user', 'characters', avatar);
const disk = (avatar = AVATAR) => JSON.parse(readPngCard(readFileSync(path(avatar)))).data.extensions;

test.beforeEach(async ({ resources, page }) => {
    mock = await startMockLLM({ scriptedReplies: ['The ledger has been checked.'] });
    server = await startServer({ scope: resources, batchKey: 'character', scenarioId: '45-world-studio', extraConfig: { storage: { mode: 'fs' } } });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    const settingsPath = resolve(server.dataRoot, 'default-user', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    settings.power_user.world_import_dialog = false;
    writeFileSync(settingsPath, JSON.stringify(settings));
    writeWorldBook({ dataRoot: server.dataRoot, name: 'studio-next-ledger', entries: [{ key: ['next'], content: 'The next ledger remains intact.' }] });
    writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: AVATAR, overrides: { name: NAME, extensions: EXT } });
    const bytes = readFileSync(path());
    const card = JSON.parse(readPngCard(bytes));
    card.data.character_book = BOOK;
    writeFileSync(path(), writePngCard(bytes, JSON.stringify(card)));
    writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: OTHER, overrides: { name: OTHER_NAME, extensions: OTHER_EXT } });
    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, OTHER_NAME);
    await expect(page.locator('#character_name_pole')).toHaveValue(OTHER_NAME);
    await selectCharacterByName(page, NAME);
    await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
});

test.afterEach(async () => { await mock.stop(); });

async function openCardAppStudio(page) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'character_editor_assistant_settings');
    await page.locator('#cea_open_cardapp_studio').click();
    const input = page.locator('[data-studio-input]');
    await input.waitFor({ state: 'visible', timeout: 20_000 });
    await closeExtensionsDrawer(page);
    return input;
}

async function live(page) {
    return page.evaluate(({ avatar, other }) => {
        const ctx = window.Luker.getContext();
        const a = ctx.characters.find(c => c.avatar === avatar);
        const b = ctx.characters.find(c => c.avatar === other);
        return {
            a: a.data.extensions,
            jsonA: JSON.parse(a.json_data).data.extensions,
            b: b.data.extensions,
            jsonB: JSON.parse(b.json_data).data.extensions,
            editor: JSON.parse(document.querySelector('#character_json_data').value).data.extensions,
            control: document.querySelector('#character_world').value,
            bound: document.querySelector('#world_button').classList.contains('world_set'),
            menuBound: document.querySelector('#set_character_world').classList.contains('world_set'),
            selected: ctx.characters[ctx.characterId].avatar,
        };
    }, { avatar: AVATAR, other: OTHER });
}

for (const kind of ['fields', 'import']) {
    test(`Studio ${kind} exposes the real refused binding outcome`, async ({ page }) => {
        mock.scriptToolCall({
            name: kind === 'fields' ? 'character_update_fields' : 'character_import_embedded_world',
            arguments: kind === 'fields' ? { fields: { world: 'studio-next-ledger' } } : {},
        });
        const input = await openCardAppStudio(page);
        const held = path() + '.held';
        const bytes = readFileSync(path());
        renameSync(path(), held);
        const refused = [];
        const observe = response => {
            if (response.url().endsWith('/api/characters/merge-attributes')) refused.push(response.status());
        };
        page.on('response', observe);
        try {
            await input.fill('Update the tide ledger.');
            await page.locator('[data-studio-action="send"]').click();
            await expect(page.locator('[data-studio-chat]')).toContainText('The ledger has been checked.', { timeout: 30_000 });
            expect(refused).toEqual([500]);

            const chatRequests = mock.requests.filter(r => r.url === '/v1/chat/completions');
            expect(chatRequests).toHaveLength(2);
            const toolMessage = chatRequests[1].body.messages.find(m => m.role === 'tool');
            expect(toolMessage).toBeTruthy();
            const result = JSON.parse(toolMessage.content);
            expect(result.ok).toBe(false);
            if (kind === 'import') {
                expect(result).toMatchObject({ imported: true, bound: false, world: BOOK.name });
                expect(JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'worlds', BOOK.name + '.json'), 'utf8')).originalData).toEqual(BOOK);
            }

            await page.locator('[data-studio-action="close"]').first().click();
            expect(await live(page)).toEqual({
                a: EXT,
                jsonA: EXT,
                b: OTHER_EXT,
                jsonB: OTHER_EXT,
                editor: EXT,
                control: EXT.world,
                bound: false,
                menuBound: false,
                selected: AVATAR,
            });
            expect(readFileSync(held)).toEqual(bytes);
            expect(disk(OTHER)).toEqual(OTHER_EXT);
        } finally {
            renameSync(held, path());
            page.off('response', observe);
        }
    });
}
