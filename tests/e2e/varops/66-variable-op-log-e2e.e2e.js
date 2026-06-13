// #66 — variable-op-log e2e: re-implement the load-bearing roster case in real flow.
//
// The jest `tests/variable-op-log/integration.test.js` proves the
// extractor + rebuilder semantics with pure-data fixtures. The structured-
// object scenario (`'AI mutates roster across turns; deleting a message
// prunes only that op'`) is the one that exercises the most surface:
// pushvar on a structured path, popvar, setvar on a deep numeric leaf,
// and a deletion-triggered rebuild that re-replays surviving ops over a
// fresh state.
//
// This e2e re-runs that scenario through a real Luker server with real
// chat persistence:
//
//   Turn 1 — Alice joins: setvar roster.alice.hp = 50
//   Turn 2 — Alice picks up a sword: pushvar roster.alice.inv = sword
//   Turn 3 — Alice picks up a shield: pushvar roster.alice.inv = shield
//   Turn 4 — Alice drops a thing: popvar roster.alice.inv
//   Turn 5 — Bob joins: setvar roster.bob.hp = 30
//   Turn 6 — Alice was hit: setvar roster.alice.hp = 40
//
// State after turn 6: { alice: { hp: 40, inv: ['sword'] }, bob: { hp: 30 } }
//
// Delete the last assistant turn (the "Alice was hit" one). MESSAGE_DELETED
// triggers a full rebuild from surviving var_ops — Alice's hp should fall
// back to 50, inventory unchanged.
//
// Then restart the server and re-load the chat. The chat JSONL header is
// re-parsed, CHAT_CHANGED fires, the rebuilder runs once more against the
// persisted ops, and the materialized state must reproduce the post-delete
// snapshot. This is the persistence guarantee that pure jest tests cannot
// verify.

import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply, reloadAndAwait } from '../_lib/page.js';

let server, mock;

const REPLIES = [
    // Turn 1
    '*Seraphina gestures at the tally slate.* "Alice joined the watch at the second bell." {{setvar::roster.alice.hp::50}}',
    // Turn 2
    '*A scrape on the floor; Alice straightens.* "Took the sword from the rack." {{pushvar::roster.alice.inv::sword}}',
    // Turn 3
    '*The leather strap creaks.* "And the shield from the lower hook." {{pushvar::roster.alice.inv::shield}}',
    // Turn 4
    '*A clatter; Alice grimaces.* "Dropped the shield. The strap broke clean." {{popvar::roster.alice.inv}}',
    // Turn 5
    '*Footsteps on the stair.* "Bob came up with the second lantern." {{setvar::roster.bob.hp::30}}',
    // Turn 6
    '*A wince, a hand to the ribs.* "Alice took a knock at the third breaker — forty by the slate now." {{setvar::roster.alice.hp::40}}',
];

const TURN_PROMPTS = [
    'Mark Alice on the roster — the second bell just rang.',
    'She is taking the sword?',
    'And the shield as well?',
    'What happened to the shield?',
    'Has Bob come up yet?',
    'How is Alice after the breaker?',
];

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [...REPLIES] });
    server = await startServer({ batchKey: 'varops', scenarioId: 'roster-replay' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#66 — variable-op-log e2e (roster across turns; delete; persist)', () => {
    test('six structured mutations replay correctly; delete prunes one op; survives restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await page.waitForFunction(() => {
            const ctx = window.SillyTavern.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // ── Six turns ─────────────────────────────────────────────────
        for (const prompt of TURN_PROMPTS) {
            await sendMessageAndAwaitReply(page, prompt);
        }

        // State should reflect every op forward-applied.
        const afterAll = await page.evaluate(() => {
            const ctx = window.SillyTavern.getContext();
            return ctx.chatMetadata?.variables?.roster ?? null;
        });
        expect(afterAll, 'roster persisted as JSON string').toBeTruthy();
        expect(JSON.parse(afterAll)).toEqual({
            alice: { hp: 40, inv: ['sword'] },
            bob: { hp: 30 },
        });

        // Every assistant floor should carry exactly one op (each reply has one macro).
        const opsPerFloor = await page.evaluate(() => {
            const ctx = window.SillyTavern.getContext();
            return ctx.chat
                .filter(m => !m.is_user)
                .map(m => m?.extra?.var_ops ?? []);
        });
        const recordedOps = opsPerFloor.flat();
        expect(recordedOps).toEqual([
            // First assistant message is the greeting; no ops. Ops below are the six turns.
            { op: 'setvar', key: 'roster', path: 'alice.hp', value: '50' },
            { op: 'pushvar', key: 'roster', path: 'alice.inv', value: 'sword' },
            { op: 'pushvar', key: 'roster', path: 'alice.inv', value: 'shield' },
            { op: 'popvar', key: 'roster', path: 'alice.inv' },
            { op: 'setvar', key: 'roster', path: 'bob.hp', value: '30' },
            { op: 'setvar', key: 'roster', path: 'alice.hp', value: '40' },
        ]);

        // ── Delete the last (assistant) turn — Alice was hit ─────────
        const tailLen = await page.evaluate(() => window.SillyTavern.getContext().chat.length);
        await page.evaluate((idx) => window.SillyTavern.getContext()
            .executeSlashCommandsWithOptions(`/cut ${idx}`), tailLen - 1);

        const afterCut = await page.evaluate(() => {
            const ctx = window.SillyTavern.getContext();
            return JSON.parse(ctx.chatMetadata?.variables?.roster ?? 'null');
        });
        // After delete, the "Alice was hit" op is gone → rebuild replays
        // every remaining op against {}; Alice's hp falls back to 50.
        // Inventory unchanged because none of the inv ops were deleted.
        expect(afterCut).toEqual({
            alice: { hp: 50, inv: ['sword'] },
            bob: { hp: 30 },
        });

        // ── Persistence: on-disk header has the post-delete state ────
        const avatarFolder = await page.evaluate(() => {
            const ctx = window.SillyTavern.getContext();
            return (ctx.characters[ctx.characterId]?.avatar || '').replace(/\.png$/, '');
        });
        // Force a save so the disk file reflects the post-cut state.
        await page.evaluate(() => window.SillyTavern.getContext().saveChat());
        const chatId = await page.evaluate(() => window.SillyTavern.getContext().getCurrentChatId());
        const chatDir = resolve(server.dataRoot, 'default-user', 'chats', avatarFolder);
        const files = readdirSync(chatDir).filter(f => f.endsWith('.jsonl'));
        expect(files.length).toBeGreaterThan(0);
        const targetFile = chatId && files.includes(`${chatId}.jsonl`) ? `${chatId}.jsonl` : files[0];
        const header = JSON.parse(readFileSync(resolve(chatDir, targetFile), 'utf8').split('\n')[0]);
        expect(JSON.parse(header?.chat_metadata?.variables?.roster ?? 'null')).toEqual({
            alice: { hp: 50, inv: ['sword'] },
            bob: { hp: 30 },
        });

        // ── Restart and verify state is reproducible from disk ───────
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await page.waitForFunction(() => {
            const ctx = window.SillyTavern?.getContext?.();
            return Array.isArray(ctx?.chat) && ctx.chat.length > 0;
        }, { timeout: 15_000 });

        const afterRestart = await page.evaluate(() => {
            const ctx = window.SillyTavern.getContext();
            return JSON.parse(ctx.chatMetadata?.variables?.roster ?? 'null');
        });
        expect(afterRestart).toEqual({
            alice: { hp: 50, inv: ['sword'] },
            bob: { hp: 30 },
        });

        // var_ops records also survive (the per-message log).
        const opsAfterRestart = await page.evaluate(() => {
            const ctx = window.SillyTavern.getContext();
            return ctx.chat
                .filter(m => !m.is_user)
                .map(m => m?.extra?.var_ops ?? [])
                .flat();
        });
        expect(opsAfterRestart).toEqual([
            { op: 'setvar', key: 'roster', path: 'alice.hp', value: '50' },
            { op: 'pushvar', key: 'roster', path: 'alice.inv', value: 'sword' },
            { op: 'pushvar', key: 'roster', path: 'alice.inv', value: 'shield' },
            { op: 'popvar', key: 'roster', path: 'alice.inv' },
            { op: 'setvar', key: 'roster', path: 'bob.hp', value: '30' },
        ]);
    });
});
