import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteEngine } from '../../../src/storage/engines/sqlite-engine.js';

describe('SqliteEngine settings handler', () => {
    let tmpDir, engine;
    const handle = 'u';
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-sqlite-settings-'));
        engine = new SqliteEngine({
            directoriesByHandle: () => ({ root: path.join(tmpDir, handle) }),
        });
    });
    afterEach(() => {
        engine.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('get returns null when no settings row', async () => {
        const got = await engine.withTransaction(handle, async (tx) => tx.getResource({ kind: 'settings', handle }));
        expect(got).toBeNull();
    });

    test('put then get round-trips the doc', async () => {
        await engine.withTransaction(handle, async (tx) =>
            tx.putResource({ kind: 'settings', handle }, { doc: { user_avatar: 'a.png', power_user: { x: 1 } } }));
        const got = await engine.withTransaction(handle, async (tx) =>
            tx.getResource({ kind: 'settings', handle }));
        expect(got).toEqual({ user_avatar: 'a.png', power_user: { x: 1 } });
    });

    test('put overwrites existing', async () => {
        await engine.withTransaction(handle, async (tx) =>
            tx.putResource({ kind: 'settings', handle }, { doc: { a: 1 } }));
        await engine.withTransaction(handle, async (tx) =>
            tx.putResource({ kind: 'settings', handle }, { doc: { b: 2 } }));
        const got = await engine.withTransaction(handle, async (tx) =>
            tx.getResource({ kind: 'settings', handle }));
        expect(got).toEqual({ b: 2 });
    });

    test('delete returns boolean', async () => {
        const missing = await engine.withTransaction(handle, async (tx) =>
            tx.deleteResource({ kind: 'settings', handle }));
        expect(missing).toBe(false);
        await engine.withTransaction(handle, async (tx) =>
            tx.putResource({ kind: 'settings', handle }, { doc: { x: 1 } }));
        const present = await engine.withTransaction(handle, async (tx) =>
            tx.deleteResource({ kind: 'settings', handle }));
        expect(present).toBe(true);
    });

    test('list throws (settings is singleton)', async () => {
        await expect(engine.withTransaction(handle, async (tx) =>
            tx.listResources({ kind: 'settings', handle })))
            .rejects.toThrow(/singleton/);
    });

    test('get returns null when stored doc is unparseable', async () => {
        // Inject corrupt JSON directly via raw db access
        engine._dbFor(handle);
        const db = engine._dbs.get(handle);
        db.prepare(`INSERT INTO settings (handle, doc, updated_at) VALUES (?, ?, ?)`).run(handle, 'not json', Date.now());
        const got = await engine.withTransaction(handle, async (tx) =>
            tx.getResource({ kind: 'settings', handle }));
        expect(got).toBeNull();
    });
});
