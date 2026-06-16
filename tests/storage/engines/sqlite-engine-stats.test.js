import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SqliteEngine } from '../../../src/storage/engines/sqlite-engine.js';

describe('SqliteEngine stats handler', () => {
    let tmpDir, engine;
    const handle = 'u';
    const key = { kind: 'stats', handle };

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-sqlite-stats-'));
        engine = new SqliteEngine({
            directoriesByHandle: () => ({ root: path.join(tmpDir, handle) }),
        });
    });

    afterEach(() => {
        engine.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('get returns null when no stats row', async () => {
        const got = await engine.withTransaction(handle, async (tx) => tx.getResource(key));
        expect(got).toBeNull();
    });

    test('put then get round-trips the doc', async () => {
        const doc = { 'foo.png': { user_msg_count: 5 }, timestamp: 12345 };
        await engine.withTransaction(handle, async (tx) => tx.putResource(key, { doc }));
        const got = await engine.withTransaction(handle, async (tx) => tx.getResource(key));
        expect(got).toEqual(doc);
    });

    test('put overwrites existing row', async () => {
        await engine.withTransaction(handle, async (tx) => tx.putResource(key, { doc: { a: 1, timestamp: 1 } }));
        await engine.withTransaction(handle, async (tx) => tx.putResource(key, { doc: { b: 2, timestamp: 2 } }));
        const got = await engine.withTransaction(handle, async (tx) => tx.getResource(key));
        expect(got).toEqual({ b: 2, timestamp: 2 });
    });

    test('delete returns boolean', async () => {
        const missing = await engine.withTransaction(handle, async (tx) => tx.deleteResource(key));
        expect(missing).toBe(false);
        await engine.withTransaction(handle, async (tx) => tx.putResource(key, { doc: { x: 1 } }));
        const present = await engine.withTransaction(handle, async (tx) => tx.deleteResource(key));
        expect(present).toBe(true);
    });

    test('list throws (stats is singleton)', async () => {
        await expect(engine.withTransaction(handle, async (tx) =>
            tx.listResources({ kind: 'stats', handle }))).rejects.toThrow(/singleton/);
    });

    test('get returns null when stored doc is unparseable', async () => {
        engine._dbFor(handle);
        const db = engine._dbs.get(handle);
        db.prepare('INSERT INTO stats (handle, doc, updated_at) VALUES (?, ?, ?)')
            .run(handle, 'not json', Date.now());
        const got = await engine.withTransaction(handle, async (tx) => tx.getResource(key));
        expect(got).toBeNull();
    });
});
