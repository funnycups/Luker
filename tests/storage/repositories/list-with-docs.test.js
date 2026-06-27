// Contract tests for the listWithDocs / listNames Repo extensions.
// These methods exist so endpoints (notably buildSettingsResponse)
// can ship preset/named-doc/world contents without a per-name N+1 round trip
// through the Repo. The actual endpoint coverage lives in
// tests/storage/endpoints/*; this file proves the Repo layer behaves
// identically across the four storage engines before any endpoint depends
// on it.

import { CONTRACT_HARNESSES } from '../harness/contract-harness.js';
import { PresetRepo } from '../../../src/storage/repositories/preset-repo.js';
import { NamedDocRepo } from '../../../src/storage/repositories/named-doc-repo.js';
import { WorldInfoRepo } from '../../../src/storage/repositories/world-info-repo.js';

describe.each(CONTRACT_HARNESSES)('PresetRepo.listWithDocs on $name', ({ make }) => {
    let h; let repo;
    beforeEach(async () => {
        h = await make();
        repo = new PresetRepo({ engine: h.engine });
    });
    afterEach(async () => { if (h) await h.cleanup(); });

    test('returns empty array when nothing saved', async () => {
        const out = await repo.listWithDocs(h.handle, 'openai');
        expect(out).toEqual([]);
    });

    test('returns name + full doc for every saved preset, sorted ASC', async () => {
        await repo.save(h.handle, 'openai', 'Zeta', { marker: 'z', temperature: 0.5 });
        await repo.save(h.handle, 'openai', 'Alpha', { marker: 'a', temperature: 0.1 });
        await repo.save(h.handle, 'openai', 'Mid', { marker: 'm', temperature: 0.3 });

        const out = await repo.listWithDocs(h.handle, 'openai');
        expect(out.map((e) => e.name)).toEqual(['Alpha', 'Mid', 'Zeta']);
        expect(out[0].doc.marker).toBe('a');
        expect(out[0].doc.temperature).toBe(0.1);
        expect(out[2].doc.marker).toBe('z');
    });

    test('scopes results to the requested apiId', async () => {
        await repo.save(h.handle, 'openai', 'shared-name', { marker: 'openai-side' });
        await repo.save(h.handle, 'novel', 'shared-name', { marker: 'novel-side' });

        const oa = await repo.listWithDocs(h.handle, 'openai');
        const nv = await repo.listWithDocs(h.handle, 'novel');

        expect(oa).toHaveLength(1);
        expect(oa[0].doc.marker).toBe('openai-side');
        expect(nv).toHaveLength(1);
        expect(nv[0].doc.marker).toBe('novel-side');
    });

    test('throws on invalid apiId', async () => {
        await expect(repo.listWithDocs(h.handle, 'not-an-api')).rejects.toThrow(/invalid apiId/);
    });
});

describe.each(CONTRACT_HARNESSES)('NamedDocRepo.listWithDocs on $name', ({ make }) => {
    let h; let repo;
    beforeEach(async () => {
        h = await make();
        repo = new NamedDocRepo({ engine: h.engine });
    });
    afterEach(async () => { if (h) await h.cleanup(); });

    test('returns empty array when nothing saved', async () => {
        const out = await repo.listWithDocs(h.handle, 'themes');
        expect(out).toEqual([]);
    });

    test('returns name + doc for every entry in bucket, sorted ASC', async () => {
        await repo.save(h.handle, 'themes', 'Dark', { bg: '#000' });
        await repo.save(h.handle, 'themes', 'Aqua', { bg: '#0ff' });
        await repo.save(h.handle, 'themes', 'Sand', { bg: '#fc0' });

        const out = await repo.listWithDocs(h.handle, 'themes');
        expect(out.map((e) => e.name)).toEqual(['Aqua', 'Dark', 'Sand']);
        expect(out[0].doc.bg).toBe('#0ff');
        expect(out[1].doc.bg).toBe('#000');
    });

    test('scopes results to the requested bucket', async () => {
        await repo.save(h.handle, 'themes', 'shared', { what: 'theme' });
        await repo.save(h.handle, 'movingUI', 'shared', { what: 'movingUI' });

        const t = await repo.listWithDocs(h.handle, 'themes');
        const m = await repo.listWithDocs(h.handle, 'movingUI');
        expect(t).toHaveLength(1);
        expect(t[0].doc.what).toBe('theme');
        expect(m).toHaveLength(1);
        expect(m[0].doc.what).toBe('movingUI');
    });

    test('throws on invalid bucket', async () => {
        await expect(repo.listWithDocs(h.handle, 'bogus')).rejects.toThrow(/invalid bucket/);
    });
});

describe.each(CONTRACT_HARNESSES)('WorldInfoRepo.listNames on $name', ({ make }) => {
    let h; let repo;
    beforeEach(async () => {
        h = await make();
        repo = new WorldInfoRepo({ engine: h.engine });
    });
    afterEach(async () => { if (h) await h.cleanup(); });

    test('returns empty array when no worlds saved', async () => {
        expect(await repo.listNames(h.handle)).toEqual([]);
    });

    test('returns sorted names of every saved world', async () => {
        await repo.save(h.handle, 'Zeta', { entries: {} });
        await repo.save(h.handle, 'Alpha', { entries: {} });
        await repo.save(h.handle, 'Mid', { entries: {} });

        expect(await repo.listNames(h.handle)).toEqual(['Alpha', 'Mid', 'Zeta']);
    });

    test('reflects deletes', async () => {
        await repo.save(h.handle, 'A', { entries: {} });
        await repo.save(h.handle, 'B', { entries: {} });
        await repo.delete(h.handle, 'A');
        expect(await repo.listNames(h.handle)).toEqual(['B']);
    });
});
