// Regression: opening a recent chat from the welcome screen used to
// mint a brand-new phantom .jsonl on disk in addition to the one the
// user clicked. Reproduced once via a real Playwright gesture; fixed
// at two layers (client + server) so the trigger condition can never
// land. See commit message for the full story.
//
// What the bug looked like:
//   1. Card's PNG had no embedded `.chat` field.
//   2. Server's processCharacter responded with
//      `chat = "<name> - <NOW>"` — a freshly-minted timestamp, never
//      persisted to disk.
//   3. Client's openRecentCharacterChat called selectCharacterById
//      BEFORE openCharacterChat, so getChat() ran first against that
//      minted string. The server returned new_chat:true, getChatResult
//      pushed first_message and saveChatConditional wrote a phantom
//      .jsonl to disk.
//   4. openCharacterChat then opened the file the user actually
//      wanted, but the phantom remained.
//
// What the fix does:
//   • welcome-screen.js:550 openRecentCharacterChat now sets
//     characters[characterId].chat = fileName BEFORE selectCharacterById,
//     so any internal getChat() targets the right file.
//   • characters.js:685 projectRuntimeCharacterFields no longer mints
//     a timestamped string for a missing .chat field — it returns ''
//     (a stable empty sentinel). The server's /api/chats/get treats
//     empty file_name as "no chat selected"; the client then takes
//     the explicit "create new chat" path when the user really
//     wants one.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import {
    bootstrapCustomBackend,
    appendConnectionProfile,
    markOnboarded,
} from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';
import { write as writePngCard, read as readPngCard } from '../../../src/character-card-parser.js';
import { readdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let server, mock;

const ASH_AVATAR = 'ash-the-cartographer.png';

function listCharChats(dataRoot, avatarFile) {
    const dir = resolve(dataRoot, 'default-user', 'chats', avatarFile.replace(/\.png$/, ''));
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort();
}

test.beforeAll(async () => {
    mock = await startMockLLM({
        scriptedReplies: [
            '*Ash sets the chart down and watches the lantern flicker once before answering.* "It will hold. The wind has chosen the cliff tonight, not us."',
        ],
    });
    server = await startServer({ batchKey: 'regression', scenarioId: 'recent-chat-phantom' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: ASH_AVATAR,
        overrides: { name: 'Ash the Cartographer' },
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#118 — opening a recent chat must not mint a second chat file', () => {
    test('PNG-without-.chat → click recent chat → still exactly one file on disk', async ({ page }) => {
        test.setTimeout(120_000);

        // Step 1: produce one real chat file on disk for Ash.
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash the Cartographer');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 });
        await sendMessageAndAwaitReply(page, 'The cliff path is steady tonight. I came earlier than I meant to.');

        const ashChatsAfterTurn = listCharChats(server.dataRoot, ASH_AVATAR);
        expect(ashChatsAfterTurn.length).toBe(1);
        const realChatFile = ashChatsAfterTurn[0];
        const realChatName = realChatFile.replace(/\.jsonl$/, '');

        // Step 2: strip the .chat field from the PNG. This is the
        // real-world precondition that lets the bug fire — a card
        // PNG without a persisted .chat value. (One Luker user
        // surveyed their character library and found exactly one
        // such card out of ~100; that single card reproduced the
        // bug deterministically.)
        const pngPath = resolve(server.dataRoot, 'default-user', 'characters', ASH_AVATAR);
        const card = JSON.parse(readPngCard(readFileSync(pngPath)));
        delete card.chat;
        if (card.data) delete card.data.chat;
        writeFileSync(pngPath, writePngCard(readFileSync(pngPath), JSON.stringify(card)));

        await server.restart();

        // Step 3: real user gesture — go to welcome, click the
        // recent chat for Ash.
        await page.goto(server.baseURL);
        await awaitMainUI(page, server.baseURL);

        const welcomePanel = page.locator('.welcomePanel');
        await welcomePanel.waitFor({ state: 'visible', timeout: 15_000 });
        const recentEntry = welcomePanel.locator(`.recentChat:has-text("${realChatName}")`).first();
        if (!(await recentEntry.count())) {
            const welcomeText = await welcomePanel.innerText().catch(() => '<no text>');
            throw new Error(`Welcome panel did not list recent chat "${realChatName}". Panel text:\n${welcomeText}`);
        }
        await recentEntry.click({ force: true });

        // Wait for the real chat to load (greeting + user + assistant = 3 mes).
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 2, { timeout: 15_000 });
        // Drain debounced saves / chat-write queue so any phantom
        // saveChatConditional has fully landed before we look.
        await page.waitForTimeout(1500);

        // Assertion: still exactly the one file we wrote in step 1.
        const ashAfterClick = listCharChats(server.dataRoot, ASH_AVATAR);
        expect(
            ashAfterClick,
            `Opening a recent chat must not mint a new file. Got: ${JSON.stringify(ashAfterClick)}`,
        ).toEqual([realChatFile]);
    });
});
