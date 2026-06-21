// #63 — Rollback one turn → state restored, verified through the flask panel.
//
// The var-op-log doubles as a chat-rollback mechanism: deleting an
// assistant message via the real pencil → trash flow triggers
// MESSAGE_DELETED, which the index.js listener answers with
// rebuildVariablesFromChat. That walks the surviving chat's var_ops in
// order and writes the replayed values onto chat_metadata.variables.
//
// Scenario: three consecutive assistant turns each setvar `count`:
//   turn 1 → count=1
//   turn 2 → count=2
//   turn 3 → count=3
//
// Then deleteMessageViaUI on the most-recent assistant message rolls back
// the most-recent turn. The replayed state should reflect `count=2`.
// Deleting again should reflect `count=1`. Finally restart the server and
// verify the rebuilt state survives.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    reloadAndAwait,
    deleteMessageViaUI,
} from '../_lib/page.js';
import { openVarOpsPanel, getRenderedVarOpsRows } from '../_lib/ui-mg-varops.js';

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

test.describe('#63 — Rollback one turn → state restored (real delete-message UI)', () => {
    test('delete last assistant turn via trash icon; rebuild reflects the previous turn count; persists across restart', async ({ page }) => {
        test.setTimeout(240_000);
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // The delete-message UI shows a confirm popup when
        // power_user.confirm_message_delete is true (the default). Flip it
        // off so deleteMessageViaUI's MESSAGE_DELETED listener resolves
        // without an extra OK click.
        await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            if (ctx.powerUserSettings) ctx.powerUserSettings.confirm_message_delete = false;
        });
        const cmd = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return { confirm: ctx.powerUserSettings?.confirm_message_delete, hasPus: !!ctx.powerUserSettings };
        });
        console.log(`SPEC63 confirm_message_delete=${JSON.stringify(cmd)}`);

        // ── Three turns, each setting count=n ─────────────────────────
        const replyIds = [];
        for (const text of [
            'Tally one for the first watch.',
            'Tally two when the wind shifts.',
            'Tally three at the third bell.',
        ]) {
            const { replyId } = await sendMessageAndAwaitReply(page, text);
            await page.waitForFunction((id) => {
                const ctx = window.Luker.getContext();
                const m = ctx.chat?.[id];
                return Boolean(m && Array.isArray(m?.extra?.var_ops) && m.extra.var_ops.length > 0);
            }, replyId, { timeout: 15_000 });
            replyIds.push(replyId);
        }

        const initial = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return {
                count: ctx.chatMetadata?.variables?.count ?? null,
                chatLen: ctx.chat.length,
            };
        });
        expect(Number(initial.count), 'count is 3 after three turns').toBe(3);

        // ── Delete the last (assistant) message via the REAL trash icon ─
        await deleteMessageViaUI(page, replyIds[2]);

        // MESSAGE_DELETED fired → rebuild listener swept the surviving ops.
        // Wait until the chat length drops and the rebuild reseats `count`.
        // Capture state after a brief settle so we can introspect even if
        // rebuild doesn't fire as expected.
        await page.waitForTimeout(500);
        const postDeleteState = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return {
                chatLen: ctx.chat?.length,
                count: ctx.chatMetadata?.variables?.count,
                varKeys: Object.keys(ctx.chatMetadata?.variables || {}),
                chatTail: (ctx.chat || []).slice(-3).map(m => ({
                    is_user: m?.is_user,
                    mes_preview: String(m?.mes || '').slice(0, 60),
                    var_ops_count: Array.isArray(m?.extra?.var_ops) ? m.extra.var_ops.length : null,
                    var_ops: Array.isArray(m?.extra?.var_ops) ? m.extra.var_ops.slice(0, 3) : null,
                })),
            };
        });
        console.log('SPEC63 postDelete:', JSON.stringify(postDeleteState));

        await page.waitForFunction((prev) => {
            const ctx = window.Luker.getContext();
            return ctx.chat.length === prev - 1
                && Number(ctx.chatMetadata?.variables?.count) === 2;
        }, initial.chatLen, { timeout: 15_000 });

        const after1 = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return {
                count: ctx.chatMetadata?.variables?.count ?? null,
                chatLen: ctx.chat.length,
            };
        });
        expect(after1.chatLen, 'delete removed one message').toBe(initial.chatLen - 1);
        expect(Number(after1.count), 'rebuild yields the previous turn value').toBe(2);

        // Open the flask panel on the surviving assistant (turn 2) and
        // confirm its count=2 row in rendered DOM — this is the
        // user-visible rollback inspection surface.
        await openVarOpsPanel(page, replyIds[1]);
        const turn2Rows = await getRenderedVarOpsRows(page);
        expect(turn2Rows).toEqual([
            { op: 'setvar', key: 'count', value: '2', path: '' },
        ]);
        await page.locator('.popup:visible .popup-button-cancel').last().click().catch(() => {});
        await page.locator('.var-ops-panel').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});

        // Also expose via the public context API — same data, different surface.
        const viaContextApi = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return String(ctx.variables.local.get('count'));
        });
        expect(Number(viaContextApi)).toBe(2);

        // Delete the now-tail user message (so we can delete the next
        // assistant down and roll back to count=1).
        await deleteMessageViaUI(page, after1.chatLen - 1);
        await page.waitForFunction((prev) => {
            const ctx = window.Luker.getContext();
            return ctx.chat.length === prev - 1;
        }, after1.chatLen, { timeout: 15_000 });

        // Delete the count=2 assistant.
        const after1Chat = await page.evaluate(() => window.Luker.getContext().chat.length);
        await deleteMessageViaUI(page, after1Chat - 1);
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Number(ctx.chatMetadata?.variables?.count) === 1;
        }, null, { timeout: 15_000 });

        const after2 = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return {
                count: ctx.chatMetadata?.variables?.count ?? null,
                chatLen: ctx.chat.length,
            };
        });
        expect(Number(after2.count), 'further rollback to first turn yields count=1').toBe(1);

        // Let the relaxed chat-save debounce (1000ms) flush to disk
        // before cycling the server. Mirrors a real user pausing briefly.
        await page.waitForTimeout(1200);

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
            return ctx.chatMetadata?.variables?.count ?? null;
        });
        expect(Number(afterRestart), 'count survives restart at rolled-back value').toBe(1);
    });
});
