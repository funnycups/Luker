// #66 — variable-op-log e2e: structured-roster scenario through real flow.
//
// Six turns mutate `roster.<who>.<field>` via embedded macros. Then we
// delete the last assistant turn via the real trash icon. MESSAGE_DELETED
// triggers a full rebuild from the surviving var_ops — Alice's hp falls
// back to 50, inventory unchanged. Each turn the flask panel shows the
// turn's ops in rendered rows.
//
// Then restart the server. The chat JSONL header re-parses, CHAT_CHANGED
// fires, rebuild reruns against the persisted ops, and the materialized
// state reproduces the post-delete snapshot.

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

const REPLIES = [
    '*Seraphina gestures at the tally slate.* "Alice joined the watch at the second bell." {{setvar::roster.alice.hp::50}}',
    '*A scrape on the floor; Alice straightens.* "Took the sword from the rack." {{pushvar::roster.alice.inv::sword}}',
    '*The leather strap creaks.* "And the shield from the lower hook." {{pushvar::roster.alice.inv::shield}}',
    '*A clatter; Alice grimaces.* "Dropped the shield. The strap broke clean." {{popvar::roster.alice.inv}}',
    '*Footsteps on the stair.* "Bob came up with the second lantern." {{setvar::roster.bob.hp::30}}',
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
    test('six structured mutations render correctly per turn; delete prunes one op; survives restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // Disable delete-confirmation so deleteMessageViaUI does not need
        // to chase a second OK click.
        await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            if (ctx.powerUserSettings) ctx.powerUserSettings.confirm_message_delete = false;
        });

        // ── Six turns, asserting the flask panel matches each turn's op ─
        const expectedOps = [
            { op: 'setvar', key: 'roster', value: '50', path: 'alice.hp' },
            { op: 'pushvar', key: 'roster', value: 'sword', path: 'alice.inv' },
            { op: 'pushvar', key: 'roster', value: 'shield', path: 'alice.inv' },
            { op: 'popvar', key: 'roster', value: '', path: 'alice.inv' },
            { op: 'setvar', key: 'roster', value: '30', path: 'bob.hp' },
            { op: 'setvar', key: 'roster', value: '40', path: 'alice.hp' },
        ];
        const replyIds = [];
        for (let i = 0; i < TURN_PROMPTS.length; i++) {
            const { replyId } = await sendMessageAndAwaitReply(page, TURN_PROMPTS[i]);
            await page.waitForFunction((id) => {
                const ctx = window.Luker.getContext();
                const m = ctx.chat?.[id];
                return Boolean(m && Array.isArray(m?.extra?.var_ops) && m.extra.var_ops.length > 0);
            }, replyId, { timeout: 15_000 });
            replyIds.push(replyId);

            await openVarOpsPanel(page, replyId);
            const rows = await getRenderedVarOpsRows(page);
            expect(rows.length, `turn ${i + 1} panel shows one row`).toBe(1);
            expect(rows[0]).toEqual(expectedOps[i]);
            await page.locator('.popup:visible .popup-button-cancel').last().click().catch(() => {});
            await page.locator('.var-ops-panel').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
        }

        // State should reflect every op forward-applied.
        const afterAll = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return ctx.chatMetadata?.variables?.roster ?? null;
        });
        expect(afterAll, 'roster persisted as JSON string').toBeTruthy();
        expect(JSON.parse(afterAll)).toEqual({
            alice: { hp: 40, inv: ['sword'] },
            bob: { hp: 30 },
        });

        // ── Delete the last (assistant) turn via the REAL trash icon ─
        const lastReplyId = replyIds[replyIds.length - 1];
        await deleteMessageViaUI(page, lastReplyId);
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            const roster = ctx.chatMetadata?.variables?.roster;
            if (!roster) return false;
            try {
                const parsed = JSON.parse(roster);
                return parsed?.alice?.hp === 50;
            } catch { return false; }
        }, null, { timeout: 15_000 });

        const afterCut = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return JSON.parse(ctx.chatMetadata?.variables?.roster ?? 'null');
        });
        expect(afterCut).toEqual({
            alice: { hp: 50, inv: ['sword'] },
            bob: { hp: 30 },
        });

        // ── Restart and verify state is reproducible from disk ───────
        // Persistence is checked via reload-from-disk below, not via raw
        // header inspection: chat patch may rewrite messages without
        // immediately rewriting the metadata header on disk, but reload
        // is the path a real user takes — re-reading the JSONL surfaces
        // the same state the user would see on next session.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await page.waitForFunction(() => {
            const ctx = window.Luker?.getContext?.();
            return Array.isArray(ctx?.chat) && ctx.chat.length > 0;
        }, { timeout: 15_000 });

        const afterRestart = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return JSON.parse(ctx.chatMetadata?.variables?.roster ?? 'null');
        });
        expect(afterRestart).toEqual({
            alice: { hp: 50, inv: ['sword'] },
            bob: { hp: 30 },
        });
    });
});
