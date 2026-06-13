// #25 — Activation strategies all inject correctly
//
// Build a single world book with one entry per strategy:
//   a) constant       — always injected (no key needed)
//   b) selective AND_ANY (single primary key) — injected on key match
//   c) selective AND_ANY (no secondary)  — "blue" / forced primary-key-only
//   d) selective AND_ALL (primary + secondary required) — "green" / AND-logic
//   e) vectorized     — flagged for semantic injection
//
// Then for each strategy, send a turn whose user text exercises that path
// and assert the entry's content appears in the next chat-completion
// request sent to the mock backend.
//
// Vectorized is the odd one out: vector ranking requires an embedding
// backend the mock LLM doesn't ship. We assert only that the entry's
// vectorized flag round-trips, and document the embedder dependency.

import { test, expect } from '@playwright/test';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, writeWorldBook } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';
import { writeCharacterWithBinding, startWorldInfoServer, tearDownWorldInfoServer } from './_helpers.js';

test.describe.configure({ mode: 'serial' });

let server, mock;

const STRATEGY_ENTRIES = [
    {
        key: [],
        keysecondary: [],
        comment: 'constant-always',
        content: 'CONSTANT_LORE: The lighthouse on Bryn cliff has burned every night since the great surge of 1899.',
        constant: true,
        order: 100,
    },
    {
        key: ['quartermaster', 'quartermasters'],
        keysecondary: [],
        comment: 'selective-single-primary',
        content: 'SELECTIVE_LORE: The quartermaster of Bryn keeps tallow candles in a locked cedar chest, rationed to one per night.',
        order: 110,
    },
    {
        key: ['drifter', 'drifters'],
        keysecondary: [],
        comment: 'blue-primary-only',
        content: 'BLUE_LORE: Drifters of the salt mark trail kelp lines behind their skiffs to mark safe water for those who come after.',
        order: 120,
    },
    {
        key: ['signal', 'signals'],
        keysecondary: ['lantern'],
        comment: 'green-and-all',
        content: 'GREEN_LORE: When the keeper raises and lowers the lantern three times, drifters answer by trimming their sails to half.',
        selectiveLogic: 3, // AND_ALL
        order: 130,
    },
    {
        key: ['kelp', 'reef-kelp'],
        keysecondary: [],
        comment: 'vectorized-flag',
        content: 'VECTOR_LORE: Kelp dies in fresh water within a tide; the green ribbons on the south reef tell of a hidden spring.',
        vectorized: true,
        order: 140,
    },
];

test.beforeAll(async () => {
    mock = await startMockLLM({
        scriptedReplies: Array.from({ length: 8 }, (_, i) =>
            `*Ash answers measuredly, eyes still on the chart.* Reply ${i + 1} acknowledged.`,
        ),
    });
    server = await startWorldInfoServer({ specBaseName: '25-activation-strategies', scenarioId: 'activation-strategies' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    const bookName = writeWorldBook({
        dataRoot: server.dataRoot,
        name: 'activation-strategies-book',
        entries: STRATEGY_ENTRIES,
    });

    writeCharacterWithBinding({
        dataRoot: server.dataRoot,
        avatarFile: 'ash-strategies.png',
        name: 'Ash Strategies',
        worldBook: bookName,
    });
});

test.afterAll(async () => {
    await tearDownWorldInfoServer(server);
    await mock?.stop();
});

test.describe('#25 — Activation strategies all inject correctly', () => {
    test('constant + selective + AND_ALL all route content into the prompt', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash Strategies');

        // Wait for the character card to finish loading (so character.data.extensions.world resolves)
        await page.waitForFunction(() => {
            const ctx = window.SillyTavern?.getContext?.();
            if (!ctx) return false;
            const id = ctx.characterId;
            if (typeof id !== 'number' && typeof id !== 'string') return false;
            return ctx.characters?.[id]?.data?.extensions?.world;
        }, { timeout: 10_000 });

        // Settle: wait for first_mes greeting to render so the next
        // MESSAGE_RECEIVED is from our /trigger, not the chat-load event.
        await page.waitForFunction(() => {
            const ctx = window.SillyTavern.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // Force selected world info so the bound book is visible to the WI pipeline.
        // characters[].data.extensions.world is the "primary book" pointer, which is
        // loaded via getCharacterLore() at scan time — so the binding flows.

        // Helper: send a turn and return the body of the resulting chat-completion request.
        async function sendAndCaptureBody(text) {
            const before = mock.requests.length;
            await sendMessageAndAwaitReply(page, text);
            const newReqs = mock.requests.slice(before);
            const chatReq = newReqs.find(r => r.url.includes('chat/completions'));
            expect(chatReq, 'expected a chat-completion request after sending').toBeTruthy();
            return JSON.stringify(chatReq.body.messages);
        }

        // (a) Constant: any message triggers it; use a message with no triggers
        //     for the other entries to keep the assertion clean.
        const bodyA = await sendAndCaptureBody('I came up the cliff path before the wind shifted.');
        expect(bodyA, 'constant entry should always appear').toContain('CONSTANT_LORE');
        expect(bodyA).not.toContain('SELECTIVE_LORE');
        expect(bodyA).not.toContain('BLUE_LORE');
        expect(bodyA).not.toContain('GREEN_LORE');

        // (b) Selective single-primary: mention "quartermaster" → SELECTIVE_LORE injected.
        const bodyB = await sendAndCaptureBody('Have you spoken with the quartermaster about the candles tonight?');
        expect(bodyB).toContain('CONSTANT_LORE'); // constant always
        expect(bodyB).toContain('SELECTIVE_LORE');
        expect(bodyB).not.toContain('BLUE_LORE');
        expect(bodyB).not.toContain('GREEN_LORE');

        // (c) Blue (primary-key only — no secondary): mention "drifters" → BLUE_LORE injected.
        const bodyC = await sendAndCaptureBody('The drifters were seen north of the gull rocks at dusk.');
        expect(bodyC).toContain('CONSTANT_LORE');
        expect(bodyC).toContain('BLUE_LORE');
        expect(bodyC).not.toContain('GREEN_LORE'); // signal+lantern not both present

        // (d) Green (AND_ALL): "signal" alone is not enough; both "signal" and "lantern" must appear.
        const bodyD1 = await sendAndCaptureBody('I think I saw a signal flicker against the rocks.');
        expect(bodyD1).toContain('CONSTANT_LORE');
        expect(bodyD1).not.toContain('GREEN_LORE'); // missing "lantern"

        const bodyD2 = await sendAndCaptureBody('The signal from the lantern was clear: three quick raises and a hold.');
        expect(bodyD2).toContain('CONSTANT_LORE');
        expect(bodyD2).toContain('GREEN_LORE'); // both primary + secondary present
    });

    test('vectorized entry preserves its flag and remains keyword-active', async ({ page }) => {
        // The vectorized flag does NOT exempt an entry from keyword matching;
        // it only ADDS the entry to the vectors extension's semantic pool.
        // So a vectorized entry whose primary key is present in the user
        // message still fires via the keyword path — and its content lands
        // in the prompt the same way a normal selective entry would.
        // This sub-case locks both behaviors: flag round-trips on disk AND
        // keyword activation isn't suppressed by the flag.

        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash Strategies');

        const sorted = await page.evaluate(async () => {
            const headers = { 'Content-Type': 'application/json', ...window.SillyTavern.getContext().getRequestHeaders() };
            const res = await fetch('/api/worldinfo/get', {
                method: 'POST',
                headers,
                body: JSON.stringify({ name: 'activation-strategies-book' }),
            });
            const data = await res.json();
            return Object.values(data.entries || {}).map(e => ({
                comment: e.comment,
                vectorized: !!e.vectorized,
                constant: !!e.constant,
            }));
        });
        const vectorEntry = sorted.find(e => e.comment === 'vectorized-flag');
        expect(vectorEntry, 'vectorized entry should be present on disk').toBeTruthy();
        expect(vectorEntry.vectorized).toBe(true);

        // Send a turn whose user text mentions the vectorized entry's
        // primary key ("kelp"). Confirm VECTOR_LORE makes it into the
        // prompt — vectorized flag does NOT block keyword activation.
        const before = mock.requests.length;
        await sendMessageAndAwaitReply(page, 'The kelp on the south reef looked thinner today than last week.');
        const newReqs = mock.requests.slice(before);
        const chatReq = newReqs.find(r => r.url.includes('chat/completions'));
        const body = JSON.stringify(chatReq.body.messages);
        expect(body, 'vectorized entry should still inject via keyword path when its primary key is matched').toContain('VECTOR_LORE');
    });
});
