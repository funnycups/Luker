import { CONTRACT_HARNESSES, makeTempFsEngineHarness } from '../harness/contract-harness.js';
import { NamedDocRepo } from '../../../src/storage/repositories/named-doc-repo.js';
import { NotFoundError } from '../../../src/storage/errors.js';
import fs from 'node:fs';
import path from 'node:path';

describe.each(CONTRACT_HARNESSES)('NamedDocRepo on $name', ({ make }) => {
    let h, repo;
    beforeEach(async () => {
        h = await make();
        for (const dir of [h.dirs.themes, h.dirs.movingUI, h.dirs.quickreplies]) {
            fs.mkdirSync(dir, { recursive: true });
        }
        repo = new NamedDocRepo({ engine: h.engine });
    });
    afterEach(() => h.cleanup());

    test('delete returns true when present', async () => {
        await repo.save(h.handle, 'themes', 'X', {});
        expect(await repo.delete(h.handle, 'themes', 'X')).toBe(true);
    });

    test('delete returns false when missing (default permissive)', async () => {
        expect(await repo.delete(h.handle, 'themes', 'Missing')).toBe(false);
    });

    test('delete with strict throws NotFoundError when missing', async () => {
        await expect(repo.delete(h.handle, 'themes', 'Missing', { strict: true }))
            .rejects.toBeInstanceOf(NotFoundError);
    });

    test('invalid bucket throws', () => {
        expect(() => repo._key(h.handle, 'invalid', 'x')).toThrow(/invalid bucket/);
    });

    test('get returns the doc after save, null when missing', async () => {
        await repo.save(h.handle, 'themes', 'Dark', { bg: '#000' });
        expect(await repo.get(h.handle, 'themes', 'Dark')).toEqual({ bg: '#000' });
        expect(await repo.get(h.handle, 'themes', 'Nope')).toBeNull();
    });

    test('list returns saved names sorted, scoped to bucket', async () => {
        await repo.save(h.handle, 'themes', 'Charlie', {});
        await repo.save(h.handle, 'themes', 'Alpha', {});
        await repo.save(h.handle, 'themes', 'Bravo', {});
        await repo.save(h.handle, 'movingUI', 'Other', {});
        const themes = await repo.list(h.handle, 'themes');
        expect(themes.map((e) => e.key.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
        const moving = await repo.list(h.handle, 'movingUI');
        expect(moving.map((e) => e.key.name)).toEqual(['Other']);
    });

    test('list returns empty when no docs saved', async () => {
        expect(await repo.list(h.handle, 'themes')).toEqual([]);
    });

    test('list throws on invalid bucket', async () => {
        await expect(repo.list(h.handle, 'invalid')).rejects.toThrow(/invalid bucket/);
    });
});

describe('NamedDocRepo — FS-only observation', () => {
    // NamedDocRepo exposes only save + delete (no get/list). On FsEngine, the on-disk file
    // is the only observable side-effect; SqliteEngine stores rows in named_docs but does
    // not expose a query path through the Repo, so these checks are necessarily FS-only.
    let h, repo;
    beforeEach(async () => {
        h = await makeTempFsEngineHarness();
        for (const dir of [h.dirs.themes, h.dirs.movingUI, h.dirs.quickreplies]) {
            fs.mkdirSync(dir, { recursive: true });
        }
        repo = new NamedDocRepo({ engine: h.engine });
    });
    afterEach(() => h.cleanup());

    test('delete actually removes the on-disk file', async () => {
        await repo.save(h.handle, 'themes', 'X', {});
        await repo.delete(h.handle, 'themes', 'X');
        expect(fs.existsSync(path.join(h.dirs.themes, 'X.json'))).toBe(false);
    });

    test('save sanitizes name (path traversal blocked)', async () => {
        await repo.save(h.handle, 'themes', '../../escaped', { v: 1 });
        // sanitize-filename strips slashes (parent-traversal segments collapse to dots), so the
        // file must land inside the bucket dir with no path separator in its name.
        const entries = fs.readdirSync(h.dirs.themes);
        expect(entries.length).toBe(1);
        expect(entries[0]).not.toContain('/');
        expect(entries[0]).not.toContain(path.sep);
        expect(entries[0].endsWith('.json')).toBe(true);
    });
});
