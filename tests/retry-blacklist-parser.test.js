import { describe, test, expect, jest } from '@jest/globals';

// The reader (`getRetryStatusBlacklist`) touches `extension_settings`, which
// pulls in the whole extensions module graph. Stub it before importing.
jest.unstable_mockModule('../public/scripts/extensions.js', () => ({
    extension_settings: {},
}));

const { parseRetryStatusBlacklist, formatRetryStatusBlacklist } = await import(
    '../public/scripts/extensions/connection-manager/max-retries.js'
);

describe('parseRetryStatusBlacklist', () => {
    test('returns [] for null / undefined / empty string', () => {
        expect(parseRetryStatusBlacklist(null)).toEqual([]);
        expect(parseRetryStatusBlacklist(undefined)).toEqual([]);
        expect(parseRetryStatusBlacklist('')).toEqual([]);
        expect(parseRetryStatusBlacklist('   ')).toEqual([]);
    });

    test('parses single code from string', () => {
        expect(parseRetryStatusBlacklist('429')).toEqual([429]);
    });

    test('parses comma-separated codes', () => {
        expect(parseRetryStatusBlacklist('429, 503')).toEqual([429, 503]);
    });

    test('parses whitespace-separated codes', () => {
        expect(parseRetryStatusBlacklist('429 503 502')).toEqual([429, 502, 503]);
    });

    test('parses semicolon-separated codes', () => {
        expect(parseRetryStatusBlacklist('429;503')).toEqual([429, 503]);
    });

    test('parses mixed separators', () => {
        expect(parseRetryStatusBlacklist('429, 503; 502  500')).toEqual([429, 500, 502, 503]);
    });

    test('accepts array input', () => {
        expect(parseRetryStatusBlacklist([503, 429])).toEqual([429, 503]);
    });

    test('accepts array of strings', () => {
        expect(parseRetryStatusBlacklist(['503', '429', '502'])).toEqual([429, 502, 503]);
    });

    test('deduplicates repeated codes', () => {
        expect(parseRetryStatusBlacklist('429, 429, 503')).toEqual([429, 503]);
    });

    test('sorts ascending', () => {
        expect(parseRetryStatusBlacklist('503, 429, 500')).toEqual([429, 500, 503]);
    });

    test('drops codes outside [100, 599]', () => {
        expect(parseRetryStatusBlacklist('99, 100, 500, 599, 600, 700')).toEqual([100, 500, 599]);
    });

    test('drops non-integer tokens', () => {
        expect(parseRetryStatusBlacklist('429, abc, 503, 4.5, ""')).toEqual([429, 503]);
    });

    test('drops empty tokens between separators', () => {
        expect(parseRetryStatusBlacklist(',, 429, , 503,')).toEqual([429, 503]);
    });
});

describe('formatRetryStatusBlacklist', () => {
    test('returns empty string for empty / non-array', () => {
        expect(formatRetryStatusBlacklist([])).toBe('');
        expect(formatRetryStatusBlacklist(null)).toBe('');
        expect(formatRetryStatusBlacklist(undefined)).toBe('');
    });

    test('joins with ", "', () => {
        expect(formatRetryStatusBlacklist([429])).toBe('429');
        expect(formatRetryStatusBlacklist([429, 503])).toBe('429, 503');
    });

    test('round-trips through parse', () => {
        const parsed = parseRetryStatusBlacklist('503, 429, 502, 500, 429');
        expect(formatRetryStatusBlacklist(parsed)).toBe('429, 500, 502, 503');
    });
});
