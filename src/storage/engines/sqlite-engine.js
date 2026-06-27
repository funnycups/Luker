import path from 'node:path';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
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
        // Sqlite is per-handle: each user has their own DB file, opened lazily.
        // A transport-level ping with no handle (e.g. the public
        // /api/storage/health probe) has no global DB to query, so treat
        // it as a no-op — the SqliteEngine instance existing is itself the
        // "engine is loaded" signal. Per-handle pings still verify SELECT 1.
        if (handle === undefined || handle === null) return;
        const db = this._dbFor(handle);
        db.prepare('SELECT 1').get();
    }

    /**
     * No-op for "engine row removal" per design spec §4.1 / §5.3 — every byte
     * of a sqlite user's data lives in `dirs.root/luker-storage.sqlite`, and
     * the admin `/delete` handler's `purge=true` branch is the single,
     * explicit owner of removing the user dir (which sweeps the .sqlite file
     * with it). `deleteUser` runs unconditionally and must therefore preserve
     * the file when the admin chose `purge=false`.
     *
     * We DO still close + evict the cached `Database` handle here so a
     * subsequent `purge=true` `fs.rm(dirs.root)` doesn't race an open file
     * descriptor (Windows refuses to delete in-use files; *nix would leave a
     * dangling unlinked inode). Idempotent — missing handle is a no-op.
     * @param {string} handle
     */
    async deleteUser(handle) {
        const existing = this._dbs.get(handle);
        if (existing) {
            try { existing.close(); } catch { /* db may already be closed */ }
            this._dbs.delete(handle);
            this._txTail.delete(handle);
        }
    }

    /**
     * sqlite returns a binary stream of the per-user .sqlite
     * file. Uses better-sqlite3's online backup API for crash-consistency
     * under concurrent writes (`db.backup(tmpPath)` is preferable to a raw
     * `fs.createReadStream` on the live file, which could capture a half-baked
     * page mid-write). The backup is written to `os.tmpdir()` first, then
     * streamed; the temp file is unlinked when the stream closes (success or
     * error).
     * @param {string} handle
     * @returns {Promise<import('node:stream').Readable>}
     */
    async dumpUser(handle) {
        const db = this._dbFor(handle);
        const tmpPath = path.join(os.tmpdir(), `luker-dump-${randomBytes(8).toString('hex')}.sqlite`);
        await db.backup(tmpPath);
        const stream = fs.createReadStream(tmpPath);
        const cleanup = () => {
            fsPromises.rm(tmpPath, { force: true }).catch(() => { /* best-effort */ });
        };
        stream.on('close', cleanup);
        stream.on('error', cleanup);
        return stream;
    }

    /**
     * sqlite restore writes the incoming bytes into
     * `dirs.root/luker-storage.sqlite`. Closes + evicts the cached `Database`
     * handle first so the rename doesn't race an open handle (Windows refuses
     * to replace open files; *nix would leave readers on a dangling inode).
     * Writes to a temp file first then `fs.rename`s atomically over the final
     * path — a partial write or a crash mid-stream leaves the previous DB
     * intact. The next `_dbFor(handle)` call re-opens the new file and runs
     * `initSchema` to bring any older dump schema forward.
     * @param {string} handle
     * @param {import('node:stream').Readable} stream
     */
    async restoreUser(handle, stream) {
        const existing = this._dbs.get(handle);
        if (existing) {
            try { existing.close(); } catch { /* best-effort */ }
            this._dbs.delete(handle);
            this._txTail.delete(handle);
        }
        const dirs = this._directoriesByHandle(handle);
        const finalPath = path.join(dirs.root, 'luker-storage.sqlite');
        const tmpPath = path.join(os.tmpdir(), `luker-restore-${randomBytes(8).toString('hex')}.sqlite`);
        try {
            await new Promise((resolve, reject) => {
                const write = fs.createWriteStream(tmpPath);
                stream.on('error', reject);
                write.on('error', reject);
                write.on('finish', resolve);
                stream.pipe(write);
            });
            // Ensure the parent dir exists — restore can run before any other
            // write has materialized the per-user directory.
            await fsPromises.mkdir(dirs.root, { recursive: true });
            await fsPromises.rename(tmpPath, finalPath);
        } catch (err) {
            await fsPromises.rm(tmpPath, { force: true }).catch(() => { /* best-effort */ });
            throw err;
        }
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

    /**
     * Drop the cached connection for a single handle. Subsequent storage
     * calls for that handle go through `_dbFor`, which lazily reopens
     * against whatever DB file is on disk at that time.
     *
     * Used by the LAN-sync orchestrator after `reconcileShadowToLive`
     * swaps in a fresh `luker-storage.sqlite` via `write-file-atomic`'s
     * rename: better-sqlite3's cached handle pins the OLD (now unlinked)
     * inode and silently returns stale data, so we MUST drop it before
     * the next read or write. Per-handle (rather than `close()`)
     * preserves any other user's connection in the same process — the
     * sync queue's mutex only covers the syncing user's pairing.
     *
     * Concurrency caveat (spec §4.4): an app write that beats this drop
     * to the cached connection — i.e. lands AFTER `reconcileShadowToLive`'s
     * rename swap but BEFORE this `closeHandle` runs — would write to the
     * old (unlinked) inode, then be lost. The spec envisions a
     * SYNC_IN_PROGRESS gate that 409s save endpoints during sync to
     * prevent this; that gate is NOT yet implemented (tracked for v1.1).
     * In v1 the per-(userRoot, peerId) FIFO queue around `runPull`
     * narrows the race window but does not close it for in-flight writes
     * the queue cannot see. User-facing docs note "avoid editing during
     * sync" as the v1 mitigation.
     *
     * Idempotent: a handle with no cached connection is a no-op. Safe to
     * call multiple times in sequence.
     *
     * @param {string} handle
     */
    closeHandle(handle) {
        const db = this._dbs.get(handle);
        if (db) {
            db.close();
            this._dbs.delete(handle);
        }
        // Drop the per-handle tx tail too; any in-flight transaction
        // should already be drained by the caller's serialization, and a
        // dangling tail would keep the chained promise pinned in memory.
        this._txTail.delete(handle);
    }
}
