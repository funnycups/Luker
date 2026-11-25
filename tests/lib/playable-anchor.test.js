// tests/lib/playable-anchor.test.js
import { describe, test, expect } from '@jest/globals';
import { getStringHash } from '../../public/scripts/lib/string-hash.js';
import {
    normalizeAnchorPlayableFloor,
    getPlayableMessageAt,
    extractLastUserMessage,
    hashAnchorText,
    computeLastUserAnchorCore,
    isPlayableAnchorHashValid,
} from '../../public/scripts/lib/playable-anchor.js';

const CHAT = [
    { is_system: true, mes: 'The tide tables are pinned above the chart desk.' },
    { is_user: false, mes: '*Ash unrolls the western channel map.*' },
    { is_user: true, mes: 'Mark the reef where the buoy broke loose.', swipe_id: 2 },
    { is_system: true, mes: 'Lantern trimmed.' },
    { is_user: false, mes: '"There — past the second shoal."' },
];
const HASH = String(getStringHash(CHAT[2].mes));

describe('lib/playable-anchor', () => {
    test('normalizeAnchorPlayableFloor floors and clamps to a non-negative integer', () => {
        expect(normalizeAnchorPlayableFloor(3.9)).toBe(3);
        expect(normalizeAnchorPlayableFloor('4')).toBe(4);
        expect(normalizeAnchorPlayableFloor(-2)).toBe(0);
        expect(normalizeAnchorPlayableFloor('x')).toBe(0);
        expect(normalizeAnchorPlayableFloor(null)).toBe(0);
    });

    test('getPlayableMessageAt counts only non-system messages', () => {
        expect(getPlayableMessageAt(CHAT, 2)).toEqual({ index: 2, message: CHAT[2] });
        expect(getPlayableMessageAt(CHAT, 3)).toEqual({ index: 4, message: CHAT[4] });
        expect(getPlayableMessageAt(CHAT, 0)).toBeNull();
        expect(getPlayableMessageAt(CHAT, 9)).toBeNull();
        expect(getPlayableMessageAt('not a chat', 1)).toBeNull();
    });

    test('extractLastUserMessage finds the last user turn or reports none', () => {
        expect(extractLastUserMessage(CHAT)).toEqual({ index: 2, message: CHAT[2] });
        expect(extractLastUserMessage(null)).toEqual({ index: -1, message: null });
        expect(extractLastUserMessage([])).toEqual({ index: -1, message: null });
    });

    test('hashAnchorText is the stringified cyrb53 of the text', () => {
        expect(hashAnchorText('abc')).toBe(String(getStringHash('abc')));
        expect(hashAnchorText(undefined)).toBe(String(getStringHash('')));
    });

    test('computeLastUserAnchorCore reports index, message, playable floor and hash', () => {
        expect(computeLastUserAnchorCore(CHAT)).toEqual({ index: 2, message: CHAT[2], playableFloor: 2, hash: HASH });
    });

    test('computeLastUserAnchorCore returns null without a user turn', () => {
        expect(computeLastUserAnchorCore([{ is_user: false, mes: 'x' }])).toBeNull();
        expect(computeLastUserAnchorCore(undefined)).toBeNull();
    });

    test('isPlayableAnchorHashValid requires a user turn at the floor with a matching trimmed hash', () => {
        expect(isPlayableAnchorHashValid(CHAT, 2, HASH)).toBe(true);
        expect(isPlayableAnchorHashValid(CHAT, 2, `  ${HASH} `)).toBe(true);
        expect(isPlayableAnchorHashValid(CHAT, 3, HASH)).toBe(false);
        expect(isPlayableAnchorHashValid(CHAT, 2, '')).toBe(false);
        expect(isPlayableAnchorHashValid(CHAT, 2, '123')).toBe(false);
    });
});
