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

    test('schema is initialized on first open', () => {
        engine._dbFor(handle);
        expect(engine._dbs.get(handle).pragma('user_version', { simple: true })).toBe(2);
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
            'SELECT name FROM sqlite_master WHERE type=\'table\' ORDER BY name',
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

    test('restoreUser serializes with in-flight and queued transactions via _txTail', async () => {
        // Prepare a second valid sqlite dump with distinct settings.
        const dumpRoot = path.join(tmpDir, 'src-dump');
        const dumpEngine = new SqliteEngine({ directoriesByHandle: () => ({ root: dumpRoot }) });
        let dumpStream;
        try {
            await dumpEngine.withTransaction('src', async (tx) => {
                await tx.putResource({ kind: 'settings', handle: 'src' }, { doc: { marker: 'restored-value' } });
            });
            dumpStream = await dumpEngine.dumpUser('src');
        } finally {
            dumpEngine.close();
        }

        await engine.withTransaction(handle, async (tx) => {
            await tx.putResource({ kind: 'settings', handle }, { doc: { marker: 'initial-value' } });
        });

        let releaseInFlight;
        let inFlightEntered;
        const entered = new Promise(resolve => { inFlightEntered = resolve; });
        const hold = new Promise(resolve => { releaseInFlight = resolve; });
        const order = [];

        const inFlightTx = engine.withTransaction(handle, async (tx) => {
            order.push('tx1-start');
            inFlightEntered();
            await hold;
            await tx.putResource({ kind: 'settings', handle }, { doc: { marker: 'tx1-committed' } });
            order.push('tx1-end');
        });

        const existingDb = engine._dbs.get(handle);
        const origClose = existingDb.close.bind(existingDb);
        existingDb.close = () => {
            order.push('restore-swap');
            return origClose();
        };

        await entered;
        const restorePromise = engine.restoreUser(handle, dumpStream);
        const queuedRead = engine.withTransaction(handle, async (tx) => {
            order.push('tx2-start');
            return await tx.getResource({ kind: 'settings', handle });
        });

        releaseInFlight();
        await Promise.all([inFlightTx, restorePromise]);
        const readAfterRestore = await queuedRead;

        expect(order).toEqual(['tx1-start', 'tx1-end', 'restore-swap', 'tx2-start']);
        expect(readAfterRestore).toEqual({ marker: 'restored-value' });
    });

    test('restoreUser surfaces existing.close() failures instead of swallowing them', async () => {
        const dumpRoot = path.join(tmpDir, 'src-close-err');
        const dumpEngine = new SqliteEngine({ directoriesByHandle: () => ({ root: dumpRoot }) });
        let dumpStream;
        try {
            await dumpEngine.withTransaction('src', async (tx) => {
                await tx.putResource({ kind: 'settings', handle: 'src' }, { doc: { marker: 'incoming' } });
            });
            dumpStream = await dumpEngine.dumpUser('src');
        } finally {
            dumpEngine.close();
        }

        await engine.withTransaction(handle, async (tx) => {
            await tx.putResource({ kind: 'settings', handle }, { doc: { marker: 'original' } });
        });

        const existingDb = engine._dbs.get(handle);
        const origClose = existingDb.close.bind(existingDb);
        existingDb.close = () => { throw new Error('SQLITE_BUSY: database handle busy'); };
        try {
            await expect(engine.restoreUser(handle, dumpStream)).rejects.toThrow(/Failed to close existing SQLite database.*SQLITE_BUSY/);
            // Original database remains intact and no temp restore files linger.
            const leftoverTemps = fs.readdirSync(path.join(tmpDir, handle)).filter(name => name.startsWith('luker-restore-'));
            expect(leftoverTemps).toEqual([]);
        } finally {
            existingDb.close = origClose;
        }
        const current = await engine.withTransaction(handle, async (tx) => tx.getResource({ kind: 'settings', handle }));
        expect(current).toEqual({ marker: 'original' });
    });

    test('withTransaction evicts and closes a wedged handle when ROLLBACK fails so subsequent transactions succeed', async () => {
        const { TransactionOutcomeUnknownError } = await import('../../../src/storage/transaction-outcome.js');
        await engine.withTransaction(handle, async (tx) => {
            await tx.putResource({ kind: 'settings', handle }, { doc: { marker: 'before-wedge' } });
        });

        const wedgedDb = engine._dbs.get(handle);
        const origExec = wedgedDb.exec.bind(wedgedDb);
        wedgedDb.exec = (sql) => {
            if (sql === 'ROLLBACK') throw new Error('synthetic rollback failure');
            return origExec(sql);
        };

        await expect(engine.withTransaction(handle, async () => {
            throw new Error('tx body boom');
        })).rejects.toBeInstanceOf(TransactionOutcomeUnknownError);

        // Wedged handle was evicted and closed.
        expect(engine._dbs.has(handle)).toBe(false);
        expect(wedgedDb.open).toBe(false);

        // Subsequent transaction opens a fresh handle cleanly instead of hitting nested BEGIN error.
        const recovered = await engine.withTransaction(handle, async (tx) => tx.getResource({ kind: 'settings', handle }));
        expect(recovered).toEqual({ marker: 'before-wedge' });
    });
});
