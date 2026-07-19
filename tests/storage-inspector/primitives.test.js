/* eslint-disable playwright/no-standalone-expect */
// playwright plugin misfires on jest `test.each` (reads as standalone expect).
// Every expect here is inside a jest test block.

import {
    CATEGORIES,
    CATEGORY_MAP,
    SENSITIVE_ROOT_FILES,
    isSensitiveRelPath,
    assertSafeSegment,
    StorageInspectorError,
} from '../../src/storage/inspector.js';

describe('storage inspector primitives', () => {
    describe('taxonomy', () => {
        test('has exactly 10 categories in stable order', () => {
            expect(CATEGORIES.map(c => c.key)).toEqual([
                'chats', 'characters', 'worlds', 'images', 'attachments',
                'presets', 'extensions', 'vectors', 'backups', 'other',
            ]);
        });

        test('every category has label / icon / colorVar / non-empty includes', () => {
            for (const cat of CATEGORIES) {
                expect(typeof cat.label).toBe('string');
                expect(cat.label.length).toBeGreaterThan(0);
                expect(typeof cat.icon).toBe('string');
                expect(cat.colorVar).toMatch(/^--storage-cat-/);
                expect(Array.isArray(cat.includes)).toBe(true);
                expect(cat.includes.length).toBeGreaterThan(0);
                for (const inc of cat.includes) {
                    expect(['dir', 'file', 'glob']).toContain(inc.kind);
                    expect(typeof inc.rel).toBe('string');
                }
            }
        });

        test('CATEGORY_MAP round-trips every category', () => {
            for (const cat of CATEGORIES) {
                expect(CATEGORY_MAP[cat.key]).toBe(cat);
            }
        });

        test('other category flags secrets.json as sensitive', () => {
            const secretsInc = CATEGORY_MAP.other.includes.find(i => i.rel === 'secrets.json');
            expect(secretsInc).toBeDefined();
            expect(secretsInc.sensitive).toBe(true);
        });
    });

    describe('SENSITIVE_ROOT_FILES', () => {
        test('contains secrets.json', () => {
            expect(SENSITIVE_ROOT_FILES.has('secrets.json')).toBe(true);
        });
    });

    describe('isSensitiveRelPath', () => {
        test.each([
            ['secrets.json', true],
            ['secrets.json/anything', true],           // 深入敏感文件仍算敏感
            ['chats/foo/bar.jsonl', false],
            ['characters/Sera.png', false],
            ['', false],
        ])('%s → %s', (relPath, expected) => {
            expect(isSensitiveRelPath(relPath)).toBe(expected);
        });
    });

    describe('assertSafeSegment', () => {
        test('accepts plain filenames', () => {
            expect(() => assertSafeSegment('Seraphina.png')).not.toThrow();
            expect(() => assertSafeSegment('some chat.jsonl')).not.toThrow();
            expect(() => assertSafeSegment('_hidden')).not.toThrow();
        });

        test.each([
            ['', 'empty'],
            ['..', 'traversal'],
            ['a/b', 'contains slash'],
            ['a\\b', 'contains backslash'],
            ['a\0b', 'null byte'],
            ['/absolute', 'absolute path'],
            ['C:\\Windows', 'windows abs'],
        ])('rejects %s (%s)', (seg) => {
            expect(() => assertSafeSegment(seg)).toThrow(StorageInspectorError);
        });

        test('non-string throws', () => {
            expect(() => assertSafeSegment(null)).toThrow(StorageInspectorError);
            expect(() => assertSafeSegment(42)).toThrow(StorageInspectorError);
            expect(() => assertSafeSegment(undefined)).toThrow(StorageInspectorError);
        });

        test('error carries E_INVALID_PATH code', () => {
            expect(() => assertSafeSegment('..')).toThrow(
                expect.objectContaining({ code: 'E_INVALID_PATH' }),
            );
        });
    });

    describe('StorageInspectorError', () => {
        test('carries code and message', () => {
            const err = new StorageInspectorError('E_NOT_INSPECTABLE', 'secrets are secret');
            expect(err).toBeInstanceOf(Error);
            expect(err.code).toBe('E_NOT_INSPECTABLE');
            expect(err.message).toBe('secrets are secret');
        });
    });
});
