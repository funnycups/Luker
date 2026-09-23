/**
 * Graph-view editor save anchoring.
 *
 * persistLatest (main.js) commits graph edits without an explicit seq —
 * callers pass `seq = null`. The commit layer stamps the store-covered seq
 * onto the log entry, so the seq used for floor derivation and the seq
 * stamped on the entry MUST be the same number. When they diverge
 * (null coerced to 0 on one side, to covered on the other), floor
 * derivation yields null and commit-diff throws
 * "caller did not supply a valid floor".
 *
 * resolveStoreCommitSeq is the single normalizer both sides share:
 * absent seq (null / undefined / 0) resolves to the store's covered
 * watermark; a present finite seq is preserved.
 */

import { describe, test, expect } from '@jest/globals';

import {
    resolveStoreCommitSeq,
    getStoreCoveredSeqTo,
    seqToFloor,
} from '../../public/scripts/extensions/memory-graph/persistence.js';

function makeStore(covered) {
    return {
        nodes: {},
        edges: [],
        seqCounter: covered,
        appliedSeqTo: covered,
        loggedSeqTo: covered,
    };
}

// Repro shape from the bug report: chatLen=41, covered seq=20.
function makeReproChat() {
    const chat = [];
    for (let i = 0; i < 20; i++) {
        chat.push({ is_user: true, mes: `u${i + 1}` });
        chat.push({ is_user: false, mes: `a${i + 1}` });
    }
    chat.push({ is_user: true, mes: 'tail' });
    return chat;
}

describe('resolveStoreCommitSeq', () => {
    test('absent seq (null) resolves to the store covered watermark', () => {
        expect(resolveStoreCommitSeq(null, makeStore(20))).toBe(20);
        expect(resolveStoreCommitSeq(null, makeStore(20)))
            .toBe(getStoreCoveredSeqTo(makeStore(20)));
    });

    test('absent seq (undefined) resolves to the store covered watermark', () => {
        expect(resolveStoreCommitSeq(undefined, makeStore(20))).toBe(20);
    });

    test('explicit zero resolves to the store covered watermark (seq 0 has no floor)', () => {
        expect(resolveStoreCommitSeq(0, makeStore(20))).toBe(20);
    });

    test('a present finite seq is preserved', () => {
        expect(resolveStoreCommitSeq(7, makeStore(20))).toBe(7);
        expect(resolveStoreCommitSeq('7', makeStore(20))).toBe(7);
    });

    test('editor-save repro: null seq yields a real floor, not null', () => {
        const store = makeStore(20);
        const context = { chat: makeReproChat() };
        expect(context.chat).toHaveLength(41);

        const effectiveSeq = resolveStoreCommitSeq(null, store);
        const floor = seqToFloor(context, effectiveSeq);

        expect(effectiveSeq).toBe(20);
        expect(Number.isInteger(floor)).toBe(true);
        expect(floor).toBe(39);
    });

    test('empty store with absent seq stays at 0', () => {
        expect(resolveStoreCommitSeq(null, makeStore(0))).toBe(0);
    });
});
