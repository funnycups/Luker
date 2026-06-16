import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SqliteEngine } from '../../../src/storage/engines/sqlite-engine.js';

describe('SqliteEngine named-doc handler', () => {
    let tmpDir, engine;
    const handle = 'u';

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-sqlite-nd-'));
        engine = new SqliteEngine({
            directoriesByHandle: () => ({ root: path.join(tmpDir, handle) }),
        });
    });

    afterEach(() => {
        engine.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const ndKey = (bucket, name) => ({ kind: 'named-doc', handle, bucket, name });

    test('put round-trips via raw db read for themes bucket', async () => {
        await engine.withTransaction(handle, async (tx) =>
            tx.putResource(ndKey('themes', 'Dark'), { doc: { bg: '#000' } }));
        const db = engine._dbs.get(handle);
        const row = db.prepare('SELECT doc FROM named_docs WHERE handle=? AND bucket=? AND name=?')
            .get(handle, 'themes', 'Dark');
        expect(JSON.parse(row.doc)).toEqual({ bg: '#000' });
    });

    test('put isolates by bucket (same name in different buckets coexist)', async () => {
        await engine.withTransaction(handle, async (tx) => {
            tx.putResource(ndKey('themes', 'Dark'), { doc: { v: 1 } });
            tx.putResource(ndKey('quickReplies', 'Dark'), { doc: { v: 2 } });
        });
        const db = engine._dbs.get(handle);
        const themes = db.prepare(`SELECT doc FROM named_docs WHERE handle=? AND bucket='themes' AND name='Dark'`).get(handle);
        const qr = db.prepare(`SELECT doc FROM named_docs WHERE handle=? AND bucket='quickReplies' AND name='Dark'`).get(handle);
        expect(JSON.parse(themes.doc)).toEqual({ v: 1 });
        expect(JSON.parse(qr.doc)).toEqual({ v: 2 });
    });

    test('put overwrites existing row (last write wins)', async () => {
        await engine.withTransaction(handle, async (tx) => {
            tx.putResource(ndKey('movingUI', 'X'), { doc: { v: 1 } });
            tx.putResource(ndKey('movingUI', 'X'), { doc: { v: 2 } });
        });
        const db = engine._dbs.get(handle);
        const row = db.prepare(`SELECT doc FROM named_docs WHERE bucket='movingUI' AND name='X'`).get();
        expect(JSON.parse(row.doc)).toEqual({ v: 2 });
    });

    test('delete returns true when present, false when missing', async () => {
        const missing = await engine.withTransaction(handle, async (tx) =>
            tx.deleteResource(ndKey('themes', 'Nope')));
        expect(missing).toBe(false);

        await engine.withTransaction(handle, async (tx) =>
            tx.putResource(ndKey('themes', 'X'), { doc: { a: 1 } }));
        const present = await engine.withTransaction(handle, async (tx) =>
            tx.deleteResource(ndKey('themes', 'X')));
        expect(present).toBe(true);

        const db = engine._dbs.get(handle);
        const row = db.prepare(`SELECT doc FROM named_docs WHERE bucket='themes' AND name='X'`).get();
        expect(row).toBeUndefined();
    });

    test('get returns the doc when present, null when missing', async () => {
        await engine.withTransaction(handle, async (tx) =>
            tx.putResource(ndKey('themes', 'X'), { doc: { a: 1 } }));
        const got = await engine.withTransaction(handle, async (tx) =>
            tx.getResource(ndKey('themes', 'X')));
        expect(got).toEqual({ a: 1 });

        const missing = await engine.withTransaction(handle, async (tx) =>
            tx.getResource(ndKey('themes', 'Nope')));
        expect(missing).toBeNull();
    });

    test('list returns names sorted ascending for the bucket', async () => {
        await engine.withTransaction(handle, async (tx) => {
            tx.putResource(ndKey('themes', 'Charlie'), { doc: {} });
            tx.putResource(ndKey('themes', 'Alpha'), { doc: {} });
            tx.putResource(ndKey('themes', 'Bravo'), { doc: {} });
            // Different bucket — must not leak in.
            tx.putResource(ndKey('movingUI', 'X'), { doc: {} });
        });
        const themes = await engine.withTransaction(handle, async (tx) =>
            tx.listResources({ kind: 'named-doc', handle, bucket: 'themes' }));
        expect(themes.map((e) => e.key.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
        const moving = await engine.withTransaction(handle, async (tx) =>
            tx.listResources({ kind: 'named-doc', handle, bucket: 'movingUI' }));
        expect(moving.map((e) => e.key.name)).toEqual(['X']);
    });

    test('list returns empty for an unpopulated bucket', async () => {
        const out = await engine.withTransaction(handle, async (tx) =>
            tx.listResources({ kind: 'named-doc', handle, bucket: 'quickReplies' }));
        expect(out).toEqual([]);
    });
});
