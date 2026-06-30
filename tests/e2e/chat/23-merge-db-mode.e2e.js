// #23 — Merge two chats works after the storage backend is migrated to
//        sqlite via the admin UI. Proves the fs/db transparency contract:
//        the same merge gestures land in the same DOM state regardless of
//        which backend ChatRepo is configured against.
//
// Real-user gesture:
//   1. Boot server in fs mode.
//   2. Drive the admin UI: open user settings → admin panel → Storage
//      Backend tab → pick sqlite → Migrate Now → confirm. The status
//      panel reflows to "sqlite".
//   3. Verify via /api/users/storage/status that the backend is now sqlite.
//   4. Select Seraphina, send 2 user turns → 2 assistant replies (chat A).
//   5. option_start_new_chat → confirm to create chat B; send 2 more turns.
//   6. Open the merge dialog via the past-chats popup, pick A then B,
//      submit. ST emits CHAT_CHANGED on openCharacterChat(merged_name).
//
// Locks (DOM-only — sqlite mode writes the merged chat into the DB row
// directly; there is no on-disk jsonl to read back):
//   - The merged chat opens automatically after submit.
//   - 10 message bubbles render (greeting + 2 user + 2 reply per source).
//   - Body order is A's slice [0..5) then B's slice [5..10), with the
//     user prompts and scripted replies appearing in their original order.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { markOnboarded, bootstrapCustomBackend, appendConnectionProfile } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    createNewChatViaUI,
} from '../_lib/page.js';
import { migrateViaAdminUI, closeAdminPanel, fetchStorageStatus } from '../_lib/storage-ui.js';
import {
    openMergeDialogViaUI,
    addSourceToMerge,
    submitMergeDialog,
} from '../_lib/ui-chat-merge-split.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Seraphina folds the chart in half.* "Reply A1: I hear the wind shifting south."',
        '*Seraphina trims the lantern wick.* "Reply A2: it will be a long watch tonight."',
        '*Seraphina sets a brass weight on the chart corner.* "Reply B1: the reef is restless again."',
        '*Seraphina taps the spyglass barrel.* "Reply B2: we should mark the second breaker."',
    ] });
    server = await startServer({ batchKey: 'storage', scenarioId: 'merge-db-mode' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#23 — merge two chats after migrating storage to sqlite', () => {
    test('merge succeeds end-to-end under the sqlite backend', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Sanity: confirm we booted in fs mode before migrating.
        const preStatus = await fetchStorageStatus(page);
        expect(preStatus.currentMode, 'server should start in fs mode').toBe('fs');

        // Drive the real admin UI migration to sqlite.
        await migrateViaAdminUI(page, 'sqlite');
        const postStatus = await fetchStorageStatus(page);
        expect(postStatus.currentMode, 'after migration the backend should be sqlite').toBe('sqlite');
        await closeAdminPanel(page);

        // From here on, EVERY chat write/read flows through SqliteEngine.
        // The merge endpoint and ChatRepo are backend-agnostic — this
        // test exists to prove that.
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

        const chatAId = await page.evaluate(() => window.Luker.getContext().getCurrentChatId());
        expect(chatAId, 'chat A must have a real chat id').toBeTruthy();
        await sendMessageAndAwaitReply(page, 'Turn A1: do you hear that wind?');
        await sendMessageAndAwaitReply(page, 'Turn A2: how long this watch?');

        await createNewChatViaUI(page);
        const chatBId = await page.evaluate(() => window.Luker.getContext().getCurrentChatId());
        expect(chatBId, 'chat B must have a fresh chat id').toBeTruthy();
        expect(chatBId).not.toBe(chatAId);
        await sendMessageAndAwaitReply(page, 'Turn B1: any sign of the reef?');
        await sendMessageAndAwaitReply(page, 'Turn B2: mark the second breaker?');

        // Open merge dialog, pick A then B, submit. The character path
        // calls openCharacterChat(merged_name) after the merge succeeds,
        // and openCharacterChat fires CHAT_CHANGED — so the default
        // submitMergeDialog flow (which listens for CHAT_CHANGED) is
        // sufficient here.
        const dialog = await openMergeDialogViaUI(page);
        await addSourceToMerge(page, dialog, chatAId);
        await addSourceToMerge(page, dialog, chatBId);
        const mergedName = 'merged-db';
        await submitMergeDialog(page, dialog, mergedName);
        await page.waitForFunction(
            (id) => window.Luker.getContext().getCurrentChatId() === id,
            mergedName,
            { timeout: 15_000 },
        );

        // DOM is the source of truth here — there is no on-disk jsonl
        // in sqlite mode (chat rows live in the DB). The 10-bubble
        // assertion locks the merge end-to-end:
        //   chat A = [greeting, u, r, u, r] = 5 entries
        //   chat B = [greeting, u, r, u, r] = 5 entries
        //   merged = A + B = 10 entries
        const messageBubbles = page.locator('#chat .mes');
        await expect(messageBubbles).toHaveCount(10);
        const messages = await page.locator('#chat .mes .mes_text').allInnerTexts();
        expect(messages.length).toBe(10);
        expect(messages[1]).toContain('Turn A1');
        expect(messages[2]).toContain('Reply A1');
        expect(messages[3]).toContain('Turn A2');
        expect(messages[4]).toContain('Reply A2');
        expect(messages[6]).toContain('Turn B1');
        expect(messages[7]).toContain('Reply B1');
        expect(messages[8]).toContain('Turn B2');
        expect(messages[9]).toContain('Reply B2');

        // ctx.chat is the in-memory mirror that the chat panel re-renders
        // from. Asserting on it as well catches any case where the panel
        // renders stale DOM from a prior chat.
        const chatLength = await page.evaluate(() => window.Luker.getContext().chat?.length);
        expect(chatLength, 'ctx.chat should match the rendered bubble count').toBe(10);
    });
});
