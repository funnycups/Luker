import fs from 'node:fs';
import path from 'node:path';
import { makeTempFsEngine } from '../harness/fs-harness.js';

describe('FsEngine — preset handler', () => {
    let h;
    beforeEach(async () => { h = await makeTempFsEngine(); });
    afterEach(() => h.cleanup());

    const presetKey = (overrides = {}) => ({
        kind: 'preset', handle: h.handle, dirKey: 'openAI_Settings', name: 'mypreset', ...overrides,
    });

    test('put writes preset to the OpenAI Settings folder for apiId=openai', async () => {
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putResource(presetKey(), { doc: { temperature: 0.7 } }));
        const fp = path.join(h.dirs.openAI_Settings, 'mypreset.json');
        expect(fs.existsSync(fp)).toBe(true);
        expect(JSON.parse(fs.readFileSync(fp, 'utf-8'))).toEqual({ temperature: 0.7 });
    });

    test('put uses 4-space pretty-printed JSON (legacy compat)', async () => {
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putResource(presetKey(), { doc: { a: 1, b: { c: 2 } } }));
        const raw = fs.readFileSync(path.join(h.dirs.openAI_Settings, 'mypreset.json'), 'utf-8');
        expect(raw).toContain('\n    "a"');
        expect(raw).toContain('\n        "c"');
    });

    test('put routes to the correct folder per dirKey', async () => {
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putResource(presetKey({ dirKey: 'novelAI_Settings', name: 'n1' }), { doc: { x: 1 } }));
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putResource(presetKey({ dirKey: 'instruct', name: 'i1' }), { doc: { y: 2 } }));
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putResource(presetKey({ dirKey: 'reasoning', name: 'r1' }), { doc: { z: 3 } }));

        expect(fs.existsSync(path.join(h.dirs.novelAI_Settings, 'n1.json'))).toBe(true);
        expect(fs.existsSync(path.join(h.dirs.instruct, 'i1.json'))).toBe(true);
        expect(fs.existsSync(path.join(h.dirs.reasoning, 'r1.json'))).toBe(true);
    });

    test('get returns null when preset file absent', async () => {
        const got = await h.engine.withTransaction(h.handle, (tx) => tx.getResource(presetKey()));
        expect(got).toBeNull();
    });

    test('get returns parsed JSON object', async () => {
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putResource(presetKey(), { doc: { temperature: 0.5, top_p: 0.9 } }));
        const got = await h.engine.withTransaction(h.handle, (tx) => tx.getResource(presetKey()));
        expect(got).toEqual({ temperature: 0.5, top_p: 0.9 });
    });

    test('get returns null when file holds a JSON array (not an object)', async () => {
        fs.mkdirSync(h.dirs.openAI_Settings, { recursive: true });
        fs.writeFileSync(path.join(h.dirs.openAI_Settings, 'mypreset.json'), '[1,2,3]');
        const got = await h.engine.withTransaction(h.handle, (tx) => tx.getResource(presetKey()));
        expect(got).toBeNull();
    });

    test('delete cascades sidecars', async () => {
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putResource(presetKey(), { doc: { t: 1 } }));
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putPresetState(presetKey(), 'ns_a', { v: 1 }));
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putPresetState(presetKey(), 'ns_b', { v: 2 }));

        const presetFp = path.join(h.dirs.openAI_Settings, 'mypreset.json');
        const sidecarA = path.join(h.dirs.openAI_Settings, 'mypreset.luker-state.ns_a.json');
        const sidecarB = path.join(h.dirs.openAI_Settings, 'mypreset.luker-state.ns_b.json');
        expect(fs.existsSync(presetFp)).toBe(true);
        expect(fs.existsSync(sidecarA)).toBe(true);
        expect(fs.existsSync(sidecarB)).toBe(true);

        const result = await h.engine.withTransaction(h.handle, (tx) => tx.deleteResource(presetKey()));
        expect(result).toBe(true);
        expect(fs.existsSync(presetFp)).toBe(false);
        expect(fs.existsSync(sidecarA)).toBe(false);
        expect(fs.existsSync(sidecarB)).toBe(false);
    });

    test('delete returns false when preset file absent', async () => {
        const result = await h.engine.withTransaction(h.handle, (tx) => tx.deleteResource(presetKey()));
        expect(result).toBe(false);
    });

    test('listResources excludes sidecars', async () => {
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putResource(presetKey({ name: 'preset_one' }), { doc: { a: 1 } }));
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putResource(presetKey({ name: 'preset_two' }), { doc: { a: 2 } }));
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putPresetState(presetKey({ name: 'preset_one' }), 'meta', { z: 1 }));
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putPresetState(presetKey({ name: 'preset_two' }), 'meta', { z: 2 }));

        const listed = await h.engine.withTransaction(h.handle, (tx) =>
            tx.listResources({ kind: 'preset', handle: h.handle, apiId: 'openai' }));
        const names = listed.map((r) => r.key.name).sort();
        expect(names).toEqual(['preset_one', 'preset_two']);
    });

    test('listResources returns empty when folder does not exist', async () => {
        const listed = await h.engine.withTransaction(h.handle, (tx) =>
            tx.listResources({ kind: 'preset', handle: h.handle, apiId: 'reasoning' }));
        expect(listed).toEqual([]);
    });

    test('listResources throws on unknown apiId', async () => {
        await expect(h.engine.withTransaction(h.handle, (tx) =>
            tx.listResources({ kind: 'preset', handle: h.handle, apiId: 'mystery' })))
            .rejects.toThrow(/invalid apiId/);
    });

    test('putPresetState + getPresetState round-trips with 4-space indent', async () => {
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putPresetState(presetKey(), 'agenda', { items: [1, 2], stamp: 'x' }));
        const fp = path.join(h.dirs.openAI_Settings, 'mypreset.luker-state.agenda.json');
        const raw = fs.readFileSync(fp, 'utf-8');
        expect(raw).toContain('\n    "items"');

        const read = await h.engine.withTransaction(h.handle, (tx) =>
            tx.getPresetState(presetKey(), 'agenda'));
        expect(read).toEqual({ items: [1, 2], stamp: 'x' });
    });

    test('getPresetState returns null when sidecar absent (no preset file required)', async () => {
        const read = await h.engine.withTransaction(h.handle, (tx) =>
            tx.getPresetState(presetKey(), 'orphan'));
        expect(read).toBeNull();
    });

    test('putPresetState works even when preset file does not exist (permissive)', async () => {
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putPresetState(presetKey(), 'orphan', { v: 1 }));
        const fp = path.join(h.dirs.openAI_Settings, 'mypreset.json');
        const sidecarFp = path.join(h.dirs.openAI_Settings, 'mypreset.luker-state.orphan.json');
        expect(fs.existsSync(fp)).toBe(false);
        expect(fs.existsSync(sidecarFp)).toBe(true);
    });

    test('deletePresetState returns true on hit, false on miss', async () => {
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putPresetState(presetKey(), 'a', { v: 1 }));
        const removed1 = await h.engine.withTransaction(h.handle, (tx) =>
            tx.deletePresetState(presetKey(), 'a'));
        expect(removed1).toBe(true);
        const removed2 = await h.engine.withTransaction(h.handle, (tx) =>
            tx.deletePresetState(presetKey(), 'a'));
        expect(removed2).toBe(false);
    });

    test('listPresetStateNamespaces enumerates only sidecars for the given preset', async () => {
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putPresetState(presetKey({ name: 'p1' }), 'a', { v: 1 }));
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putPresetState(presetKey({ name: 'p1' }), 'b', { v: 2 }));
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putPresetState(presetKey({ name: 'p2' }), 'c', { v: 3 }));

        const ns = await h.engine.withTransaction(h.handle, (tx) =>
            tx.listPresetStateNamespaces(presetKey({ name: 'p1' })));
        expect(ns.sort()).toEqual(['a', 'b']);
    });

    test('kobold and koboldhorde both list from koboldAI_Settings', async () => {
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putResource(presetKey({ dirKey: 'koboldAI_Settings', name: 'shared' }), { doc: { x: 1 } }));

        const listedKobold = await h.engine.withTransaction(h.handle, (tx) =>
            tx.listResources({ kind: 'preset', handle: h.handle, apiId: 'kobold' }));
        const listedHorde = await h.engine.withTransaction(h.handle, (tx) =>
            tx.listResources({ kind: 'preset', handle: h.handle, apiId: 'koboldhorde' }));
        expect(listedKobold.map((r) => r.key.name)).toEqual(['shared']);
        expect(listedHorde.map((r) => r.key.name)).toEqual(['shared']);
    });
});
