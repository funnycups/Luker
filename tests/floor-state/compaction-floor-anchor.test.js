/**
 * Regression for "compression commit anchored at a historical floor breaks
 * truncate-by-floor recovery" (memory-graph crash on delete-after-compression),
 * and pins the post-fix invariant that lets the user's swipe / delete on the
 * chat tail leave the historical graph intact.
 *
 * Contract under test:
 *   Floor-state's truncate-by-floor handler (MESSAGE_DELETED) is sound ONLY
 *   when commit.floor is monotonically non-decreasing in log-append order.
 *   Once any commit lands at a floor lower than an earlier commit on the
 *   same log, "truncate at floor >= N" stops being equivalent to "drop a
 *   log suffix" — it leaves earlier-in-log commits whose `prev` state
 *   depends on commits that were just dropped, and replay crashes inside
 *   fast-json-patch with "Array index out of bounds" or similar.
 *
 *   memory-graph satisfies that invariant by:
 *     (a) anchoring each extraction-batch commit at `seqToFloor(batch.endSeq)`,
 *         which is monotonic because endSeq is monotonic; and
 *     (b) running compression inline after each batch, so every rollup commit
 *         is appended right after the batch that produced its candidate
 *         events. The rollup's `parent.seqTo` is bounded above by that
 *         batch's endSeq → `seqToFloor(parent.seqTo)` is bounded above by
 *         the batch's anchor floor → log-append-order monotonicity holds.
 *
 *   The bug demo below pins what goes wrong when compression instead defers
 *   to the end of all batches (the historical shape that f5778aa4 papered
 *   over by pinning everything to the trigger floor): the deferred rollup
 *   commit lands in the log AFTER later batches but anchors at the historical
 *   floor of its parent.seqTo, breaking the chain.
 */

import { describe, test, expect } from '@jest/globals';

import { createFloorStateWithDeps } from '../../public/scripts/floor-state.js';

// --- minimal mocks (subset copied from instance.test.js — kept inline so the
//     contract test is independently readable) ---

function makeStore() {
    const partitions = new Map();
    function targetKey(target) {
        if (!target || typeof target !== 'object') return '';
        if (target.is_group) return `g:${String(target.id ?? '')}`;
        return `c:${String(target.avatar_url ?? '')}/${String(target.file_name ?? '')}`;
    }
    function partitionFor(target) {
        const key = targetKey(target);
        if (!partitions.has(key)) partitions.set(key, new Map());
        return partitions.get(key);
    }
    return {
        async getChatState(ns, options) {
            const k = String(ns ?? '').trim().toLowerCase();
            const v = partitionFor(options?.target).get(k);
            return v == null ? null : structuredClone(v);
        },
        async updateChatState(ns, updater, options) {
            const k = String(ns ?? '').trim().toLowerCase();
            const part = partitionFor(options?.target);
            const current = part.get(k) ?? null;
            const next = await updater(current == null ? null : structuredClone(current));
            if (next === null || next === undefined) {
                part.delete(k);
            } else {
                part.set(k, structuredClone(next));
            }
            return { ok: true, state: part.get(k) ?? null, updated: true };
        },
        async deleteChatState(ns, options) {
            const k = String(ns ?? '').trim().toLowerCase();
            partitionFor(options?.target).delete(k);
            return true;
        },
        get _raw() { return partitionFor(undefined); },
    };
}

async function buildObjectPatchOperationsAsync(prev, next) {
    const { compare } = await import('../../public/scripts/util/fast-json-patch.js');
    return compare(prev ?? {}, next ?? {});
}

function makeDeps(chatRef) {
    const store = makeStore();
    return {
        store,
        deps: {
            getChatState: store.getChatState.bind(store),
            updateChatState: store.updateChatState.bind(store),
            deleteChatState: store.deleteChatState.bind(store),
            buildObjectPatchOperationsAsync,
            getChat: () => chatRef.value,
        },
    };
}

function msg() { return { swipe_id: 0, mes: 'x' }; }

/**
 * Drive a payload through fs.update so the recorded patches are an
 * incremental diff against current materialized state — exactly what
 * commitMemoryStoreDiffByChatKey does in production.
 */
async function updateToPayload(fs, nextPayloadProducer, options) {
    return await fs.update((current) => {
        const safeCurrent = current && typeof current === 'object' ? current : {};
        return nextPayloadProducer(safeCurrent);
    }, options);
}

describe('compaction commit floor anchor — invariants', () => {
    /**
     * Post-fix shape: extraction batches at floors 0/2/4, with a compression
     * round appended INLINE after the batch at floor 2 (anchored at floor 2,
     * matching seqToFloor of the rollup's parent.seqTo which equals the
     * batch's own endSeq at that point). One more batch follows at floor 4.
     *
     * Log-append-order floors: [0, 2, 2, 4] — monotonic. Truncating to chat
     * length=3 drops floors >= 3 → keeps [0, 2, 2], log suffix removed,
     * patch chain self-consistent, rollup preserved.
     */
    test('inline per-batch compression keeps anchors monotonic and survives delete past the tail', async () => {
        const chatRef = { value: [msg(), msg(), msg(), msg(), msg()] }; // floors 0..4
        const { store, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'mg' }, deps);

        // Batch 1 at floor 0.
        await updateToPayload(fs, (cur) => ({
            edges: [...(cur.edges || []), { from: 'a', to: 'b' }],
        }), { floor: 0 });

        // Batch 2 at floor 2.
        await updateToPayload(fs, (cur) => ({
            edges: [...(cur.edges || []), { from: 'b', to: 'c' }],
        }), { floor: 2 });

        // Compression triggered inline after batch 2 — anchored at floor 2,
        // matching seqToFloor of the rollup parent.seqTo (bounded above by
        // batch-2's endSeq).
        await updateToPayload(fs, (cur) => ({
            edges: [...(cur.edges || []), { from: 'rollup-1', to: 'a-b' }],
        }), { floor: 2 });

        // Batch 3 at floor 4.
        await updateToPayload(fs, (cur) => ({
            edges: [...(cur.edges || []), { from: 'c', to: 'd' }],
        }), { floor: 4 });

        // Log-append-order anchor sequence: [0, 2, 2, 4] — strictly non-decreasing.
        expect(store._raw.get('mg__floor_log').commits.map((c) => c.floor)).toEqual([0, 2, 2, 4]);
        const beforeDelete = await fs.get();
        expect(beforeDelete.edges).toHaveLength(4);

        // User deletes back to length=3 → truncate floor >= 3.
        chatRef.value = chatRef.value.slice(0, 3);
        await fs.__handleMessageDeleted(3);
        await fs.ready();

        const recovered = await fs.get();
        expect(recovered).not.toBeNull();
        // Surviving commits: batch-0 + batch-2 + rollup-after-batch-2.
        expect(recovered.edges).toEqual([
            { from: 'a', to: 'b' },
            { from: 'b', to: 'c' },
            { from: 'rollup-1', to: 'a-b' },
        ]);
        // Survivors keep their original anchors.
        expect(store._raw.get('mg__floor_log').commits.map((c) => c.floor)).toEqual([0, 2, 2]);
    });

    /**
     * Tail-swipe shape: user swipes the tail message after a fresh rebuild
     * (or normal incremental extraction). The tail's only commits are the
     * last batch + any compression rounds that ran inline after it — all
     * anchored at the tail floor. Swipe shifts that floor's active swipeId
     * so those commits get filtered out of replay; earlier batches stay.
     *
     * Critical: the user's original complaint was that swipe wiped the
     * entire graph because every rebuild commit was pinned to the tail
     * trigger floor. With per-seq anchoring, swipe of floor=4 only drops
     * floor-4 commits, leaving the floor-0/2 batches intact.
     */
    test('tail swipe drops only tail-anchored commits, leaves historical batches', async () => {
        const chatRef = { value: [msg(), msg(), msg(), msg(), msg()] }; // floors 0..4
        const { store, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'mg' }, deps);

        await updateToPayload(fs, (cur) => ({
            edges: [...(cur.edges || []), { from: 'a', to: 'b' }],
        }), { floor: 0 });
        await updateToPayload(fs, (cur) => ({
            edges: [...(cur.edges || []), { from: 'b', to: 'c' }],
        }), { floor: 2 });
        await updateToPayload(fs, (cur) => ({
            edges: [...(cur.edges || []), { from: 'c', to: 'd' }],
        }), { floor: 4 });
        // Inline compression after batch-3, also at floor 4.
        await updateToPayload(fs, (cur) => ({
            edges: [...(cur.edges || []), { from: 'rollup-tail', to: 'c-d' }],
        }), { floor: 4 });

        const beforeSwipe = await fs.get();
        expect(beforeSwipe.edges).toHaveLength(4);

        // User swipes floor 4 — chat[4].swipe_id flips from 0 to 1, so
        // shouldKeepCommit filters out both floor-4 commits on the next get().
        chatRef.value[4] = { swipe_id: 1, mes: 'x-swipe-1' };
        await fs.__handleMessageSwiped();
        await fs.ready();

        const recovered = await fs.get();
        expect(recovered).not.toBeNull();
        // Floor-0 and floor-2 commits survive untouched.
        expect(recovered.edges).toEqual([
            { from: 'a', to: 'b' },
            { from: 'b', to: 'c' },
        ]);
        // Floor-4 log entries remain on disk (they would replay again if the
        // user swipes back to swipe_id=0), but they're filtered out of the
        // current replay.
        expect(store._raw.get('mg__floor_log').commits.map((c) => c.floor)).toEqual([0, 2, 4, 4]);
    });

    /**
     * Regression for the "整个图被废掉" outcome: a compression commit whose
     * caller-supplied anchor floor is BELOW the log tail (e.g. compression
     * folds in pre-existing older nodes and the caller anchors at
     * `parent.seqTo` rather than the triggering batch's endSeq).
     *
     * Pre-fix: the out-of-order commit landed in the log; on delete,
     * `truncateCommits` dropped a mid-log slice and left a dangling
     * compression commit whose `add /edges/3` referenced an edges array
     * that the surviving prefix had only built up to length 2 → fast-json-patch
     * throws "Array index out of bounds" → recovery truncated by brokenFloor
     * and the rest of the graph went with it.
     *
     * Post-fix: `appendCommit` clamps any out-of-order commit's floor up to
     * the log tail's floor, preserving the chain. The user's data still
     * lands, and the commit survives until the chat shrinks past the prior
     * tail.
     */
    test('out-of-order compression commit is clamped to log tail and survives', async () => {
        const chatRef = { value: [msg(), msg(), msg(), msg(), msg()] };
        const { store, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'mg' }, deps);

        await updateToPayload(fs, (cur) => ({
            edges: [...(cur.edges || []), { from: 'a', to: 'b' }],
        }), { floor: 0 });
        await updateToPayload(fs, (cur) => ({
            edges: [...(cur.edges || []), { from: 'b', to: 'c' }],
        }), { floor: 2 });
        await updateToPayload(fs, (cur) => ({
            edges: [...(cur.edges || []), { from: 'c', to: 'd' }],
        }), { floor: 4 });

        // Buggy caller anchors compression at a historical floor (2) even
        // though the log tail is already at floor 4. appendCommit's clamp
        // pulls the floor up to 4 to keep the chain monotone.
        const HISTORICAL_FLOOR = 2;
        await updateToPayload(fs, (cur) => ({
            edges: [...(cur.edges || []), { from: 'rollup', to: 'parent' }],
        }), { floor: HISTORICAL_FLOOR });

        // Log floors: [0, 2, 4, 4] — strictly non-decreasing thanks to clamp.
        expect(store._raw.get('mg__floor_log').commits.map((c) => c.floor)).toEqual([0, 2, 4, 4]);

        chatRef.value = chatRef.value.slice(0, 3);
        await fs.__handleMessageDeleted(3);
        await fs.ready();

        // Truncate floor >= 3 drops the floor-4 batch and the clamped-to-4
        // compression together — a clean log suffix. The historical-floor
        // batches survive intact.
        const recovered = await fs.get();
        expect(recovered.edges).toEqual([
            { from: 'a', to: 'b' },
            { from: 'b', to: 'c' },
        ]);
        expect(store._raw.get('mg__floor_log').commits.map((c) => c.floor)).toEqual([0, 2]);
    });

    /**
     * The same scenario that produced the user's "记忆图清零" report from a
     * real chat: extraction batches advance the log to floor 12, then manual
     * compression folds in pre-existing older nodes and the rollup's
     * parent.seqTo translates back to a much earlier floor (8, then 0, 0, 0,
     * 0 across multiple rounds). Without clamp this is the exact failure
     * mode that orphaned 5 compression commits at floor=0 in the brokenLog.
     * With clamp every out-of-order commit gets pulled up to floor 12, so
     * delete-on-tail still yields a monotone chain and a clean truncate.
     */
    test('multi-round compression folding old nodes stays monotone via clamp', async () => {
        const chatRef = { value: Array.from({ length: 14 }, msg) };
        const { store, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'mg' }, deps);

        // Extraction batches at floors 0, 2, 6, 8, 10, 12 — monotone.
        for (const floor of [0, 2, 6, 8, 10, 12]) {
            await updateToPayload(fs, (cur) => ({
                edges: [...(cur.edges || []), { from: `batch-${floor}`, to: 'x' }],
            }), { floor });
        }

        // Five compression rounds, each anchored at a historical floor that
        // matches the rollup's parent.seqTo (the bug). 8 → 0 → 0 → 0 → 0.
        for (const buggyFloor of [8, 0, 0, 0, 0]) {
            await updateToPayload(fs, (cur) => ({
                edges: [...(cur.edges || []), { from: `rollup-at-${buggyFloor}`, to: 'parent' }],
            }), { floor: buggyFloor });
        }

        // Log floors are clamped to the tail (12) for every out-of-order
        // commit. Monotone.
        expect(store._raw.get('mg__floor_log').commits.map((c) => c.floor)).toEqual([
            0, 2, 6, 8, 10, 12,   // batches
            12, 12, 12, 12, 12,    // clamped compression commits
        ]);

        // Replay from scratch (no recovery path) — should never throw.
        const replayed = await fs.get();
        expect(replayed).not.toBeNull();
        expect(replayed.edges).toHaveLength(11);

        // Delete back to length=11 → truncate floor >= 11 → drops the
        // floor-12 batch and all clamped compression commits. The
        // floor-0..10 batches survive.
        chatRef.value = chatRef.value.slice(0, 11);
        await fs.__handleMessageDeleted(11);
        await fs.ready();

        const recovered = await fs.get();
        expect(recovered).not.toBeNull();
        expect(recovered.edges).toEqual([
            { from: 'batch-0', to: 'x' },
            { from: 'batch-2', to: 'x' },
            { from: 'batch-6', to: 'x' },
            { from: 'batch-8', to: 'x' },
            { from: 'batch-10', to: 'x' },
        ]);
    });
});
