import { assertSafeRepoName, assertSafeRepoNameShape } from '../../src/storage/name-validation.js';
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

describe('assertSafeRepoNameShape', () => {
    // Shape-only variant is what engine put layers call so pre-validation
    // legacy data (chat/preset/world names written before the length limit
    // existed) can still flow through save/append/patch/rename. It must
    // keep every character / suffix guard from the full check but drop the
    // 128-byte cap.

    test('accepts the same well-formed names as the full check', () => {
        expect(assertSafeRepoNameShape('MyPreset')).toBe('MyPreset');
        expect(assertSafeRepoNameShape('我的预设')).toBe('我的预设');
        expect(assertSafeRepoNameShape('🔥preset')).toBe('🔥preset');
        expect(assertSafeRepoNameShape('  Foo  ')).toBe('Foo');
    });

    test('accepts names exceeding 128 bytes but within FS filename limits', () => {
        // ASCII long name — legacy chat.name that predates the length limit
        // must still put/rename/append/patch without a 400.
        const long = 'a'.repeat(200);
        expect(assertSafeRepoNameShape(long)).toBe(long);
        // Multi-byte: 60 CJK chars = 180 UTF-8 bytes, still under the FS
        // filename ceiling (~255 bytes; sanitize-filename truncates past
        // that, so shape rejects anything larger — enforce with the FS
        // engine round-trip test, not here).
        const utf8Heavy = '我'.repeat(60);
        expect(assertSafeRepoNameShape(utf8Heavy)).toBe(utf8Heavy);
    });

    test('still rejects empty / whitespace-only', () => {
        expect(() => assertSafeRepoNameShape('')).toThrow(InvalidArgumentError);
        expect(() => assertSafeRepoNameShape('   ')).toThrow(InvalidArgumentError);
        expect(() => assertSafeRepoNameShape(null)).toThrow(InvalidArgumentError);
        expect(() => assertSafeRepoNameShape(undefined)).toThrow(InvalidArgumentError);
    });

    test('still rejects filename-shaped names', () => {
        expect(() => assertSafeRepoNameShape('Foo.json')).toThrow(/must not end with ".json"/);
        expect(() => assertSafeRepoNameShape('chat.jsonl')).toThrow(/must not end with ".jsonl"/);
    });

    test('still rejects character-unsafe names (sanitize would rewrite)', () => {
        expect(() => assertSafeRepoNameShape('Foo/Bar')).toThrow(InvalidArgumentError);
        expect(() => assertSafeRepoNameShape('Foo\\Bar')).toThrow(InvalidArgumentError);
        expect(() => assertSafeRepoNameShape('Foo:Bar')).toThrow(InvalidArgumentError);
        expect(() => assertSafeRepoNameShape('Foo\x00Bar')).toThrow(InvalidArgumentError);
    });

    test('propagates custom field name in error', () => {
        expect(() => assertSafeRepoNameShape('', { field: 'chat.name' })).toThrow(/chat\.name is required/);
        expect(() => assertSafeRepoNameShape('Foo/Bar', { field: 'chat.name' })).toThrow(/chat\.name contains characters/);
    });
});
