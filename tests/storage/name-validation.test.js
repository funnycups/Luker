import { assertSafeRepoName } from '../../src/storage/name-validation.js';
import { InvalidArgumentError } from '../../src/storage/errors.js';

describe('assertSafeRepoName', () => {
    test('accepts ASCII names', () => {
        expect(assertSafeRepoName('MyPreset')).toBe('MyPreset');
        expect(assertSafeRepoName('preset-1_v2')).toBe('preset-1_v2');
    });

    test('accepts CJK and emoji', () => {
        expect(assertSafeRepoName('我的预设')).toBe('我的预设');
        expect(assertSafeRepoName('🔥preset')).toBe('🔥preset');
    });

    test('trims whitespace', () => {
        expect(assertSafeRepoName('  Foo  ')).toBe('Foo');
    });

    test('rejects empty / whitespace-only', () => {
        expect(() => assertSafeRepoName('')).toThrow(InvalidArgumentError);
        expect(() => assertSafeRepoName('   ')).toThrow(InvalidArgumentError);
        expect(() => assertSafeRepoName(null)).toThrow(InvalidArgumentError);
        expect(() => assertSafeRepoName(undefined)).toThrow(InvalidArgumentError);
    });

    test('rejects names that look like filenames', () => {
        expect(() => assertSafeRepoName('Foo.json')).toThrow(/must not end with ".json"/);
        expect(() => assertSafeRepoName('chat.jsonl')).toThrow(/must not end with ".jsonl"/);
        expect(() => assertSafeRepoName('FOO.JSON')).toThrow(/must not end with ".json"/);
    });

    test('rejects names with path separators', () => {
        expect(() => assertSafeRepoName('Foo/Bar')).toThrow(InvalidArgumentError);
        expect(() => assertSafeRepoName('Foo\\Bar')).toThrow(InvalidArgumentError);
    });

    test('rejects names with reserved or control characters', () => {
        expect(() => assertSafeRepoName('Foo:Bar')).toThrow(InvalidArgumentError);
        expect(() => assertSafeRepoName('Foo*Bar')).toThrow(InvalidArgumentError);
        expect(() => assertSafeRepoName('Foo?Bar')).toThrow(InvalidArgumentError);
        expect(() => assertSafeRepoName('Foo\x00Bar')).toThrow(InvalidArgumentError);
    });

    test('rejects names exceeding 128 bytes', () => {
        const long = 'a'.repeat(129);
        expect(() => assertSafeRepoName(long)).toThrow(/exceeds 128 bytes/);
        // Boundary: exactly 128 bytes is fine.
        expect(assertSafeRepoName('a'.repeat(128))).toHaveLength(128);
        // Multi-byte chars count by UTF-8 bytes, not characters.
        const utf8Heavy = '我'.repeat(43); // 43 * 3 = 129 bytes
        expect(() => assertSafeRepoName(utf8Heavy)).toThrow(/exceeds 128 bytes/);
    });

    test('uses custom field name in error', () => {
        expect(() => assertSafeRepoName('', { field: 'newName' })).toThrow(/newName is required/);
        expect(() => assertSafeRepoName('Foo/Bar', { field: 'newName' })).toThrow(/newName contains characters/);
    });
});
