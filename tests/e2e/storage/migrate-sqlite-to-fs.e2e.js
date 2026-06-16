// tests/e2e/storage/migrate-sqlite-to-fs.e2e.js — reverse-direction
// admin migration: boot fs, migrate to sqlite (so SQLite is the live
// engine), send a chat that lands in SQLite, then migrate back to fs
// and verify the chat round-trips into the on-disk JSONL store.
//
// The "start in sqlite mode" path is not directly supported by the
// content-seed bootstrap (settings.json is written to disk, not via
// SettingsRepo). The migration round-trip is the realistic way to land
// in SQLite for an existing dataRoot.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply, reloadAndAwait } from '../_lib/page.js';
import { migrateViaAdminUI, closeAdminPanel, fetchStorageStatus } from '../_lib/storage-ui.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Seraphina marks the chart with a stub of charcoal.* "If the gulls fly seaward at first light, the swell will calm before noon — write that down."',
    ] });
    server = await startServer({ batchKey: 'storage', scenarioId: 'sqlite-to-fs' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test('migrate sqlite -> fs via admin UI preserves a chat sent while in sqlite', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);

    // First leg: fs → sqlite so SQLite becomes the live engine.
    await migrateViaAdminUI(page, 'sqlite');
    const sqliteStatus = await fetchStorageStatus(page);
    expect(sqliteStatus.currentMode).toBe('sqlite');
    await closeAdminPanel(page);

    // Send a chat under SQLite mode. The user + assistant pair must
    // land in the SQLite kv_chats table (verified indirectly by the
    // post-fs-migration assertion: any data on disk has to have come
    // from the sqlite source set during the reverse migration).
    await selectCharacterByName(page, 'Seraphina');
    await page.waitForFunction(() => {
        const ctx = window.Luker.getContext();
        return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
    }, { timeout: 10_000 }).catch(() => {});

    await sendMessageAndAwaitReply(
        page,
        'Mark this in the log: the gulls turn at the first hour past dawn.',
    );

    const preChatSnapshot = await page.evaluate(() => {
        const ctx = window.Luker.getContext();
        return ctx.chat.map(m => String(m.mes || ''));
    });
    expect(preChatSnapshot.some(m => /gulls turn|first hour past dawn/.test(m))).toBe(true);

    // Second leg: sqlite → fs. This is the assertion under test.
    await migrateViaAdminUI(page, 'fs');
    const fsStatus = await fetchStorageStatus(page);
    expect(fsStatus.currentMode).toBe('fs');
    expect(fsStatus.lastMigration).toBeTruthy();
    await closeAdminPanel(page);

    // Reload so the chat panel re-reads from the (now active) fs engine.
    await reloadAndAwait(page, server.baseURL);
    await selectCharacterByName(page, 'Seraphina');
    await page.waitForFunction(() => {
        const ctx = window.Luker.getContext();
        return Array.isArray(ctx.chat) && ctx.chat.length >= 2;
    }, { timeout: 10_000 });

    const postChatSnapshot = await page.evaluate(() => {
        const ctx = window.Luker.getContext();
        return ctx.chat.map(m => String(m.mes || ''));
    });
    expect(postChatSnapshot.some(m => /gulls turn|first hour past dawn/.test(m))).toBe(true);
    expect(postChatSnapshot.some(m => /gulls fly seaward|swell will calm/.test(m))).toBe(true);
});
