import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteEngine } from '../../../src/storage/engines/sqlite-engine.js';

describe('SqliteEngine preset handler', () => {
    let tmpDir, engine;
    const handle = 'u';
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-sqlite-preset-'));
        engine = new SqliteEngine({
            directoriesByHandle: () => ({ root: path.join(tmpDir, handle) }),
        });
    });
    afterEach(() => {
        engine.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const presetKey = (name, dirKey = 'openAI_Settings') => ({ kind: 'preset', handle, dirKey, name });

    test('get returns null when missing', async () => {
        expect(await engine.withTransaction(handle, async (tx) => tx.getResource(presetKey('X')))).toBeNull();
    });

    test('put then get round-trips', async () => {
        await engine.withTransaction(handle, async (tx) =>
            tx.putResource(presetKey('GPT'), { doc: { temperature: 0.7, max_tokens: 1000 } }));
        const got = await engine.withTransaction(handle, async (tx) => tx.getResource(presetKey('GPT')));
        expect(got).toEqual({ temperature: 0.7, max_tokens: 1000 });
    });

    test('put overwrites', async () => {
        await engine.withTransaction(handle, async (tx) =>
            tx.putResource(presetKey('X'), { doc: { v: 1 } }));
        await engine.withTransaction(handle, async (tx) =>
            tx.putResource(presetKey('X'), { doc: { v: 2 } }));
        const got = await engine.withTransaction(handle, async (tx) => tx.getResource(presetKey('X')));
        expect(got).toEqual({ v: 2 });
    });

    test('delete cascades preset_states', async () => {
        await engine.withTransaction(handle, async (tx) => {
            tx.putResource(presetKey('X'), { doc: { v: 1 } });
            tx.putPresetState(presetKey('X'), 'search-tools', { active: true });
            tx.putPresetState(presetKey('X'), 'memory-graph', { items: [] });
        });
        const before = await engine.withTransaction(handle, async (tx) =>
            tx.listPresetStateNamespaces(presetKey('X')));
        expect(before.sort()).toEqual(['memory-graph', 'search-tools']);
        await engine.withTransaction(handle, async (tx) => tx.deleteResource(presetKey('X')));
        const after = await engine.withTransaction(handle, async (tx) =>
            tx.listPresetStateNamespaces(presetKey('X')));
        expect(after).toEqual([]);
    });

    test('delete returns boolean', async () => {
        expect(await engine.withTransaction(handle, async (tx) =>
            tx.deleteResource(presetKey('Nope')))).toBe(false);
        await engine.withTransaction(handle, async (tx) => tx.putResource(presetKey('X'), { doc: {} }));
        expect(await engine.withTransaction(handle, async (tx) =>
            tx.deleteResource(presetKey('X')))).toBe(true);
    });

    test('list returns sorted within (handle, dirKey)', async () => {
        await engine.withTransaction(handle, async (tx) => {
            tx.putResource(presetKey('beta', 'openAI_Settings'), { doc: {} });
            tx.putResource(presetKey('alpha', 'openAI_Settings'), { doc: {} });
            tx.putResource(presetKey('zeta', 'openAI_Settings'), { doc: {} });
        });
        const list = await engine.withTransaction(handle, async (tx) =>
            tx.listResources({ kind: 'preset', handle, dirKey: 'openAI_Settings' }));
        expect(list.map((r) => r.key.name)).toEqual(['alpha', 'beta', 'zeta']);
    });

    test('list isolates by dirKey', async () => {
        await engine.withTransaction(handle, async (tx) => {
            tx.putResource(presetKey('shared', 'openAI_Settings'), { doc: {} });
            tx.putResource(presetKey('shared', 'novelAI_Settings'), { doc: {} });
        });
        const openai = await engine.withTransaction(handle, async (tx) =>
            tx.listResources({ kind: 'preset', handle, dirKey: 'openAI_Settings' }));
        const novel = await engine.withTransaction(handle, async (tx) =>
            tx.listResources({ kind: 'preset', handle, dirKey: 'novelAI_Settings' }));
        expect(openai).toHaveLength(1);
        expect(novel).toHaveLength(1);
    });

    test('getPresetState returns null on miss', async () => {
        expect(await engine.withTransaction(handle, async (tx) =>
            tx.getPresetState(presetKey('X'), 'ns'))).toBeNull();
    });

    test('putPresetState then getPresetState round-trips', async () => {
        await engine.withTransaction(handle, async (tx) => {
            tx.putResource(presetKey('X'), { doc: {} });
            tx.putPresetState(presetKey('X'), 'search-tools', { active: true });
        });
        const got = await engine.withTransaction(handle, async (tx) =>
            tx.getPresetState(presetKey('X'), 'search-tools'));
        expect(got).toEqual({ active: true });
    });

    test('putPresetState is permissive — no parent preset required (orphan sidecar OK)', async () => {
        // This MUST NOT throw — matches FS behavior for preset state sidecars.
        await expect(engine.withTransaction(handle, async (tx) =>
            tx.putPresetState(presetKey('NonexistentPreset'), 'ns', { x: 1 }),
        )).resolves.not.toThrow();
        const got = await engine.withTransaction(handle, async (tx) =>
            tx.getPresetState(presetKey('NonexistentPreset'), 'ns'));
        expect(got).toEqual({ x: 1 });
    });

    test('deletePresetState returns boolean', async () => {
        await engine.withTransaction(handle, async (tx) => {
            tx.putResource(presetKey('X'), { doc: {} });
            tx.putPresetState(presetKey('X'), 'ns', { v: 1 });
        });
        expect(await engine.withTransaction(handle, async (tx) =>
            tx.deletePresetState(presetKey('X'), 'absent'))).toBe(false);
        expect(await engine.withTransaction(handle, async (tx) =>
            tx.deletePresetState(presetKey('X'), 'ns'))).toBe(true);
    });

    test('listPresetStateNamespaces returns all for a preset', async () => {
        await engine.withTransaction(handle, async (tx) => {
            tx.putResource(presetKey('X'), { doc: {} });
            tx.putPresetState(presetKey('X'), 'a', {});
            tx.putPresetState(presetKey('X'), 'b', {});
        });
        const ns = await engine.withTransaction(handle, async (tx) =>
            tx.listPresetStateNamespaces(presetKey('X')));
        expect(ns.sort()).toEqual(['a', 'b']);
    });
});
