import { StorageReadOnlyError } from './errors.js';

let _readOnly = false;
let _bypassDepth = 0;

export function setReadOnly(value) { _readOnly = !!value; }
export function isReadOnly() { return _readOnly; }

/**
 * Throws when the global read-only flag is set, UNLESS the caller is currently
 * inside a `withReadOnlyBypass` scope (which the migration runner uses to write
 * to the destination engine while the source is frozen).
 */
export function assertWritable() {
    if (_readOnly && _bypassDepth === 0) throw new StorageReadOnlyError();
}

/**
 * Temporarily suspends the read-only guard for the duration of `fn`. Used by
 * MigrationRunner so its destination writes go through while the global flag
 * keeps HTTP request handlers locked out.
 *
 * Reentrant via depth counter so nested scopes (e.g. migrateAllUsers calling
 * migrateUser within its READ_ONLY scope) don't accidentally pop the bypass
 * before the inner call finishes.
 *
 * @template T
 * @param {() => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
export async function withReadOnlyBypass(fn) {
    _bypassDepth++;
    try {
        return await fn();
    } finally {
        _bypassDepth--;
    }
}
