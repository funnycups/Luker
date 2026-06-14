// #111 — MG session-write floor anchor (commit 9663b9ce7)
//
// Bug shape: memory-graph session writes (the LLM tool surface used by
// orchestrator director / loop sub-agents) stamped both their per-node
// `seqTo` and their floor-state commit floor from `store.seqCounter`,
// which lagged by one turn during a director's post-draft execution.
// The commit also wiped the prior incremental log via replace-mode flush.
//
// Combined effect: records produced by memory_curator on turn N were
// written into a floor-state commit tagged at the previous turn's floor,
// with snapshot-from-empty patches that replaced the extraction log.
// Deleting message N afterwards left these records intact (commit's
// floor was below the deleted floor, so tail-truncate kept it), and the
// next regenerate at that slot re-injected the orphan records.
//
// Fix: `resolveInFlightAnchor(context)` derives `{ floor, turnSeq }`
// from the in-flight chat tail; `write-api.js::applyOne` and
// `deleteLinks` use `anchor.turnSeq` as the seqTo stamp;
// `main.js::commitSessionMutation` branches on the anchor and uses
// `commitMemoryStoreDiffByChatKey` (append-incremental at the in-flight
// floor) for the in-flight path.
//
// Regression lock: drive the public session API to write a node while
// a turn is in flight, then delete that turn's tail. The node should be
// gone (tail-truncated). Pre-fix the node would survive deletion.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({
        scriptedReplies: [
            '*Ash glances at the chart, brushing a strand of salt-bleached hair away.* "First watch is calm. The reef is whispering, not roaring."',
            '*She traces a line northward.* "Second watch, the gull rocks held. No drift signal yet."',
            '*A measured nod.* "Third watch. I marked a smudge on the south reef but it could be fog. I will note it."',
            '*She trims the lantern.* "Fourth watch — the wind shifted east. Drifters use east winds. We watch closer."',
            '*Her voice drops a register.* "Fifth watch. Something is moving past the gull rocks. Not skiffs. Bigger."',
        ],
    });
    server = await startServer({ batchKey: 'regression', scenarioId: 'mg-floor-anchor' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#111 — MG session-write anchors to in-flight floor; deletion truncates', () => {
    test.setTimeout(180_000);
    test.fixme('full director-mode reproduction needs real LLM to fire memory_curator at the right floor lag; ' +
        'unit-level coverage lives at tests/memory-graph/session-write-deletion-sync.test.js + session-commit-anchor.test.js. ' +
        'This e2e shell exercises the openSession API for shape parity but the bug-trigger condition (commit anchored ' +
        'BEHIND the in-flight floor) requires a director-mode extraction post-draft, not a manual session.createNode.',
        async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // Drive five turns so the chat has floors 0..4.
        for (const text of [
            'I climbed the cliff path at dusk before the lantern was lit.',
            'A gull called twice, then went silent — what does that mean to you?',
            'The wind has shifted; I think I see smoke over the southern reef.',
            'Should we walk down to the keeper before the watch changes?',
            'I will hold the lantern; you take the spyglass. Tell me what you see.',
        ]) {
            await sendMessageAndAwaitReply(page, text);
        }

        // 1. Snapshot chat length.
        const chatLenBefore = await page.evaluate(() => window.Luker.getContext().chat.length);
        expect(chatLenBefore, 'expected at least the greeting + 4 user/asst pairs after 5 sends').toBeGreaterThanOrEqual(8);

        // 2. Open a memory-graph session. Write a marker node tagged
        //    to the in-flight floor (the most recent assistant turn's
        //    floor). The post-fix behavior: this node's seqTo anchors to
        //    the in-flight turn so deleting that turn's tail truncates
        //    the node.
        const writeResult = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const mg = ctx.getExtensionApi && ctx.getExtensionApi('memory-graph');
            if (!mg || typeof mg.openSession !== 'function') {
                return { error: 'memory-graph openSession API not available' };
            }
            const session = await mg.openSession(ctx);
            if (!session) return { error: 'openSession returned null (no chat target?)' };
            let node;
            try {
                node = await session.createNode({
                    type: 'event',
                    title: 'REGRESSION-111-MARKER tail anchor',
                    fields: { summary: 'REGRESSION-111-MARKER placed at in-flight floor for deletion-sync test' },
                });
            } catch (err) {
                return { error: 'createNode threw: ' + String(err?.message || err) };
            }
            // Use the candidate listing as ground truth — listVisibleCandidates
            // returns nodes the recall stage would consider, and the marker
            // we just created lives at the in-flight floor so it should be
            // reachable.
            const cands = await session.listVisibleCandidates?.({});
            const candsJson = JSON.stringify((cands || []).slice(0, 5));
            return {
                nodeId: node?.id || null,
                candCount: cands?.length || 0,
                visibleMarker: !!(cands || []).some(n => candidateContainsMarker(n)),
                candsJson: candsJson.slice(0, 800),
            };

            function candidateContainsMarker(n) {
                if (!n || typeof n !== 'object') return false;
                const blob = JSON.stringify(n);
                return blob.includes('REGRESSION-111-MARKER');
            }
        });
        expect(writeResult.error, `MG session write setup error: ${writeResult.error}`).toBeUndefined();
        expect(writeResult.nodeId, 'session.createNode should return a node with an id').toBeTruthy();
        expect(writeResult.visibleMarker,
            `marker node should be visible to listVisibleCandidates after write. cands=${writeResult.candCount} sample=${writeResult.candsJson}`,
        ).toBe(true);

        // 3. Delete enough message tail to truncate past the floor the
        //    marker anchored to. `/cut last` removes the most recent
        //    message; cutting four messages here drops at least one
        //    complete user/assistant pair (one floor). The MESSAGE_DELETED
        //    handler then runs `applyMutationInvalidation` against the
        //    affected assistant seq, truncating any commits whose floor
        //    is >= the deleted floor.
        await page.evaluate(async () => {
            for (let i = 0; i < 4; i++) {
                await window.Luker.getContext().executeSlashCommandsWithOptions('/cut last');
            }
        });
        // Give the async invalidation a moment to settle (the
        // MESSAGE_DELETED listener is async).
        await page.waitForTimeout(800);

        // 4. Re-open a session and verify the marker is gone via the same
        //    candidate listing.
        const afterDelete = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const mg = ctx.getExtensionApi && ctx.getExtensionApi('memory-graph');
            const session = await mg.openSession(ctx);
            if (!session) return { error: 'openSession returned null after delete' };
            const cands = await session.listVisibleCandidates({}) || [];
            return {
                listedNow: cands.length,
                stillHasMarker: cands.some(n => JSON.stringify(n || {}).includes('REGRESSION-111-MARKER')),
                candsJson: JSON.stringify(cands.slice(0, 5)).slice(0, 800),
            };
        });
        expect(afterDelete.error, `post-delete session error: ${afterDelete.error}`).toBeUndefined();
        expect(afterDelete.stillHasMarker,
            'marker node should be tail-truncated after the in-flight turn is deleted (commit 9663b9ce7); ' +
            `if it survives, session writes are anchoring to the lagging seqCounter again. cands=${afterDelete.listedNow} sample=${afterDelete.candsJson}`,
        ).toBe(false);
    });
});
