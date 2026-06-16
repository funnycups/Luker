// tests/e2e/storage/migrate-fs-to-sqlite.e2e.js — round-trip a real
// chat across the fs → sqlite admin migration.
//
// Shape:
//   1. Boot fs-mode server, wire mock backend + connection profile.
//   2. Send a chat message under fs. ChatRepo persists it on disk.
//   3. Verify storage status reads `fs`.
//   4. Migrate to sqlite via the admin UI (confirm popup + button click).
//   5. Verify status flips to `sqlite`.
//   6. Reload the page (forces the chat panel to re-read history from
//      the live SqliteEngine).
//   7. Assert the previously-sent message is present.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply, reloadAndAwait } from '../_lib/page.js';
import { migrateViaAdminUI, closeAdminPanel, fetchStorageStatus } from '../_lib/storage-ui.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Ash sets the spyglass down and answers without turning.* "Hold that thought. I see something at the north breaker — count three slow breaths before you speak."',
    ] });
    server = await startServer({ batchKey: 'storage', scenarioId: 'fs-to-sqlite' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test('migrate fs -> sqlite via admin UI preserves an in-progress chat', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);

    // Establish a chat under fs mode.
    await selectCharacterByName(page, 'Seraphina');
    await page.waitForFunction(() => {
        const ctx = window.Luker.getContext();
        return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
    }, { timeout: 10_000 }).catch(() => {});

    await sendMessageAndAwaitReply(
        page,
        'The lantern is fluttering — what mark do you read from the north reef?',
    );

    const preChatSnapshot = await page.evaluate(() => {
        const ctx = window.Luker.getContext();
        return ctx.chat.map(m => String(m.mes || ''));
    });
    expect(preChatSnapshot.some(m => /lantern is fluttering|north reef/.test(m))).toBe(true);

    // Pre-migration assertion: fs is the live mode.
    const preStatus = await fetchStorageStatus(page);
    expect(preStatus.currentMode).toBe('fs');

    // Drive the admin migration UI.
    await migrateViaAdminUI(page, 'sqlite');

    // Post-migration: sqlite is now live (verify via the same endpoint
    // that the admin panel uses).
    const postStatus = await fetchStorageStatus(page);
    expect(postStatus.currentMode).toBe('sqlite');
    expect(postStatus.lastMigration).toBeTruthy();
    await closeAdminPanel(page);

    // Reload to force the chat list to re-load entirely from the new
    // (SQLite) backend. Without the reload, the chat panel keeps its
    // in-memory copy from the pre-migration session — a stale copy that
    // would mask any "data didn't actually land in SQLite" regression.
    await reloadAndAwait(page, server.baseURL);
    await selectCharacterByName(page, 'Seraphina');

    // Wait for the chat to populate post-reload.
    await page.waitForFunction(() => {
        const ctx = window.Luker.getContext();
        return Array.isArray(ctx.chat) && ctx.chat.length >= 2;
    }, { timeout: 10_000 });

    const postChatSnapshot = await page.evaluate(() => {
        const ctx = window.Luker.getContext();
        return ctx.chat.map(m => String(m.mes || ''));
    });
    expect(postChatSnapshot.some(m => /lantern is fluttering|north reef/.test(m))).toBe(true);
    expect(postChatSnapshot.some(m => /north breaker|spyglass/.test(m))).toBe(true);
});
