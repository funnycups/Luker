// #3 — Multi-swipe: 3 variants total, pick variant #2, restart, ordering
// + selected swipe_id preserved.
//
// Slash command path: /swipe direction=right pops a new swipe; /swipe
// direction=left would step back. We end on swipe_id 1 (second variant)
// and assert that survives restart.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait, selectCharacterByName, sendMessageAndAwaitReply, getChatSnapshot } from '../_lib/page.js';

const REPLIES = [
    '*Seraphina looks out across the black water and sighs softly.* "First variant — the wind is steady tonight, and the chart held its shape."',
    '*Seraphina sets the spyglass down and meets your eye.* "Second variant — the wind is steady tonight, but I do not trust the chart."',
    '*Seraphina tilts her head, listening.* "Third variant — the wind is steady tonight; something in the silence does not match the chart."',
];

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: REPLIES });
    server = await startServer({ batchKey: 'chat', scenarioId: 'multi-swipe' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

async function swipeRightSlash(page) {
    return page.evaluate(() => new Promise((resolve, reject) => {
        const ctx = window.Luker.getContext();
        const t = setTimeout(() => reject(new Error('swipe timeout')), 30_000);
        const off = ctx.eventSource.on(ctx.eventTypes.MESSAGE_RECEIVED, (id) => {
            clearTimeout(t);
            try { ctx.eventSource.removeListener(ctx.eventTypes.MESSAGE_RECEIVED, off); } catch {}
            resolve(id);
        });
        ctx.executeSlashCommandsWithOptions('/swipe direction=right').catch(reject);
    }));
}

test.describe('#3 — multi-swipe persistence', () => {
    test('3 swipe variants, pick #2, ordering preserved across restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // First-turn reply → swipe_id 0.
        await sendMessageAndAwaitReply(page, 'What do you read in the reef tonight?');
        // Two more swipes → swipe_id 1 and 2.
        await swipeRightSlash(page);
        await swipeRightSlash(page);

        // Now step left once to land on swipe #2 (index 1).
        await page.evaluate(async () => {
            await window.Luker.getContext().executeSlashCommandsWithOptions('/swipe direction=left');
        });
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            const last = ctx.chat[ctx.chat.length - 1];
            return last && last.swipe_id === 1;
        }, { timeout: 10_000 });

        const before = await getChatSnapshot(page);
        const lastBefore = before.messages[before.messages.length - 1];
        expect(lastBefore.swipes).toBeTruthy();
        expect(lastBefore.swipes.length).toBe(3);
        expect(lastBefore.swipe_id).toBe(1);
        // Confirm each variant text matches its scripted reply.
        expect(lastBefore.swipes[0]).toContain('First variant');
        expect(lastBefore.swipes[1]).toContain('Second variant');
        expect(lastBefore.swipes[2]).toContain('Third variant');

        // /swipe direction=left only updates in-memory state; nothing emits
        // a chat-save. Explicitly persist before restarting.
        await page.evaluate(async () => {
            await window.Luker.getContext().saveChat();
        });
        await page.waitForTimeout(500);

        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 2;
        }, { timeout: 15_000 });

        const after = await getChatSnapshot(page);
        const lastAfter = after.messages[after.messages.length - 1];
        expect(lastAfter.swipes).toBeTruthy();
        expect(lastAfter.swipes.length, 'swipes count should survive restart').toBe(3);
        expect(lastAfter.swipe_id, 'selected swipe index should survive restart').toBe(1);
        expect(lastAfter.swipes[0]).toContain('First variant');
        expect(lastAfter.swipes[1]).toContain('Second variant');
        expect(lastAfter.swipes[2]).toContain('Third variant');
    });
});
