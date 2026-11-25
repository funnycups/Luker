import { describe, test, expect, beforeEach } from '@jest/globals';
import { registerTarget, hasTarget, clearRegistry } from '/scripts/iteration-library/storage/target-registry.js';

const HANDLER = { read: async () => ({}), write: async () => {}, describe: () => 'x' };

beforeEach(() => clearRegistry());

describe('hasTarget', () => {
    test('reflects registration and clearRegistry', () => {
        expect(hasTarget('skill-registry')).toBe(false);
        registerTarget('skill-registry', HANDLER);
        expect(hasTarget('skill-registry')).toBe(true);
        expect(hasTarget('preset')).toBe(false);
        clearRegistry();
        expect(hasTarget('skill-registry')).toBe(false);
    });

    test('returns false for non-string input', () => {
        registerTarget('preset', HANDLER);
        expect(hasTarget(undefined)).toBe(false);
        expect(hasTarget(42)).toBe(false);
        expect(hasTarget({ type: 'preset' })).toBe(false);
    });
});
