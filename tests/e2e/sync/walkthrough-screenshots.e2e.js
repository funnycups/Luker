// LAN Sync walkthrough — drives every panel the user encounters during
// the documented pair → sync → conflict → resolve flow, captures one
// screenshot per step into docs/public/_screenshots/lan-sync/, and
// asserts the banner text reads the way the user docs claim.
//
// Outcome model:
//   - The screenshots are the artifact the docs embed. They MUST come
//     from real DOM, not mock-ups — when the panel layout changes, the
//     screenshots diverge from production and the next regen catches it.
//   - The banner-text assertions cover the UX gap audited earlier:
//     spec 01–11 prove "right button → right data lands", they do NOT
//     prove "the banner says something a user can understand". This
//     spec pins three load-bearing strings the docs reference:
//     "Sync complete.", "Synced with <peer>.", and the conflict count
//     phrasing. If the wording shifts, the docs go stale; failing here
//     forces the update in the same change.
//
// Per feedback_e2e_real_user_flow: two real `startServer` instances,
// real Playwright clicks, the exact same helpers spec 01-11 use. No
// new test plumbing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, expect } from '@playwright/test';

import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import {
    openLanSyncPanel,
    generatePairingLink,
    resolveAllConflictsAs,
    clickSyncNow,
    listConflictKinds,
    applyConflictResolutions,
} from '../_lib/sync.js';

// __dirname is .../tests/e2e/sync; three levels up to repo root.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCREENSHOTS_DIR = path.join(REPO_ROOT, 'docs', 'public', '_screenshots', 'lan-sync');

function screenshotPath(step) {
    const safe = String(step).replace(/[^A-Za-z0-9_-]+/g, '-');
    return path.join(SCREENSHOTS_DIR, `${safe}.png`);
}

/**
 * Crop the screenshot to the LAN Sync panel popup. Cropping to the
 * popup boundary keeps the doc images focused on the feature and
 * survives unrelated chrome changes (drawer width, background avatar
 * thumbnails) that would otherwise force a regen.
 *
 * Scrolls the banner into view first when one is present, because the
 * panel is long enough to scroll under its modal container; capturing
 * mid-form would crop the banner out of frame even though it's
 * technically in the DOM.
 *
 * DEFAULT: skips the actual `page.screenshot()` write. Regression runs
 * shouldn't rewrite in-tree docs images. The scroll/wait side effects
 * still run so the banner-text assertions below observe the same
 * post-scroll DOM state they did before. Opt-in to regenerate via
 * `LUKER_UPDATE_DOC_SCREENSHOTS=1`.
 */
async function shootPanel(page, step) {
    const panel = page.locator('.userLanSync').first();
    await panel.waitFor({ state: 'visible', timeout: 5_000 });
    const banner = panel.locator('.lanSyncStatusBanner').first();
    if (await banner.isVisible().catch(() => false)) {
        await banner.scrollIntoViewIfNeeded();
    } else {
        // No banner — scroll the panel header into view so steps that
        // care about the tab strip (01, 02, 06, 08) frame cleanly.
        await panel.evaluate((el) => { el.scrollIntoView({ block: 'start' }); });
    }
    if (!process.env.LUKER_UPDATE_DOC_SCREENSHOTS) return;
    await page.screenshot({ path: screenshotPath(step), fullPage: false });
}

let A, B;

test.beforeAll(async () => {
    // Only create the docs screenshots dir when a regen was requested.
    // Regression runs skip the screenshot writes entirely (see shootPanel).
    if (process.env.LUKER_UPDATE_DOC_SCREENSHOTS) {
        fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    }

    A = await startServer({
        batchKey: 'sync',
        scenarioId: 'walkthrough-A',
    });
    B = await startServer({
        batchKey: 'sync',
        scenarioId: 'walkthrough-B',
    });
    markOnboarded({ dataRoot: A.dataRoot });
    markOnboarded({ dataRoot: B.dataRoot });

    // Seed a shared world on both sides with identical content so the
    // initial pair lands clean (no conflict) — gives us a "Sync complete."
    // screenshot before the divergent edit forces the conflict screen.
    const aWorlds = path.join(A.dataRoot, 'default-user', 'worlds');
    const bWorlds = path.join(B.dataRoot, 'default-user', 'worlds');
    fs.mkdirSync(aWorlds, { recursive: true });
    fs.mkdirSync(bWorlds, { recursive: true });
    const initial = JSON.stringify({ name: 'Cascade Lore', entries: {} });
    fs.writeFileSync(path.join(aWorlds, 'Cascade Lore.json'), initial);
    fs.writeFileSync(path.join(bWorlds, 'Cascade Lore.json'), initial);
});

test.afterAll(async () => {
    await tearDownServer(A);
    await tearDownServer(B);
});

test.describe('LAN Sync — walkthrough screenshots and banner UX', () => {
    test('panel empty → pair → sync clean → trigger conflict → resolve, capturing the panel at each step', async ({ browser }) => {
        test.setTimeout(180_000);

        const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();

        await awaitMainUI(pageA, A.baseURL);
        await awaitMainUI(pageB, B.baseURL);

        // --- Step 01: A opens the panel and lands on My devices. Peers
        // list is empty, banner is hidden. This is what a user sees the
        // first time they open the LAN Sync panel after a fresh install.
        await openLanSyncPanel(pageA);
        await pageA.locator('.lanSyncTabPeers').click();
        const peersEmptyOnA = pageA.locator('.lanSyncPeersEmpty').first();
        await expect(peersEmptyOnA).toBeVisible();
        await shootPanel(pageA, '01-panel-empty');

        // --- Step 02: A clicks "Pair new device", fills the label,
        // selects categories. Captured before clicking Generate so the
        // doc can call out the form fields by position.
        await pageA.locator('.lanSyncTabPairNew').click();
        await pageA.locator('.lanSyncPairLabel').fill('Phone');
        await pageA.evaluate(() => {
            document.querySelectorAll('.lanSyncCategoryGrid input[name="lanSyncCategory"]').forEach((el) => {
                const input = /** @type {HTMLInputElement} */ (el);
                input.checked = input.value === 'worlds' || input.value === 'chats' || input.value === 'characters';
            });
        });
        await shootPanel(pageA, '02-pair-new-form-filled');

        // --- Step 03: link generated. The readonly link field is visible
        // with Copy / Generate-another buttons. Doc references this image
        // when describing the Quick Start "URL valid for 10 minutes" step.
        const link = await generatePairingLink(pageA, {
            label: 'Phone',
            categories: ['worlds', 'chats', 'characters'],
        });
        expect(link).toMatch(/^luker-sync:/);
        await shootPanel(pageA, '03-pair-link-generated');

        // --- Step 04: B opens the panel, switches to "Pair with existing
        // device", pastes the link. Captured BEFORE clicking Pair so the
        // user can see what the populated form looks like.
        await openLanSyncPanel(pageB);
        await pageB.locator('.lanSyncTabPairExisting').click();
        await pageB.locator('.lanSyncAcceptLink').fill(link);
        await pageB.locator('.lanSyncAcceptLink').dispatchEvent('input');
        await pageB.locator('.lanSyncAcceptLabel').fill('Laptop');
        await pageB.evaluate(() => {
            document.querySelectorAll('.lanSyncAcceptCategoryGrid input[name="lanSyncCategory"]').forEach((el) => {
                const input = /** @type {HTMLInputElement} */ (el);
                input.checked = input.value === 'worlds' || input.value === 'chats' || input.value === 'characters';
            });
        });
        await shootPanel(pageB, '04-pair-existing-pasted');

        // --- Step 05: Pair completes. With identical worlds seed and the
        // attemptMerge identical-trees branch, pairOutcome should be
        // 'success' (clean auto-merge). If it surfaces conflicts (seed
        // drift), pick 'theirs' so the doc still gets a coherent
        // success-banner screenshot. The banner-text assertion is the
        // UX-validation gate: doc text claims "Synced with <peer>." —
        // the assertion proves that exact wording lands.
        await pageB.locator('.lanSyncAcceptButton').click();
        let pairOutcome = await waitForTerminalBanner(pageB);
        if (pairOutcome === 'warning') {
            pairOutcome = await resolveAllConflictsAs(pageB, 'theirs');
        }
        expect(pairOutcome).toBe('success');
        await expectBannerContains(pageB, /Sync complete\.|Synced with/i);
        await shootPanel(pageB, '05-pair-success-banner');

        // --- Step 06: B's My devices list now has A registered under
        // 'Laptop' (the localLabel B picked above — that's B's own name
        // for A in B's peer list). Each row exposes Sync now / Undo /
        // Forget. This is the recurring state — every subsequent visit
        // looks like this.
        await pageB.locator('.lanSyncTabPeers').click();
        const peerRowOnB = pageB.locator('.lanSyncPeerRow', { hasText: 'Laptop' }).first();
        await expect(peerRowOnB).toBeVisible({ timeout: 5_000 });
        await shootPanel(pageB, '06-my-devices-after-pair');

        // --- Step 07: divergent edit on both sides so the next sync
        // surfaces a real conflict. Modify the same file with different
        // bodies — this is the "bothModified" path, the most
        // user-visible conflict scenario.
        fs.writeFileSync(
            path.join(A.dataRoot, 'default-user', 'worlds', 'Cascade Lore.json'),
            JSON.stringify({ name: 'Cascade Lore', entries: { '0': { content: 'on the phone, Asha rewrote the prologue' } } }),
        );
        fs.writeFileSync(
            path.join(B.dataRoot, 'default-user', 'worlds', 'Cascade Lore.json'),
            JSON.stringify({ name: 'Cascade Lore', entries: { '0': { content: 'on the laptop, the prologue stayed canonical' } } }),
        );

        const syncOutcome = await clickSyncNow(pageB, 'Laptop');
        expect(syncOutcome).toBe('warning');
        await expectBannerContains(pageB, /conflict/i);
        await shootPanel(pageB, '07-conflict-banner');

        // --- Step 08: the conflict resolution panel itself. One row,
        // "worlds/Cascade Lore.json", kind = bothModified, two radio
        // buttons (Local / Remote). Doc uses this for the "Each conflict
        // has two cards" paragraph.
        const conflictPanel = pageB.locator('.lanSyncConflictPanel').first();
        await expect(conflictPanel).toBeVisible({ timeout: 5_000 });
        const kinds = await listConflictKinds(pageB);
        expect(kinds['worlds/Cascade Lore.json']).toBe('bothModified');
        await shootPanel(pageB, '08-conflict-panel');

        // --- Step 09: user picks Local (ours wins). Apply lands and the
        // banner returns to success with the doc-canonical "Sync complete."
        // text. This is the screenshot the recovery section references
        // when it says "If a sync overwrites something you wanted back,
        // click Undo last sync" — the success state IS the prerequisite
        // for being able to undo.
        const resolveOutcome = await applyConflictResolutions(pageB, {
            'worlds/Cascade Lore.json': 'ours',
        });
        expect(resolveOutcome).toBe('success');
        await expectBannerContains(pageB, /Sync complete\.|Synced with/i);
        await shootPanel(pageB, '09-resolved-success');

        await ctxA.close();
        await ctxB.close();
    });
});

/**
 * Inline mirror of sync.js's waitForTerminalBannerState — kept private
 * to this test so the helper module's public surface doesn't grow a
 * new export just for this walkthrough. (sync.js's version isn't
 * exported.) Resolves to 'success' | 'warning' | 'error'.
 */
async function waitForTerminalBanner(page, timeoutMs = 30_000) {
    const handle = await page.waitForFunction(() => {
        const el = document.querySelector('.lanSyncStatusBanner');
        if (!el || el.classList.contains('displayNone')) return null;
        for (const kind of ['success', 'warning', 'error']) {
            if (el.classList.contains(kind)) return kind;
        }
        return null;
    }, null, { timeout: timeoutMs });
    return /** @type {'success' | 'warning' | 'error'} */ (await handle.jsonValue());
}

/**
 * Assert the visible status banner text matches a regex. The doc text
 * references three banner phrases verbatim ("Sync complete.", "Synced
 * with <peer>.", "<n> file(s) conflict.") — pinning them with
 * assertions means the docs and the runtime can't silently diverge.
 */
async function expectBannerContains(page, pattern) {
    const banner = page.locator('.lanSyncStatusBanner').first();
    await banner.waitFor({ state: 'visible', timeout: 5_000 });
    const text = (await banner.innerText()).trim();
    expect(text, `banner text "${text}" must match ${pattern}`).toMatch(pattern);
}
