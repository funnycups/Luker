// #27 — Bind WI to character → switch character
//
// Each character carries its own primary book pointer at
// character.data.extensions.world. When the active character changes,
// the WI pipeline must (a) detach the old book and (b) attach the new.
//
// Scenario:
//   - Char1 (Ash) bound to bookA — contains entry "OAKWOOD_LORE" on key "oakwood"
//   - Char2 (Rhonin) bound to bookB — contains entry "STONEPATH_LORE" on key "stonepath"
//
// 1. Select Ash, send a turn with "the oakwood is restless tonight"
//      → OAKWOOD_LORE present, STONEPATH_LORE absent
// 2. Switch to Rhonin, send a turn with "the stonepath narrows past the mill"
//      → STONEPATH_LORE present, OAKWOOD_LORE absent
// 3. Restart, repeat both with new chat — bindings persist on disk.

import { test, expect } from '@playwright/test';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, writeWorldBook } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';
import { writeCharacterWithBinding, startWorldInfoServer, tearDownWorldInfoServer } from './_helpers.js';

test.describe.configure({ mode: 'serial' });

let server, mock;

const BOOK_A_ENTRIES = [
    {
        key: ['oakwood', 'oak-grove'],
        comment: 'ash-private-lore',
        content: 'OAKWOOD_LORE: Ash learned to read tide-charts at her aunt\'s oakwood cottage, where the gulls always nested over the eastern window.',
        order: 100,
    },
];

const BOOK_B_ENTRIES = [
    {
        key: ['stonepath', 'stone-path'],
        comment: 'rhonin-private-lore',
        content: 'STONEPATH_LORE: Rhonin walks the stonepath each dawn to count the herring traps along the inner cove, never trusting the count to apprentices.',
        order: 100,
    },
];

test.beforeAll(async () => {
    mock = await startMockLLM({
        scriptedReplies: Array.from({ length: 10 }, (_, i) =>
            `*A measured reply, eyes on the horizon.* Acknowledged (${i + 1}).`,
        ),
    });
    server = await startWorldInfoServer({ specBaseName: '27-bind-character-switch', scenarioId: 'char-bind-switch' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    const bookA = writeWorldBook({ dataRoot: server.dataRoot, name: 'ash-private-book', entries: BOOK_A_ENTRIES });
    const bookB = writeWorldBook({ dataRoot: server.dataRoot, name: 'rhonin-private-book', entries: BOOK_B_ENTRIES });

    writeCharacterWithBinding({
        dataRoot: server.dataRoot,
        avatarFile: 'ash-cartographer.png',
        name: 'Ash Cartographer',
        worldBook: bookA,
    });
    writeCharacterWithBinding({
        dataRoot: server.dataRoot,
        avatarFile: 'rhonin-warden.png',
        name: 'Rhonin Warden',
        worldBook: bookB,
        extras: {
            description: 'A coastal warden in his late forties. Greying beard, deliberate movements, never raises his voice. Charges the morning herring count himself.',
            personality: 'Quiet, exacting, generous with rules and stingy with praise.',
            scenario: 'You meet Rhonin at the cove gate where he is examining the night\'s trap-lines.',
            first_mes: '*Rhonin straightens from the trap-rope, salt on his sleeves.* "Early. Walk with me along the stonepath — the inner cove was unsettled at the third bell."',
        },
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

async function settleFirstMes(page) {
    // Wait for the just-selected character's greeting to populate ctx.chat so
    // the next MESSAGE_RECEIVED is from our /trigger, not the chat-load event.
    await page.waitForFunction(() => {
        const ctx = window.Luker.getContext();
        return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
    }, { timeout: 10_000 }).catch(() => { /* welcome panel path is ok */ });
}

async function forceCharacterDrawerOpen(page) {
    // The right-side character drawer's open/closed state can desync from
    // visibility (the class flips but the panel stays hidden). Force-open
    // it before any selectCharacterByName so the next click lands on a
    // visible card list.
    await page.evaluate(() => {
        const drawer = document.querySelector('#rightNavDrawerIcon');
        const block = document.querySelector('#rm_print_characters_block');
        if (!drawer || !block) return;
        const isHidden = window.getComputedStyle(block).display === 'none' || block.offsetParent === null;
        if (drawer.classList.contains('closedIcon') || isHidden) {
            drawer.click();
        }
    });
    await page.locator('#rm_print_characters_block').waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
}

async function selectByNameProgrammatic(page, name) {
    // Drives selectCharacterById through the context API instead of clicking
    // the drawer card, so character switching doesn't depend on the drawer
    // being visible. Returns true if a character with the matching name was
    // found and selected.
    return page.evaluate(async (wantName) => {
        const ctx = window.Luker.getContext();
        const idx = ctx.characters.findIndex(c => c?.name === wantName || c?.data?.name === wantName);
        if (idx < 0) return false;
        await ctx.selectCharacterById(idx);
        return true;
    }, name);
}

test.describe('#27 — Bind WI to character → switch character', () => {
    test('each character pulls only its own bound book', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await forceCharacterDrawerOpen(page);

        // --- Ash turn: only OAKWOOD_LORE ---
        await selectCharacterByName(page, 'Ash Cartographer');
        await page.waitForFunction(() => {
            const ctx = window.Luker?.getContext?.();
            if (!ctx) return false;
            const id = ctx.characterId;
            if (typeof id !== 'number' && typeof id !== 'string') return false;
            return ctx.characters?.[id]?.data?.extensions?.world === 'ash-private-book';
        }, { timeout: 10_000 });
        await settleFirstMes(page);

        const ashBody = await sendAndCaptureBody(page, 'The oakwood is restless tonight; the gulls are silent.');
        expect(ashBody).toContain('OAKWOOD_LORE');
        expect(ashBody).not.toContain('STONEPATH_LORE');

        // --- Switch to Rhonin via programmatic API to skip drawer flicker ---
        const switched = await selectByNameProgrammatic(page, 'Rhonin Warden');
        expect(switched, 'expected Rhonin Warden to be present in characters list').toBe(true);
        await page.waitForFunction(() => {
            const ctx = window.Luker?.getContext?.();
            if (!ctx) return false;
            const id = ctx.characterId;
            if (typeof id !== 'number' && typeof id !== 'string') return false;
            return ctx.characters?.[id]?.data?.extensions?.world === 'rhonin-private-book';
        }, { timeout: 10_000 });
        await settleFirstMes(page);

        const rhoninBody = await sendAndCaptureBody(page, 'The stonepath narrows past the mill at the third bend.');
        expect(rhoninBody).toContain('STONEPATH_LORE');
        expect(rhoninBody).not.toContain('OAKWOOD_LORE');
    });

    test('bindings persist across server restart', async ({ page }) => {
        await server.restart();
        await awaitMainUI(page, server.baseURL);

        // Use programmatic selection — drawer-state is unreliable across restart.
        const ashOk = await selectByNameProgrammatic(page, 'Ash Cartographer');
        expect(ashOk, 'expected Ash Cartographer to be in the post-restart characters list').toBe(true);
        await page.waitForFunction(() => {
            const ctx = window.Luker?.getContext?.();
            if (!ctx) return false;
            const id = ctx.characterId;
            if (typeof id !== 'number' && typeof id !== 'string') return false;
            return ctx.characters?.[id]?.data?.extensions?.world === 'ash-private-book';
        }, { timeout: 10_000 });
        await settleFirstMes(page);

        const ashBody = await sendAndCaptureBody(page, 'The oakwood cottage still stands on the eastern bluff.');
        expect(ashBody).toContain('OAKWOOD_LORE');
        expect(ashBody).not.toContain('STONEPATH_LORE');

        const rhoninOk = await selectByNameProgrammatic(page, 'Rhonin Warden');
        expect(rhoninOk).toBe(true);
        await page.waitForFunction(() => {
            const ctx = window.Luker?.getContext?.();
            if (!ctx) return false;
            const id = ctx.characterId;
            if (typeof id !== 'number' && typeof id !== 'string') return false;
            return ctx.characters?.[id]?.data?.extensions?.world === 'rhonin-private-book';
        }, { timeout: 10_000 });
        await settleFirstMes(page);

        const rhoninBody = await sendAndCaptureBody(page, 'Two of the stonepath traps showed broken lines this dawn.');
        expect(rhoninBody).toContain('STONEPATH_LORE');
        expect(rhoninBody).not.toContain('OAKWOOD_LORE');
    });
});
