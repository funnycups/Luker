// #35 — Replace / Update must rename the character identity, not only the
// display name.
//
// /api/characters/import writes the replacement card back to the old
// avatar filename (preserved_name) so chats survive. The card's
// data.name changes, but characters/<avatar>.png and chats/<avatar>/
// keep the old identity until the user renames the character by hand.
// This test drives the real Replace / Update gesture and asserts the
// whole identity follows the new card name:
//
//   - characters/<old>.png is gone, characters/<new>.png exists
//   - chats/<old>/ is gone, chats/<new>/ exists
//   - chat files generated as "<old name> - <stamp>" are renamed to
//     "<new name> - <stamp>"
//   - character messages in the chat carry the new name
//   - the current chat pointer follows the renamed file
//   - card-apps/<old>/ moves to card-apps/<new>/
//   - the renamed character and its chat survive a reload

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { disableTagImportPopup, dismissAnyPopup, clickCharacterCard, openCharacterEditPanel, openReplaceWithFile, writeEmbeddedCharacter } from './_helpers.js';
import { awaitMainUI, reloadAndAwait, selectCharacterProgrammatic, getChatSnapshot, getRenderedChatTexts } from '../_lib/page.js';
import { write as writePngCard } from '../../../src/character-card-parser.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

const ASH_NAME = 'Ash the Cartographer';
const ASH_AVATAR = 'ash-rename.png';
const BRIALLEN_NAME = 'Briallen the Lighthouse Keeper';
const BRIALLEN_DESCRIPTION = 'A weathered keeper of the eastern light, raised on the rocks beyond the reef. She knows every tide and every name carved into the lantern base.';

function buildBriallenPng(seedPng) {
    const payload = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name: BRIALLEN_NAME,
        description: BRIALLEN_DESCRIPTION,
        personality: 'Patient. Sees patterns. Suspicious of unfamiliar lights at sea.',
        scenario: 'You climb the spiral stair as Briallen trims the wick.',
        first_mes: '*Briallen does not turn from the lantern.* "Close the hatch."',
        mes_example: '',
        creator_notes: 'e2e fixture — replace-rename',
        system_prompt: 'You are Briallen. Stay in scene.',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: ['rp', 'fixture'],
        creator: 'luker-e2e',
        character_version: '1.0',
        data: {
            name: BRIALLEN_NAME,
            description: BRIALLEN_DESCRIPTION,
            personality: 'Patient. Sees patterns. Suspicious of unfamiliar lights at sea.',
            scenario: 'You climb the spiral stair as Briallen trims the wick.',
            first_mes: '*Briallen does not turn from the lantern.* "Close the hatch."',
            mes_example: '',
            creator_notes: 'e2e fixture — replace-rename',
            system_prompt: 'You are Briallen. Stay in scene.',
            post_history_instructions: '',
            alternate_greetings: [],
            tags: ['rp', 'fixture'],
            creator: 'luker-e2e',
            character_version: '1.0',
            extensions: {},
        },
    };
    return writePngCard(seedPng, JSON.stringify(payload));
}

let tmpDir, briallenPngPath;

test.describe('#35 — replace renames card identity and chats', () => {
    test.beforeAll(async () => {
        tmpDir = mkdtempSync(resolve(tmpdir(), 'luker-e2e-replace-rename-'));
        const seed = readFileSync(resolve(REPO_ROOT, 'default/content/default_Seraphina.png'));
        briallenPngPath = resolve(tmpDir, 'briallen-replace.png');
        writeFileSync(briallenPngPath, buildBriallenPng(seed));
    });

    test.afterAll(async () => {
        if (tmpDir && existsSync(tmpDir)) {
            try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
        }
    });

    test('the replacement name drives the avatar file, chats folder, chat files and messages', async ({ page }) => {
        test.setTimeout(180_000);
        const server = await startServer({
            batchKey: 'character',
            scenarioId: 'replace-rename',
            extraConfig: { 'performance.lazyLoadCharacters': true },
        });
        try {
            markOnboarded({ dataRoot: server.dataRoot });
            disableTagImportPopup({ dataRoot: server.dataRoot });
            writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: ASH_AVATAR });

            // CardApp content is keyed by the avatar base. It must move with
            // the character or the app silently detaches after the rename.
            const oldCardAppDir = resolve(server.dataRoot, 'default-user', 'card-apps', 'ash-rename');
            mkdirSync(oldCardAppDir, { recursive: true });
            writeFileSync(resolve(oldCardAppDir, 'index.js'), 'export default {};\n');

            await awaitMainUI(page, server.baseURL);
            await clickCharacterCard(page, ASH_NAME);
            await dismissAnyPopup(page);
            await openCharacterEditPanel(page);

            // A new chat gives us a real chat file and a real first message
            // without depending on an LLM connection.
            await page.evaluate(async () => {
                const mod = await import('/script.js');
                await mod.doNewChat();
                await mod.saveChatConditional?.();
            });
            await expect.poll(async () => (await getChatSnapshot(page)).chatId || '', { timeout: 10_000 })
                .toMatch(new RegExp(`^${ASH_NAME} - `));

            const before = await getChatSnapshot(page);
            expect(before.chatId, 'chat file name is set before replace').toBeTruthy();
            expect(before.messages?.length, 'new chat has its first message').toBeGreaterThanOrEqual(1);

            const expectedChatBase = `${BRIALLEN_NAME} - ${before.chatId.slice(`${ASH_NAME} - `.length)}`;
            const expectedChatFile = `${expectedChatBase}.jsonl`;

            await openReplaceWithFile(page, briallenPngPath);

            const charsDir = resolve(server.dataRoot, 'default-user', 'characters');
            const chatsDir = resolve(server.dataRoot, 'default-user', 'chats');
            const newChatsDir = resolve(chatsDir, BRIALLEN_NAME);
            const newChatFiles = () => existsSync(newChatsDir)
                ? readdirSync(newChatsDir).filter(name => name.endsWith('.jsonl'))
                : [];

            await expect.poll(() => existsSync(resolve(charsDir, `${BRIALLEN_NAME}.png`)), { timeout: 30_000 })
                .toBe(true);
            await expect.poll(() => existsSync(resolve(charsDir, ASH_AVATAR)), { timeout: 10_000 })
                .toBe(false);
            await expect.poll(() => existsSync(newChatsDir), { timeout: 10_000 })
                .toBe(true);
            await expect.poll(() => existsSync(resolve(chatsDir, 'ash-rename')), { timeout: 10_000 })
                .toBe(false);
            await expect.poll(() => existsSync(resolve(newChatsDir, expectedChatFile)), { timeout: 15_000 })
                .toBe(true);

            await dismissAnyPopup(page);

            // Every auto-generated chat under the old character name must
            // move to the new prefix; a stale old-prefix file means the
            // identity split in two.
            for (const name of newChatFiles()) {
                expect(name.startsWith(`${BRIALLEN_NAME} - `), `chat file ${name} carries the new character name`).toBe(true);
            }

            const renamedChatPath = resolve(newChatsDir, expectedChatFile);
            const lines = readFileSync(renamedChatPath, 'utf8').split('\n').filter(Boolean);
            const messages = lines.slice(1).map(line => JSON.parse(line));
            expect(messages.some(message => message?.mes?.includes('Ash looks up from a half-folded chart')), 'existing conversation survives the rename').toBe(true);
            expect(messages.some(message => message?.name === BRIALLEN_NAME), 'character messages carry the new name').toBe(true);
            expect(messages.some(message => message?.name === ASH_NAME), 'no character message keeps the old name').toBe(false);

            const newCardAppDir = resolve(server.dataRoot, 'default-user', 'card-apps', BRIALLEN_NAME);
            await expect.poll(() => existsSync(resolve(newCardAppDir, 'index.js')), { timeout: 10_000 })
                .toBe(true);
            expect(existsSync(oldCardAppDir), 'old CardApp directory is gone').toBe(false);

            const afterReplace = await page.evaluate(() => {
                const ctx = window.Luker.getContext();
                return {
                    chatId: ctx.getCurrentChatId?.(),
                    pole: document.querySelector('#selected_chat_pole')?.value || '',
                    characters: ctx.characters.map(character => ({ avatar: character.avatar, name: character.name })),
                };
            });
            expect(afterReplace.characters, 'character list shows the renamed identity')
                .toContainEqual(expect.objectContaining({ avatar: `${BRIALLEN_NAME}.png`, name: BRIALLEN_NAME }));
            expect(afterReplace.characters.find(character => character.avatar === ASH_AVATAR), 'no entry keeps the replaced avatar').toBeUndefined();
            expect(afterReplace.chatId, 'current chat pointer follows the renamed chat file').toBe(expectedChatBase);
            expect(afterReplace.pole, 'selected chat pole follows the renamed chat file').toBe(expectedChatBase);

            await reloadAndAwait(page, server.baseURL);
            // The card-select path was exercised before the replace. After
            // the reload only the persisted pointer matters, and the
            // programmatic path still clicks the real character card
            // without depending on the character-edit drawer layout.
            await selectCharacterProgrammatic(page, BRIALLEN_NAME);
            await dismissAnyPopup(page);

            const afterReload = await getChatSnapshot(page);
            expect(afterReload.chatId, 'renamed chat pointer survives a reload').toBe(expectedChatBase);
            const rendered = await getRenderedChatTexts(page);
            expect(rendered.join('\n'), 'conversation still renders after the rename and reload').toContain('Ash looks up from a half-folded chart');
        } finally {
            await tearDownServer(server);
        }
    });
});
