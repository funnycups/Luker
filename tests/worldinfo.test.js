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
});
