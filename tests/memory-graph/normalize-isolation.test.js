/**
 * Regression coverage for the ce2594723 tag-shortcut bug.
 *
 * `normalizeStoreForRuntime` used to short-circuit and return the same
 * object reference when given an already-tagged input (perf optimization
 * for large mobile imports). That broke every "before snapshot" pattern in
 * the codebase: `commitMemoryStoreDiffByChatKey` reads `beforeStore` and
 * `afterStore`, normalizes both, and diffs them — if the caller passed the
 * same cached store reference (which `runScheduledExtractionPass`,
 * manual-rebuild popups, and the editor save paths all did), the short-
 * circuit made `normalizedBefore === normalizedAfter`, the diff went
 * empty, and the commit became a silent no-op. Cache kept advancing in
 * memory, disk stayed put, and the next rematerialize wiped cache back to
 * log state — the user-visible "regenerate rolls back N layers" symptom.
 *
 * This suite locks in the invariant: every call to normalize MUST return a
 * fresh independent object. Future perf optimizations may revisit how
 * normalization is gated, but not by aliasing the cache.
 */

import { describe, test, expect } from '@jest/globals';
import {
    normalizeStoreForRuntime,
    createEmptyStore,
} from '../../public/scripts/extensions/memory-graph/persistence.js';

describe('normalizeStoreForRuntime isolation invariants', () => {
    function makeStoreWithOneNode() {
        return {
            nodes: {
                n_1: {
                    id: 'n_1',
                    type: 'event',
                    level: 'semantic',
                    title: 'orig',
                    fields: { what: 'something' },
                    seqTo: 1,
                    parentId: '',
                    childrenIds: [],
                    archived: false,
                    semanticDepth: 0,
                    semanticRollup: false,
                },
            },
            edges: [],
            nodeSeq: 1,
            seqCounter: 1,
            appliedSeqTo: 1,
            loggedSeqTo: 1,
        };
    }

    test('two normalize calls on the same input return DIFFERENT object references', () => {
        const source = makeStoreWithOneNode();
        const a = normalizeStoreForRuntime(source);
        const b = normalizeStoreForRuntime(source);
        expect(a).not.toBe(b);
    });

    test('normalize result is independent of its input — mutating the input does not leak into the normalized copy', () => {
        const source = makeStoreWithOneNode();
        const normalized = normalizeStoreForRuntime(source);
        source.nodes.n_1.title = 'mutated after normalize';
        source.nodes.n_99 = { id: 'n_99', type: 'event', level: 'semantic', fields: {}, seqTo: 99 };
        expect(normalized.nodes.n_1.title).toBe('orig');
        expect(normalized.nodes.n_99).toBeUndefined();
    });

    test('feeding normalize back into normalize still produces a fresh independent object', () => {
        const source = makeStoreWithOneNode();
        const a = normalizeStoreForRuntime(source);
        const b = normalizeStoreForRuntime(a);
        expect(a).not.toBe(b);
        b.nodes.n_1.title = 'mutated b';
        expect(a.nodes.n_1.title).toBe('orig');
    });

    test('regression: commit-diff "before snapshot" pattern stays isolated', () => {
        // Reproduces the runScheduledExtractionPass / editor / rebuild pattern:
        //   const workingStore = normalizeStoreForRuntime(cached);
        //   const committedStore = normalizeStoreForRuntime(cached);
        // Under the old tag-shortcut, both ended up === cached and the
        // working-side mutations also reflected in committedStore, making
        // the diff empty and the commit a no-op.
        const cached = normalizeStoreForRuntime(makeStoreWithOneNode());
        const workingStore = normalizeStoreForRuntime(cached);
        const committedStore = normalizeStoreForRuntime(cached);

        expect(workingStore).not.toBe(committedStore);
        expect(workingStore).not.toBe(cached);
        expect(committedStore).not.toBe(cached);

        workingStore.nodes.n_2 = {
            id: 'n_2',
            type: 'event',
            level: 'semantic',
            title: 'added on working side',
            fields: {},
            seqTo: 2,
            parentId: '',
            childrenIds: [],
            archived: false,
            semanticDepth: 0,
            semanticRollup: false,
        };
        workingStore.appliedSeqTo = 2;

        expect(committedStore.nodes.n_2).toBeUndefined();
        expect(committedStore.appliedSeqTo).toBe(1);
        expect(cached.nodes.n_2).toBeUndefined();
        expect(cached.appliedSeqTo).toBe(1);
    });

    test('non-object inputs still return an empty store (preserved behavior)', () => {
        const empty = createEmptyStore();
        expect(normalizeStoreForRuntime(null)).toEqual(empty);
        expect(normalizeStoreForRuntime(undefined)).toEqual(empty);
        expect(normalizeStoreForRuntime(42)).toEqual(empty);
        expect(normalizeStoreForRuntime('not a store')).toEqual(empty);
    });
});
