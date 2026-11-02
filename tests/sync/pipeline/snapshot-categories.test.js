import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    snapshotCategoriesPath,
    readSnapshotCategories,
    writeSnapshotCategories,
    markCategoriesSynced,
} from '../../../src/sync/pipeline/snapshot-categories.js';

const L = 'a'.repeat(40);
const M = 'b'.repeat(40);

describe('snapshot category record', () => {
    let userRoot;
    beforeEach(() => { userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-snapcats-')); });
    afterEach(() => fs.rmSync(userRoot, { recursive: true, force: true }));

    const write = body => {
        const file = snapshotCategoriesPath({ userRoot, backendId: 'b1' });
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(body));
    };

    test('absent record reads as null and a write round-trips', async () => {
        expect(snapshotCategoriesPath({ userRoot, backendId: 'b1' })).toBe(path.join(userRoot, '.sync', 'b1', 'snapshot-categories.json'));
        expect(readSnapshotCategories({ userRoot, backendId: 'b1' })).toBeNull();
        await writeSnapshotCategories({ userRoot, backendId: 'b1', categories: ['characters', 'worlds'], syncedAt: { characters: L, worlds: M } });
        expect(readSnapshotCategories({ userRoot, backendId: 'b1' })).toEqual({ categories: ['characters', 'worlds'], syncedAt: { characters: L, worlds: M } });
    });

    test('a record without sync points reads with none', () => {
        write({ version: 1, categories: ['characters'] });
        expect(readSnapshotCategories({ userRoot, backendId: 'b1' })).toEqual({ categories: ['characters'], syncedAt: {} });
    });

    test('a malformed record throws', () => {
        write({ version: 1, categories: 'characters' });
        expect(() => readSnapshotCategories({ userRoot, backendId: 'b1' })).toThrow(/unexpected shape/);
        write({ version: 2, categories: ['characters'], syncedAt: { characters: 'nope' } });
        expect(() => readSnapshotCategories({ userRoot, backendId: 'b1' })).toThrow(/unexpected shape/);
    });

    test('rejects a sync point that is not a commit oid', async () => {
        await expect(writeSnapshotCategories({ userRoot, backendId: 'b1', categories: ['worlds'], syncedAt: { worlds: null } })).rejects.toThrow(TypeError);
    });

    test('marking categories synced moves only those categories', async () => {
        await markCategoriesSynced({ userRoot, backendId: 'b1', categories: ['worlds'], oid: M });
        expect(readSnapshotCategories({ userRoot, backendId: 'b1' })).toBeNull();
        await writeSnapshotCategories({ userRoot, backendId: 'b1', categories: ['characters'], syncedAt: { characters: L, worlds: L } });
        await markCategoriesSynced({ userRoot, backendId: 'b1', categories: ['worlds'], oid: M });
        expect(readSnapshotCategories({ userRoot, backendId: 'b1' })).toEqual({ categories: ['characters'], syncedAt: { characters: L, worlds: M } });
    });
});
