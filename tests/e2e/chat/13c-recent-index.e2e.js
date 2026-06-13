// #13c — recent-chats index ordering.
//
// Two characters, three turns split between them. The most recently
// touched chat should appear first in /api/chats/recent.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Seraphina answers first.* "Reply S1."',
        '*Seraphina answers again.* "Reply S2."',
        '*Iyana folds her arms.* "Reply I1."',
        '*Seraphina speaks last.* "Reply S3."',
    ] });
    server = await startServer({ batchKey: 'chat', scenarioId: 'recent-index' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

async function createIyana(page) {
    return page.evaluate(async () => {
        const ctx = window.SillyTavern.getContext();
        const headers = ctx.getRequestHeaders?.() || { 'Content-Type': 'application/json' };
        const res = await fetch('/api/characters/create', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                ch_name: 'Iyana the Watchwoman',
                description: 'A second watchwoman walking the eastern stretch.',
                personality: 'Reserved, careful.',
                scenario: 'Eastern watch on the Bryn headland.',
                first_mes: '*Iyana lifts a hand in greeting.*',
                mes_example: '',
                creator_notes: 'e2e fixture',
                system_prompt: '',
                post_history_instructions: '',
                talkativeness: '0.5',
                fav: false,
                file_name: 'iyana-the-watchwoman',
                create_date: new Date().toISOString(),
            }),
        });
        return res.ok ? await res.text() : '';
    });
}

async function fetchRecent(page) {
    return page.evaluate(async () => {
        const ctx = window.SillyTavern.getContext();
        const headers = ctx.getRequestHeaders?.() || { 'Content-Type': 'application/json' };
        const res = await fetch('/api/chats/recent', {
            method: 'POST',
            headers,
            body: JSON.stringify({ pinned: [], max: 50 }),
        });
        return res.ok ? res.json() : [];
    });
}

test.describe('#13c — recent-chats index', () => {
    test('most-recent chat is first in /api/chats/recent', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => {
            const ctx = window.SillyTavern.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});
        await sendMessageAndAwaitReply(page, 'Seraphina turn 1: open the watch.');
        await sendMessageAndAwaitReply(page, 'Seraphina turn 2: hold steady.');

        // Create Iyana via live API, then re-pull the character list.
        const iyanaAvatar = await createIyana(page);
        expect(iyanaAvatar).toBe('iyana-the-watchwoman.png');
        await page.evaluate(async () => {
            const ctx = window.SillyTavern.getContext();
            await ctx.getCharacters?.();
        });
        await page.waitForFunction(() => {
            const ctx = window.SillyTavern.getContext();
            return ctx.characters.some(c => c?.name === 'Iyana the Watchwoman');
        }, { timeout: 10_000 });

        // Bypass selectCharacterByName helper which assumes the picker is
        // closed — after a previous selection the right drawer remains
        // open but the picker block visibility flickers. Select Iyana
        // through the context API directly.
        await page.evaluate(async (wantName) => {
            const ctx = window.SillyTavern.getContext();
            const idx = ctx.characters.findIndex(c => c?.name === wantName);
            if (idx < 0) throw new Error(`character ${wantName} not loaded`);
            const mod = await import('/script.js');
            await mod.selectCharacterById?.(idx);
        }, 'Iyana the Watchwoman');
        await page.waitForFunction((wantName) => {
            const ctx = window.SillyTavern.getContext();
            const c = ctx.characters[ctx.characterId];
            return c?.name === wantName;
        }, 'Iyana the Watchwoman', { timeout: 10_000 });
        await page.waitForFunction(() => {
            const ctx = window.SillyTavern.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        await sendMessageAndAwaitReply(page, 'Iyana turn 1: take the next shift.');

        // Now Iyana's chat is the most recent.
        const recentAfterIyana = await fetchRecent(page);
        expect(recentAfterIyana.length).toBeGreaterThanOrEqual(2);
        // The first entry should belong to Iyana.
        expect(recentAfterIyana[0].avatar, `expected Iyana to be most-recent; got ${JSON.stringify(recentAfterIyana.map(r => r.avatar))}`)
            .toContain('iyana-the-watchwoman');

        // Switch back to Seraphina via context, send a turn, recency flips back.
        await page.evaluate(async () => {
            const ctx = window.SillyTavern.getContext();
            const idx = ctx.characters.findIndex(c => c?.name === 'Seraphina');
            const mod = await import('/script.js');
            await mod.selectCharacterById?.(idx);
        });
        await page.waitForFunction(() => {
            const ctx = window.SillyTavern.getContext();
            const c = ctx.characters[ctx.characterId];
            return c?.name === 'Seraphina';
        }, { timeout: 10_000 });
        await sendMessageAndAwaitReply(page, 'Seraphina turn 3: returning to the chart.');

        const recentAfterSeraphina = await fetchRecent(page);
        expect(recentAfterSeraphina[0].avatar, `expected Seraphina back at the top; got ${JSON.stringify(recentAfterSeraphina.map(r => r.avatar))}`)
            .toMatch(/default_seraphina|Seraphina/i);
        // Both characters present in the index.
        const avatars = recentAfterSeraphina.map(r => r.avatar);
        expect(avatars.some(a => /default_seraphina/i.test(a))).toBe(true);
        expect(avatars.some(a => /iyana-the-watchwoman/.test(a))).toBe(true);
    });
});
