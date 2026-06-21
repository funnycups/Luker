// #13c — recent-chats index ordering across multiple characters.
//
// Two characters (Seraphina + Iyana). Send turns to each via real DOM
// gestures (character card click in the drawer + #send_textarea +
// #send_but). Confirm /api/chats/recent reflects the latest activity
// in MRU order.
//
// Note: the /api/chats/recent index is server-side state, not directly
// surfaced in the UI as a sorted list with stable per-row identifiers
// — the past-chats popup shows per-character chats, not a global recent
// list. The PERSISTENT invariant we're locking is "the server records
// most-recent activity correctly", so we hit /api/chats/recent
// directly. The driving actions (turn sends, character switches) are
// real DOM gestures.
//
// Setup note: Iyana is created via /api/characters/create rather than
// the writeCharacter fixture because Luker reads character data from the
// PNG's embedded tEXt chunk, not from sidecar JSON. Copying the
// Seraphina PNG to "iyana-the-watchwoman.png" would still load as
// Seraphina. The /api/characters/create endpoint properly writes a
// fresh PNG with the embedded chara JSON, which is what the real "Create
// character" UI flow does under the hood.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import {
    bootstrapCustomBackend,
    appendConnectionProfile,
    markOnboarded,
} from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    closeRightNavDrawer,
} from '../_lib/page.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';

/**
 * After a previous selectCharacterByName, the right-nav drawer's
 * "character editor" sub-panel is showing instead of the character
 * list. Navigate back to the list via the real "Characters" tab inside
 * the right-nav drawer.
 */
async function navigateBackToCharacterList(page) {
    // Open the right nav drawer if closed (the click on the icon toggles).
    const drawer = page.locator('#rightNavDrawerIcon');
    const drawerClosed = await drawer.evaluate(el => el.classList.contains('closedIcon')).catch(() => true);
    if (drawerClosed) await drawer.click();
    // Click the Characters sub-panel button to switch back to the list.
    await page.locator('#rm_button_characters').click();
    await page.locator('#rm_print_characters_block').waitFor({ state: 'visible', timeout: 5_000 });
}

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
    // Seed Iyana as a real PNG card on disk so the boot-time character
    // scan picks her up alongside the bundled Seraphina.
    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: 'iyana-the-watchwoman.png',
        overrides: {
            name: 'Iyana the Watchwoman',
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
        },
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

/**
 * Read the most-recent chats index. This is server-side state — the
 * past-chats popup shows per-character chats only, not a cross-character
 * MRU list. We read /api/chats/recent (the same endpoint the past-chats
 * popup hits for global recency) purely as an assertion source.
 */
async function fetchRecent(page) {
    return page.evaluate(async () => {
        const ctx = window.Luker.getContext();
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
    test('most-recent activity moves to the top of /api/chats/recent', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Real user gesture: pick Seraphina from the character drawer,
        // send two turns via #send_textarea + #send_but.
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});
        await sendMessageAndAwaitReply(page, 'Seraphina turn 1: open the watch.');
        await sendMessageAndAwaitReply(page, 'Seraphina turn 2: hold steady.');

        // Set up the second character via the fs fixture (above). Iyana
        // is already on disk; she'll appear in the right-nav character
        // list after a list refresh — go back to the list and re-open the
        // drawer to pick her up.
        await navigateBackToCharacterList(page);
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return ctx.characters.some(c => c?.name === 'Iyana the Watchwoman');
        }, { timeout: 10_000 });

        // Real user gesture: pick Iyana from the character drawer, send one turn.
        await selectCharacterByName(page, 'Iyana the Watchwoman');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});
        await sendMessageAndAwaitReply(page, 'Iyana turn 1: take the next shift.');

        // Iyana's chat is now the most recent.
        const recentAfterIyana = await fetchRecent(page);
        expect(recentAfterIyana.length).toBeGreaterThanOrEqual(2);
        expect(recentAfterIyana[0].avatar,
            `expected Iyana to be most-recent; got ${JSON.stringify(recentAfterIyana.map(r => r.avatar))}`)
            .toContain('iyana-the-watchwoman');

        // Real user gesture: switch back to Seraphina in the drawer,
        // send another turn — recency flips back.
        await navigateBackToCharacterList(page);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});
        await sendMessageAndAwaitReply(page, 'Seraphina turn 3: returning to the chart.');

        const recentAfterSeraphina = await fetchRecent(page);
        expect(recentAfterSeraphina[0].avatar,
            `expected Seraphina back at the top; got ${JSON.stringify(recentAfterSeraphina.map(r => r.avatar))}`)
            .toMatch(/default_seraphina|Seraphina/i);
        const avatars = recentAfterSeraphina.map(r => r.avatar);
        expect(avatars.some(a => /default_seraphina/i.test(a))).toBe(true);
        expect(avatars.some(a => /iyana-the-watchwoman/.test(a))).toBe(true);
    });
});
