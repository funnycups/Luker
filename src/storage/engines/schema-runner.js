import fsAsync from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

// Migration files live at <migrationsDir>/<kind>/NNNN-<slug>.sql. The leading
// integer is the schema version this migration advances to; ordering and the
// "already applied" check are purely numeric, so file slugs are decorative.
const FILE_PATTERN = /^(\d{4,})-.+\.sql$/;

function listMigrations(entries) {
    return entries
        .map((name) => {
            const m = FILE_PATTERN.exec(name);
            return m ? { name, number: Number(m[1]) } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.number - b.number);
}

function checkVersionFloor(kind, current, files) {
    const maxKnown = files.length > 0 ? files[files.length - 1].number : 0;
    if (current > maxKnown) {
        throw new Error(`schema version ${current} is newer than max known migration ${maxKnown} for engine "${kind}"`);
    }
}

/**
 * Apply pending SQL migrations for the given engine kind.
 *
 * The runner is dialect-agnostic. The caller is responsible for everything
 * engine-specific: opening a connection / transaction, parsing multi-statement
 * SQL the way that engine's driver expects, persisting and reading back the
 * schema version (e.g. a `_storage_meta` row for mysql/postgres or the
 * `user_version` pragma for sqlite).
 *
 * - Sorts <migrationsDir>/<kind>/NNNN-*.sql files numerically.
 * - Throws if `readVersion()` returns a number higher than the largest known
 *   migration (operator downgraded the binary; refuse rather than corrupt).
 * - Applies each migration whose number > current via `executor(sql)`, then
 *   immediately calls `writeVersion(number)` so a crash leaves a recoverable
 *   state (re-running skips the ones that already landed).
 * - A missing per-kind directory is treated as "no migrations" (returns
 *   silently), which lets callers point at a shared migrations root without
 *   pre-checking every engine slot.
 *
 * Atomicity contract:
 * - Migrations are atomic at the FILE boundary: `writeVersion(n)` is only
 *   called after `executor(sql)` resolves, so a crash leaves the DB at the
 *   last fully-applied version.
 * - Statements INSIDE a single file are NOT atomic on mysql/postgres: the
 *   engine executor runs them sequentially via `pool.query()`, and mysql
 *   does not support transactional DDL at all. A mid-file failure leaves
 *   partial state with no automatic rollback.
 * - Sqlite IS file-atomic because `sqlite-schema.js` wraps the entire sweep
 *   in `BEGIN`/`ROLLBACK`.
 * - Authoring guideline: every statement in a migration file must be
 *   individually idempotent (`CREATE TABLE IF NOT EXISTS`,
 *   `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` where supported,
 *   `DROP ... IF EXISTS`), OR the file must contain exactly one statement.
 */
export async function runMigrations({ kind, executor, migrationsDir, readVersion, writeVersion }) {
    const dir = path.join(migrationsDir, kind);
    let entries;
    try {
        entries = await fsAsync.readdir(dir);
    } catch (err) {
        if (err && err.code === 'ENOENT') entries = [];
        else throw err;
    }
    const files = listMigrations(entries);

    const current = await readVersion();
    checkVersionFloor(kind, current, files);

    for (const f of files) {
        if (f.number <= current) continue;
        const sql = await fsAsync.readFile(path.join(dir, f.name), 'utf8');
        await executor(sql);
        await writeVersion(f.number);
    }
}

/**
 * Synchronous variant of `runMigrations` for callers that cannot tolerate a
 * Promise boundary — currently only `sqlite-schema.js`, because better-sqlite3
 * is sync end-to-end and the sqlite engine's `_dbFor(handle)` returns a fully
 * initialized DB from a sync path (consumer tests rely on this).
 *
 * Semantics match `runMigrations` exactly; only the I/O is `*Sync`.
 */
export function runMigrationsSync({ kind, executor, migrationsDir, readVersion, writeVersion }) {
    const dir = path.join(migrationsDir, kind);
    let entries;
    try {
        entries = fsSync.readdirSync(dir);
    } catch (err) {
        if (err && err.code === 'ENOENT') entries = [];
        else throw err;
    }
    const files = listMigrations(entries);

    const current = readVersion();
    checkVersionFloor(kind, current, files);

    for (const f of files) {
        if (f.number <= current) continue;
        const sql = fsSync.readFileSync(path.join(dir, f.name), 'utf8');
        executor(sql);
        writeVersion(f.number);
    }
}
