import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { SqliteTransaction } from './sqlite-engine-transaction.js';
import { initSchema } from './sqlite-schema.js';

export class SqliteEngine {
    constructor({ directoriesByHandle }) {
        if (typeof directoriesByHandle !== 'function') {
            throw new TypeError('SqliteEngine requires { directoriesByHandle: (handle) => dirs }');
        }
        this.kind = 'sqlite';
        this._directoriesByHandle = directoriesByHandle;
        this._dbs = new Map();
        // Per-handle async tail. `withTransaction` chains onto the previous
        // promise for the same handle, so two parallel HTTP requests on the
        // same user's DB don't both run `BEGIN IMMEDIATE` and trip
        // "cannot start a transaction within a transaction". better-sqlite3
        // is synchronous per-call but `withTransaction` accepts async work,
        // which the language alone can't serialize.
        this._txTail = new Map();
    }

    _dbFor(handle) {
        if (this._dbs.has(handle)) return this._dbs.get(handle);
        const root = this._directoriesByHandle(handle).root;
        fs.mkdirSync(root, { recursive: true });
        const dbPath = path.join(root, 'luker-storage.sqlite');
        const db = new Database(dbPath);
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL');
        db.pragma('foreign_keys = ON');
        initSchema(db);
        this._dbs.set(handle, db);
        return db;
    }

    async ping(handle) {
        const db = this._dbFor(handle);
        db.prepare('SELECT 1').get();
    }

    async withTransaction(handle, fn) {
        const db = this._dbFor(handle);
        const tx = new SqliteTransaction({ db, handle, directoriesByHandle: this._directoriesByHandle });
        // Serialize transactions per-handle: chain onto the previous tail
        // and replace it with our own. Independent of `await`-scheduling
        // order across the event loop, only one BEGIN/COMMIT pair runs at
        // a time per DB.
        const prev = this._txTail.get(handle) || Promise.resolve();
        const run = prev.then(async () => {
            // better-sqlite3 `db.transaction()` only wraps sync functions; we need to
            // await an async closure, so drive BEGIN/COMMIT/ROLLBACK manually.
            db.exec('BEGIN IMMEDIATE');
            try {
                const result = await fn(tx);
                db.exec('COMMIT');
                return result;
            } catch (err) {
                try { db.exec('ROLLBACK'); } catch { /* engine may already have rolled back */ }
                throw err;
            }
        });
        // Swallow rejection on the tail so a failed tx doesn't poison the
        // next caller's promise chain.
        this._txTail.set(handle, run.catch(() => {}));
        return run;
    }

    close() {
        for (const db of this._dbs.values()) {
            db.close();
        }
        this._dbs.clear();
        this._txTail.clear();
    }
}
