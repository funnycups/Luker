import { FsTransaction } from './fs-engine-transaction.js';

export class FsEngine {
    constructor({ directoriesByHandle }) {
        if (typeof directoriesByHandle !== 'function') {
            throw new TypeError('FsEngine requires { directoriesByHandle: (handle) => dirs }');
        }
        this.kind = 'fs';
        this._directoriesByHandle = directoriesByHandle;
    }

    // `handle` is accepted but unused by FsTransaction — its per-kind handlers
    // extract `handle` from key.handle / filter.handle themselves. SqliteEngine
    // *does* need it to pick the per-user DB before the transaction begins, so
    // the engine contract takes (handle, fn) uniformly.
    async withTransaction(handle, fn) {
        const tx = new FsTransaction({ directoriesByHandle: this._directoriesByHandle });
        return fn(tx);
    }

    async ping(handle) { /* nothing to do */ }

    /**
     * No-op by design: the fs engine has no engine-internal rows to wipe —
     * every byte of a user's data lives in the on-disk directory tree. The
     * admin `/delete` handler's `purge=true` branch is the single, explicit
     * owner of removing that directory; `deleteUser` here runs unconditionally
     * and must therefore preserve the dir when the admin chose `purge=false`.
     * Idempotent (it does nothing).
     * @param {string} _handle
     */
    async deleteUser(_handle) {
        // intentionally empty — see jsdoc above
    }

    /**
     * The fs engine has no engine-internal rows to dump. The on-disk
     * directory tree (already included by createBackupArchive's
     * file/directory loop) IS the backup. createBackupArchive's
     * `kind !== 'fs'` guard ensures this method is never called in
     * production. Returning null is the documented "nothing to dump"
     * signal.
     * @param {string} _handle
     * @returns {Promise<null>}
     */
    async dumpUser(_handle) {
        return null;
    }

    /**
     * fs restore is a no-op. Backup files for fs mode are
     * regular files inside the ZIP; restoreUserBackupArchive extracts them
     * via fs writes, not via this method. The engine.kind === 'fs' branch
     * in the restore handler does not call this.
     * @param {string} _handle
     * @param {import('node:stream').Readable} _stream
     * @returns {Promise<void>}
     */
    async restoreUser(_handle, _stream) {
        // Intentionally empty.
    }

    async close() { /* nothing to do */ }
}
