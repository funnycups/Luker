/**
 * Regression for "compression commit anchored at historical floor breaks
 * truncate-by-floor recovery" (memory-graph crash on delete-after-compression).
 *
 * Contract under test:
 *   Floor-state's truncate-by-floor handler (MESSAGE_DELETED) is sound ONLY
 *   when commit.floor is monotonically non-decreasing in append order. Once
 *   any commit lands at a floor lower than an earlier commit on the same log,
 *   "truncate at floor >= N" stops being equivalent to "drop a log suffix" —
 *   it leaves earlier-in-log commits whose `prev` state depends on commits
 *   that were just dropped, and replay then crashes inside fast-json-patch
 *   with "Array index out of bounds" or similar.
 *
 *   memory-graph's event compression used to anchor compression commits to
 *   `seqToFloor(parent.seqTo)`, which resolves to the (historical) floor of
 *   the most-recent compressed child — strictly less than the trigger floor.
 *   That violated the invariant above and produced the live crash.
 *
 * Both tests below operate directly on FloorState (no memory-graph adapter)
 * so the contract is documented at the layer that enforces it.
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

describe('compaction commit floor anchor — root-cause regression', () => {
    /**
     * Repro of the production crash:
     *   - chat has 5 messages (floors 0..4)
     *   - extraction adds an edge at floors 0, 2, 4 (3 commits, edges.length grows 0→1→2→3)
     *   - compression triggered AT floor 4 produces a rollup whose
     *     parent.seqTo maps back to the OLD floor 2 (the most recent
     *     compressed child)
     *   - production currently anchors that compression commit at floor 2,
     *     not at floor 4
     *   - user then deletes the chat back to length=3 (i.e. floors 0..2),
     *     which truncates commits whose floor >= 3
     *
     * Outcome under the bug: floor-2 compression commit survives, but the
     * floor-4 extraction commit it implicitly depended on (edges[2] add)
     * was just truncated → its `add /edges/3` patch throws
     * "Array index out of bounds: 3" inside fast-json-patch.
     *
     * Outcome with the fix: compression commit is anchored at floor 4 (the
     * trigger floor), so truncating chat to length=3 drops the compression
     * commit alongside the floor-4 extraction commit. The remaining log
     * (floor-0 + floor-2 extraction) replays cleanly.
     */
    test('compression commit anchored at trigger floor survives delete-after-compression', async () => {
        const chatRef = { value: [msg(), msg(), msg(), msg(), msg()] }; // floors 0..4
        const { store, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'mg' }, deps);

        // Three extraction commits at floors 0, 2, 4 — each appends one edge.
        await updateToPayload(fs, (cur) => ({
            edges: [...(cur.edges || []), { from: 'a', to: 'b' }],
        }), { floor: 0 });

        await updateToPayload(fs, (cur) => ({
            edges: [...(cur.edges || []), { from: 'b', to: 'c' }],
        }), { floor: 2 });

        await updateToPayload(fs, (cur) => ({
            edges: [...(cur.edges || []), { from: 'c', to: 'd' }],
        }), { floor: 4 });

        // Sanity: state has all three edges, log has 3 commits at 0/2/4.
        const beforeCompress = await fs.get();
        expect(beforeCompress.edges).toHaveLength(3);
        expect(store._raw.get('mg__floor_log').commits.map((c) => c.floor)).toEqual([0, 2, 4]);

        // Compression triggered AT floor 4. Adds rollup edge → edges grows to 4.
        // CONTRACT: this commit MUST be anchored at the trigger floor (4),
        // NOT at the rollup parent's historical seqTo (which would map to
        // floor 2 via seqToFloor). Anchoring at the historical floor is what
        // breaks the chain on subsequent truncation.
        const TRIGGER_FLOOR = 4;
        await updateToPayload(fs, (cur) => ({
            edges: [...(cur.edges || []), { from: 'rollup', to: 'parent' }],
        }), { floor: TRIGGER_FLOOR });

        const afterCompress = await fs.get();
        expect(afterCompress.edges).toHaveLength(4);

        // Now the user deletes back to chat length 3 (keeping floors 0..2).
        chatRef.value = chatRef.value.slice(0, 3);
        await fs.__handleMessageDeleted(3);
        await fs.ready();

        // Survivors must replay cleanly. Bug manifests here as
        // "Array index out of bounds" thrown out of fs.get().
        const recovered = await fs.get();

        // The two surviving extraction commits each added one edge.
        // Compression commit was at floor 4 (≥3) so it was dropped with the
        // floor-4 extraction commit — atomicity preserved.
        expect(recovered).not.toBeNull();
        expect(recovered.edges).toHaveLength(2);
        expect(recovered.edges).toEqual([
            { from: 'a', to: 'b' },
            { from: 'b', to: 'c' },
        ]);

        // Defensive: log must have exactly the two extraction commits left.
        const survivingFloors = store._raw.get('mg__floor_log').commits.map((c) => c.floor);
        expect(survivingFloors).toEqual([0, 2]);
    });

    /**
     * The complementary case: user deletes back to a point AFTER the
     * compression trigger floor. The compression commit must still be in
     * place and the materialized state must still reflect the rollup.
     *
     * This guards against an over-zealous fix that drops compression
     * commits unconditionally on truncate.
     */
    /**
     * Demonstrates the BUG STATE that motivated the contract: when a
     * compression commit is anchored at a historical floor (the rollup
     * parent's seqTo, as production used to compute it via
     * `seqToFloor(parent.seqTo)`) instead of the trigger floor, then any
     * subsequent truncation that lands between the historical floor and the
     * trigger floor leaves the compression commit orphaned — its `prev`
     * state assumes log entries that were just dropped, and replay throws
     * out of fast-json-patch.
     *
     * This is the floor-state-level proof of why memory-graph's compaction
     * commit anchoring had to change. It's an existence test, not a
     * regression — the system contract is "callers must anchor at trigger
     * floor"; this test shows what happens when a caller violates that.
     *
     * Note on observed behavior: floor-state's broken-log recovery (added
     * in dede4cb39) catches the replay throw, identifies the broken floor
     * (here: floor 2), and TRUNCATES EVERYTHING at floor >= 2 — i.e. it
     * drops the perfectly-good floor-2 extraction commit too, taking half
     * the graph with it. That's the "整个图废掉" the user reported. The
     * test below pins that data-loss outcome so a future change to
     * recovery semantics is forced to consciously re-evaluate it.
     */
    test('compression commit anchored at HISTORICAL floor causes catastrophic data loss after truncation (bug demo)', async () => {
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

        // BUG: compression triggered at floor 4 but anchored back at
        // floor 2 — the historical floor of the rollup parent's seqTo.
        const HISTORICAL_FLOOR = 2;
        await updateToPayload(fs, (cur) => ({
            edges: [...(cur.edges || []), { from: 'rollup', to: 'parent' }],
        }), { floor: HISTORICAL_FLOOR });

        // User deletes back to length=3 → floor >= 3 truncated.
        // floor-2 compression commit survives; floor-4 extraction commit
        // (which the compression commit's prev state assumed) does not.
        chatRef.value = chatRef.value.slice(0, 3);
        await fs.__handleMessageDeleted(3);
        await fs.ready();

        // Replay: floor-0 ext → floor-2 ext → floor-2 compression.
        // Compression's `add /edges/3` assumes edges.length === 3, but the
        // surviving prefix only built edges up to length 2 → out of bounds.
        // Recovery (recoverByTruncatingBrokenFloor) catches the throw,
        // identifies brokenFloor=2, truncates floor >= 2 → drops the
        // floor-2 extraction commit too. Result: only the floor-0 edge
        // survives. This is "整个图被废掉".
        const recovered = await fs.get();
        expect(recovered.edges).toEqual([{ from: 'a', to: 'b' }]);
        // floor-2 extraction was collateral damage — both b→c (extraction)
        // and the rollup edge are gone.
    });

    test('compression commit at trigger floor is preserved when delete stops short of it', async () => {
        const chatRef = { value: [msg(), msg(), msg(), msg(), msg(), msg()] }; // floors 0..5
        const { deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'mg', }, deps);

        await updateToPayload(fs, (cur) => ({
            edges: [...(cur.edges || []), { from: 'a', to: 'b' }],
        }), { floor: 0 });

        await updateToPayload(fs, (cur) => ({
            edges: [...(cur.edges || []), { from: 'b', to: 'c' }],
        }), { floor: 2 });

        // Compression triggered at floor 4 — anchored AT floor 4.
        await updateToPayload(fs, (cur) => ({
            edges: [...(cur.edges || []), { from: 'rollup', to: 'parent' }],
        }), { floor: 4 });

        // Then one more extraction at floor 5 (next turn).
        await updateToPayload(fs, (cur) => ({
            edges: [...(cur.edges || []), { from: 'd', to: 'e' }],
        }), { floor: 5 });

        // Delete back to length=5 — keeps floors 0..4 (including compression).
        chatRef.value = chatRef.value.slice(0, 5);
        await fs.__handleMessageDeleted(5);
        await fs.ready();

        const recovered = await fs.get();
        expect(recovered).not.toBeNull();
        expect(recovered.edges).toEqual([
            { from: 'a', to: 'b' },
            { from: 'b', to: 'c' },
            { from: 'rollup', to: 'parent' },
        ]);
    });
});
