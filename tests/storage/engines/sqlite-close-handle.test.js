/**
 * SqliteEngine.closeHandle — covers the cache-invalidation contract that
 * the LAN-sync orchestrator (`src/sync/orchestrator.js`) depends on after
 * `reconcileShadowToLive` swaps the live DB file via `write-file-atomic`.
 *
 * The other sqlite-engine.test.js cases only exercise the no-DB-cached
 * branch (which falls through `if (db)` as a no-op); they would still pass
 * if `closeHandle(h) {}` were a literal empty function. This file fills
 * the gap by setting up the destructive case:
 *
 *   1. Lazy-open the cached connection by writing through the engine.
 *   2. Out-of-band swap the on-disk DB file with a different DB (mimicking
 *      the atomic rename `replaceSqliteFile` does during a sync reconcile).
 *   3. Read again — the cached handle still points at the unlinked inode,
 *      so SQLite returns the OLD content. This step asserts the staleness
 *      we're guarding against.
 *   4. Call `closeHandle('a')`, read again — the engine reopens the file
 *      and now sees the NEW content. This is the assertion that fails if
 *      `closeHandle` becomes a no-op.
 *
 * Without step 3, a regression where `closeHandle` silently stops dropping
 * the connection would not be caught (the lazy `_dbFor` would happen to
 * still point at the same `.sqlite` path and read the new data anyway via
 * SQLite's own page cache invalidation). Step 3 proves the test really
 * exercises the cache-pinning bug.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SqliteEngine } from '../../../src/storage/engines/sqlite-engine.js';
import { initSchema } from '../../../src/storage/engines/sqlite-schema.js';

describe('SqliteEngine.closeHandle', () => {
    let tmpDir, engine, dbPath;
    const handle = 'a';

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-sqlite-close-handle-'));
        engine = new SqliteEngine({
            directoriesByHandle: () => ({ root: path.join(tmpDir, handle) }),
        });
        dbPath = path.join(tmpDir, handle, 'luker-storage.sqlite');
    });

    afterEach(() => {
        try { engine.close(); } catch { /* may already be torn down */ }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('next access after closeHandle reopens against the post-rename inode', async () => {
        // Step 1: lazy-open handle 'a' by writing the OLD value through the
        // real engine path. This populates `_dbs.get('a')` and pins
        // better-sqlite3's handle to the inode currently at `dbPath`.
        await engine.withTransaction(handle, async (tx) => {
            await tx.putResource({ kind: 'settings', handle }, { doc: { marker: 'OLD' } });
        });
        expect(fs.existsSync(dbPath)).toBe(true);
        expect(engine._dbs.has(handle)).toBe(true);

        // Step 2: swap the file on disk. Build the replacement DB with the
        // full schema (via `initSchema` so the per-table handlers don't
        // explode with "no such table") plus the NEW settings row, then
        // atomically rename it into place — mirrors what
        // `reconcileShadowToLive` does when it materializes A's DB into
        // B's data root.
        const replacementPath = path.join(tmpDir, 'replacement.sqlite');
        const replacement = new Database(replacementPath);
        replacement.pragma('journal_mode = WAL');
        // `initSchema` only runs on `user_version === 0`; a freshly-
        // created DB satisfies that, so the chats/settings/etc. tables
        // land and `user_version` advances to 1 (matching the engine's
        // expected schema).
        initSchema(replacement);
        replacement.prepare('INSERT INTO settings (handle, doc, updated_at) VALUES (?, ?, ?)')
            .run(handle, JSON.stringify({ marker: 'NEW' }), Date.now());
        replacement.close();

        // The `-wal`/`-shm` sidecars from the OLD DB would, if left in
        // place after the file swap, cause SQLite to replay an unrelated
        // WAL against the new inode. `replaceSqliteFile` in
        // `src/sync/sqlite-snapshot.js` clears them; mirror that here so
        // the test exercises the post-reconcile filesystem state, not a
        // half-reconciled hybrid.
        for (const suffix of ['-wal', '-shm']) {
            const p = dbPath + suffix;
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }
        fs.renameSync(replacementPath, dbPath);

        // Step 3: prove the staleness. The cached handle is pinned to the
        // OLD (now-unlinked) inode. SQLite happily reads from it and
        // returns the OLD marker — the very failure mode the orchestrator
        // is guarding against.
        const stale = await engine.withTransaction(handle, async (tx) =>
            tx.getResource({ kind: 'settings', handle }));
        expect(stale).toEqual({ marker: 'OLD' });

        // Step 4: drop the cached handle and read again. `_dbFor` lazily
        // reopens against `dbPath`, which now resolves to the replacement
        // inode, so the NEW marker becomes visible. This is the assertion
        // that fails if `closeHandle` regresses to a no-op.
        engine.closeHandle(handle);
        expect(engine._dbs.has(handle)).toBe(false);

        const fresh = await engine.withTransaction(handle, async (tx) =>
            tx.getResource({ kind: 'settings', handle }));
        expect(fresh).toEqual({ marker: 'NEW' });
    });

    test('closeHandle on an unopened handle is a no-op', () => {
        // The orchestrator calls closeHandle in branches where the handle
        // may never have been lazy-opened on this side (e.g. responder
        // reconciliation for a handle the server hasn't served reads for
        // yet). Idempotence is part of the contract documented in the
        // engine's JSDoc.
        expect(() => engine.closeHandle('never-opened')).not.toThrow();
        expect(engine._dbs.has('never-opened')).toBe(false);
    });

    test('closeHandle only drops the target handle, leaving siblings open', async () => {
        // Two distinct handles share one engine in the sync integration
        // harness (`tests/sync/integration/sqlite-mode.test.js`'s
        // `buildDualSqliteHarness`). The orchestrator drops only the
        // syncing user's handle so a parallel app request for a different
        // user doesn't crash with "database connection closed".
        await engine.withTransaction(handle, async (tx) => {
            await tx.putResource({ kind: 'settings', handle }, { doc: { marker: 'A' } });
        });
        await engine.withTransaction('other', async (tx) => {
            await tx.putResource({ kind: 'settings', handle: 'other' }, { doc: { marker: 'B' } });
        });
        expect(engine._dbs.has(handle)).toBe(true);
        expect(engine._dbs.has('other')).toBe(true);

        engine.closeHandle(handle);

        expect(engine._dbs.has(handle)).toBe(false);
        expect(engine._dbs.has('other')).toBe(true);
        // The unaffected handle still reads via its preserved connection.
        const otherStill = await engine.withTransaction('other', async (tx) =>
            tx.getResource({ kind: 'settings', handle: 'other' }));
        expect(otherStill).toEqual({ marker: 'B' });
    });
});
