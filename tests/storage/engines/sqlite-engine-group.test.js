import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SqliteEngine } from '../../../src/storage/engines/sqlite-engine.js';

describe('SqliteEngine group handler', () => {
    let tmpDir, engine;
    const handle = 'u';

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-sqlite-group-'));
        engine = new SqliteEngine({
            directoriesByHandle: () => ({ root: path.join(tmpDir, handle) }),
        });
    });

    afterEach(() => {
        engine.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const groupKey = (id) => ({ kind: 'group', handle, id });

    test('get returns null when missing', async () => {
        const got = await engine.withTransaction(handle, async (tx) => tx.getResource(groupKey('nope')));
        expect(got).toBeNull();
    });

    test('put then get round-trips', async () => {
        await engine.withTransaction(handle, async (tx) =>
            tx.putResource(groupKey('g1'), { doc: { id: 'g1', name: 'My Group', chats: ['c1', 'c2'] } }));
        const got = await engine.withTransaction(handle, async (tx) => tx.getResource(groupKey('g1')));
        expect(got).toEqual({ id: 'g1', name: 'My Group', chats: ['c1', 'c2'] });
    });

    test('put coerces non-string id (e.g. number) to string', async () => {
        await engine.withTransaction(handle, async (tx) =>
            tx.putResource({ kind: 'group', handle, id: 42 }, { doc: { id: 42 } }));
        const db = engine._dbs.get(handle);
        const row = db.prepare('SELECT id FROM groups_table WHERE handle=?').get(handle);
        expect(row.id).toBe('42');
    });

    test('put rejects empty id', async () => {
        // Contract: put with an empty `id` MUST reject before writing.
        // Message wording is an implementation detail (the shared
        // name-validation layer says "id is required" for empty, "invalid
        // id" for other reasons); accept either so a future wording tweak
        // in name-validation.js doesn't break this parity test.
        await expect(engine.withTransaction(handle, async (tx) =>
            tx.putResource({ kind: 'group', handle, id: '' }, { doc: {} })))
            .rejects.toThrow(/invalid id|(^|\W)id\W.*required/i);
    });

    test('put preserves created_at on overwrite, re-stamps updated_at', async () => {
        await engine.withTransaction(handle, async (tx) =>
            tx.putResource(groupKey('g1'), {
                doc: { id: 'g1', name: 'v1' }, createdAt: 1000, updatedAt: 1000,
            }));
        await engine.withTransaction(handle, async (tx) =>
            tx.putResource(groupKey('g1'), {
                doc: { id: 'g1', name: 'v2' }, updatedAt: 2000,
            }));
        const db = engine._dbs.get(handle);
        const row = db.prepare('SELECT created_at, updated_at FROM groups_table WHERE id=?').get('g1');
        expect(row.created_at).toBe(1000);
        expect(row.updated_at).toBe(2000);
    });

    test('delete returns boolean', async () => {
        const missing = await engine.withTransaction(handle, async (tx) => tx.deleteResource(groupKey('nope')));
        expect(missing).toBe(false);
        await engine.withTransaction(handle, async (tx) =>
            tx.putResource(groupKey('g'), { doc: { id: 'g' } }));
        const present = await engine.withTransaction(handle, async (tx) => tx.deleteResource(groupKey('g')));
        expect(present).toBe(true);
    });

    test('list returns rows sorted by id ASC', async () => {
        await engine.withTransaction(handle, async (tx) => {
            tx.putResource(groupKey('zeta'), { doc: { id: 'zeta' } });
            tx.putResource(groupKey('alpha'), { doc: { id: 'alpha' } });
            tx.putResource(groupKey('mid'), { doc: { id: 'mid' } });
        });
        const list = await engine.withTransaction(handle, async (tx) =>
            tx.listResources({ kind: 'group', handle }));
        expect(list.map((r) => r.key.id)).toEqual(['alpha', 'mid', 'zeta']);
    });

    test('get returns null when stored doc is unparseable', async () => {
        engine._dbFor(handle);
        const db = engine._dbs.get(handle);
        const now = Date.now();
        db.prepare('INSERT INTO groups_table (handle, id, doc, updated_at, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(handle, 'broken', 'not json', now, now);
        const got = await engine.withTransaction(handle, async (tx) => tx.getResource(groupKey('broken')));
        expect(got).toBeNull();
    });

    test('get returns null when stored doc is an array', async () => {
        engine._dbFor(handle);
        const db = engine._dbs.get(handle);
        const now = Date.now();
        db.prepare('INSERT INTO groups_table (handle, id, doc, updated_at, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(handle, 'arr', '[1,2,3]', now, now);
        const got = await engine.withTransaction(handle, async (tx) => tx.getResource(groupKey('arr')));
        expect(got).toBeNull();
    });

    test('listGroupsWithChatStats joins group with member chat sizes (approximated via length(doc))', async () => {
        await engine.withTransaction(handle, async (tx) => {
            tx.putResource(groupKey('g1'), {
                doc: { id: 'g1', name: 'Crew', chats: ['c1', 'c2', 'c-missing'] },
            });
            tx.putResource(
                { kind: 'chat', handle, charDir: '', name: 'c1', isGroup: true, groupId: 'c1' },
                {
                    header: { chat_metadata: {} }, body: [{ mes: 'hi' }],
                    integrity: 'x', updatedAt: 1000, createdAt: 1000,
                },
            );
            tx.putResource(
                { kind: 'chat', handle, charDir: '', name: 'c2', isGroup: true, groupId: 'c2' },
                {
                    header: { chat_metadata: {} }, body: [{ mes: 'much longer body content here' }],
                    integrity: 'y', updatedAt: 2000, createdAt: 1500,
                },
            );
            // An unrelated group chat that should NOT contribute.
            tx.putResource(
                { kind: 'chat', handle, charDir: '', name: 'other', isGroup: true, groupId: 'other' },
                {
                    header: { chat_metadata: {} }, body: [{ mes: 'unrelated' }],
                    integrity: 'z', updatedAt: 9000, createdAt: 9000,
                },
            );
        });
        const list = await engine.withTransaction(handle, async (tx) =>
            tx.listGroupsWithChatStats({ kind: 'group', handle }));
        expect(list).toHaveLength(1);
        const g = list[0];
        expect(g.id).toBe('g1');
        expect(g.chat_size).toBeGreaterThan(0);
        // 'c2' has a longer body than 'c1', so combined > c1 alone.
        expect(g.date_last_chat).toBe(2000);
        expect(typeof g.create_date).toBe('string');
        expect(typeof g.date_added).toBe('number');
    });

    test('listGroupsWithChatStats returns zero stats for group with no chats array', async () => {
        await engine.withTransaction(handle, async (tx) =>
            tx.putResource(groupKey('empty'), { doc: { id: 'empty' } }));
        const list = await engine.withTransaction(handle, async (tx) =>
            tx.listGroupsWithChatStats({ kind: 'group', handle }));
        expect(list).toHaveLength(1);
        expect(list[0].chat_size).toBe(0);
        expect(list[0].date_last_chat).toBe(0);
    });

    test('listGroupsWithChatStats returns zero stats for empty chats array', async () => {
        await engine.withTransaction(handle, async (tx) =>
            tx.putResource(groupKey('zilch'), { doc: { id: 'zilch', chats: [] } }));
        const list = await engine.withTransaction(handle, async (tx) =>
            tx.listGroupsWithChatStats({ kind: 'group', handle }));
        expect(list[0].chat_size).toBe(0);
        expect(list[0].date_last_chat).toBe(0);
    });

    test('listGroupsWithChatStats skips groups with unparseable doc', async () => {
        engine._dbFor(handle);
        const db = engine._dbs.get(handle);
        const now = Date.now();
        db.prepare('INSERT INTO groups_table (handle, id, doc, updated_at, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(handle, 'bad', 'not json', now, now);
        await engine.withTransaction(handle, async (tx) =>
            tx.putResource(groupKey('good'), { doc: { id: 'good', chats: [] } }));
        const list = await engine.withTransaction(handle, async (tx) =>
            tx.listGroupsWithChatStats({ kind: 'group', handle }));
        // 'bad' is skipped; 'good' is included.
        expect(list.map((g) => g.id)).toEqual(['good']);
    });
});
