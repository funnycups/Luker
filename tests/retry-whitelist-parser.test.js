import { describe, test, expect, jest } from '@jest/globals';

// The reader (`getRetryStatusWhitelist`) touches `extension_settings`, which
// pulls in the whole extensions module graph. Stub it before importing.
jest.unstable_mockModule('../public/scripts/extensions.js', () => ({
    extension_settings: {},
}));

const { parseRetryStatusWhitelist, formatRetryStatusWhitelist, matchesWhitelist } = await import(
    '../public/scripts/extensions/connection-manager/max-retries.js'
);

describe('parseRetryStatusWhitelist', () => {
    test('returns [] for null / undefined / empty string', () => {
        expect(parseRetryStatusWhitelist(null)).toEqual([]);
        expect(parseRetryStatusWhitelist(undefined)).toEqual([]);
        expect(parseRetryStatusWhitelist('')).toEqual([]);
        expect(parseRetryStatusWhitelist('   ')).toEqual([]);
    });

    test('parses single code from string', () => {
        expect(parseRetryStatusWhitelist('429')).toEqual([429]);
    });

    test('parses comma-separated codes', () => {
        expect(parseRetryStatusWhitelist('429, 503')).toEqual([429, 503]);
    });

    test('parses whitespace-separated codes', () => {
        expect(parseRetryStatusWhitelist('429 503 502')).toEqual([429, 502, 503]);
    });

    test('parses semicolon-separated codes', () => {
        expect(parseRetryStatusWhitelist('429;503')).toEqual([429, 503]);
    });

    test('parses mixed separators', () => {
        expect(parseRetryStatusWhitelist('429, 503; 502  500')).toEqual([429, 500, 502, 503]);
    });

    test('accepts array of numbers', () => {
        expect(parseRetryStatusWhitelist([503, 429])).toEqual([429, 503]);
    });

    test('accepts array of numeric strings', () => {
        expect(parseRetryStatusWhitelist(['503', '429', '502'])).toEqual([429, 502, 503]);
    });

    test('accepts range object in array input', () => {
        expect(parseRetryStatusWhitelist([{ start: 500, end: 599 }, 429]))
            .toEqual([429, { start: 500, end: 599 }]);
    });

    test('deduplicates repeated codes', () => {
        expect(parseRetryStatusWhitelist('429, 429, 503')).toEqual([429, 503]);
    });

    test('sorts ascending', () => {
        expect(parseRetryStatusWhitelist('503, 429, 500')).toEqual([429, 500, 503]);
    });

    test('drops codes outside [100, 599]', () => {
        expect(parseRetryStatusWhitelist('99, 100, 500, 599, 600, 700')).toEqual([100, 500, 599]);
    });

    test('drops non-integer tokens', () => {
        expect(parseRetryStatusWhitelist('429, abc, 503, 4.5, ""')).toEqual([429, 503]);
    });

    test('drops empty tokens between separators', () => {
        expect(parseRetryStatusWhitelist(',, 429, , 503,')).toEqual([429, 503]);
    });

    describe('range syntax', () => {
        test('parses "A-B" as inclusive range', () => {
            expect(parseRetryStatusWhitelist('500-599')).toEqual([{ start: 500, end: 599 }]);
        });

        test('range + single code coexist', () => {
            expect(parseRetryStatusWhitelist('429, 500-504'))
                .toEqual([429, { start: 500, end: 504 }]);
        });

        test('single-point range collapses to number', () => {
            expect(parseRetryStatusWhitelist('500-500')).toEqual([500]);
        });

        test('drops reversed range', () => {
            expect(parseRetryStatusWhitelist('599-500, 429')).toEqual([429]);
        });

        test('drops range with out-of-bounds endpoint', () => {
            expect(parseRetryStatusWhitelist('500-700, 429')).toEqual([429]);
            expect(parseRetryStatusWhitelist('50-500, 429')).toEqual([429]);
        });

        test('drops range with non-integer endpoint', () => {
            expect(parseRetryStatusWhitelist('500-abc, 429')).toEqual([429]);
            expect(parseRetryStatusWhitelist('500-5.5, 429')).toEqual([429]);
        });

        test('drops malformed multi-hyphen tokens', () => {
            expect(parseRetryStatusWhitelist('500-550-599, 429')).toEqual([429]);
        });

        test('overlapping ranges merge', () => {
            expect(parseRetryStatusWhitelist('500-550, 540-599'))
                .toEqual([{ start: 500, end: 599 }]);
        });

        test('touching ranges merge (integer status codes)', () => {
            expect(parseRetryStatusWhitelist('500-509, 510-599'))
                .toEqual([{ start: 500, end: 599 }]);
        });

        test('range absorbs single code inside it', () => {
            expect(parseRetryStatusWhitelist('503, 500-599'))
                .toEqual([{ start: 500, end: 599 }]);
        });

        test('single code adjacent to range extends it', () => {
            expect(parseRetryStatusWhitelist('499, 500-599'))
                .toEqual([{ start: 499, end: 599 }]);
        });
    });
});

describe('formatRetryStatusWhitelist', () => {
    test('returns empty string for empty / non-array', () => {
        expect(formatRetryStatusWhitelist([])).toBe('');
        expect(formatRetryStatusWhitelist(null)).toBe('');
        expect(formatRetryStatusWhitelist(undefined)).toBe('');
    });

    test('joins single codes with ", "', () => {
        expect(formatRetryStatusWhitelist([429])).toBe('429');
        expect(formatRetryStatusWhitelist([429, 503])).toBe('429, 503');
    });

    test('renders range as "A-B"', () => {
        expect(formatRetryStatusWhitelist([{ start: 500, end: 599 }])).toBe('500-599');
    });

    test('mixes single codes and ranges', () => {
        expect(formatRetryStatusWhitelist([429, { start: 500, end: 504 }]))
            .toBe('429, 500-504');
    });

    test('round-trips through parse', () => {
        const parsed = parseRetryStatusWhitelist('503, 429, 500-502, 500');
        expect(formatRetryStatusWhitelist(parsed)).toBe('429, 500-503');
    });
});

describe('matchesWhitelist', () => {
    test('empty list matches nothing', () => {
        expect(matchesWhitelist(429, [])).toBe(false);
        expect(matchesWhitelist(500, null)).toBe(false);
        expect(matchesWhitelist(500, undefined)).toBe(false);
    });

    test('matches single code entries', () => {
        expect(matchesWhitelist(429, [429])).toBe(true);
        expect(matchesWhitelist(500, [429])).toBe(false);
    });

    test('matches inside range (endpoints inclusive)', () => {
        const list = [{ start: 500, end: 599 }];
        expect(matchesWhitelist(500, list)).toBe(true);
        expect(matchesWhitelist(550, list)).toBe(true);
        expect(matchesWhitelist(599, list)).toBe(true);
        expect(matchesWhitelist(499, list)).toBe(false);
        expect(matchesWhitelist(600, list)).toBe(false);
    });

    test('matches across mixed entries', () => {
        const list = [429, { start: 500, end: 504 }];
        expect(matchesWhitelist(429, list)).toBe(true);
        expect(matchesWhitelist(502, list)).toBe(true);
        expect(matchesWhitelist(505, list)).toBe(false);
        expect(matchesWhitelist(403, list)).toBe(false);
    });
});
