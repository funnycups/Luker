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

    async close() { /* nothing to do */ }
}
