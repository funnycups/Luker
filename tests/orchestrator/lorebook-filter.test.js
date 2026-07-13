// tests/orchestrator/lorebook-filter.test.js
import { describe, test, expect, jest } from '@jest/globals';
import {
    sanitizeLorebookFilter,
    compileLorebookFilter,
    applyLorebookFilterPatchArgs,
    applyProfileWorldInfoFilter,
} from '../../public/scripts/extensions/orchestrator/lorebook-filter.js';

describe('sanitizeLorebookFilter', () => {
    test('non-object input → empty', () => {
        expect(sanitizeLorebookFilter(null)).toEqual({ bookPattern: '', entryPattern: '' });
        expect(sanitizeLorebookFilter(undefined)).toEqual({ bookPattern: '', entryPattern: '' });
        expect(sanitizeLorebookFilter('foo')).toEqual({ bookPattern: '', entryPattern: '' });
        expect(sanitizeLorebookFilter(42)).toEqual({ bookPattern: '', entryPattern: '' });
    });
    test('missing fields → empty strings', () => {
        expect(sanitizeLorebookFilter({})).toEqual({ bookPattern: '', entryPattern: '' });
    });
    test('coerces values to strings', () => {
        expect(sanitizeLorebookFilter({ bookPattern: 123, entryPattern: null }))
            .toEqual({ bookPattern: '123', entryPattern: '' });
    });
    test('passes valid multiline strings through', () => {
        const input = { bookPattern: '^private$\n^secret_.*$', entryPattern: 'foo' };
        expect(sanitizeLorebookFilter(input)).toEqual(input);
    });
});

describe('compileLorebookFilter', () => {
    test('empty filter isEmpty=true, test always false', () => {
        const c = compileLorebookFilter({ bookPattern: '', entryPattern: '' });
        expect(c.isEmpty).toBe(true);
        expect(c.test('any', 'thing')).toBe(false);
    });
    test('book pattern only matches book name', () => {
        const c = compileLorebookFilter({ bookPattern: '^private$', entryPattern: '' });
        expect(c.isEmpty).toBe(false);
        expect(c.test('private', 'anything')).toBe(true);
        expect(c.test('public', 'anything')).toBe(false);
    });
    test('entry pattern only matches comment', () => {
        const c = compileLorebookFilter({ bookPattern: '', entryPattern: '^secret_' });
        expect(c.test('any', 'secret_key')).toBe(true);
        expect(c.test('any', 'public_key')).toBe(false);
    });
    test('multiline: any line matches → true', () => {
        const c = compileLorebookFilter({ bookPattern: '^a$\n^b$\n^c$', entryPattern: '' });
        expect(c.test('a', '')).toBe(true);
        expect(c.test('b', '')).toBe(true);
        expect(c.test('d', '')).toBe(false);
    });
    test('empty lines ignored', () => {
        const c = compileLorebookFilter({ bookPattern: '\n\n^x$\n', entryPattern: '' });
        expect(c.bookRegexes.length).toBe(1);
        expect(c.test('x', '')).toBe(true);
    });
    test('invalid regex line skipped with console warn', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const c = compileLorebookFilter({ bookPattern: '[bad(regex\n^good$', entryPattern: '' });
        expect(c.bookRegexes.length).toBe(1);
        expect(c.test('good', '')).toBe(true);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
    test('book OR entry semantics — either dimension match filters', () => {
        const c = compileLorebookFilter({ bookPattern: '^private$', entryPattern: '^secret_' });
        expect(c.test('private', 'public_key')).toBe(true);  // book match
        expect(c.test('public', 'secret_key')).toBe(true);   // entry match
        expect(c.test('public', 'public_key')).toBe(false);  // neither
    });
});

describe('applyProfileWorldInfoFilter', () => {
    function makePayload({ before = [], after = [], depth = [], outlets = {}, anBefore = [], anAfter = [], examples = [], entries = [] } = {}) {
        return {
            worldInfoBeforeEntries: before,
            worldInfoAfterEntries: after,
            worldInfoDepth: depth,
            outletEntries: outlets,
            anBefore,
            anAfter,
            worldInfoExamples: examples,
            worldInfoResolution: { activatedEntries: entries },
        };
    }

    test('empty filter no-ops', () => {
        const p = makePayload({ before: ['A', 'B'], entries: [] });
        applyProfileWorldInfoFilter(p, { bookPattern: '', entryPattern: '' });
        expect(p.worldInfoBeforeEntries).toEqual(['A', 'B']);
    });

    test('book match drops all entries of that book across all channels', () => {
        const entries = [
            { world: 'private', uid: 1, comment: 'x', content: 'PA', position: 0 },
            { world: 'private', uid: 2, comment: 'y', content: 'PB', position: 1 },
            { world: 'public',  uid: 3, comment: 'z', content: 'QA', position: 0 },
        ];
        const p = makePayload({
            before: ['PA', 'QA'],
            after: ['PB'],
            entries,
        });
        applyProfileWorldInfoFilter(p, { bookPattern: '^private$', entryPattern: '' });
        expect(p.worldInfoBeforeEntries).toEqual(['QA']);
        expect(p.worldInfoAfterEntries).toEqual([]);
    });

    test('entry comment match drops single entry only', () => {
        const entries = [
            { world: 'x', uid: 1, comment: 'secret_key', content: 'S', position: 0 },
            { world: 'x', uid: 2, comment: 'public_key', content: 'P', position: 0 },
        ];
        const p = makePayload({ before: ['S', 'P'], entries });
        applyProfileWorldInfoFilter(p, { bookPattern: '', entryPattern: '^secret_' });
        expect(p.worldInfoBeforeEntries).toEqual(['P']);
    });

    test('unknown string (not in activatedEntries) is preserved (default allow)', () => {
        const p = makePayload({ before: ['UNKNOWN'], entries: [] });
        applyProfileWorldInfoFilter(p, { bookPattern: '^anything$', entryPattern: '' });
        expect(p.worldInfoBeforeEntries).toEqual(['UNKNOWN']);
    });

    test('depth buckets filtered in place, empty buckets retained', () => {
        const entries = [
            { world: 'x', uid: 1, comment: 'a', content: 'A', position: 4, depth: 2, role: 0 },
            { world: 'x', uid: 2, comment: 'b', content: 'B', position: 4, depth: 2, role: 0 },
        ];
        const p = makePayload({
            depth: [{ depth: 2, role: 0, entries: ['A', 'B'] }],
            entries,
        });
        applyProfileWorldInfoFilter(p, { bookPattern: '', entryPattern: '^a$' });
        expect(p.worldInfoDepth).toEqual([{ depth: 2, role: 0, entries: ['B'] }]);
    });

    test('outletEntries per-key filter, empty arrays retained', () => {
        const entries = [
            { world: 'x', uid: 1, comment: 'a', content: 'A', position: 100 },
        ];
        const p = makePayload({ outlets: { slot1: ['A'] }, entries });
        applyProfileWorldInfoFilter(p, { bookPattern: '', entryPattern: '^a$' });
        expect(p.outletEntries).toEqual({ slot1: [] });
    });

    test('anBefore/anAfter/worldInfoExamples all filtered by content lookup', () => {
        const entries = [
            { world: 'x', uid: 1, comment: 'an', content: 'ANB', position: 2 },
            { world: 'x', uid: 2, comment: 'an', content: 'ANA', position: 3 },
            { world: 'x', uid: 3, comment: 'ex', content: 'EX', position: 5 },
        ];
        const p = makePayload({ anBefore: ['ANB'], anAfter: ['ANA'], examples: [{ content: 'EX', position: 5 }], entries });
        applyProfileWorldInfoFilter(p, { bookPattern: '', entryPattern: '^(an|ex)$' });
        expect(p.anBefore).toEqual([]);
        expect(p.anAfter).toEqual([]);
        expect(p.worldInfoExamples).toEqual([]);
    });
});

describe('applyLorebookFilterPatchArgs', () => {
    test('book dimension patches bookPattern', () => {
        const current = { bookPattern: '', entryPattern: 'e' };
        const next = applyLorebookFilterPatchArgs(current, { pattern: '^new$' }, { dimension: 'book' });
        expect(next).toEqual({ bookPattern: '^new$', entryPattern: 'e' });
    });
    test('entry dimension patches entryPattern', () => {
        const current = { bookPattern: 'b', entryPattern: '' };
        const next = applyLorebookFilterPatchArgs(current, { pattern: '^new$' }, { dimension: 'entry' });
        expect(next).toEqual({ bookPattern: 'b', entryPattern: '^new$' });
    });
    test('empty pattern clears dimension', () => {
        const current = { bookPattern: 'old', entryPattern: '' };
        const next = applyLorebookFilterPatchArgs(current, { pattern: '' }, { dimension: 'book' });
        expect(next.bookPattern).toBe('');
    });
    test('missing pattern arg → invalid_args', () => {
        expect(() =>
            applyLorebookFilterPatchArgs({ bookPattern: '', entryPattern: '' }, {}, { dimension: 'book' })
        ).toThrow(/invalid_args/);
    });
    test('non-string pattern → invalid_args', () => {
        expect(() =>
            applyLorebookFilterPatchArgs({ bookPattern: '', entryPattern: '' }, { pattern: 42 }, { dimension: 'book' })
        ).toThrow(/invalid_args/);
    });
    test('invalid regex line → invalid_args with line number', () => {
        expect(() =>
            applyLorebookFilterPatchArgs({ bookPattern: '', entryPattern: '' }, { pattern: '^ok$\n[bad(regex' }, { dimension: 'book' })
        ).toThrow(/invalid_args.*line 2/);
    });
    test('unchanged pattern → noop', () => {
        expect(() =>
            applyLorebookFilterPatchArgs({ bookPattern: '^same$', entryPattern: '' }, { pattern: '^same$' }, { dimension: 'book' })
        ).toThrow(/noop/);
    });
    test('unknown dimension → invalid_args', () => {
        expect(() =>
            applyLorebookFilterPatchArgs({ bookPattern: '', entryPattern: '' }, { pattern: 'x' }, { dimension: 'weird' })
        ).toThrow(/invalid_args/);
    });
});
