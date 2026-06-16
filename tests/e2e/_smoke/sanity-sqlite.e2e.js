// tests/e2e/_smoke/sanity-sqlite.e2e.js — chat happy-path while the
// SQLite storage engine is the live backend.
//
// Bootstrap path: the server boots in fs mode (so the standard
// content-seed step writes default settings.json to disk), the fixture
// helpers wire the mock backend into that on-disk settings.json, then
// the test drives the admin UI to migrate fs → sqlite. From that point
// every storage read/write goes through SqliteEngine. The chat send is
// then the same as sanity.e2e.js. If this passes, the SqliteEngine
// handles a real first-turn round-trip (settings read, chat append,
// chat persist) under load that mirrors the boot flow.
//
// NB: A "boot directly in sqlite mode" path is currently unsupported
// because content-seed writes settings.json to the filesystem, not via
// SettingsRepo. The migration path is the realistic way to land in
// sqlite for an existing dataRoot, which is exactly what the admin
// panel documents.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';
import { migrateViaAdminUI, closeAdminPanel, fetchStorageStatus } from '../_lib/storage-ui.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Seraphina folds the chart and meets your eyes.* "The lantern will hold another hour. Tell me what you saw on the path."',
    ] });
    server = await startServer({ batchKey: 'storage', scenarioId: 'sanity-sqlite' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test('sanity (SQLite): migrate fs->sqlite then run the first-turn happy path', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);

    // Migrate to SQLite via the real admin UI before sending any chat,
    // so the SqliteEngine is the live backend when the chat fires.
    await migrateViaAdminUI(page, 'sqlite');
    const postStatus = await fetchStorageStatus(page);
    expect(postStatus.currentMode).toBe('sqlite');
    await closeAdminPanel(page);

    // Standard sanity flow against the live SQLite backend.
    await selectCharacterByName(page, 'Seraphina');

    await page.waitForFunction(() => {
        const ctx = window.Luker.getContext();
        return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
    }, { timeout: 10_000 }).catch(() => {});

    const before = mock.requests.length;
    const initialChatLen = await page.evaluate(() => window.Luker.getContext().chat?.length || 0);

    await sendMessageAndAwaitReply(page, 'I walked the cliff path. The wind is cold but the lantern holds.');

    const finalChat = await page.evaluate(() => {
        const ctx = window.Luker.getContext();
        return ctx.chat.map(m => ({ is_user: !!m.is_user, mes: String(m.mes || '').slice(0, 80) }));
    });
    expect(finalChat.length).toBeGreaterThanOrEqual(initialChatLen + 2);
    const lastUser = [...finalChat].reverse().find(m => m.is_user);
    const lastAsst = [...finalChat].reverse().find(m => !m.is_user);
    expect(lastUser?.mes).toMatch(/cliff path/);
    expect(lastAsst?.mes).toMatch(/lantern|chart|Seraphina/);

    const newReqs = mock.requests.slice(before);
    const chatReq = newReqs.find(r => r.url.includes('chat/completions'));
    expect(chatReq, `expected the user turn to be forwarded to mock; mock saw ${newReqs.length} new requests`).toBeTruthy();
    expect(Array.isArray(chatReq.body.messages)).toBe(true);
    expect(chatReq.body.messages.some(m => /cliff path/i.test(JSON.stringify(m.content)))).toBe(true);
});
