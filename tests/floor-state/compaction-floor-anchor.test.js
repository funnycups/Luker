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
     * Bug demo: this is what happens when compression is deferred to the END
     * of all batches but anchored at seqToFloor(parent.seqTo) — the rollup
     * commit lands in the log AFTER batches at later floors, but anchors
     * back at an earlier floor. Log-append-order anchors become [0, 2, 4, 2]
     * — non-monotonic. Truncate to length=3 (floor >= 3) keeps [0, 2, 2],
     * but the surviving floor-2 compression commit's `add /edges/3` assumes
     * edges.length === 3 (the post-batch-3 state), while the surviving
     * prefix only built edges to length 2 → patch out of bounds → recovery
     * truncates floor >= 2 → user loses half the graph.
     *
     * Pins the failure mode the production fix avoids by running compression
     * INLINE (test above) rather than deferring it to the pass tail.
     */
    test('deferred compression at historical anchor causes catastrophic data loss', async () => {
        const chatRef = { value: [msg(), msg(), msg(), msg(), msg()] };
        const { deps } = makeDeps(chatRef);
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

        // BUG: compression deferred to pass tail, anchored at the historical
        // floor of rollup.parent.seqTo (which compresses batches 1+2, so
        // parent.seqTo maps back to floor 2).
        const HISTORICAL_FLOOR = 2;
        await updateToPayload(fs, (cur) => ({
            edges: [...(cur.edges || []), { from: 'rollup', to: 'parent' }],
        }), { floor: HISTORICAL_FLOOR });

        chatRef.value = chatRef.value.slice(0, 3);
        await fs.__handleMessageDeleted(3);
        await fs.ready();

        // Replay: floor-0 ext → floor-2 ext → floor-2 compression.
        // Compression's `add /edges/3` assumes edges.length === 3, but the
        // surviving prefix only built edges up to length 2 → out of bounds.
        // Recovery catches the throw, identifies brokenFloor=2, truncates
        // floor >= 2 → drops the floor-2 extraction commit too. Result:
        // only the floor-0 edge survives. This is the "整个图被废掉" outcome.
        const recovered = await fs.get();
        expect(recovered.edges).toEqual([{ from: 'a', to: 'b' }]);
    });
});
