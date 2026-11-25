// tests/lib/playable-anchor-consumers.test.js
import { describe, test, expect } from '@jest/globals';
import { getStringHash } from '../../public/scripts/lib/string-hash.js';
import {
    buildLastUserAnchorFromMessages as buildOrchAnchor,
    isStoredOrchestrationSnapshotValidForMessages,
} from '../../public/scripts/extensions/orchestrator/anchors.js';
import {
    buildLastUserAnchorFromMessages as buildSearchAnchor,
} from '../../public/scripts/extensions/search-tools/anchors.js';

const CHAT = [
    { is_system: true, mes: 'The tide tables are pinned above the chart desk.' },
    { is_user: false, mes: '*Ash unrolls the western channel map.*' },
    { is_user: true, mes: 'Mark the reef where the buoy broke loose.', swipe_id: 2 },
    { is_system: true, mes: 'Lantern trimmed.' },
    { is_user: false, mes: '"There — past the second shoal."' },
];
const HASH = String(getStringHash(CHAT[2].mes));

describe('anchor wrappers keep their plugin shapes', () => {
    test('orchestrator anchor carries chatIndex, playableFloor, swipeId, hash', () => {
        expect(buildOrchAnchor(CHAT)).toEqual({ chatIndex: 2, playableFloor: 2, swipeId: 2, hash: HASH });
    });

    test('search-tools anchor carries floor, playableFloor, hash', () => {
        expect(buildSearchAnchor(CHAT)).toEqual({ floor: 3, playableFloor: 2, hash: HASH });
    });

    test('orchestrator snapshot validity follows capsule text and message hash', () => {
        expect(isStoredOrchestrationSnapshotValidForMessages(2, { anchorHash: HASH, capsuleText: 'Ash marks the reef.' }, CHAT)).toBe(true);
        expect(isStoredOrchestrationSnapshotValidForMessages(2, { anchorHash: HASH, capsuleText: '' }, CHAT)).toBe(false);
        const edited = CHAT.map((m, i) => (i === 2 ? { ...m, mes: 'Mark the northern shoal instead.' } : m));
        expect(isStoredOrchestrationSnapshotValidForMessages(2, { anchorHash: HASH, capsuleText: 'Ash marks the reef.' }, edited)).toBe(false);
    });

    test('search-tools anchor hash tracks text edits without changing a captured anchor', () => {
        const captured = buildSearchAnchor(CHAT);
        const edited = CHAT.map((message, index) => (index === 2 ? { ...message, mes: 'Mark the northern shoal instead.' } : message));
        expect(buildSearchAnchor(edited)).toEqual({ floor: 3, playableFloor: 2, hash: String(getStringHash(edited[2].mes)) });
        expect(buildSearchAnchor(edited).hash).not.toBe(HASH);
        expect(captured).toEqual({ floor: 3, playableFloor: 2, hash: HASH });
    });
});
