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
import { test, expect } from '../../../harness/playwright.js';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { startServer } from '../../../harness/server.js';
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

test('cross-mode recovery: real sqlite data round-trips through fs restore with full category parity', async ({ resources, page }) => {
    const realDataRoot = resolveRealDataRoot();
    const tempDir = (await resources.directory(`xmode-${SPEC_ID}`)).path;
    let sourceServer = null;
    let destServer = null;
    let sourceDataRoot = null;

    {
        const data = await cloneRealDataForSpec({ scope: resources, sourceDataRoot: realDataRoot, specId: SPEC_ID });
        sourceDataRoot = data.path;
        expect(realDataLooksPopulated(sourceDataRoot)).toBe(true);

        // Step 2: boot a sqlite source server pointed at the cloned data.
        sourceServer = await startServer({ scope: resources,
            batchKey: 'xmode',
            scenarioId: `${SPEC_ID}-src`,
            data,
            extraConfig: { storage: { mode: SOURCE_MODE } },
        });
        markOnboarded({ dataRoot: sourceServer.dataRoot });
        await awaitMainUI(page, sourceServer.baseURL);
        await completeFirstRunOnboardingIfVisible(page);

        // Step 4: download a full backup ZIP via Account → Backup.
        // We keep the page's default content selection and click Download.
        const backupZipPath = path.join(tempDir, 'real-backup.zip');
        await downloadBackupViaUI(page, backupZipPath);
        expect(existsSync(backupZipPath)).toBe(true);
        expect(statSync(backupZipPath).size).toBeGreaterThan(64 * 1024);

        // Step 5: kill source before reading its on-disk state. A live sqlite
        // server keeps boot-time settings writes in the WAL; an out-of-band
        // read during that window sees the pre-boot value while the backup
        // carries the current one. Stopping first checkpoints the WAL.
        await sourceServer.stop();
        sourceServer = null;

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

        // Step 6: boot a fresh fs destination before restoring the selected bytes.
        destServer = await startServer({ scope: resources,
            batchKey: 'xmode',
            scenarioId: `${SPEC_ID}-dst`,
            extraConfig: { storage: { mode: DEST_MODE } },
        });
        markOnboarded({ dataRoot: destServer.dataRoot });
        await awaitMainUI(page, destServer.baseURL);

        // Step 7: open Account → Restore, attach the ZIP, restore in
        // Replace mode, accept the confirm.  Same flow as the
        // fabricated specs use, lifted here without dragging in the
        // mock-LLM and character-select scaffolding the parameterized
        // flow imposes.
        await restoreBackupViaUI(page, backupZipPath);

        // Step 8: wait until every backed-up category matches. The restore
        // response streams progress before the fs writes settle, so polling
        // for parity is the completion condition rather than a row floor.
        const report = await waitForRestoredParity(destServer.dataRoot, beforeSnap);

        // Step 9: assert no missing / changed items in ANY backed-up
        // category.  Extras on dest are tolerated (the fs server's boot
        // re-seeds a couple of default themes that the operator may have
        // overwritten in their real install; the backup ZIP carries the
        // operator's version which then displaces the seed — but a dest
        // that was JUST booted may still carry the seed file briefly).
        // The failure message embeds the full per-category diff so the
        // developer can see exactly which row didn't round-trip.
        expect(hasParityFailures(report), formatParityReport(report)).toBe(false);
    }
});

// ----- helpers -----------------------------------------------------------

async function completeFirstRunOnboardingIfVisible(page) {
    const onboarding = page.locator('dialog.popup[open]', { hasText: /Welcome to Luker|欢迎使用|歡迎使用/ }).first();
    if (!(await onboarding.isVisible())) return;
    await onboarding.locator('.popup-button-ok').click();
    await onboarding.waitFor({ state: 'detached', timeout: 5_000 });
}

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

async function waitForRestoredParity(dataRoot, sourceSnapshot) {
    const deadline = Date.now() + 180_000;
    let lastReport = null;
    while (Date.now() < deadline) {
        try {
            const snapshot = await snapshotDataRoot({ dataRoot, engineMode: DEST_MODE });
            lastReport = compareSnapshots(sourceSnapshot, snapshot);
            if (!hasParityFailures(lastReport)) return lastReport;
        } catch { /* dest dir may not exist or be readable yet */ }
        await new Promise(r => setTimeout(r, 500));
    }
    const detail = lastReport ? formatParityReport(lastReport) : 'no destination snapshot could be read';
    throw new Error(`dest dataRoot did not reach source parity within 180s: ${detail}`);
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
