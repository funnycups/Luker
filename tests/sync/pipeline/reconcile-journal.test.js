import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { journalPath, writeReconcileJournal, readReconcileJournal, deleteReconcileJournal } from '../../../src/sync/pipeline/reconcile-journal.js';

const L = 'a'.repeat(40);
const M = 'b'.repeat(40);
const CATS = ['characters', 'worlds'];

describe('reconcile journal', () => {
    let userRoot;
    beforeEach(() => { userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-journal-')); });
    afterEach(() => fs.rmSync(userRoot, { recursive: true, force: true }));

    test('lives in the backend shadow directory', () => {
        expect(journalPath({ userRoot, backendId: 'b1' })).toBe(path.join(userRoot, '.sync', 'b1', 'reconcile-journal.json'));
    });

    test('round-trips base target and categories', async () => {
        await writeReconcileJournal({ userRoot, backendId: 'b1', base: L, target: M, categories: CATS });
        expect(readReconcileJournal({ userRoot, backendId: 'b1' })).toEqual({ base: L, target: M, categories: CATS, advanceOnSkip: false });
        expect(JSON.parse(fs.readFileSync(journalPath({ userRoot, backendId: 'b1' }), 'utf8'))).toEqual({ version: 2, base: L, target: M, categories: CATS });
    });

    test('round-trips advanceOnSkip and keeps the version', async () => {
        await writeReconcileJournal({ userRoot, backendId: 'b1', base: L, target: M, categories: CATS, advanceOnSkip: true });
        expect(readReconcileJournal({ userRoot, backendId: 'b1' })).toEqual({ base: L, target: M, categories: CATS, advanceOnSkip: true });
        expect(JSON.parse(fs.readFileSync(journalPath({ userRoot, backendId: 'b1' }), 'utf8'))).toEqual({ version: 2, base: L, target: M, categories: CATS, advanceOnSkip: true });
    });

    test('rejects an advanceOnSkip that is not a boolean', async () => {
        await expect(writeReconcileJournal({ userRoot, backendId: 'b1', base: L, target: M, categories: CATS, advanceOnSkip: 'yes' })).rejects.toThrow(TypeError);
        const p = journalPath({ userRoot, backendId: 'b1' });
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify({ version: 2, base: L, target: M, categories: CATS, advanceOnSkip: 1 }));
        expect(() => readReconcileJournal({ userRoot, backendId: 'b1' })).toThrow(/unexpected shape/);
    });

    test('accepts a null base for a first pull', async () => {
        await writeReconcileJournal({ userRoot, backendId: 'b1', base: null, target: M, categories: CATS });
        expect(readReconcileJournal({ userRoot, backendId: 'b1' })).toEqual({ base: null, target: M, categories: CATS, advanceOnSkip: false });
    });

    test('a journal written without categories reads with null categories', () => {
        const p = journalPath({ userRoot, backendId: 'b1' });
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify({ version: 1, base: L, target: M }));
        expect(readReconcileJournal({ userRoot, backendId: 'b1' })).toEqual({ base: L, target: M, categories: null, advanceOnSkip: false });
    });

    test('absent journal reads as null and delete is idempotent', async () => {
        expect(readReconcileJournal({ userRoot, backendId: 'b1' })).toBeNull();
        await deleteReconcileJournal({ userRoot, backendId: 'b1' });
        await writeReconcileJournal({ userRoot, backendId: 'b1', base: L, target: M, categories: CATS });
        await deleteReconcileJournal({ userRoot, backendId: 'b1' });
        await deleteReconcileJournal({ userRoot, backendId: 'b1' });
        expect(readReconcileJournal({ userRoot, backendId: 'b1' })).toBeNull();
    });

    test('rewrites replace the file through a rename', async () => {
        await writeReconcileJournal({ userRoot, backendId: 'b1', base: L, target: M, categories: CATS });
        const before = fs.statSync(journalPath({ userRoot, backendId: 'b1' })).ino;
        await writeReconcileJournal({ userRoot, backendId: 'b1', base: M, target: L, categories: CATS });
        expect(fs.statSync(journalPath({ userRoot, backendId: 'b1' })).ino).not.toBe(before);
    });

    test('rejects invalid oids', async () => {
        await expect(writeReconcileJournal({ userRoot, backendId: 'b1', base: 'nope', target: M, categories: CATS })).rejects.toThrow(TypeError);
        await expect(writeReconcileJournal({ userRoot, backendId: 'b1', base: L, target: null, categories: CATS })).rejects.toThrow(TypeError);
    });

    test('rejects categories that are not a list of ids', async () => {
        await expect(writeReconcileJournal({ userRoot, backendId: 'b1', base: L, target: M })).rejects.toThrow(TypeError);
        await expect(writeReconcileJournal({ userRoot, backendId: 'b1', base: L, target: M, categories: 'worlds' })).rejects.toThrow(TypeError);
    });

    test('a malformed journal throws instead of being ignored', () => {
        const p = journalPath({ userRoot, backendId: 'b1' });
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, '{"version":1,"base":null}');
        expect(() => readReconcileJournal({ userRoot, backendId: 'b1' })).toThrow(/unexpected shape/);
        fs.writeFileSync(p, JSON.stringify({ version: 2, base: null, target: M, categories: [1] }));
        expect(() => readReconcileJournal({ userRoot, backendId: 'b1' })).toThrow(/unexpected shape/);
        fs.writeFileSync(p, '{trunc');
        expect(() => readReconcileJournal({ userRoot, backendId: 'b1' })).toThrow();
    });
});
