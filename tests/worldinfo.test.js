import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, test, expect, afterEach } from '@jest/globals';
import {
    findMatchingWorldInfoFilename,
    normalizeWorldInfoFile,
    readWorldInfoFile,
    resolveWorldInfoFilename,
    sanitizeImportedWorldInfoFilename,
} from '../src/endpoints/worldinfo.js';

const tempDirs = [];

afterEach(() => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function createTempWorldDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-worldinfo-'));
    tempDirs.push(dir);
    return dir;
}

describe('world info filename resolution', () => {
    test('should resolve the raw filename when the basename has trailing whitespace', () => {
        const directory = createTempWorldDir();
        const filename = 'Example Book .json';
        fs.writeFileSync(path.join(directory, filename), JSON.stringify({ entries: { '0': { key: ['x'] } } }));

        expect(findMatchingWorldInfoFilename([filename], 'Example Book')).toBe(filename);
        expect(resolveWorldInfoFilename(directory, 'Example Book')).toBe(filename);
        expect(readWorldInfoFile({ worlds: directory }, 'Example Book', false)).toEqual({ entries: { '0': { key: ['x'] } } });
    });

    test('should keep tolerant emoji matching while returning the exact stored filename', () => {
        const directory = createTempWorldDir();
        const filename = '❤️World.json';
        fs.writeFileSync(path.join(directory, filename), JSON.stringify({ entries: {} }));

        expect(resolveWorldInfoFilename(directory, '❤World')).toBe(filename);
    });
});

describe('world info import filename sanitization', () => {
    test('should trim whitespace before the json extension for imported files', () => {
        expect(sanitizeImportedWorldInfoFilename('Example Book .json')).toBe('Example Book.json');
        expect(sanitizeImportedWorldInfoFilename('v1.2 .json')).toBe('v1.2.json');
    });
});

describe('normalizeWorldInfoFile', () => {
    test('keeps a well-shaped object unchanged', () => {
        const file = { entries: { '0': { uid: 0, content: 'hi' } }, name: 'X' };
        const { file: out, changed } = normalizeWorldInfoFile(file);
        expect(changed).toBe(false);
        expect(out).toBe(file);
    });

    test('reduces a [null, null, {uid:66,...}] array into a uid-keyed object', () => {
        const sparse = new Array(66);
        sparse[66] = { uid: 66, content: 'survivor' };
        const { file: out, changed } = normalizeWorldInfoFile({ entries: sparse, name: 'BadBook' });
        expect(changed).toBe(true);
        expect(Array.isArray(out.entries)).toBe(false);
        expect(out.entries).toEqual({ '66': { uid: 66, content: 'survivor' } });
        expect(out.name).toBe('BadBook');
    });

    test('falls back to the array index when an entry has no usable uid', () => {
        const { file: out, changed } = normalizeWorldInfoFile({
            entries: [null, { content: 'no uid here' }, { uid: 'not-a-number', content: 'bad uid' }],
        });
        expect(changed).toBe(true);
        expect(out.entries).toEqual({
            '1': { uid: 1, content: 'no uid here' },
            '2': { uid: 2, content: 'bad uid' },
        });
    });

    test('returns non-object inputs untouched', () => {
        expect(normalizeWorldInfoFile(null)).toEqual({ file: null, changed: false });
        expect(normalizeWorldInfoFile([1, 2])).toEqual({ file: [1, 2], changed: false });
    });

    test('heals originalData.entries items that only carry id (legacy convertCharacterBook output)', () => {
        const file = {
            entries: {
                '0': { uid: 0, content: 'A' },
                '2': { uid: 2, content: 'C' },
            },
            originalData: {
                entries: [
                    { id: 0, content: 'A', comment: 'kept' },
                    { id: 1, content: 'B', comment: 'STALE' },
                    { id: 2, content: 'C' },
                ],
            },
        };
        const { file: out, changed } = normalizeWorldInfoFile(file);
        expect(changed).toBe(true);
        expect(Array.isArray(out.originalData.entries)).toBe(true);
        for (const entry of out.originalData.entries) {
            expect(entry.uid).toBe(entry.id);
        }
    });

    test('keeps originalData entries that already carry uid unchanged', () => {
        const file = {
            entries: { '0': { uid: 0 } },
            originalData: {
                entries: [{ id: 0, uid: 0, comment: 'ok' }],
            },
        };
        const { file: out, changed } = normalizeWorldInfoFile(file);
        expect(changed).toBe(false);
        expect(out).toBe(file);
    });

    test('falls back to array index when an originalData entry lacks both id and uid', () => {
        const file = {
            entries: { '0': { uid: 0 }, '5': { uid: 5 } },
            originalData: {
                entries: [{ content: 'no id' }, { id: 5, content: 'kept' }],
            },
        };
        const { file: out, changed } = normalizeWorldInfoFile(file);
        expect(changed).toBe(true);
        expect(out.originalData.entries[0].uid).toBe(0);
        expect(out.originalData.entries[1].uid).toBe(5);
    });

    test('leaves originalData alone when it is not the documented shape', () => {
        const file = {
            entries: { '0': { uid: 0 } },
            originalData: { entries: 'not an array' },
        };
        const { file: out, changed } = normalizeWorldInfoFile(file);
        expect(changed).toBe(false);
        expect(out).toBe(file);
    });

    test('drops originalData entries whose uid is absent from the live entries map', () => {
        const file = {
            entries: {
                '0': { uid: 0, comment: 'kept-A' },
                '2': { uid: 2, comment: 'kept-C' },
            },
            originalData: {
                entries: [
                    { id: 0, uid: 0, comment: 'kept-A' },
                    { id: 1, uid: 1, comment: 'ORPHAN-B' },
                    { id: 2, uid: 2, comment: 'kept-C' },
                ],
            },
        };
        const { file: out, changed } = normalizeWorldInfoFile(file);
        expect(changed).toBe(true);
        const comments = out.originalData.entries.map((e) => e.comment);
        expect(comments).toEqual(['kept-A', 'kept-C']);
    });

    test('does not drop originalData entries when the live entries map is missing or empty', () => {
        const file = {
            entries: {},
            originalData: {
                entries: [{ id: 0, uid: 0, comment: 'lonely' }],
            },
        };
        const { file: out, changed } = normalizeWorldInfoFile(file);
        expect(changed).toBe(false);
        expect(out).toBe(file);
    });
});
