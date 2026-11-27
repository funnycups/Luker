// tests/lib/string-hash.test.js
import { describe, test, expect } from '@jest/globals';
import { getStringHash } from '../../public/scripts/lib/string-hash.js';

describe('lib/string-hash getStringHash', () => {
    test('returns the persisted cyrb53 values', () => {
        expect(getStringHash('hello world')).toBe(3259054761512980);
        expect(getStringHash('你好，世界')).toBe(267949778711503);
        expect(getStringHash('')).toBe(3338908027751811);
    });

    test('the seed changes the hash', () => {
        expect(getStringHash('abc', 42)).toBe(6035376845117563);
        expect(getStringHash('abc', 42)).not.toBe(getStringHash('abc'));
    });

    test('non-string input hashes to 0', () => {
        expect(getStringHash(null)).toBe(0);
        expect(getStringHash(undefined)).toBe(0);
        expect(getStringHash(42)).toBe(0);
        expect(getStringHash({})).toBe(0);
    });
});
