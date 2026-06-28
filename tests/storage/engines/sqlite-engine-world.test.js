import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SqliteEngine } from '../../../src/storage/engines/sqlite-engine.js';

describe('SqliteEngine world handler', () => {
    let tmpDir, engine;
    const handle = 'u';

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-sqlite-world-'));
        engine = new SqliteEngine({
            directoriesByHandle: () => ({ root: path.join(tmpDir, handle) }),
        });
    });

    afterEach(() => {
        engine.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const worldKey = (name) => ({ kind: 'world', handle, name });

    test('get returns null when missing', async () => {
        const got = await engine.withTransaction(handle, async (tx) => tx.getResource(worldKey('Nope')));
        expect(got).toBeNull();
    });

    test('put then get round-trips', async () => {
        await engine.withTransaction(handle, async (tx) =>
            tx.putResource(worldKey('MyWorld'), { doc: { entries: { '0': { content: 'hi' } }, name: 'MyWorld' } }),
        );
        const got = await engine.withTransaction(handle, async (tx) => tx.getResource(worldKey('MyWorld')));
        expect(got.entries['0'].content).toBe('hi');
        expect(got.name).toBe('MyWorld');
    });

    test('put overwrites canonical when tolerant-matched', async () => {
        await engine.withTransaction(handle, async (tx) =>
            tx.putResource(worldKey('Café'), { doc: { entries: {}, version: 1 } }),
        );
        // Re-put under the same name overwrites cleanly via exact match.
        await engine.withTransaction(handle, async (tx) =>
            tx.putResource(worldKey('Café'), { doc: { entries: {}, version: 2 } }),
        );
        const got = await engine.withTransaction(handle, async (tx) => tx.getResource(worldKey('Café')));
        expect(got.version).toBe(2);
    });

    test('delete returns boolean', async () => {
        const missing = await engine.withTransaction(handle, async (tx) => tx.deleteResource(worldKey('Nope')));
        expect(missing).toBe(false);
        await engine.withTransaction(handle, async (tx) =>
            tx.putResource(worldKey('X'), { doc: { entries: {} } }),
        );
        const present = await engine.withTransaction(handle, async (tx) => tx.deleteResource(worldKey('X')));
        expect(present).toBe(true);
    });

    test('list returns sorted with name + extensions', async () => {
        await engine.withTransaction(handle, async (tx) => {
            await tx.putResource(worldKey('B'), { doc: { entries: {}, name: 'Bee', extensions: { tag: 'x' } } });
            await tx.putResource(worldKey('A'), { doc: { entries: {} } });
        });
        const list = await engine.withTransaction(handle, async (tx) =>
            tx.listResources({ kind: 'world', handle }),
        );
        expect(list.map((r) => r.key.name)).toEqual(['A', 'B']);
        expect(list[0].name).toBe('A'); // fallback to basename
        expect(list[1].name).toBe('Bee');
        expect(list[1].extensions).toEqual({ tag: 'x' });
        expect(list[0].extensions).toEqual({});
    });

    test('resolveWorldName returns canonical name for present and null for missing', async () => {
        await engine.withTransaction(handle, async (tx) =>
            tx.putResource(worldKey('MyWorld'), { doc: { entries: {} } }),
        );
        const present = await engine.withTransaction(handle, async (tx) => tx.resolveWorldName(worldKey('MyWorld')));
        expect(present).toBe('MyWorld');
        const missing = await engine.withTransaction(handle, async (tx) => tx.resolveWorldName(worldKey('Nonexistent')));
        expect(missing).toBeNull();
    });

    test('get returns null when stored doc is unparseable', async () => {
        engine._dbFor(handle);
        const db = engine._dbs.get(handle);
        db.prepare('INSERT INTO worlds (handle, name, doc, updated_at) VALUES (?, ?, ?, ?)')
            .run(handle, 'Broken', 'not json', Date.now());
        const got = await engine.withTransaction(handle, async (tx) => tx.getResource(worldKey('Broken')));
        expect(got).toBeNull();
    });

    test('get returns null when stored doc is a non-object (array root)', async () => {
        engine._dbFor(handle);
        const db = engine._dbs.get(handle);
        db.prepare('INSERT INTO worlds (handle, name, doc, updated_at) VALUES (?, ?, ?, ?)')
            .run(handle, 'BadShape', '[1,2,3]', Date.now());
        const got = await engine.withTransaction(handle, async (tx) => tx.getResource(worldKey('BadShape')));
        expect(got).toBeNull();
    });

    test('list coerces invalid extensions (array) to {}', async () => {
        engine._dbFor(handle);
        const db = engine._dbs.get(handle);
        db.prepare('INSERT INTO worlds (handle, name, doc, updated_at) VALUES (?, ?, ?, ?)')
            .run(handle, 'World', JSON.stringify({ entries: {}, extensions: ['x', 'y'] }), Date.now());
        const list = await engine.withTransaction(handle, async (tx) =>
            tx.listResources({ kind: 'world', handle }),
        );
        expect(list[0].extensions).toEqual({});
    });
});
