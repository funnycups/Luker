// e2e/storage/cross-mode-recovery/99-real-data-sqlite-to-fs.e2e.js
//
// Real-data smoke for cross-mode recovery.  The 12 parameterized specs in
// this directory drive the wiring with a fabricated minimal seed (Seraphina
// + one Chinese-emoji chat turn) — they prove the orchestration works but
// can't tell us whether realistic user data (custom presets, lorebooks,
// extensions, embedded chats) round-trips intact.
//
// This spec clones the developer's actual `~/Desktop/projects/open-source/
// Luker/data` (or `LUKER_REAL_DATA_ROOT`), boots a sqlite server against
// the clone, downloads a full backup ZIP via Account → Backup, then
// boots a fresh fs server, restores the ZIP, and runs a per-category
// fingerprint diff that asserts EVERY backed-up engine row + fs file
// round-tripped exactly.
//
// Skipped automatically when no real dataRoot is available (CI envs etc).

import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startServer, tearDownServer } from '../../_lib/server.js';
import { awaitMainUI } from '../../_lib/page.js';
import { markOnboarded } from '../../_lib/fixtures.js';
import { accountWindow, answerWindowConfirm, closeAccountWindow, openAccountTab, pageHead } from '../../_lib/account-window.js';
import {
    cloneRealDataForSpec,
    realDataLooksPopulated,
    resolveRealDataRoot,
} from './_lib/real-data.js';
import {
    snapshotDataRoot,
    compareSnapshots,
    hasParityFailures,
    formatParityReport,
} from './_lib/parity-verify.js';

const SOURCE_MODE = 'sqlite';
const DEST_MODE = 'fs';
const SPEC_ID = '99-real-data-sqlite-to-fs';

// Real-data restore writes hundreds of files + many engine rows; budget
// extra wall-clock vs the fabricated-data specs.
test.setTimeout(15 * 60 * 1000);

test('cross-mode recovery: real sqlite data round-trips through fs restore with full category parity', async ({ page }) => {
    const realDataRoot = resolveRealDataRoot();
    test.skip(
        !realDataRoot || !realDataLooksPopulated(realDataRoot),
        `no real Luker dataRoot found (set LUKER_REAL_DATA_ROOT to point at one); resolved: ${realDataRoot}`,
    );

    const tempDir = mkdtempSync(path.join(os.tmpdir(), `xmode-${SPEC_ID}-`));
    let sourceServer = null;
    let destServer = null;
    let sourceDataRoot = null;

    try {
        // Step 1: APFS-clone the real data into the scratch root, scrub
        // secrets + dev prompt pollution.  This becomes the source server's
        // dataRoot — the real data dir is never touched.
        sourceDataRoot = cloneRealDataForSpec({ sourceDataRoot: realDataRoot, specId: SPEC_ID });
        expect(realDataLooksPopulated(sourceDataRoot)).toBe(true);

        // Step 2: snapshot the source BEFORE booting any server, so the
        // fingerprint reflects the operator's real on-disk state and isn't
        // polluted by anything the running server might write on boot
        // (settings hydration, default-content seeding, etc).
        const beforeSnap = await snapshotDataRoot({
            dataRoot: sourceDataRoot,
            engineMode: SOURCE_MODE,
        });
        const sourceCounts = describeCounts('source', beforeSnap);
        // Sanity floor: the test is only meaningful if SOMETHING is there.
        // For the developer's real data this is in the hundreds; the gate
        // below catches a corrupt or empty clone before we waste 5 minutes
        // on a no-op round trip.
        expect(sourceCounts.totalRows, `source has no engine rows: ${JSON.stringify(sourceCounts)}`).toBeGreaterThan(0);

        // Step 3: boot a sqlite source server pointed at the cloned data.
        sourceServer = await startServer({
            batchKey: 'xmode',
            scenarioId: `${SPEC_ID}-src`,
            useExistingDataRoot: sourceDataRoot,
            extraConfig: { 'storage.mode': SOURCE_MODE },
        });
        markOnboarded({ dataRoot: sourceServer.dataRoot });
        await awaitMainUI(page, sourceServer.baseURL);

        // Step 4: download a full backup ZIP via Account → Backup.
        // We keep the page's default content selection and click Download.
        const backupZipPath = path.join(tempDir, 'real-backup.zip');
        await downloadBackupViaUI(page, backupZipPath);
        expect(existsSync(backupZipPath)).toBe(true);
        expect(statSync(backupZipPath).size).toBeGreaterThan(64 * 1024);

        // Step 5: kill source.
        await tearDownServer(sourceServer);
        sourceServer = null;

        // Step 6: boot a fresh fs dest server.  No useExistingDataRoot —
        // we want a clean dest so the restored data has nothing to merge
        // against.
        destServer = await startServer({
            batchKey: 'xmode',
            scenarioId: `${SPEC_ID}-dst`,
            extraConfig: { 'storage.mode': DEST_MODE },
        });
        markOnboarded({ dataRoot: destServer.dataRoot });
        await awaitMainUI(page, destServer.baseURL);

        // Step 7: open Account → Restore, attach the ZIP, restore in
        // Replace mode, accept the confirm.  Same flow as the
        // fabricated specs use, lifted here without dragging in the
        // mock-LLM and character-select scaffolding the parameterized
        // flow imposes.
        await restoreBackupViaUI(page, backupZipPath);

        // Step 8: wait until the migrated data lands.  The cross-mode
        // orchestrator runs synchronously inside the POST handler, but the
        // fs writes flush after the HTTP response; poll the dest dataRoot
        // until it carries at least as many rows as the source had.
        await waitForDestPopulated(destServer.dataRoot, sourceCounts.totalRows);

        // Step 9: snapshot the dest and diff.
        const afterSnap = await snapshotDataRoot({
            dataRoot: destServer.dataRoot,
            engineMode: DEST_MODE,
        });
        const report = compareSnapshots(beforeSnap, afterSnap);

        // Step 10: assert no missing / changed items in ANY backed-up
        // category.  Extras on dest are tolerated (the fs server's boot
        // re-seeds a couple of default themes that the operator may have
        // overwritten in their real install; the backup ZIP carries the
        // operator's version which then displaces the seed — but a dest
        // that was JUST booted may still carry the seed file briefly).
        // The failure message embeds the full per-category diff so the
        // developer can see exactly which row didn't round-trip.
        expect(hasParityFailures(report), formatParityReport(report)).toBe(false);
    } finally {
        if (sourceServer) {
            try { await tearDownServer(sourceServer); } catch { /* best-effort cleanup */ }
        }
        if (destServer) {
            try { await tearDownServer(destServer); } catch { /* best-effort cleanup */ }
        }
        if (sourceDataRoot && existsSync(sourceDataRoot)) {
            try { rmSync(sourceDataRoot, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
        }
        try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    }
});

// ----- helpers -----------------------------------------------------------

function describeCounts(label, snap) {
    const out = { label, totalRows: 0, perCategory: {} };
    for (const cat of Object.keys(snap.engine)) {
        const n = Object.keys(snap.engine[cat]).length;
        out.perCategory[cat] = n;
        out.totalRows += n;
    }
    for (const cat of Object.keys(snap.fsTree)) {
        const n = Object.keys(snap.fsTree[cat]).length;
        out.perCategory['fs.' + cat] = n;
        out.totalRows += n;
    }
    return out;
}

async function waitForDestPopulated(dataRoot, expectedMinRows) {
    const deadline = Date.now() + 180_000;
    let lastSnap = null;
    while (Date.now() < deadline) {
        try {
            lastSnap = await snapshotDataRoot({ dataRoot, engineMode: DEST_MODE });
            const counts = describeCounts('dest', lastSnap);
            if (counts.totalRows >= expectedMinRows) return;
        } catch { /* dest dir may not exist yet */ }
        await new Promise(r => setTimeout(r, 500));
    }
    const lastCounts = lastSnap ? describeCounts('dest', lastSnap) : { totalRows: 0, perCategory: {} };
    throw new Error(
        `dest dataRoot did not reach ${expectedMinRows} rows within 180s; ` +
        `last counts = ${JSON.stringify(lastCounts.perCategory)} (total ${lastCounts.totalRows})`,
    );
}

// ----- DOM helpers (duplicated from recovery-flow.js, scaled down) ------
//
// We don't import recovery-flow.js because that module bakes in the mock
// LLM + character select + scratch-creds prompt path none of which apply
// here (sqlite → fs needs no scratch creds; no LLM call happens).

async function openBackupManagerViaUI(page, tab) {
    await openAccountTab(page, tab);
    await expect(pageHead(page)).toHaveAttribute('data-view', tab);
}

async function downloadBackupViaUI(page, destPath) {
    await openBackupManagerViaUI(page, 'backup');
    const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 120_000 }),
        accountWindow(page).locator('[data-act="backup-go"]').click(),
    ]);
    await download.saveAs(destPath);
    await closeAccountWindow(page);
}

async function restoreBackupViaUI(page, zipPath) {
    await openBackupManagerViaUI(page, 'restore');
    const win = accountWindow(page);
    await win.locator('[data-act="mode"][data-set="restore"][data-mode="replace"]').click();
    await win.locator('input[data-role="file"]').setInputFiles(zipPath);
    await win.locator('.dw-file').waitFor({ state: 'visible', timeout: 10_000 });
    await win.locator('[data-act="restore-go"]').click();
    await answerWindowConfirm(page);
}
