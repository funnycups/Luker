// Case #77 — Snapshot cache: hits and invalidates (ported from e2e).
//
// Spec:
//   - Same spec input twice → second is instant (cache hit).
//   - Change one field in spec → cache misses, full re-run.
//
// Source-of-truth: snapshot-cache.js — `canReuseLatestOrchestrationSnapshot`
// is the cache-hit predicate. It returns true iff the active snapshot's
// chatKey + anchorPlayableFloor + anchorHash all match the candidate
// anchor. The anchorHash is computed from the source content (the user
// message + scenario fields the orchestration depends on); when the
// spec changes, the hash changes, and the predicate returns false.
//
// The e2e file's third case originally drove the lifecycle through
// `storeCompletedOrchestrationSnapshot`, which requires a live
// floor-state. We can prove the same predicate contracts by seeding
// the module-private active-snapshot via the exported
// `setLatestOrchestrationSnapshotFromPick` setter — that decouples the
// reuse-decision unit test from the floor-state I/O path. Production
// runs through the same predicate when `storeCompletedOrchestrationSnapshot`
// finishes persisting; persistence is independently tested in
// `tests/orchestrator/persistence.test.js`.

import { describe, test, expect, beforeEach } from '@jest/globals';
import * as sc from '../../public/scripts/extensions/orchestrator/snapshot-cache.js';

beforeEach(() => {
    // The cache is module-global; clear it before each test so prior
    // state doesn't bleed in.
    sc.clearCacheForChatChange();
});

describe('#77 — Snapshot cache: hits and invalidates', () => {
    test('canReuseLatestOrchestrationSnapshot: returns false for any candidate against an empty cache (cold-start defensive contract)', () => {
        const candidate = { playableFloor: 5, hash: 'h_abcdef' };

        // With a fresh cache and no seeded snapshot, the predicate
        // returns false for any candidate — proving the predicate is
        // correctly defensive on cold start.
        expect(sc.canReuseLatestOrchestrationSnapshot('char:x.png:cA', candidate)).toBe(false);
        expect(sc.canReuseLatestOrchestrationSnapshot('char:x.png:cB', candidate)).toBe(false);
        expect(sc.canReuseLatestOrchestrationSnapshot('char:x.png:cA', null)).toBe(false);
    });

    test('snapshot-cache module exposes the documented entry points: canReuseLatestOrchestrationSnapshot, getActiveSnapshot, refreshActiveSnapshotFromCache, getChatKey, storeCompletedOrchestrationSnapshot', () => {
        expect(typeof sc.canReuseLatestOrchestrationSnapshot).toBe('function');
        expect(typeof sc.getActiveSnapshot).toBe('function');
        expect(typeof sc.refreshActiveSnapshotFromCache).toBe('function');
        expect(typeof sc.getChatKey).toBe('function');
        expect(typeof sc.storeCompletedOrchestrationSnapshot).toBe('function');
    });

    test('full reuse roundtrip: seeded snapshot → canReuse returns true for same anchor; false for mismatched floor / hash / chatKey', () => {
        // Seed the cache via `setLatestOrchestrationSnapshotFromPick` (the
        // module's documented setter). The lifecycle that
        // `storeCompletedOrchestrationSnapshot` drives through floor-state
        // ultimately calls the same setter — persistence I/O is covered by
        // `persistence.test.js`; the predicate behavior under a seeded
        // cache is what this case asserts.
        const chatKey = 'char:ash.png:scenario-77';
        const anchorHash = 'h_anchor_77_canonical';
        const anchorFloor = 5;
        const capsuleText = 'Snapshot #77 cached capsule body for reuse assertion.';
        const stageOutputs = [{ id: 'stage-a', text: 'Stage A output.' }];

        // BEFORE seed: cache cold for this anchor.
        const beforeCache = sc.canReuseLatestOrchestrationSnapshot(chatKey, {
            playableFloor: anchorFloor,
            hash: anchorHash,
        });
        expect(beforeCache).toBe(false);

        sc.setLatestOrchestrationSnapshotFromPick(chatKey, {
            playableFloor: anchorFloor,
            snapshot: {
                anchorHash,
                capsuleText,
                stageOutputs,
            },
        });

        const stored = sc.getActiveSnapshot();
        expect(stored).toBeTruthy();
        expect(stored.chatKey).toBe(chatKey);
        expect(stored.anchorPlayableFloor).toBe(anchorFloor);
        expect(stored.anchorHash).toBe(anchorHash);
        expect(stored.capsuleText).toBe(capsuleText);

        // AFTER seed: same anchor → reuse hit (the load-bearing contract).
        expect(sc.canReuseLatestOrchestrationSnapshot(chatKey, {
            playableFloor: anchorFloor,
            hash: anchorHash,
        })).toBe(true);

        // Mismatched: same chatKey + same floor but different hash.
        expect(sc.canReuseLatestOrchestrationSnapshot(chatKey, {
            playableFloor: anchorFloor,
            hash: anchorHash + '_mutated',
        })).toBe(false);

        // Mismatched: same chatKey + same hash but different floor.
        expect(sc.canReuseLatestOrchestrationSnapshot(chatKey, {
            playableFloor: anchorFloor + 100,
            hash: anchorHash,
        })).toBe(false);

        // Mismatched: foreign chatKey (different chat / character).
        expect(sc.canReuseLatestOrchestrationSnapshot('char:foreign.png:other', {
            playableFloor: anchorFloor,
            hash: anchorHash,
        })).toBe(false);
    });
});
