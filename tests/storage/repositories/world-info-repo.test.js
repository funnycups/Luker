import fs from 'node:fs';

import { CONTRACT_HARNESSES } from '../harness/contract-harness.js';
import { WorldInfoRepo } from '../../../src/storage/repositories/world-info-repo.js';
import { PatchTestFailedError } from '../../../src/storage/errors.js';

describe.each(CONTRACT_HARNESSES)('WorldInfoRepo on $name — basic CRUD', ({ make }) => {
    let h, repo;
    beforeEach(async () => {
        h = await make();
        fs.mkdirSync(h.dirs.worlds, { recursive: true });
        repo = new WorldInfoRepo({ engine: h.engine });
    });
    afterEach(() => h.cleanup());

    test('get returns null when no world exists', async () => {
        expect(await repo.get(h.handle, 'Nope')).toBeNull();
    });

    test('save then get round-trips', async () => {
        await repo.save(h.handle, 'MyWorld', { entries: { '0': { content: 'hi' } }, name: 'MyWorld' });
        const got = await repo.get(h.handle, 'MyWorld');
        expect(got.entries['0'].content).toBe('hi');
        expect(got.name).toBe('MyWorld');
    });

    test('save overwrites an existing world', async () => {
        await repo.save(h.handle, 'W', { entries: { '0': { content: 'a' } } });
        await repo.save(h.handle, 'W', { entries: { '0': { content: 'b' } } });
        expect((await repo.get(h.handle, 'W')).entries['0'].content).toBe('b');
    });

    test('save rejects doc without entries object', async () => {
        await expect(repo.save(h.handle, 'X', {})).rejects.toThrow();
        await expect(repo.save(h.handle, 'X', { entries: [] })).rejects.toThrow();
        await expect(repo.save(h.handle, 'X', { entries: null })).rejects.toThrow();
        await expect(repo.save(h.handle, 'X', null)).rejects.toThrow();
        await expect(repo.save(h.handle, 'X', [1, 2])).rejects.toThrow();
    });

    test('delete removes the world and returns true', async () => {
        await repo.save(h.handle, 'X', { entries: {} });
        expect(await repo.delete(h.handle, 'X')).toBe(true);
        expect(await repo.get(h.handle, 'X')).toBeNull();
    });

    test('delete returns false when missing', async () => {
        expect(await repo.delete(h.handle, 'Missing')).toBe(false);
    });

    test('exists is true after save and false otherwise', async () => {
        expect(await repo.exists(h.handle, 'Nope')).toBe(false);
        await repo.save(h.handle, 'My World', { entries: {} });
        expect(await repo.exists(h.handle, 'My World')).toBe(true);
    });
});

describe.each(CONTRACT_HARNESSES)('WorldInfoRepo on $name — patch', ({ make }) => {
    let h, repo;
    beforeEach(async () => {
        h = await make();
        fs.mkdirSync(h.dirs.worlds, { recursive: true });
        repo = new WorldInfoRepo({ engine: h.engine });
    });
    afterEach(() => h.cleanup());

    test('patch on missing world seeds {entries:{}} and applies', async () => {
        const next = await repo.patch(h.handle, 'New', [
            { op: 'add', path: '/entries/0', value: { content: 'a' } },
        ]);
        expect(next.entries['0'].content).toBe('a');
        const stored = await repo.get(h.handle, 'New');
        expect(stored.entries['0'].content).toBe('a');
    });

    test('patch on existing world applies json-patch ops', async () => {
        await repo.save(h.handle, 'X', { entries: { '0': { content: 'a' } } });
        const next = await repo.patch(h.handle, 'X', [
            { op: 'replace', path: '/entries/0/content', value: 'b' },
            { op: 'add', path: '/entries/1', value: { content: 'c' } },
        ]);
        expect(next.entries['0'].content).toBe('b');
        expect(next.entries['1'].content).toBe('c');
    });

    test('patch throws if result loses entries via remove', async () => {
        await repo.save(h.handle, 'X', { entries: {} });
        await expect(repo.patch(h.handle, 'X', [
            { op: 'remove', path: '/entries' },
        ])).rejects.toThrow(/entries/);
    });

    test('patch throws PatchTestFailedError on test op failure', async () => {
        await repo.save(h.handle, 'X', { entries: { '0': { content: 'a' } } });
        await expect(repo.patch(h.handle, 'X', [
            { op: 'test', path: '/entries/0/content', value: 'WRONG' },
        ])).rejects.toBeInstanceOf(PatchTestFailedError);
    });
});

describe.each(CONTRACT_HARNESSES)('WorldInfoRepo on $name — list and resolveName', ({ make }) => {
    let h, repo;
    beforeEach(async () => {
        h = await make();
        fs.mkdirSync(h.dirs.worlds, { recursive: true });
        repo = new WorldInfoRepo({ engine: h.engine });
    });
    afterEach(() => h.cleanup());

    test('list returns sorted entries with name + extensions', async () => {
        await repo.save(h.handle, 'B', { entries: {}, name: 'Bee', extensions: { tag: 'x' } });
        await repo.save(h.handle, 'A', { entries: {} });
        const list = await repo.list(h.handle);
        expect(list).toHaveLength(2);
        expect(list[0].key.name).toBe('A');
        expect(list[1].key.name).toBe('B');
        expect(list[1].name).toBe('Bee');
        expect(list[1].extensions).toEqual({ tag: 'x' });
        // fallback name when parsed.name is absent
        expect(list[0].name).toBe('A');
        expect(list[0].extensions).toEqual({});
    });

    test('list returns empty array when no worlds exist', async () => {
        const list = await repo.list(h.handle);
        expect(list).toEqual([]);
    });

    test('resolveName returns canonical filename for exact match', async () => {
        await repo.save(h.handle, 'MyWorld', { entries: {} });
        expect(await repo.resolveName(h.handle, 'MyWorld')).toBe('MyWorld.json');
    });

    test('resolveName returns null for missing world', async () => {
        expect(await repo.resolveName(h.handle, 'Nonexistent')).toBeNull();
    });

    test('resolveName returns null when file absent, canonical name when present', async () => {
        expect(await repo.resolveName(h.handle, 'Missing')).toBeNull();
        await repo.save(h.handle, 'Present', { entries: {} });
        expect(await repo.resolveName(h.handle, 'Present')).toBe('Present.json');
    });
});
