import fs from 'node:fs';
import Database from 'better-sqlite3';

/**
 * Produce a snapshot of a (possibly running) SQLite database using
 * `VACUUM INTO` — SQLite's official online-backup mechanism.
 *
 * The snapshot reflects the database state at the moment VACUUM INTO
 * acquires its implicit read lock; concurrent writes that land between
 * the caller's decision to snapshot and SQLite acquiring the lock are
 * non-deterministic w.r.t. which side of the snapshot they fall on.
 *
 * Concurrency caveat (spec §4.4): user-initiated save endpoints
 * (`/api/chats/save`, `/api/settings/save`, etc.) are 409-gated for
 * the duration of a sync window by the `SYNC_IN_PROGRESS` middleware
 * in `src/sync/in-progress-gate.js`, so by construction no concurrent
 * application writer races this snapshot for the same handle. A
 * different handle (multi-user server) is independent — its writes
 * proceed normally. The user-facing failure mode "the edit I made
 * during a sync vanished" is therefore prevented at the HTTP layer;
 * the user instead sees a one-time 409 with `Retry-After` and the
 * client retries after the sync finishes.
 *
 * The destination file must not already exist (better-sqlite3's VACUUM
 * INTO inherits SQLite's behaviour and errors if the target is present),
 * so we unlink any stale file at `destPath` first. This also self-heals
 * a leftover snapshot from a previously-crashed `replaceSqliteFile`
 * EXDEV fallback (see below).
 *
 * @param {{ sourcePath: string, destPath: string }} args
 */
export async function snapshotSqliteToFile({ sourcePath, destPath }) {
    if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
    const db = new Database(sourcePath, { readonly: true });
    try {
        // VACUUM INTO takes the destination as a SQL string literal — escape
        // single quotes by doubling them to keep arbitrary paths safe.
        const quoted = destPath.replace(/'/g, '\'\'');
        db.exec(`VACUUM INTO '${quoted}'`);
    } finally {
        db.close();
    }
}

/**
 * Replace `targetPath` with the contents of `sourcePath`.
 *
 * IMPORTANT: the caller must guarantee no Luker process holds the target
 * DB open across this call. The failure mode depends on platform:
 *   - On Windows, the open handle surfaces as `EBUSY`/`EPERM` during
 *     rename — loud and easy to diagnose.
 *   - On POSIX, rename succeeds but reads against the cached handle keep
 *     pointing at the unlinked inode and silently return stale data —
 *     the worse failure mode, since nothing errors.
 * This function offers no detection for either case; Task 16's
 * orchestrator owns the close-before / reopen-after dance around the
 * `SqliteEngine` cache.
 *
 * If `targetPath` does not exist (first-ever pairing on this side),
 * `rename`/`copyFile` behave as a plain create — no special-casing
 * needed.
 *
 * The `-wal` and `-shm` sidecars belong to the *old* database; once the
 * underlying file is replaced they are not just stale but actively
 * harmful (SQLite would try to replay an unrelated WAL against the new
 * DB), so we remove them first.
 *
 * The EXDEV fallback (copy + unlink across filesystems) is not atomic:
 * if the process dies between the copy and the unlink, `sourcePath` is
 * left on disk. This is harmless because `snapshotSqliteToFile` unlinks
 * any stale `destPath` on entry — the next snapshot self-heals.
 *
 * @param {{ targetPath: string, sourcePath: string }} args
 */
export async function replaceSqliteFile({ targetPath, sourcePath }) {
    for (const suffix of ['-wal', '-shm']) {
        const p = targetPath + suffix;
        if (fs.existsSync(p)) await fs.promises.unlink(p);
    }
    try {
        await fs.promises.rename(sourcePath, targetPath);
    } catch (e) {
        // `rename` is atomic only within a single filesystem. Fall back to
        // copy+unlink across filesystems (rare, but possible if the shadow
        // repo lives on a different mount than the user's data dir).
        if (e.code !== 'EXDEV') throw e;
        await fs.promises.copyFile(sourcePath, targetPath);
        await fs.promises.unlink(sourcePath);
    }
}
