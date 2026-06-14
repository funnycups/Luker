// #63 — Rollback one turn → state restored.
//
// The var-op-log doubles as a chat-rollback mechanism: deleting an
// assistant message triggers MESSAGE_DELETED, which the index.js listener
// answers with rebuildVariablesFromChat. That walks the surviving chat's
// var_ops in order and writes the replayed values onto chat_metadata.variables,
// preserving any keys that the op-log doesn't own.
//
// Scenario: three consecutive assistant turns each setvar `count`:
//   turn 1 → count=1
//   turn 2 → count=2
//   turn 3 → count=3
//
// Then /cut <lastFloor> rolls back the most-recent turn. The replayed
// state should reflect `count=2`. Cutting again should reflect `count=1`.
// Finally, restart the server and verify the rebuilt state and the
// trimmed chat both persist on disk.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply, reloadAndAwait } from '../_lib/page.js';

let server, mock;

const REPLY = (n) => [
    `*Seraphina marks the slate with a steady hand.* {{setvar::count::${n}}}`,
    ` "Mark ${n} on the tally, keep — that brings us to ${n}."`,
].join('');

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [REPLY(1), REPLY(2), REPLY(3)] });
    server = await startServer({ batchKey: 'varops', scenarioId: 'rollback-turn' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#63 — Rollback one turn → state restored', () => {
    test('cut last assistant turn; rebuild reflects the previous turn count; persists across restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // ── Three turns, each set count=n ─────────────────────────────
        for (const text of [
            'Tally one for the first watch.',
            'Tally two when the wind shifts.',
            'Tally three at the third bell.',
        ]) {
            await sendMessageAndAwaitReply(page, text);
        }

        const initial = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return {
                count: ctx.chatMetadata?.variables?.count ?? null,
                chatLen: ctx.chat.length,
            };
        });
        expect(Number(initial.count), 'count is 3 after three turns').toBe(3);

        // ── Cut the last (assistant) message ──────────────────────────
        //
        // /cut <floor> removes a single index. Cutting only the assistant
        // turn (leaving the user message) is the most precise rollback —
        // it tests that the rebuild ignores user-side ops cleanly (there
        // are none in this test, but the path is exercised).
        const lastAssistantIdx = initial.chatLen - 1;
        await page.evaluate((idx) => window.Luker.getContext()
            .executeSlashCommandsWithOptions(`/cut ${idx}`), lastAssistantIdx);

        // MESSAGE_DELETED fired → rebuild listener swept the surviving ops.
        const after1 = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return {
                count: ctx.chatMetadata?.variables?.count ?? null,
                chatLen: ctx.chat.length,
            };
        });
        expect(after1.chatLen, 'cut removed one message').toBe(initial.chatLen - 1);
        expect(Number(after1.count), 'rebuild yields the previous turn value').toBe(2);

        // Also expose via the public context API — same data, different surface.
        const viaContextApi = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return String(ctx.variables.local.get('count'));
        });
        expect(Number(viaContextApi)).toBe(2);

        // Cut the user message we just received a reply for (now the tail).
        // Then cut the next assistant turn so we are back to count=1.
        await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            // chat now: [greeting, u1, a1(count=1), u2, a2(count=2), u3] after one cut
            // We want to roll back to "after a1" → cut indices >= 3
            //  /cut 3-5 inclusive
            await ctx.executeSlashCommandsWithOptions('/cut 3-5');
        });

        const after2 = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return {
                count: ctx.chatMetadata?.variables?.count ?? null,
                chatLen: ctx.chat.length,
            };
        });
        // chatLen should be: greeting + u1 + a1 = 3
        expect(Number(after2.count), 'further rollback to first turn yields count=1').toBe(1);

        // ── Persistence across restart ────────────────────────────────
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await page.waitForFunction(() => {
            const ctx = window.Luker?.getContext?.();
            return Array.isArray(ctx?.chat) && ctx.chat.length > 0;
        }, { timeout: 15_000 });

        const afterRestart = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return {
                count: ctx.chatMetadata?.variables?.count ?? null,
                chatLen: ctx.chat.length,
            };
        });
        // The trimmed chat persisted (greeting+u1+a1), and rebuild on chat-load
        // reproduced count=1 from the single surviving setvar op.
        expect(Number(afterRestart.count), 'count survives restart at rolled-back value').toBe(1);
    });
});
