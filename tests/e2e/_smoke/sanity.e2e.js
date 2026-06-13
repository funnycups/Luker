// tests/e2e/_smoke/sanity.e2e.js — proves the shared fixtures work end-to-end.
//
// 1. Spawns a Luker server on its own port + cloned dataRoot.
// 2. Spawns the in-process mock LLM and bootstraps the custom backend
//    in the cloned settings.json so the first turn already routes to it.
// 3. Loads the UI, selects the bundled Seraphina, sends one message, and
//    confirms (a) the assistant bubble appears, (b) the mock recorded a
//    chat-completion request from Luker's server.
//
// If this passes, every batch spec can rely on:
//   startServer() + startMockLLM() + bootstrapCustomBackend()
//   awaitMainUI() + selectCharacterByName() + sendMessageAndAwaitReply()

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Seraphina folds the chart and meets your eyes.* "The lantern will hold another hour. Tell me what you saw on the path."',
    ] });
    server = await startServer({ batchKey: 'chat', scenarioId: 'sanity' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test('sanity: dedicated server + mock backend + first-turn happy path', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, 'Seraphina');

    // Wait for the first_mes to settle (so MESSAGE_RECEIVED later is the
    // /send reply, not the greeting). Greeting fires as a chat-load event.
    await page.waitForFunction(() => {
        const ctx = window.SillyTavern.getContext();
        return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
    }, { timeout: 10_000 }).catch(() => {});

    const before = mock.requests.length;
    const initialChatLen = await page.evaluate(() => window.SillyTavern.getContext().chat?.length || 0);

    await sendMessageAndAwaitReply(page, 'I walked the cliff path. The wind is cold but the lantern holds.');

    // chat should now contain at least: greeting + user + assistant
    const finalChat = await page.evaluate(() => {
        const ctx = window.SillyTavern.getContext();
        return ctx.chat.map(m => ({ is_user: !!m.is_user, mes: String(m.mes || '').slice(0, 80) }));
    });
    expect(finalChat.length).toBeGreaterThanOrEqual(initialChatLen + 2);
    const lastUser = [...finalChat].reverse().find(m => m.is_user);
    const lastAsst = [...finalChat].reverse().find(m => !m.is_user);
    expect(lastUser?.mes).toMatch(/cliff path/);
    expect(lastAsst?.mes).toMatch(/lantern|chart|Seraphina/);

    const newReqs = mock.requests.slice(before);
    const chatReq = newReqs.find(r => r.url.includes('chat/completions'));
    expect(chatReq, `expected the user turn to be forwarded to mock; mock saw ${newReqs.length} new requests at urls=${JSON.stringify(newReqs.map(r => r.url))}`).toBeTruthy();
    expect(Array.isArray(chatReq.body.messages)).toBe(true);
    expect(chatReq.body.messages.some(m => /cliff path/i.test(JSON.stringify(m.content)))).toBe(true);
});
