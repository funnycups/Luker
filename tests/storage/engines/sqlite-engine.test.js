import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteEngine } from '../../../src/storage/engines/sqlite-engine.js';

describe('SqliteEngine scaffolding', () => {
    let tmpDir, dbPath, engine;
    const handle = 'u';
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-sqlite-'));
        const userDir = path.join(tmpDir, handle);
        fs.mkdirSync(userDir, { recursive: true });
        dbPath = path.join(userDir, 'luker-storage.sqlite');
        engine = new SqliteEngine({
            directoriesByHandle: (h) => ({ root: userDir }),
        });
    });
    afterEach(() => {
        engine.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('ping opens the per-user db lazily and creates the file', async () => {
        await engine.ping(handle);
        expect(fs.existsSync(dbPath)).toBe(true);
    });

    test('withTransaction returns the closure result', async () => {
        const result = await engine.withTransaction(handle, async () => 42);
        expect(result).toBe(42);
    });

    test('withTransaction rolls back on throw and remains usable after', async () => {
        await expect(engine.withTransaction(handle, async () => { throw new Error('boom'); }))
            .rejects.toThrow('boom');
        const result = await engine.withTransaction(handle, async () => 'ok');
        expect(result).toBe('ok');
    });

    test('close releases db handle; reopen via new engine works', () => {
        engine._dbFor(handle);  // force open
        expect(() => engine.close()).not.toThrow();
        const engine2 = new SqliteEngine({
            directoriesByHandle: (h) => ({ root: path.join(tmpDir, handle) }),
        });
        expect(() => engine2._dbFor(handle)).not.toThrow();
        engine2.close();
    });

    test('schema is initialized on first open (user_version === 1)', () => {
        engine._dbFor(handle);
        expect(engine._dbs.get(handle).pragma('user_version', { simple: true })).toBe(1);
    });

    test('schema is idempotent — reopen on existing db does not error', () => {
        engine._dbFor(handle);
        engine.close();
        const engine2 = new SqliteEngine({
            directoriesByHandle: (h) => ({ root: path.join(tmpDir, handle) }),
        });
        expect(() => engine2._dbFor(handle)).not.toThrow();
        engine2.close();
    });

    test('all expected tables exist', () => {
        engine._dbFor(handle);
        const tables = engine._dbs.get(handle).prepare(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        ).all().map(r => r.name);
        expect(tables).toEqual(expect.arrayContaining([
            'chats', 'chat_states', 'settings', 'presets', 'preset_states',
            'worlds', 'named_docs', 'groups_table', 'stats',
        ]));
    });

    test('chats integrity GENERATED column is populated from doc.header.chat_metadata.integrity', () => {
        engine._dbFor(handle);
        const db = engine._dbs.get(handle);
        const doc = JSON.stringify({ header: { chat_metadata: { integrity: 'abc-123' } }, body: [] });
        db.prepare(`INSERT INTO chats (handle, char_dir, name, is_group, group_id, doc, updated_at, created_at)
                    VALUES (?, ?, ?, 0, '', ?, ?, ?)`).run(handle, 'TestChar', 'chat1', doc, 100, 100);
        const row = db.prepare('SELECT integrity FROM chats WHERE handle=? AND char_dir=? AND name=?').get(handle, 'TestChar', 'chat1');
        expect(row.integrity).toBe('abc-123');
    });
});
