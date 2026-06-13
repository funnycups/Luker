// tests/e2e/memorygraph/53-session-write-floor-anchor.e2e.js
//
// #53 — Regression lock for `known_bug_mg_session_write_floor` (fixed
// 2026-05-28 in 9663b9ce7).
//
// Pre-fix, MG session writes (the surface used by orchestrator director /
// loop sub-agents) stamped the floor-state commit at
// `seqToFloor(store.seqCounter)` — which lags by one turn during the
// director's post-draft execution — and used replace-mode flush. Combined:
// records written by `memory_curator` on turn N ended up tagged at
// floor < N AND wiped the prior extraction log; deleting message N left
// these records intact.
//
// The fix routes session writes through `resolveInFlightAnchor(context)` →
// stamp `seqTo = anchor.turnSeq` → diff-mode commit at the in-flight floor.
// Now deleting the floor where session writes landed truncates them
// along with the assistant turn.
//
// This test pins that contract: write 3 MG nodes inside the current
// chat tail's anchor, delete the last assistant message, assert the
// nodes are gone (truncated alongside the floor). Pre-fix would have
// left them as orphans.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply, deleteLastMessage } from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Seraphina folds the chart and meets your eyes.* "The lantern will hold."',
        '*She traces a line on the chart with one knuckle.* "Breakers north of the gulls."',
        '*Seraphina exhales slowly.* "The drifters know that channel better than we do."',
        '*She turns to the rail, spyglass raised.* "Hold. Don\'t speak for a moment."',
        '*Seraphina nods once.* "Then it is decided. We wait."',
    ] });
    server = await startServer({ batchKey: 'memorygraph', scenarioId: 'floor-anchor' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#53 — session-write floor anchor (FIXED 2026-05-28)', () => {
    test.fixme(
        'reproducing the bug-trigger condition requires a director-mode extraction ' +
        'firing post-draft with a lagging seqCounter, which manual session.createNode ' +
        'from outside the chat-completion flow can\'t reliably reproduce against a mock LLM. ' +
        'Unit-level coverage at tests/memory-graph/session-write-deletion-sync.test.js + ' +
        'session-commit-anchor.test.js. The regression-batch mirror at ' +
        'tests/e2e/regression/111-mg-session-write-floor-anchor.e2e.js is also fixmed for ' +
        'the same reason.',
        async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // 5 RP turns so the chat tail anchor is non-trivial.
        for (const t of [
            'The first watch begins. The lantern is steady.',
            'A skiff drifted south of the gull rocks an hour ago.',
            'The reef sounds different tonight — slower, like breath.',
            'I think the drifters are coming back along the old salt-mark.',
            'Hold the watch. I will fetch the chart.',
        ]) {
            await sendMessageAndAwaitReply(page, t);
        }

        const seeded = await page.evaluate(async () => {
            const ctx = window.SillyTavern.getContext();
            const settings = ctx.extensionSettings?.memory_graph;
            if (settings) settings.enabled = true;
            const mgApi = ctx.getExtensionApi?.('memory-graph');
            const session = await mgApi?.openSession?.(ctx);
            if (!session) return { ok: false, reason: 'no session' };

            // The chat's tail at write time IS the anchor. Whatever floor
            // these land at must follow the in-flight tail, not the lagged
            // seqCounter.
            const ids = [];
            const a = await session.createNode({ type: 'event', title: 'tail-anchor-event-1', fields: { summary: '时间：第五幕；user 准备去取最新的潮汐图。' } });
            ids.push(a.id);
            const b = await session.createNode({ type: 'character_sheet', title: 'TailAnchorChar', fields: { title: 'TailAnchorChar', identity: '盐礁夜间巡视员；同样要等到天亮才能确认涌动来源。' } });
            ids.push(b.id);
            const c = await session.createNode({ type: 'location_state', title: 'TailAnchorPost', fields: { title: 'TailAnchorPost', state: '夜风骤起；信号灯被风吹斜。', controller: 'Seraphina' } });
            ids.push(c.id);

            // Capture the per-node `seqTo` so we can assert the in-flight
            // anchor stamped non-zero values (pre-fix landed at lagged seq).
            const beforeDelete = session.listVisibleCandidates({});
            return {
                ok: true,
                ids,
                beforeDelete: beforeDelete.map(n => ({ id: n.id, type: n.type, title: n.title, seqTo: n.seqTo })),
                chatLen: ctx.chat.length,
            };
        });
        expect(seeded.ok, JSON.stringify(seeded)).toBe(true);
        expect(seeded.ids).toHaveLength(3);
        // Every seeded node must visibly come back in listVisibleCandidates.
        for (const id of seeded.ids) {
            expect(seeded.beforeDelete.find(n => n.id === id), `node ${id} missing pre-delete`).toBeTruthy();
        }
        // Per the in-flight-anchor fix, seqTo for newly created nodes is
        // pegged at the current tail's assistant seq — never 0.
        for (const node of seeded.beforeDelete.filter(n => seeded.ids.includes(n.id))) {
            expect(node.seqTo, `node ${node.id} (${node.title}) should have a positive seqTo from the in-flight anchor`).toBeGreaterThan(0);
        }

        // Delete the last assistant message (which IS the floor at the
        // anchor used above). Under the fix, the floor-state log truncates
        // commits at floor >= deleted-floor, which removes our 3 session
        // writes alongside it.
        await deleteLastMessage(page);
        // Give MG's CHAT_CHANGED / MESSAGE_DELETED listeners a beat to
        // settle before we re-open the session.
        await page.waitForFunction(
            (prev) => window.SillyTavern.getContext().chat.length === prev - 1,
            seeded.chatLen,
            { timeout: 10_000 },
        ).catch(() => { /* fall through and let the assertion surface the gap */ });
        // Then nudge the load by re-opening the session.
        const afterDelete = await page.evaluate(async () => {
            const ctx = window.SillyTavern.getContext();
            // Force the cached MG store to drop so the next openSession
            // re-loads from the (now-truncated) log on disk.
            const mod = await import('/scripts/extensions/memory-graph/main.js').catch(() => null);
            try {
                if (mod?.invalidateMemoryStoreCache) mod.invalidateMemoryStoreCache();
            } catch {}
            const mgApi = ctx.getExtensionApi?.('memory-graph');
            const session = await mgApi?.openSession?.(ctx);
            if (!session) return { ok: false };
            const visible = session.listVisibleCandidates({});
            return {
                ok: true,
                chatLen: ctx.chat.length,
                nodes: visible.map(n => ({ id: n.id, title: n.title, seqTo: n.seqTo })),
            };
        });
        expect(afterDelete.ok).toBe(true);
        expect(afterDelete.chatLen).toBe(seeded.chatLen - 1);

        // The CORE regression check: after deleting the floor, the session-
        // written nodes are gone. Pre-fix would have left orphans (the bug
        // was that they had been stamped at floor < tail, and the
        // replace-mode flush wiped extraction-pipeline commits but left
        // session-write commits intact).
        const survivingTargetIds = afterDelete.nodes.map(n => n.id).filter(id => seeded.ids.includes(id));
        expect(
            survivingTargetIds,
            `expected session-written nodes to truncate with the deleted floor, but these survived: ${JSON.stringify(survivingTargetIds)}`,
        ).toEqual([]);
    });
});
