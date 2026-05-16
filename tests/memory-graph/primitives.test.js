import { describe, test, expect } from '@jest/globals';

import { isExtractableAssistantMessage } from '../../public/scripts/extensions/memory-graph/primitives.js';

describe('isExtractableAssistantMessage', () => {
    test('accepts a plain assistant turn', () => {
        expect(isExtractableAssistantMessage({ is_user: false, is_system: false, mes: 'hello' })).toBe(true);
    });

    test('rejects user messages', () => {
        expect(isExtractableAssistantMessage({ is_user: true, is_system: false, mes: 'hi' })).toBe(false);
    });

    test('rejects empty / whitespace-only assistant turns', () => {
        expect(isExtractableAssistantMessage({ is_user: false, is_system: false, mes: '' })).toBe(false);
        expect(isExtractableAssistantMessage({ is_user: false, is_system: false, mes: '   \n\t' })).toBe(false);
        expect(isExtractableAssistantMessage({ is_user: false, is_system: false })).toBe(false);
    });

    test('rejects null / undefined / non-object', () => {
        expect(isExtractableAssistantMessage(null)).toBe(false);
        expect(isExtractableAssistantMessage(undefined)).toBe(false);
    });

    // /hide flips is_system on an existing assistant turn. Treating that as a
    // reason to exclude the message would shift the extractable-seq coordinate
    // space and drift stored node seqs against chat[]. Community convention
    // is that /hide only hides the message from the prompt — it must not
    // delete or move memory.
    test('still accepts hidden assistant turns (is_system flipped by /hide)', () => {
        expect(isExtractableAssistantMessage({ is_user: false, is_system: true, mes: 'hello' })).toBe(true);
    });
});
