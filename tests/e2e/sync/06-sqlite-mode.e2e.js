// SQLite-mode LAN Sync e2e — exercises the whole-DB blob path through
// the real UI on a real SQLite backend.
//
// Setup matches `tests/e2e/_smoke/sanity-sqlite.e2e.js`: both servers
// boot in fs mode (so the standard content-seed step works), then the
// test migrates each side to SQLite via the admin UI. From that point
// the live storage layer is SqliteEngine and the LAN Sync pipeline must
// route through `snapshotSqliteIntoShadowIfNeeded` → `VACUUM INTO` →
// commit blob → reconcile → `replaceSqliteFile` → `engine.closeHandle`.
//
// This is the path the spec §6.3 says is required for SQLite-mode users.
// Without this e2e, the only coverage is the in-process jest test in
// `tests/sync/integration/sqlite-mode.test.js`, which mocks the user
// middleware. This spec proves the full user click path works.

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { migrateViaAdminUI, fetchStorageStatus, closeAdminPanel } from '../_lib/storage-ui.js';
import {
    openLanSyncPanel,
    generatePairingLink,
    acceptPairingLink,
    resolveAllConflictsAs,
} from '../_lib/sync.js';

let A, B;

test.beforeAll(async () => {
    A = await startServer({
        batchKey: 'sync',
        scenarioId: 'sqlite-A',
        extraConfig: { enableUserAccounts: false },
    });
    B = await startServer({
        batchKey: 'sync',
        scenarioId: 'sqlite-B',
        extraConfig: { enableUserAccounts: false },
    });
    markOnboarded({ dataRoot: A.dataRoot });
    markOnboarded({ dataRoot: B.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(A);
    await tearDownServer(B);
});

test.describe('LAN Sync — SQLite storage mode', () => {
    test('migrate both sides to SQLite → pair with database category → B receives A\'s DB blob', async ({ browser }) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();

        await awaitMainUI(pageA, A.baseURL);
        await awaitMainUI(pageB, B.baseURL);

        // Migrate each side fs → sqlite through the admin UI. The
        // helper drives the real admin panel buttons; on return,
        // SqliteEngine is the live backend on that server.
        await migrateViaAdminUI(pageA, 'sqlite');
        expect((await fetchStorageStatus(pageA)).currentMode).toBe('sqlite');
        await closeAdminPanel(pageA);

        await migrateViaAdminUI(pageB, 'sqlite');
        expect((await fetchStorageStatus(pageB)).currentMode).toBe('sqlite');
        await closeAdminPanel(pageB);

        // Sanity: both sides have a SQLite DB file on disk now.
        const aDbPath = path.join(A.dataRoot, 'default-user', 'luker-storage.sqlite');
        const bDbPath = path.join(B.dataRoot, 'default-user', 'luker-storage.sqlite');
        expect(fs.existsSync(aDbPath)).toBe(true);
        expect(fs.existsSync(bDbPath)).toBe(true);

        // Capture B's DB size as the baseline — after sync, B's DB
        // should be replaced by A's (different size, because A's
        // post-migration DB has slightly different settings content
        // due to the migration history).
        const bDbSizeBefore = fs.statSync(bDbPath).size;

        // Open LAN Sync — the availability check should report
        // available (sqlite IS supported, unlike mysql/postgres).
        await openLanSyncPanel(pageA);

        // The panel rendered — meaning availability returned true on
        // sqlite. If it returned false, lanSyncMain would be hidden
        // and the tab buttons wouldn't be visible.
        await expect(pageA.locator('.lanSyncTabPairNew')).toBeVisible();

        // Generate a pairing link with the `database` category enabled
        // alongside `worlds`. The `database` category is what carries
        // the whole-DB snapshot blob.
        const link = await generatePairingLink(pageA, {
            label: 'B device',
            categories: ['worlds', 'database'],
        });

        await openLanSyncPanel(pageB);
        const acceptOutcome = await acceptPairingLink(pageB, link, {
            categories: ['worlds', 'database'],
            localLabel: 'A device',
        });

        // The `database` category's whole-DB conflictMode means even
        // identical bytes register as a conflict (different blob oids
        // since each side's DB has independent rowids/timestamps from
        // the separate migrations). Resolve to A's version.
        if (acceptOutcome === 'warning') {
            const resolveOutcome = await resolveAllConflictsAs(pageB, 'theirs');
            expect(resolveOutcome).toBe('success');
        } else {
            expect(acceptOutcome).toBe('success');
        }

        // The load-bearing assertion: B's live DB file has been
        // replaced. The orchestrator's reconcile path wrote A's DB
        // blob over B's via write-file-atomic, then dropped B's
        // cached engine handle so the next storage call lazy-reopens
        // against the new inode. We verify the file got swapped by
        // checking it changed size (A's and B's post-migration DBs
        // differ enough to be detectable).
        await expect.poll(
            () => fs.statSync(bDbPath).size,
            { timeout: 10_000 },
        ).not.toBe(bDbSizeBefore);

        // Sanity that the swap didn't corrupt the file: it's still a
        // SQLite DB (magic bytes 'SQLite format 3\0' at offset 0).
        const head = fs.readFileSync(bDbPath).subarray(0, 15).toString('utf8');
        expect(head).toBe('SQLite format 3');

        await ctxA.close();
        await ctxB.close();
    });
});
