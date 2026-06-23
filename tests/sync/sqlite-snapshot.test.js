import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { snapshotSqliteToFile, replaceSqliteFile } from '../../src/sync/sqlite-snapshot.js';

describe('SQLite snapshot/replace', () => {
    let dir, sourcePath, snapshotPath, replacementPath;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-sync-sqlite-'));
        sourcePath = path.join(dir, 'live.sqlite');
        snapshotPath = path.join(dir, 'snapshot.sqlite');
        replacementPath = path.join(dir, 'replacement.sqlite');

        // Seed the "live" DB with two rows.
        const db = new Database(sourcePath);
        db.exec('CREATE TABLE t(k TEXT PRIMARY KEY, v TEXT)');
        db.prepare('INSERT INTO t VALUES (?, ?)').run('a', '1');
        db.prepare('INSERT INTO t VALUES (?, ?)').run('b', '2');
        db.close();
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('snapshotSqliteToFile produces a consistent, readable copy', async () => {
        await snapshotSqliteToFile({ sourcePath, destPath: snapshotPath });
        expect(fs.existsSync(snapshotPath)).toBe(true);

        const snap = new Database(snapshotPath, { readonly: true });
        const rows = snap.prepare('SELECT k, v FROM t ORDER BY k').all();
        snap.close();
        expect(rows).toEqual([{ k: 'a', v: '1' }, { k: 'b', v: '2' }]);
    });

    test('replaceSqliteFile atomically swaps in a new database', async () => {
        // Build a distinct replacement DB.
        const repl = new Database(replacementPath);
        repl.exec('CREATE TABLE t(k TEXT, v TEXT)');
        repl.prepare('INSERT INTO t VALUES (?, ?)').run('z', '99');
        repl.close();

        // Drop fake -wal/-shm sidecars on the target to verify they get cleaned.
        fs.writeFileSync(sourcePath + '-wal', 'fake-wal');
        fs.writeFileSync(sourcePath + '-shm', 'fake-shm');

        await replaceSqliteFile({ targetPath: sourcePath, sourcePath: replacementPath });

        const db = new Database(sourcePath, { readonly: true });
        const rows = db.prepare('SELECT k, v FROM t').all();
        db.close();
        expect(rows).toEqual([{ k: 'z', v: '99' }]);

        // Sidecars from the old DB must be gone so reopens see fresh state.
        expect(fs.existsSync(sourcePath + '-wal')).toBe(false);
        expect(fs.existsSync(sourcePath + '-shm')).toBe(false);
    });
});
