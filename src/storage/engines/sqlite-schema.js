import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrationsSync } from './schema-runner.js';

export const CURRENT_SCHEMA_VERSION = 1;

// SQLite schema mirroring mysql/postgres counterparts. Statements live in
// ./migrations/sqlite/0001-initial.sql; this module bootstraps nothing — sqlite
// uses the built-in `user_version` pragma instead of a `_storage_meta` table.
// We delegate to the sync variant of the migration runner because better-sqlite3
// is sync end-to-end and the engine's `_dbFor(handle)` relies on `initSchema`
// returning without a Promise boundary.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

export function initSchema(db) {
    // Wrap the whole migration sweep in a transaction so a mid-DDL failure
    // rolls back cleanly and leaves user_version untouched (the runner only
    // calls writeVersion after a successful executor call, but ROLLBACK gives
    // us belt-and-suspenders against partial CREATE TABLE state).
    db.exec('BEGIN');
    try {
        runMigrationsSync({
            kind: 'sqlite',
            executor: (sql) => db.exec(sql),
            migrationsDir: MIGRATIONS_DIR,
            readVersion: () => db.pragma('user_version', { simple: true }),
            // PRAGMA does not accept bound parameters, so inline the integer.
            // The value comes from the migration filename (parsed to Number),
            // never from user input.
            writeVersion: (n) => db.pragma(`user_version = ${n}`),
        });
        db.exec('COMMIT');
    } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* engine may already have rolled back */ }
        throw err;
    }
}
