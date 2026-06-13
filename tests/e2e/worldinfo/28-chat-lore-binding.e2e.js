// #28 — Bind WI to chat (chat lore)
//
// A chat lore book is stored in `chat_metadata.world_info` (per
// METADATA_KEY in world-info.js). It's scoped to a specific chat
// file — switching chats detaches it; switching back reattaches.
//
// Scenario:
//   - One character (Ash) carries no primary book.
//   - We create a chat-scoped book "harbor-chat-lore" bound to the
//     CURRENT chat metadata via setChatWorldInfoSelection().
//   - Send a turn that mentions the chat-lore key → CHAT_LORE present
//   - Create a NEW chat (doNewChat) → chat metadata is fresh, no chat lore
//     → CHAT_LORE absent in the next turn.
//   - Reopen the original chat → chat lore reattaches → CHAT_LORE present.
//
// Restart between sub-steps locks the on-disk metadata persistence.

import { test, expect } from '@playwright/test';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, writeWorldBook } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';
import { writeCharacterWithBinding, startWorldInfoServer, tearDownWorldInfoServer } from './_helpers.js';

test.describe.configure({ mode: 'serial' });

let server, mock;

const CHAT_LORE_ENTRIES = [
    {
        key: ['harbor', 'harbour'],
        comment: 'chat-bound-harbor',
        content: 'CHAT_HARBOR_LORE: This is a chat-only secret: the harbor watch passes a coded knock against the lantern post when the tide reverses unexpectedly.',
        order: 100,
    },
];

test.beforeAll(async () => {
    mock = await startMockLLM({
        scriptedReplies: Array.from({ length: 16 }, (_, i) =>
            `*A patient reply, watching the water.* Acknowledged turn ${i + 1}.`,
        ),
    });
    server = await startWorldInfoServer({ specBaseName: '28-chat-lore-binding', scenarioId: 'chat-lore' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    writeWorldBook({ dataRoot: server.dataRoot, name: 'harbor-chat-lore', entries: CHAT_LORE_ENTRIES });
    writeCharacterWithBinding({
        dataRoot: server.dataRoot,
        avatarFile: 'ash-unbound.png',
        name: 'Ash Unbound',
        // No worldBook: character has no primary book; lore comes from chat metadata
    });
});

test.afterAll(async () => {
    await tearDownWorldInfoServer(server);
    await mock?.stop();
});

async function sendAndCaptureBody(page, text) {
    const before = mock.requests.length;
    await sendMessageAndAwaitReply(page, text);
    const newReqs = mock.requests.slice(before);
    const chatReq = newReqs.find(r => r.url.includes('chat/completions'));
    expect(chatReq, 'expected a chat-completion request after sending').toBeTruthy();
    return JSON.stringify(chatReq.body.messages);
}

test.describe('#28 — Chat lore binding follows the chat, not the character', () => {
    test('chat lore detaches on new chat and reattaches on chat reopen', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash Unbound');
        await page.waitForFunction(() => {
            const ctx = window.SillyTavern?.getContext?.();
            if (!ctx) return false;
            const id = ctx.characterId;
            if (typeof id !== 'number' && typeof id !== 'string') return false;
            return Array.isArray(ctx.chat);
        }, { timeout: 10_000 });

        // Settle the first_mes load so the next MESSAGE_RECEIVED is ours.
        await page.waitForFunction(() => {
            const ctx = window.SillyTavern.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // --- Step 1: bind chat lore to current chat, record current chat id ---
        const firstChatId = await page.evaluate(async () => {
            const ctx = window.SillyTavern.getContext();
            // Direct mutation via the world-info module's metadata key.
            ctx.chatMetadata.world_info = 'harbor-chat-lore';
            // Persist chatMetadata via saveMetadata() if available; saveChat
            // also flushes chatMetadata for character chats.
            await ctx.saveChat();
            return ctx.getCurrentChatId();
        });

        const bodyWithLore = await sendAndCaptureBody(page, 'I just checked the harbor — the lantern post is unlit at the second bell.');
        expect(bodyWithLore).toContain('CHAT_HARBOR_LORE');

        // --- Step 2: create a NEW chat — chat metadata resets, lore detaches ---
        await page.evaluate(async () => {
            const ctx = window.SillyTavern.getContext();
            await ctx.doNewChat({ deleteCurrentChat: false });
        });
        // Wait for the new chat to settle (chat_metadata should not contain world_info)
        await page.waitForFunction(() => {
            const ctx = window.SillyTavern?.getContext?.();
            const wi = ctx?.chatMetadata?.world_info;
            return !wi || (Array.isArray(wi) && wi.length === 0);
        }, { timeout: 10_000 });

        const newChatBody = await sendAndCaptureBody(page, 'The harbor was calm tonight — gulls quiet, no signs of trouble.');
        expect(newChatBody, 'new chat should not inherit the previous chat\'s lore').not.toContain('CHAT_HARBOR_LORE');

        // --- Step 3: reopen the original chat — lore reattaches ---
        await page.evaluate(async (chatId) => {
            const ctx = window.SillyTavern.getContext();
            await ctx.openCharacterChat(chatId);
        }, firstChatId);

        // Wait for the original chat's metadata to be restored
        await page.waitForFunction((id) => {
            const ctx = window.SillyTavern?.getContext?.();
            return ctx?.getCurrentChatId() === id && ctx?.chatMetadata?.world_info === 'harbor-chat-lore';
        }, firstChatId, { timeout: 10_000 });

        const reopenBody = await sendAndCaptureBody(page, 'Looking back at the harbor again — what about the knock signal?');
        expect(reopenBody, 'chat lore should reattach when the original chat is reopened').toContain('CHAT_HARBOR_LORE');
    });

    test('chat lore binding survives server restart', async ({ page }) => {
        // Server restart wipes in-memory state. The current chat's metadata
        // must reach disk (chat .jsonl file's METADATA_KEY) for the lore to
        // reattach on reload.
        await server.restart();
        await awaitMainUI(page, server.baseURL);

        // Defensive: force the right-side character drawer open before
        // selectCharacterByName tries to read its state.
        await page.evaluate(() => {
            const drawer = document.querySelector('#rightNavDrawerIcon');
            if (drawer && drawer.classList.contains('closedIcon')) {
                drawer.click();
            }
        });
        await page.locator('#rm_print_characters_block').waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});

        await selectCharacterByName(page, 'Ash Unbound');

        // The most recent chat for Ash Unbound is the one we just reopened,
        // which carries the harbor-chat-lore metadata.
        await page.waitForFunction(() => {
            const ctx = window.SillyTavern?.getContext?.();
            return ctx?.chatMetadata?.world_info === 'harbor-chat-lore';
        }, { timeout: 15_000 });

        const body = await sendAndCaptureBody(page, 'Returning to the harbor after the rebuild — the knock should still hold.');
        expect(body).toContain('CHAT_HARBOR_LORE');
    });
});
