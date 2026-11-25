import { test, expect } from '../../harness/playwright.js';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { markOnboarded, bootstrapCustomBackend, appendConnectionProfile, writeWorldBook } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { writeEmbeddedCharacter } from './_helpers.js';
import { read as readPngCard, write as writePngCard } from '../../../src/character-card-parser.js';

const AVATAR = 'studio-world-ledger.png';
const OTHER = 'studio-other-ledger.png';
const NAME = 'Keeper of the Studio Ledger';
const OTHER_NAME = 'Keeper of the Unchanged Studio Ledger';
const BOOK = { name: 'studio-imported-ledger', extensions: {}, entries: [{ id: 3, uid: 3, keys: ['bell'], content: 'The brass bell marks the low tide.', enabled: true, insertion_order: 51, extensions: {} }] };
const ENTRY = `export function init(ctx) {
    const live = ctx.lukerContext;
    const result = document.createElement('pre'); result.id = 'studio-world-results';
    const button = document.createElement('button'); button.id = 'studio-world-send'; button.textContent = 'Edit the world binding';
    button.onclick = async () => {
        const { sendAIMessage } = await import('/scripts/extensions/character-editor-assistant/studio/ai-chat.js');
        const messages = [];
        await sendAIMessage(live.getExtensionApi('card-app').getCharId(), messages, 'Update the tide ledger.', {
            systemPrompt: live.extensionSettings.character_editor_assistant.cardAppStudioSystemPrompt,
            onToolCall: (name, args, outcome) => { result.textContent = JSON.stringify(outcome); },
        });
        result.dataset.complete = 'true';
    };
    const reload = document.createElement('button'); reload.id = 'studio-world-reload'; reload.textContent = 'Reload characters';
    reload.onclick = async () => { const old = live.characters[live.characterId]; await live.getCharacters(); await live.unshallowCharacter(live.characters.findIndex(c => c.avatar === '${OTHER}')); result.dataset.replaced = String(!live.characters.includes(old)); };
    ctx.container.append(button, reload, result);
}`;
const EXT = { world: 'not-a-stored-book', retained: { tide: ['unchanged'] }, card_app: { enabled: true, entry: 'index.js', files: { 'index.js': ENTRY } } };
const OTHER_EXT = { world: '', retained: { bell: 'other character' } };
let server, mock;
const path = (avatar = AVATAR) => resolve(server.dataRoot, 'default-user', 'characters', avatar);
const disk = (avatar = AVATAR) => JSON.parse(readPngCard(readFileSync(path(avatar)))).data.extensions;

test.beforeEach(async ({ resources, page }) => {
    mock = await startMockLLM({ scriptedReplies: ['The ledger has been checked.'] });
    server = await startServer({ scope: resources, batchKey: 'character', scenarioId: '45-world-studio', extraConfig: { storage: { mode: 'fs' } } });
    markOnboarded({ dataRoot: server.dataRoot }); bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL }); appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    const settingsPath = resolve(server.dataRoot, 'default-user', 'settings.json'); const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    settings.power_user.world_import_dialog = false; writeFileSync(settingsPath, JSON.stringify(settings));
    writeWorldBook({ dataRoot: server.dataRoot, name: 'studio-next-ledger', entries: [{ key: ['next'], content: 'The next ledger remains intact.' }] });
    writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: AVATAR, overrides: { name: NAME, extensions: EXT } });
    const bytes = readFileSync(path()); const card = JSON.parse(readPngCard(bytes)); card.data.character_book = BOOK; writeFileSync(path(), writePngCard(bytes, JSON.stringify(card)));
    writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: OTHER, overrides: { name: OTHER_NAME, extensions: OTHER_EXT } });
    const dir = resolve(server.dataRoot, 'default-user', 'card-apps', 'studio-world-ledger'); mkdirSync(dir, { recursive: true }); writeFileSync(resolve(dir, 'index.js'), ENTRY);
    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, OTHER_NAME); await expect(page.locator('#character_name_pole')).toHaveValue(OTHER_NAME);
    await selectCharacterByName(page, NAME); await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
    await expect(page.locator('#studio-world-send')).toBeVisible();
});
test.afterEach(async () => { await mock.stop(); });

async function live(page) {
    return page.evaluate(({ avatar, other }) => {
        const ctx = window.Luker.getContext(); const a = ctx.characters.find(c => c.avatar === avatar); const b = ctx.characters.find(c => c.avatar === other);
        return { a: a.data.extensions, jsonA: JSON.parse(a.json_data).data.extensions, b: b.data.extensions, jsonB: JSON.parse(b.json_data).data.extensions, editor: JSON.parse(document.querySelector('#character_json_data').value).data.extensions, control: document.querySelector('#character_world').value, bound: document.querySelector('#world_button').classList.contains('world_set'), menuBound: document.querySelector('#set_character_world').classList.contains('world_set'), selected: ctx.characters[ctx.characterId].avatar };
    }, { avatar: AVATAR, other: OTHER });
}

for (const kind of ['fields', 'import']) {
    test(`Studio ${kind} exposes the real refused binding outcome`, async ({ page }) => {
        mock.scriptToolCall({ name: kind === 'fields' ? 'character_update_fields' : 'character_import_embedded_world', arguments: kind === 'fields' ? { fields: { world: 'studio-next-ledger' } } : {} });
        const held = path() + '.held'; const bytes = readFileSync(path()); renameSync(path(), held);
        const refused = []; const observe = response => { if (response.url().endsWith('/api/characters/merge-attributes')) refused.push(response.status()); };
        page.on('response', observe);
        try {
            await page.locator('#studio-world-send').click();
            await expect(page.locator('#studio-world-results')).toHaveAttribute('data-complete', 'true');
            expect(refused).toEqual([500]);
            const result = JSON.parse(await page.locator('#studio-world-results').textContent()); expect(result.ok).toBe(false);
            if (kind === 'import') { expect(result).toMatchObject({ imported: true, bound: false, world: BOOK.name }); expect(JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'worlds', BOOK.name + '.json'), 'utf8')).originalData).toEqual(BOOK); }
            expect(await live(page)).toEqual({ a: EXT, jsonA: EXT, b: OTHER_EXT, jsonB: OTHER_EXT, editor: EXT, control: EXT.world, bound: false, menuBound: false, selected: AVATAR });
            expect(readFileSync(held)).toEqual(bytes); expect(disk(OTHER)).toEqual(OTHER_EXT);
        } finally { renameSync(held, path()); page.off('response', observe); }
    });
}

for (const change of ['selection', 'object']) {
    test(`Studio keeps the original world target across a pending model ${change}`, async ({ page }) => {
        mock.scriptToolCall({ name: 'character_update_fields', arguments: { fields: { world: 'studio-next-ledger' } } });
        const hold = mock.holdNextQueuedRequest();
        const writes = []; page.on('request', request => { if (request.url().endsWith('/api/characters/merge-attributes') && request.postDataJSON()?.data?.extensions?.world !== undefined) writes.push(request.postDataJSON()); });
        await page.locator('#studio-world-send').click(); await hold.requested;
        if (change === 'selection') { await selectCharacterByName(page, OTHER_NAME); await expect(page.locator('#character_name_pole')).toHaveValue(OTHER_NAME); }
        else { await page.locator('#studio-world-reload').click(); await expect(page.locator('#studio-world-results')).toHaveAttribute('data-replaced', 'true'); }
        hold.release();
        await expect.poll(() => disk().world).toBe(change === 'selection' ? 'studio-next-ledger' : EXT.world);
        // The real follow-up model request contains the tool's emitted result.
        await expect.poll(() => mock.requests.filter(r => r.url === '/v1/chat/completions').length).toBe(2);
        const tool = mock.requests.filter(r => r.url === '/v1/chat/completions')[1].body.messages.find(m => m.role === 'tool');
        expect(JSON.parse(tool.content).ok).toBe(change === 'selection');
        expect(writes).toEqual(change === 'selection' ? [{ avatar: AVATAR, data: { extensions: { world: 'studio-next-ledger' } }, replacePaths: ['data.extensions.world'] }] : []);
        await expect.poll(() => mock.requests.filter(r => r.url === '/v1/chat/completions')[1].responseCompleted).toBe(true);
        const state = await live(page); const expected = change === 'selection' ? { ...EXT, world: 'studio-next-ledger' } : EXT;
        expect(state.a).toEqual(expected); expect(state.jsonA).toEqual(expected); expect(state.b).toEqual(OTHER_EXT); expect(state.jsonB).toEqual(OTHER_EXT); expect(state.editor).toEqual(change === 'selection' ? OTHER_EXT : EXT); expect(disk(OTHER)).toEqual(OTHER_EXT);
        expect(state.control).toBe(change === 'selection' ? '' : EXT.world); expect(state.bound).toBe(false); expect(state.menuBound).toBe(false); expect(state.selected).toBe(change === 'selection' ? OTHER : AVATAR);
    });
}
