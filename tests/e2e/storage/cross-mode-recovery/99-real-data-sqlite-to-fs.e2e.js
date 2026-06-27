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
// the clone, downloads a full backup ZIP via the Backup Manager UI, then
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

        // Step 4: download a full backup ZIP via the Backup Manager UI.
        // ALL categories selected — that's the default of every checkbox in
        // the Backup Manager popup; we just keep them and click Download.
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

        // Step 7: open Backup Manager, attach the ZIP, click Restore in
        // OVERWRITE mode, accept the confirm popup.  Same flow as the
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

async function ensureUserSettingsDrawerOpen(page) {
    const settingsDrawer = page.locator('#user-settings-button');
    if (await settingsDrawer.count() === 0) return;
    const drawerClosed = await page
        .locator('#user-settings-button .drawer-icon.closedIcon').count().then(n => n > 0);
    if (drawerClosed) {
        await page.locator('#user-settings-button .drawer-toggle').click();
        await page.waitForFunction(() => {
            const el = document.getElementById('user-settings-block');
            return el && !el.classList.contains('closedDrawer');
        }, { timeout: 5_000 });
    }
}

async function openBackupManagerViaUI(page) {
    await ensureUserSettingsDrawerOpen(page);
    const accountBtn = page.locator('#account_button');
    await accountBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await accountBtn.click();
    const backupBtn = page.locator('.userBackupButton').last();
    await backupBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await backupBtn.click();
    await page.locator('.userBackupManager').last().waitFor({ state: 'visible', timeout: 10_000 });
}

async function downloadBackupViaUI(page, destPath) {
    await openBackupManagerViaUI(page);
    const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 120_000 }),
        page.locator('.backupDownloadButton').last().click(),
    ]);
    await download.saveAs(destPath);
    await page.keyboard.press('Escape').catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
}

async function restoreBackupViaUI(page, zipPath) {
    await openBackupManagerViaUI(page);
    await page.locator('input[name="backupRestoreMode"][value="overwrite"]').last().click();
    const fileInput = page.locator('.backupRestoreFileInput').last();
    await fileInput.setInputFiles(zipPath);
    const baseOpenCount = await openPopupCount(page);
    await page.locator('.backupRestoreButton').last().click();
    await resolveTopmostPopupAffirmative(page, baseOpenCount + 1);
}

async function openPopupCount(page) {
    return await page.evaluate(async () => {
        const mod = await import('/scripts/popup.js');
        return (mod?.Popup?.util?.popups || []).filter(p => p?.dlg?.hasAttribute('open')).length;
    });
}

async function resolveTopmostPopupAffirmative(page, expectedMinOpenCount) {
    await page.waitForFunction(async (minOpen) => {
        const mod = await import('/scripts/popup.js');
        const open = (mod?.Popup?.util?.popups || []).filter(p => p?.dlg?.hasAttribute('open'));
        return open.length >= minOpen;
    }, expectedMinOpenCount, { timeout: 15_000 });
    const beforeCount = await openPopupCount(page);
    await page.evaluate(async () => {
        const mod = await import('/scripts/popup.js');
        const open = (mod?.Popup?.util?.popups || []).filter(p => p?.dlg?.hasAttribute('open'));
        if (open.length === 0) throw new Error('no open popup');
        await open[open.length - 1].complete(1);
    });
    await page.waitForFunction(async (expected) => {
        const mod = await import('/scripts/popup.js');
        const open = (mod?.Popup?.util?.popups || []).filter(p => p?.dlg?.hasAttribute('open'));
        return open.length === expected;
    }, beforeCount - 1, { timeout: 10_000 }).catch(() => {});
}
