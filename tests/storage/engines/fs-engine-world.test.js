import fs from 'node:fs';
import path from 'node:path';

import { makeTempFsEngine } from '../harness/fs-harness.js';

describe('FsEngine world handler', () => {
    let h;
    beforeEach(async () => {
        h = await makeTempFsEngine();
        fs.mkdirSync(h.dirs.worlds, { recursive: true });
    });
    afterEach(() => h.cleanup());

    test('put writes pretty-printed JSON to worlds dir', async () => {
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putResource({ kind: 'world', handle: h.handle, name: 'X' }, { doc: { entries: { '0': { content: 'hi' } } } }));
        const fp = path.join(h.dirs.worlds, 'X.json');
        const raw = fs.readFileSync(fp, 'utf-8');
        expect(raw).toContain('\n    "entries"');
        expect(JSON.parse(raw)).toEqual({ entries: { '0': { content: 'hi' } } });
    });

    test('put on existing name with disk variant overwrites the canonical file', async () => {
        // Pre-create a file with the same canonical name
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putResource({ kind: 'world', handle: h.handle, name: 'Existing' }, { doc: { entries: {} } }));
        // Overwrite with new content
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putResource({ kind: 'world', handle: h.handle, name: 'Existing' }, { doc: { entries: { '0': { content: 'new' } } } }));
        const fp = path.join(h.dirs.worlds, 'Existing.json');
        expect(JSON.parse(fs.readFileSync(fp, 'utf-8'))).toEqual({ entries: { '0': { content: 'new' } } });
        // Did NOT create a second file
        const allFiles = fs.readdirSync(h.dirs.worlds).filter(f => f.endsWith('.json'));
        expect(allFiles).toEqual(['Existing.json']);
    });

    test('get returns null on parse failure', async () => {
        fs.writeFileSync(path.join(h.dirs.worlds, 'broken.json'), 'not json');
        const got = await h.engine.withTransaction(h.handle, (tx) =>
            tx.getResource({ kind: 'world', handle: h.handle, name: 'broken' }));
        expect(got).toBeNull();
    });

    test('get returns null on empty file', async () => {
        fs.writeFileSync(path.join(h.dirs.worlds, 'empty.json'), '');
        const got = await h.engine.withTransaction(h.handle, (tx) =>
            tx.getResource({ kind: 'world', handle: h.handle, name: 'empty' }));
        expect(got).toBeNull();
    });

    test('get returns null when file holds a JSON array (not an object)', async () => {
        fs.writeFileSync(path.join(h.dirs.worlds, 'arr.json'), '[1,2,3]');
        const got = await h.engine.withTransaction(h.handle, (tx) =>
            tx.getResource({ kind: 'world', handle: h.handle, name: 'arr' }));
        expect(got).toBeNull();
    });

    test('list returns objects with name + extensions, sorted by filename', async () => {
        await h.engine.withTransaction(h.handle, async (tx) => {
            await tx.putResource({ kind: 'world', handle: h.handle, name: 'B' }, { doc: { entries: {}, name: 'Bee', extensions: { x: 1 } } });
            await tx.putResource({ kind: 'world', handle: h.handle, name: 'A' }, { doc: { entries: {} } });
        });
        const out = await h.engine.withTransaction(h.handle, (tx) =>
            tx.listResources({ kind: 'world', handle: h.handle }));
        expect(out.map(o => o.key.name)).toEqual(['A', 'B']);
        expect(out[1].name).toBe('Bee');
        expect(out[1].extensions).toEqual({ x: 1 });
        // fallback when no parsed.name
        expect(out[0].name).toBe('A');
        expect(out[0].extensions).toEqual({});
    });

    test('list skips parse errors gracefully and still lists the file with fallbacks', async () => {
        fs.writeFileSync(path.join(h.dirs.worlds, 'bad.json'), 'not json');
        const out = await h.engine.withTransaction(h.handle, (tx) =>
            tx.listResources({ kind: 'world', handle: h.handle }));
        expect(out).toHaveLength(1);
        expect(out[0].key.name).toBe('bad');
        expect(out[0].name).toBe('bad');
        expect(out[0].extensions).toEqual({});
    });

    test('list returns empty when worlds dir does not exist', async () => {
        fs.rmSync(h.dirs.worlds, { recursive: true, force: true });
        const out = await h.engine.withTransaction(h.handle, (tx) =>
            tx.listResources({ kind: 'world', handle: h.handle }));
        expect(out).toEqual([]);
    });

    test('delete returns false when missing, true when present', async () => {
        const missing = await h.engine.withTransaction(h.handle, (tx) =>
            tx.deleteResource({ kind: 'world', handle: h.handle, name: 'Nope' }));
        expect(missing).toBe(false);
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putResource({ kind: 'world', handle: h.handle, name: 'X' }, { doc: { entries: {} } }));
        const present = await h.engine.withTransaction(h.handle, (tx) =>
            tx.deleteResource({ kind: 'world', handle: h.handle, name: 'X' }));
        expect(present).toBe(true);
        expect(fs.existsSync(path.join(h.dirs.worlds, 'X.json'))).toBe(false);
    });

    test('resolveWorldName returns canonical name via tolerant lookup', async () => {
        // Pre-existing emoji-variant file
        const filename = '❤️World.json';
        fs.writeFileSync(path.join(h.dirs.worlds, filename), JSON.stringify({ entries: {} }));
        const resolved = await h.engine.withTransaction(h.handle, (tx) =>
            tx.resolveWorldName({ kind: 'world', handle: h.handle, name: '❤World' }));
        expect(resolved).toBe(path.parse(filename).name);
    });

    test('resolveWorldName returns null when not found', async () => {
        const resolved = await h.engine.withTransaction(h.handle, (tx) =>
            tx.resolveWorldName({ kind: 'world', handle: h.handle, name: 'ghost' }));
        expect(resolved).toBeNull();
    });

    test('put does not leave .tmp stragglers in worlds dir', async () => {
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putResource({ kind: 'world', handle: h.handle, name: 'X' }, { doc: { entries: {} } }));
        const stragglers = fs.readdirSync(h.dirs.worlds).filter(e => e.endsWith('.tmp'));
        expect(stragglers).toEqual([]);
    });
});
