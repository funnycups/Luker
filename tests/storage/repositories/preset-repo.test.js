import { PresetRepo } from '../../../src/storage/repositories/preset-repo.js';
import { ConflictError, NotFoundError } from '../../../src/storage/errors.js';
import { CONTRACT_HARNESSES } from '../harness/contract-harness.js';

describe.each(CONTRACT_HARNESSES)('PresetRepo on $name — basic CRUD', ({ make }) => {
    let h, repo;
    beforeEach(async () => {
        h = await make();
        repo = new PresetRepo({ engine: h.engine });
    });
    afterEach(() => h.cleanup());

    test('get returns null when preset missing', async () => {
        const r = await repo.get(h.handle, 'openai', 'absent');
        expect(r).toBeNull();
    });

    test('save then get round-trips an OpenAI preset', async () => {
        const doc = { temperature: 0.7, top_p: 0.95, prompts: [{ name: 'a', content: 'hi' }] };
        await repo.save(h.handle, 'openai', 'mypreset', doc);
        expect(await repo.get(h.handle, 'openai', 'mypreset')).toEqual(doc);
    });

    test('save overwrites an existing preset', async () => {
        await repo.save(h.handle, 'openai', 'p', { a: 1 });
        await repo.save(h.handle, 'openai', 'p', { b: 2 });
        expect(await repo.get(h.handle, 'openai', 'p')).toEqual({ b: 2 });
    });

    test('exists is true after save and false otherwise', async () => {
        expect(await repo.exists(h.handle, 'openai', 'x')).toBe(false);
        await repo.save(h.handle, 'openai', 'x', { a: 1 });
        expect(await repo.exists(h.handle, 'openai', 'x')).toBe(true);
    });

    test('delete returns true when present and cascades sidecars', async () => {
        await repo.save(h.handle, 'openai', 'p', { a: 1 });
        await repo.setState(h.handle, 'openai', 'p', 'ns_one', { v: 1 });
        await repo.setState(h.handle, 'openai', 'p', 'ns_two', { v: 2 });

        const result = await repo.delete(h.handle, 'openai', 'p');
        expect(result).toBe(true);

        expect(await repo.get(h.handle, 'openai', 'p')).toBeNull();
        expect(await repo.getState(h.handle, 'openai', 'p', 'ns_one')).toBeNull();
        expect(await repo.getState(h.handle, 'openai', 'p', 'ns_two')).toBeNull();
    });

    test('delete on missing preset returns false', async () => {
        const result = await repo.delete(h.handle, 'openai', 'ghost');
        expect(result).toBe(false);
    });

    test('save/get routes per apiId mapping', async () => {
        await repo.save(h.handle, 'novel', 'nv', { n: 1 });
        await repo.save(h.handle, 'instruct', 'ins', { i: 1 });
        await repo.save(h.handle, 'sysprompt', 'sp', { s: 1 });
        expect(await repo.get(h.handle, 'novel', 'nv')).toEqual({ n: 1 });
        expect(await repo.get(h.handle, 'instruct', 'ins')).toEqual({ i: 1 });
        expect(await repo.get(h.handle, 'sysprompt', 'sp')).toEqual({ s: 1 });
        // Cross-API isolation: openai bucket should not see novel preset.
        expect(await repo.get(h.handle, 'openai', 'nv')).toBeNull();
    });

    test('kobold and koboldhorde resolve to the same shared bucket', async () => {
        await repo.save(h.handle, 'kobold', 'shared', { k: 1 });
        expect(await repo.get(h.handle, 'koboldhorde', 'shared')).toEqual({ k: 1 });
    });

    test('save throws on invalid apiId', async () => {
        await expect(repo.save(h.handle, 'mystery', 'p', {}))
            .rejects.toThrow(/invalid apiId mystery/);
    });
});

describe.each(CONTRACT_HARNESSES)('PresetRepo on $name — patch', ({ make }) => {
    let h, repo;
    beforeEach(async () => {
        h = await make();
        repo = new PresetRepo({ engine: h.engine });
    });
    afterEach(() => h.cleanup());

    test('patch applies json-patch and persists', async () => {
        await repo.save(h.handle, 'openai', 'p', { a: 1, b: { c: 2 } });
        const next = await repo.patch(h.handle, 'openai', 'p', [
            { op: 'replace', path: '/a', value: 9 },
            { op: 'add', path: '/b/d', value: 3 },
        ]);
        expect(next).toEqual({ a: 9, b: { c: 2, d: 3 } });
        expect(await repo.get(h.handle, 'openai', 'p')).toEqual({ a: 9, b: { c: 2, d: 3 } });
    });

    test('patch throws NotFoundError on missing preset', async () => {
        await expect(repo.patch(h.handle, 'openai', 'absent', [
            { op: 'replace', path: '/a', value: 1 },
        ])).rejects.toBeInstanceOf(NotFoundError);
    });

    test('patch surfaces test-op failures (becomes 409 at endpoint)', async () => {
        await repo.save(h.handle, 'openai', 'p', { a: 1 });
        await expect(repo.patch(h.handle, 'openai', 'p', [
            { op: 'test', path: '/a', value: 99 },
        ])).rejects.toThrow(/json patch test failed/);
    });

    test('patch surfaces missing-parent (replace) failures', async () => {
        await repo.save(h.handle, 'openai', 'p', { a: 1 });
        await expect(repo.patch(h.handle, 'openai', 'p', [
            { op: 'replace', path: '/nope/inner', value: 'x' },
        ])).rejects.toThrow(/missing parent/);
    });
});

describe.each(CONTRACT_HARNESSES)('PresetRepo on $name — state sidecars', ({ make }) => {
    let h, repo;
    beforeEach(async () => {
        h = await make();
        repo = new PresetRepo({ engine: h.engine });
        await repo.save(h.handle, 'openai', 'p', { temperature: 0.5 });
    });
    afterEach(() => h.cleanup());

    test('getState returns null on missing sidecar', async () => {
        const r = await repo.getState(h.handle, 'openai', 'p', 'memory_graph__meta');
        expect(r).toBeNull();
    });

    test('setState then getState round-trip', async () => {
        await repo.setState(h.handle, 'openai', 'p', 'agenda', { items: ['x'] });
        expect(await repo.getState(h.handle, 'openai', 'p', 'agenda'))
            .toEqual({ items: ['x'] });
    });

    test('setState is permissive about orphan sidecars (no preset file required)', async () => {
        await repo.setState(h.handle, 'openai', 'orphan_target', 'meta', { v: 1 });
        // get on the preset itself is still null
        expect(await repo.get(h.handle, 'openai', 'orphan_target')).toBeNull();
        // but the sidecar can be read
        expect(await repo.getState(h.handle, 'openai', 'orphan_target', 'meta')).toEqual({ v: 1 });
    });

    test('deleteState returns true on hit, false on miss', async () => {
        await repo.setState(h.handle, 'openai', 'p', 'a', { v: 1 });
        expect(await repo.deleteState(h.handle, 'openai', 'p', 'a')).toBe(true);
        expect(await repo.deleteState(h.handle, 'openai', 'p', 'a')).toBe(false);
    });

    test('deleteAllStates returns count of deleted sidecars', async () => {
        await repo.setState(h.handle, 'openai', 'p', 'a', { v: 1 });
        await repo.setState(h.handle, 'openai', 'p', 'b', { v: 2 });
        await repo.setState(h.handle, 'openai', 'p', 'c', { v: 3 });
        const deleted = await repo.deleteAllStates(h.handle, 'openai', 'p');
        expect(deleted).toBe(3);
        expect(await repo.getState(h.handle, 'openai', 'p', 'a')).toBeNull();
        expect(await repo.getState(h.handle, 'openai', 'p', 'b')).toBeNull();
        expect(await repo.getState(h.handle, 'openai', 'p', 'c')).toBeNull();
    });

    test('deleteAllStates returns 0 when no sidecars exist', async () => {
        const deleted = await repo.deleteAllStates(h.handle, 'openai', 'p');
        expect(deleted).toBe(0);
    });
});

describe.each(CONTRACT_HARNESSES)('PresetRepo on $name — renameStates', ({ make }) => {
    let h, repo;
    beforeEach(async () => {
        h = await make();
        repo = new PresetRepo({ engine: h.engine });
    });
    afterEach(() => h.cleanup());

    test('renameStates moves all sidecars from old base to new base', async () => {
        await repo.setState(h.handle, 'openai', 'old', 'a', { v: 1 });
        await repo.setState(h.handle, 'openai', 'old', 'b', { v: 2 });

        const moved = await repo.renameStates(h.handle, 'openai', 'old', 'new');
        expect(moved).toBe(2);

        expect(await repo.getState(h.handle, 'openai', 'old', 'a')).toBeNull();
        expect(await repo.getState(h.handle, 'openai', 'old', 'b')).toBeNull();
        expect(await repo.getState(h.handle, 'openai', 'new', 'a')).toEqual({ v: 1 });
        expect(await repo.getState(h.handle, 'openai', 'new', 'b')).toEqual({ v: 2 });
    });

    test('renameStates returns 0 when source has no sidecars', async () => {
        const moved = await repo.renameStates(h.handle, 'openai', 'empty_src', 'empty_dst');
        expect(moved).toBe(0);
    });

    test('renameStates throws ConflictError on target sidecar collision', async () => {
        await repo.setState(h.handle, 'openai', 'old', 'a', { v: 1 });
        await repo.setState(h.handle, 'openai', 'new', 'a', { v: 'pre-existing' });

        const err = await repo.renameStates(h.handle, 'openai', 'old', 'new').catch((e) => e);
        expect(err).toBeInstanceOf(ConflictError);
        expect(err.code).toBe('preset_state_rename_collision');

        // Source is unchanged; pre-existing target is preserved.
        expect(await repo.getState(h.handle, 'openai', 'old', 'a')).toEqual({ v: 1 });
        expect(await repo.getState(h.handle, 'openai', 'new', 'a')).toEqual({ v: 'pre-existing' });
    });
});
