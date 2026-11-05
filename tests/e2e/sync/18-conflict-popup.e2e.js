// The Sync issues page of the Account window: a file conflict shows on
// both devices and one choice converges them, a conflict whose file changed
// later is stale, a conflict the other device resolves while the page is
// open is no longer offered,
// a choice the other device already resolved gets its own notice while the
// others apply, and labels and paths from the other device render as text.
//
// Two real servers. World entries are added through the World Info UI;
// the hostile-name test writes its world file straight to disk as spec 02
// does. Device labels are configured through Device settings before pairing.

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';

import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { selectWorldBook, addWorldEntry } from '../_lib/ui-worldinfo.js';
import { normalizeDeviceLabel } from '../../../src/sync/device-label.js';
import {
    openLanSyncPanel, generatePairingLink, acceptPairingLink, clickSyncNow, setSyncSchedule, closeAllPopups,
    waitForBackgroundSync, waitForSyncPopup, waitForStatusChecks, syncPopup, listPopupConflicts, conflictChoiceShowing, readConflictDiff,
    chooseConflictVersion, applyConflictChoices, closeSyncPopup, readUserFile, userRootOf, backendIdOf, shadowMain, setSyncDeviceLabel,
    conflictRow, accountWindow,
} from '../_lib/sync.js';

const GLADE = 'worlds/Glade.json';
const FERN = 'worlds/Fern Hollow.json';
const HOST_LABEL = normalizeDeviceLabel(os.hostname());

let A;
let B;
let contexts = [];
let pauseDir = null;

async function start(testInfo, envB = {}) {
    A = await startServer({ batchKey: 'sync', scenarioId: `popup-${testInfo.testId}-A` });
    B = await startServer({ batchKey: 'sync', scenarioId: `popup-${testInfo.testId}-B`, extraEnv: envB });
    if (process.env.LUKER_TASK11_ACTUAL_JITLESS === '1') {
        for (const server of [A, B]) {
            const cache = path.join(server.dataRoot, '_webpack');
            const bundles = fs.readdirSync(cache).map(dir => path.join(cache, dir, 'output')).find(dir => fs.existsSync(path.join(dir, 'lib.core.bundle.js')));
            expect(bundles).toBeTruthy();
            await server.restart({ jitless: true, extraEnv: { LUKER_FORCE_JITLESS: '1', LUKER_PREBUILT_BUNDLES_DIR: bundles } });
        }
    }
    await testInfo.attach('actual-server-argv', { body: JSON.stringify([A, B].map(server => ({ port: server.port, dataRoot: server.dataRoot, argv: server.execArgv }))), contentType: 'application/json' });
}

/** Start B with a test pausepoint that holds a conflict choice before it reaches live data. */
async function startPausable(testInfo, name) {
    pauseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-e2e-pause-'));
    await start(testInfo, { LUKER_SYNC_PAUSEPOINT: name, LUKER_SYNC_PAUSE_DIR: pauseDir });
}
const arm = name => fs.writeFileSync(path.join(pauseDir, `${name}.arm`), '');
const reached = name => expect.poll(() => fs.existsSync(path.join(pauseDir, `${name}.reached`)), { timeout: 60_000 }).toBe(true);
const release = name => fs.writeFileSync(path.join(pauseDir, `${name}.release`), '');
const fileText = (server, rel) => readUserFile(server, rel) ?? '';
const holdsOnly = (server, kept, dropped) => {
    const text = fileText(server, GLADE);
    return text.includes(kept) && !text.includes(dropped);
};
/** Every version of `rel` in the sync history of `server`. */
async function historyOf(server, rel) {
    const id = backendIdOf(server);
    const gitdir = path.join(userRootOf(server), '.sync', id, 'repo.git');
    const texts = [];
    for (const entry of await git.log({ fs, gitdir, ref: await shadowMain(server, id) })) {
        const blob = await git.readBlob({ fs, gitdir, oid: entry.oid, filepath: rel }).catch(() => null);
        if (blob) texts.push(Buffer.from(blob.blob).toString('utf8'));
    }
    return texts;
}
/** The recorded bytes of one conflict version, read from the server's shadow. */
async function versionText(server, rel, oid) {
    const id = backendIdOf(server);
    const gitdir = path.join(userRootOf(server), '.sync', id, 'repo.git');
    const blob = await git.readBlob({ fs, gitdir, oid });
    return Buffer.from(blob.blob).toString('utf8');
}
const statusChecks = page => page.evaluate(() => Number(document.body.dataset.syncStatusChecks || 0));
/** Version buttons of a conflict; the window disables them while its records cannot be read. */
const versionsOf = (page, rel) => conflictRow(page, rel).locator('.dw-version');
/** Toast the Account window shows after Apply. */
const toastOf = (page, text) => accountWindow(page).locator('.dw-toast', { hasText: text });
const ALREADY_HANDLED = /files were already handled on another device/;
const pendingPaths = page => page.evaluate(async () => (await (await fetch('/api/sync/v1/status')).json()).conflicts.map(c => c.path));
const conflictEntry = (page, rel) => page.evaluate(async path => (await (await fetch('/api/sync/v1/status')).json()).conflicts.find(entry => entry.path === path), rel);

// Narrow corruption fixture: replace only the pending metadata object's bytes,
// restoring the exact object afterward. Runtime settings are never modified.
async function corruptPending(server) {
    const gitdir = path.join(userRootOf(server), '.sync', backendIdOf(server), 'repo.git');
    const oid = await git.resolveRef({ fs, gitdir, ref: 'refs/heads/main' });
    const { oid: blob } = await git.readBlob({ fs, gitdir, oid, filepath: '.luker-sync/conflicts.json' });
    const object = path.join(gitdir, 'objects', blob.slice(0, 2), blob.slice(2));
    const bytes = fs.readFileSync(object);
    fs.writeFileSync(object, 'deliberately unreadable pending metadata');
    return () => fs.writeFileSync(object, bytes);
}

function seedWorld(server, rel) {
    fs.writeFileSync(path.join(userRootOf(server), ...rel.split('/')), JSON.stringify({ entries: {} }));
}

test.afterEach(async () => {
    for (const ctx of contexts) await ctx.close();
    contexts = [];
    await tearDownServer(A);
    await tearDownServer(B);
    if (pauseDir) fs.rmSync(pauseDir, { recursive: true, force: true });
    pauseDir = null;
});

async function pairedPages(browser, deviceLabel, categories = ['worlds']) {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    contexts = [ctxA, ctxB];
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await awaitMainUI(pageA, A.baseURL);
    await awaitMainUI(pageB, B.baseURL);
    const pairedSince = Date.now();
    await openLanSyncPanel(pageA);
    const link = await generatePairingLink(pageA, { label: 'B device', categories });
    await openLanSyncPanel(pageB);
    if (deviceLabel) await setSyncDeviceLabel(pageB, deviceLabel);
    expect(await acceptPairingLink(pageB, link, { categories, localLabel: 'A device' })).toBe('success');
    await setSyncSchedule(pageB, { idleSeconds: 3600, pollSeconds: 3600 });
    await closeAllPopups(pageA);
    await openLanSyncPanel(pageA);
    await setSyncSchedule(pageA, { idleSeconds: 3600, pollSeconds: 3600 });
    await closeAllPopups(pageA);
    await closeAllPopups(pageB);
    // A syncs in the background on B's notify; edit only after both
    // devices finished their runs.
    await waitForBackgroundSync(pageA, { since: pairedSince });
    await waitForBackgroundSync(pageB, { since: pairedSince });
    // B's World Info list was loaded before the pairing brought A's books.
    await reloadAndAwait(pageB, B.baseURL);
    return { pageA, pageB };
}

/** Both devices add an entry to each book; B's Sync now records the conflicts. */
async function conflictOnB(browser, books = ['Glade']) {
    const pages = await pairedPages(browser);
    for (const [page, server, side] of [[pages.pageA, A, 'A'], [pages.pageB, B, 'B']]) {
        for (const book of books) {
            await selectWorldBook(page, book);
            await addWorldEntry(page, { key: 'oak', content: `from ${side}: the old oak of ${book} ${side === 'A' ? 'speaks at dusk' : 'sleeps'}.` });
            await expect.poll(() => fileText(server, `worlds/${book}.json`), { timeout: 30_000 }).toContain(`from ${side}`);
        }
    }
    await openLanSyncPanel(pages.pageB);
    expect(await clickSyncNow(pages.pageB, 'A device')).toBe('warning');
    await waitForSyncPopup(pages.pageB);
    return pages;
}

/** B adds an entry after the conflict and syncs, so the conflict turns stale. */
async function editAfterConflict(pageB) {
    await closeAllPopups(pageB);
    await selectWorldBook(pageB, 'Glade');
    await addWorldEntry(pageB, { key: 'moss', content: 'later B: moss covers the stones.' });
    await expect.poll(() => fileText(B, GLADE), { timeout: 30_000 }).toContain('later B');
    await openLanSyncPanel(pageB);
    expect(await clickSyncNow(pageB, 'A device')).toBe('warning');
    await reloadAndAwait(pageB, B.baseURL);
    await waitForSyncPopup(pageB);
}

test.describe('LAN Sync — Sync issues page', () => {
    test.describe.configure({ timeout: 240_000 });

    test('a file conflict opens the Sync issues page on both devices and one resolution converges', async ({ browser }, testInfo) => {
        await start(testInfo);
        seedWorld(A, GLADE);
        const { pageA, pageB } = await conflictOnB(browser);
        expect(await listPopupConflicts(pageB)).toEqual([{ path: GLADE, stale: false }]);
        await reloadAndAwait(pageA, A.baseURL);
        await waitForSyncPopup(pageA);
        expect(await listPopupConflicts(pageA)).toEqual([{ path: GLADE, stale: false }]);
        await chooseConflictVersion(pageA, GLADE, await conflictChoiceShowing(pageA, GLADE, 'from A'));
        expect(await applyConflictChoices(pageA)).toBe('success');
        await expect.poll(() => [holdsOnly(A, 'from A', 'from B'), holdsOnly(B, 'from A', 'from B')], { timeout: 60_000 }).toEqual([true, true]);
        for (const [page, server] of [[pageA, A], [pageB, B]]) {
            await reloadAndAwait(page, server.baseURL);
            await waitForStatusChecks(page, 1);
            await expect(syncPopup(page)).toHaveCount(0);
        }
    });

    test('a multi-megabyte field is truncated in the diff instead of rendered in full', async ({ browser }, testInfo) => {
        await start(testInfo);
        const HEAVY = 'worlds/Heavy.json';
        const heavyFile = server => path.join(userRootOf(server), ...HEAVY.split('/'));
        const heavyBook = content => JSON.stringify({ entries: { 0: { uid: 1, displayIndex: 0, comment: 'Heavy', content, key: ['heavy'] } } });
        fs.mkdirSync(path.dirname(heavyFile(A)), { recursive: true });
        fs.writeFileSync(heavyFile(A), heavyBook('x'.repeat(1_000_000)));
        const { pageB } = await pairedPages(browser);
        fs.writeFileSync(heavyFile(A), heavyBook('a'.repeat(1_000_000)));
        fs.writeFileSync(heavyFile(B), heavyBook('b'.repeat(1_000_000)));
        await openLanSyncPanel(pageB);
        expect(await clickSyncNow(pageB, 'A device')).toBe('warning');
        await waitForSyncPopup(pageB);
        const row = conflictRow(pageB, HEAVY);
        await expect(row.locator('.syncConflictDiffSummary')).not.toHaveText('Comparing versions…', { timeout: 60_000 });
        const diff = row.locator('.syncConflictDiff').first();
        const entry = diff.locator('.syncDiffItem', { hasText: 'Heavy' }).first();
        await entry.locator('summary').click();
        const content = entry.locator('.syncDiffField', { hasText: 'Content' }).first();
        await content.locator('summary').click();
        const values = content.locator('.syncDiffValueText');
        await expect(values).toHaveCount(2);
        await expect.poll(async () => (await values.first().innerText()).length, { timeout: 30_000 }).toBe(4000);
        await expect(content.locator('.syncConflictDiffTruncated')).toContainText('1.0 MB total');
        const text = await diff.innerText();
        expect(text.length).toBeLessThan(100_000);
        await content.locator('.syncDiffLoadMore').click();
        await expect.poll(async () => (await values.first().innerText()).length, { timeout: 30_000 }).toBe(8000);
        await expect(content.locator('.syncConflictDiffTruncated')).toContainText('1.0 MB total');
    });

    test('a secrets conflict shows masked values and keeps the plaintext out of the page', async ({ browser }, testInfo) => {
        await start(testInfo);
        const SECRETS = 'secrets.json';
        const document = (value, label, active) => JSON.stringify({ api_key_custom: [{ id: 'one', value, label, active }] });
        fs.writeFileSync(path.join(userRootOf(A), SECRETS), document('sk-base-secret-0000', 'base label', true));
        fs.writeFileSync(path.join(userRootOf(B), SECRETS), document('sk-base-secret-0000', 'base label', true));
        const { pageB } = await pairedPages(browser, undefined, ['secrets']);
        fs.writeFileSync(path.join(userRootOf(A), SECRETS), document('sk-left-secret-AAAA', 'left label', true));
        fs.writeFileSync(path.join(userRootOf(B), SECRETS), document('sk-right-secret-BBBB', 'right label', false));
        await openLanSyncPanel(pageB);
        expect(await clickSyncNow(pageB, 'A device')).toBe('warning');
        await waitForSyncPopup(pageB);
        const row = conflictRow(pageB, SECRETS);
        await expect(row.locator('.syncConflictDiffSummary')).not.toHaveText('Comparing versions…', { timeout: 60_000 });
        const diff = await readConflictDiff(pageB, SECRETS);
        expect(diff.text).toContain('left label');
        expect(diff.text).toContain('right label');
        expect([...diff.ours, ...diff.theirs].filter(value => value.includes('********AAAA'))).toHaveLength(1);
        expect([...diff.ours, ...diff.theirs].filter(value => value.includes('********BBBB'))).toHaveLength(1);
        await expect(row).not.toContainText('sk-left-secret');
        await expect(row).not.toContainText('sk-right-secret');
    });

    test('a delayed pre-apply status cannot bring back a resolved conflict', async ({ browser }, testInfo) => {
        await start(testInfo);
        seedWorld(A, GLADE);
        seedWorld(A, FERN);
        const { pageB } = await conflictOnB(browser, ['Glade', 'Fern Hollow']);
        let held;
        let releaseResponse;
        const captured = new Promise(resolve => { held = resolve; });
        const barrier = new Promise(resolve => { releaseResponse = resolve; });
        let delayed = false;
        await pageB.route('**/api/sync/v1/status', async route => {
            if (delayed) return route.continue();
            delayed = true;
            const response = await route.fetch();
            held();
            await barrier;
            await route.fulfill({ response });
        });
        await captured;
        const checks = await statusChecks(pageB);
        await chooseConflictVersion(pageB, GLADE, await conflictChoiceShowing(pageB, GLADE, 'from B'));
        await chooseConflictVersion(pageB, FERN, await conflictChoiceShowing(pageB, FERN, 'from B'));
        fs.unlinkSync(path.join(userRootOf(B), FERN));
        fs.mkdirSync(path.join(userRootOf(B), FERN));
        expect(await applyConflictChoices(pageB)).toBe('error');
        releaseResponse();
        await waitForStatusChecks(pageB, checks + 1);
        await expect(conflictRow(pageB, GLADE)).toHaveCount(0);
        await expect(conflictRow(pageB, FERN)).toHaveCount(1);
        await pageB.unroute('**/api/sync/v1/status');
    });

    test('unreadable pending rows are unknown and identical recovery restores actions', async ({ browser }, testInfo) => {
        await start(testInfo);
        seedWorld(A, GLADE);
        const { pageB } = await conflictOnB(browser);
        const restore = await corruptPending(B);
        try {
            await waitForStatusChecks(pageB, await statusChecks(pageB) + 1);
            // Still listed, but unknown: none of its versions can be chosen.
            await expect(conflictRow(pageB, GLADE)).toHaveCount(1);
            for (const version of await versionsOf(pageB, GLADE).all()) await expect(version).toBeDisabled();
        } finally { restore(); }
        await waitForStatusChecks(pageB, await statusChecks(pageB) + 1);
        for (const version of await versionsOf(pageB, GLADE).all()) await expect(version).toBeEnabled();
        await chooseConflictVersion(pageB, GLADE, 'current');
        expect(await applyConflictChoices(pageB)).toBe('success');
    });

    test('post-Apply pending read failure cannot complete a refused choice', async ({ browser }, testInfo) => {
        await start(testInfo);
        seedWorld(A, GLADE);
        const { pageB } = await conflictOnB(browser);
        await chooseConflictVersion(pageB, GLADE, 'theirs');
        fs.unlinkSync(path.join(userRootOf(B), GLADE));
        fs.mkdirSync(path.join(userRootOf(B), GLADE));
        let restore;
        await pageB.route('**/api/sync/v1/conflicts/resolve', async route => {
            const response = await route.fetch();
            expect((await response.json()).results[0].applied).toBe(false);
            restore = await corruptPending(B);
            await route.fulfill({ response });
        });
        try {
            expect(await applyConflictChoices(pageB)).toBe('error');
            await expect(conflictRow(pageB, GLADE)).toHaveCount(1);
            for (const version of await versionsOf(pageB, GLADE).all()) await expect(version).toBeDisabled();
            await expect(toastOf(pageB, 'Applied')).toHaveCount(0);
        } finally { restore?.(); }
    });

    test('a fresh same-path conflict is visible on its first refresh after partial Apply', async ({ browser }, testInfo) => {
        await start(testInfo);
        seedWorld(A, GLADE);
        seedWorld(A, FERN);
        seedWorld(A, 'worlds/Willow.json');
        const { pageA, pageB } = await conflictOnB(browser, ['Glade', 'Fern Hollow']);
        // Hold the original tab's polling before Apply so no intermediate
        // empty status deletes A's shown identity before the fresh record.
        let releaseStatus;
        const barrier = new Promise(resolve => { releaseStatus = resolve; });
        let applying = false;
        let heldReads = 0;
        let releasedReads = 0;
        let releaseRemaining;
        const remaining = new Promise(resolve => { releaseRemaining = resolve; });
        const routes = [];
        const holdStatus = route => {
            const task = (async () => {
                if (applying) return route.continue();
                const read = ++heldReads;
                await barrier;
                if (read > releasedReads) await remaining;
                await route.continue();
            })();
            routes.push(task.then(() => ({}), error => ({ error })));
            return task;
        };
        await pageB.route('**/api/sync/v1/status', holdStatus);
        try {
            await chooseConflictVersion(pageB, GLADE, 'theirs');
            await chooseConflictVersion(pageB, FERN, 'theirs');
            fs.unlinkSync(path.join(userRootOf(B), FERN));
            fs.mkdirSync(path.join(userRootOf(B), FERN));
            applying = true;
            expect(await applyConflictChoices(pageB)).toBe('error');
            applying = false;
            await expect(conflictRow(pageB, GLADE)).toHaveCount(0);
            await expect.poll(() => pendingPaths(pageA), { timeout: 60_000 }).toEqual([FERN]);
            // Keep the original window open. Edits use independent real browser tabs.
            const editorB = await contexts[1].newPage();
            await awaitMainUI(editorB, B.baseURL);
            await closeAllPopups(editorB);
            await closeAllPopups(pageA);
            for (const [page, side] of [[pageA, 'A'], [editorB, 'B']]) {
                await selectWorldBook(page, 'Glade');
                await addWorldEntry(page, { key: `fresh-${side}`, content: `fresh conflict from ${side}` });
            }
            await openLanSyncPanel(editorB);
            expect(await clickSyncNow(editorB, 'A device')).toBe('warning');
            await expect.poll(() => heldReads).toBeGreaterThan(0);
            const before = await statusChecks(pageB);
            // Release all already-admitted reads: older responses are invalidated
            // by the newest request. Later reads stay held for this assertion.
            releasedReads = heldReads;
            releaseStatus();
            await waitForStatusChecks(pageB, before + releasedReads);
            await expect(conflictRow(pageB, GLADE)).toBeVisible();
            expect((await readConflictDiff(pageB, GLADE)).text).toContain('fresh conflict');
            await closeSyncPopup(pageB);
            releaseRemaining();
            await pageB.unroute('**/api/sync/v1/status', holdStatus);
            // Keep this module instance: a seen record must remain suppressed
            // during ordinary polling, then a genuinely unseen record reopens
            // the Sync issues page with the still-pending same-path record included.
            await waitForStatusChecks(pageB, await statusChecks(pageB) + 1);
            await expect(syncPopup(pageB)).toHaveCount(0);
            for (const [page, side] of [[pageA, 'A'], [editorB, 'B']]) {
                await closeAllPopups(page);
                await selectWorldBook(page, 'Willow');
                await addWorldEntry(page, { key: side, content: `unseen Willow conflict ${side}` });
            }
            await openLanSyncPanel(editorB);
            expect(await clickSyncNow(editorB, 'A device')).toBe('warning');
            await waitForSyncPopup(pageB);
            await expect(conflictRow(pageB, GLADE)).toBeVisible();
            await expect(conflictRow(pageB, 'worlds/Willow.json')).toBeVisible();
        } finally {
            releaseStatus();
            releaseRemaining();
            await pageB.unroute('**/api/sync/v1/status', holdStatus);
            const errors = (await Promise.all(routes)).flatMap(settled => settled.error ? [settled.error] : []);
            expect(errors, 'Held conflict status routes must settle without errors').toEqual([]);
        }
    });

    test('a choice admitted before another tab resolves does not overwrite its decision', async ({ browser }, testInfo) => {
        await startPausable(testInfo, 'conflict-choices-after-read');
        seedWorld(A, GLADE);
        const { pageB } = await conflictOnB(browser);
        const other = await contexts[1].newPage();
        await awaitMainUI(other, B.baseURL);
        await waitForSyncPopup(other);
        await chooseConflictVersion(pageB, GLADE, await conflictChoiceShowing(pageB, GLADE, 'from B'));
        await chooseConflictVersion(other, GLADE, await conflictChoiceShowing(other, GLADE, 'from A'));
        arm('conflict-choices-after-read');
        const queued = applyConflictChoices(pageB);
        await reached('conflict-choices-after-read');
        expect(await applyConflictChoices(other)).toBe('success');
        release('conflict-choices-after-read');
        expect(await queued).toBe('success');
        expect(holdsOnly(B, 'from A', 'from B')).toBe(true);
        await expect(toastOf(pageB, ALREADY_HANDLED)).toBeVisible();
    });

    test('a live edit before Apply is retained until refreshed previews receive overwrite confirmation', async ({ browser }, testInfo) => {
        await start(testInfo);
        seedWorld(A, GLADE);
        const { pageB } = await conflictOnB(browser);
        const otherTab = await contexts[1].newPage();
        await awaitMainUI(otherTab, B.baseURL);
        await closeAllPopups(otherTab);
        const shown = await pageB.evaluate(async () => (await (await fetch('/api/sync/v1/status')).json()).conflicts[0]);
        const choice = await conflictChoiceShowing(pageB, GLADE, 'from A');
        const chosenText = await versionText(B, GLADE, shown[choice]);
        await chooseConflictVersion(pageB, GLADE, choice);
        let releaseStatus;
        const barrier = new Promise(resolve => { releaseStatus = resolve; });
        let allowStatus = false;
        const requests = [];
        const holdStatus = route => {
            const request = (async () => { if (!allowStatus) await barrier; await route.continue(); })();
            requests.push(request.then(() => ({}), error => ({ error })));
            return request;
        };
        await contexts[1].route('**/api/sync/v1/status', holdStatus);
        try {
            await selectWorldBook(otherTab, 'Glade');
            await addWorldEntry(otherTab, { key: 'moss', content: 'later B: retained live edit' });
            await expect.poll(() => fileText(B, GLADE)).toContain('later B');
            const live = fileText(B, GLADE);
            const response = pageB.waitForResponse(r => r.url().endsWith('/conflicts/resolve'));
            const applying = applyConflictChoices(pageB);
            const refused = await response;
            expect(refused.request().postDataJSON()).toEqual([{ path: GLADE, choice, review: {
                backendId: shown.backendId, selectedOid: shown[choice], recordVersions: shown.recordVersions, currentVersions: shown.currentVersions,
            } }]);
            expect(await refused.json()).toMatchObject({ ok: true, results: [{ applied: false, committedBackends: [] }] });
            expect(fileText(B, GLADE)).toBe(live);
            allowStatus = true; releaseStatus();
            expect(await applying).toBe('error');
            await expect(conflictRow(pageB, GLADE)).toHaveAttribute('data-stale', 'true');
            expect((await readConflictDiff(pageB, GLADE, { index: 1 })).text).toContain('later B');
            await expect(conflictRow(pageB, GLADE).locator('.dw-version.on')).toHaveCount(0);
            await chooseConflictVersion(pageB, GLADE, choice);
            expect(await applyConflictChoices(pageB)).toBe('confirm-cancelled');
            expect(fileText(B, GLADE)).toBe(live);
            expect(await applyConflictChoices(pageB, { confirmOverwrite: true })).toBe('success');
            expect(JSON.parse(fileText(B, GLADE))).toEqual(JSON.parse(chosenText));
            expect(await historyOf(B, GLADE)).toContain(live);
        } finally {
            releaseStatus();
            await contexts[1].unroute('**/api/sync/v1/status', holdStatus);
            expect((await Promise.all(requests)).flatMap(result => result.error ? [result.error] : [])).toEqual([]);
        }
    });

    test('a stale conflict shows the current version and keeping it preserves the later edit', async ({ browser }, testInfo) => {
        await start(testInfo);
        seedWorld(A, GLADE);
        const { pageB } = await conflictOnB(browser);
        await editAfterConflict(pageB);
        expect(await listPopupConflicts(pageB)).toEqual([{ path: GLADE, stale: true }]);
        expect((await readConflictDiff(pageB, GLADE, { index: 1 })).text).toContain('later B');
        await chooseConflictVersion(pageB, GLADE, 'current');
        expect(await applyConflictChoices(pageB)).toBe('success');
        expect(readUserFile(B, GLADE)).toContain('later B');
        await expect.poll(() => fileText(A, GLADE), { timeout: 60_000 }).toContain('later B');
    });

    test('choosing another version over a stale entry asks first and keeps the old version in history', async ({ browser }, testInfo) => {
        await start(testInfo);
        seedWorld(A, GLADE);
        const { pageB } = await conflictOnB(browser);
        await editAfterConflict(pageB);
        await chooseConflictVersion(pageB, GLADE, await conflictChoiceShowing(pageB, GLADE, 'from A'));
        expect(await applyConflictChoices(pageB)).toBe('confirm-cancelled');
        expect(await listPopupConflicts(pageB)).toEqual([{ path: GLADE, stale: true }]);
        expect(readUserFile(B, GLADE)).toContain('later B');
        expect(await applyConflictChoices(pageB, { confirmOverwrite: true })).toBe('success');
        expect(readUserFile(B, GLADE)).toContain('from A');
        expect(readUserFile(B, GLADE)).not.toContain('later B');
        expect((await historyOf(B, GLADE)).some(text => text.includes('later B'))).toBe(true);
    });

    test('a conflict the other device resolves while the page is open is no longer offered', async ({ browser }, testInfo) => {
        await start(testInfo);
        seedWorld(A, GLADE);
        seedWorld(A, FERN);
        const { pageA, pageB } = await conflictOnB(browser, ['Glade', 'Fern Hollow']);
        expect(await listPopupConflicts(pageB)).toEqual([{ path: FERN, stale: false }, { path: GLADE, stale: false }]);
        await reloadAndAwait(pageA, A.baseURL);
        await waitForSyncPopup(pageA);
        await chooseConflictVersion(pageA, GLADE, await conflictChoiceShowing(pageA, GLADE, 'from A'));
        expect(await applyConflictChoices(pageA)).toBe('success');
        // A's choice reaches B's sync history while B's Sync issues page is open.
        await expect.poll(() => pendingPaths(pageB), { timeout: 60_000 }).toEqual([FERN]);
        await waitForStatusChecks(pageB, await statusChecks(pageB) + 1);
        // The window drops a conflict resolved elsewhere, so it can no longer be chosen.
        await expect(conflictRow(pageB, GLADE)).toHaveCount(0);
        await expect(conflictRow(pageB, FERN)).toHaveCount(1);
        await chooseConflictVersion(pageB, FERN, await conflictChoiceShowing(pageB, FERN, 'from B'));
        expect(await applyConflictChoices(pageB)).toBe('success');
        expect(await pendingPaths(pageB)).toEqual([]);
        expect(holdsOnly(B, 'from A', 'from B')).toBe(true);
        expect(readUserFile(B, FERN)).toContain('from B');
        expect(readUserFile(B, FERN)).not.toContain('from A');
        await expect.poll(() => fileText(A, FERN), { timeout: 60_000 }).not.toContain('from A');
        expect(readUserFile(A, FERN)).toContain('from B');
    });

    test('a choice resolved elsewhere before Apply gets its own notice while the other choices apply', async ({ browser }, testInfo) => {
        await start(testInfo);
        seedWorld(A, GLADE);
        seedWorld(A, FERN);
        const { pageB } = await conflictOnB(browser, ['Glade', 'Fern Hollow']);
        await chooseConflictVersion(pageB, GLADE, await conflictChoiceShowing(pageB, GLADE, 'from B'));
        await chooseConflictVersion(pageB, FERN, await conflictChoiceShowing(pageB, FERN, 'from B'));
        // A second tab on B resolves Glade on the same server, so nothing
        // but that tab's own apply runs between the two applies.
        const otherTab = await contexts[1].newPage();
        await awaitMainUI(otherTab, B.baseURL);
        await waitForSyncPopup(otherTab);
        await chooseConflictVersion(otherTab, GLADE, await conflictChoiceShowing(otherTab, GLADE, 'from A'));
        // The first tab checks the status every 30 s; start right after a
        // check so the next one cannot mark the row before Apply.
        await waitForStatusChecks(pageB, await statusChecks(pageB) + 1);
        const checks = await statusChecks(pageB);
        expect(await applyConflictChoices(otherTab)).toBe('success');
        expect(await pendingPaths(pageB)).toEqual([FERN]);
        expect(await statusChecks(pageB)).toBe(checks);
        expect(await applyConflictChoices(pageB)).toBe('success');
        await expect(toastOf(pageB, ALREADY_HANDLED)).toBeVisible();
        // The other choice applied: nothing is left to choose.
        await expect(conflictRow(pageB, FERN)).toHaveCount(0);
        expect(await pendingPaths(pageB)).toEqual([]);
        expect(holdsOnly(B, 'from A', 'from B')).toBe(true);
        expect(readUserFile(B, FERN)).toContain('from B');
    });

    test('a choice whose file changes while it applies stays listed while the other choices apply', async ({ browser }, testInfo) => {
        await startPausable(testInfo, 'local-edit-before-reconcile');
        seedWorld(A, GLADE);
        seedWorld(A, FERN);
        const { pageB } = await conflictOnB(browser, ['Glade', 'Fern Hollow']);
        // The merge keeps ours in use, so theirs is the version a choice writes to live data.
        await chooseConflictVersion(pageB, GLADE, 'theirs');
        await chooseConflictVersion(pageB, FERN, 'theirs');
        const gladeEntry = await conflictEntry(pageB, GLADE);
        const gladeTheirs = await versionText(B, GLADE, gladeEntry.theirs);
        // Choices apply in path order, so the pause holds Fern Hollow's
        // choice; a program outside Luker rewrites the file meanwhile.
        arm('local-edit-before-reconcile');
        const applied = applyConflictChoices(pageB);
        await reached('local-edit-before-reconcile');
        const outside = JSON.stringify({ entries: { 0: { uid: 999, displayIndex: 0, comment: 'Outside', content: 'edited outside Luker', key: [] } } });
        fs.writeFileSync(path.join(userRootOf(B), 'worlds', 'Fern Hollow.json'), outside);
        release('local-edit-before-reconcile');
        expect(await applied).toBe('error');
        expect(await listPopupConflicts(pageB)).toEqual([{ path: FERN, stale: true }]);
        expect((await readConflictDiff(pageB, FERN, { index: 1 })).text).toContain('edited outside Luker');
        await expect(conflictRow(pageB, FERN).locator('.dw-version.on')).toHaveCount(0);
        const failed = syncPopup(pageB).locator('.dw-banner.error', { hasText: 'These choices could not be applied' });
        await expect(failed).toBeVisible();
        await expect(failed.locator('code')).toHaveText([FERN]);
        expect(readUserFile(B, FERN)).toBe(outside);
        expect(JSON.parse(readUserFile(B, GLADE))).toEqual(JSON.parse(gladeTheirs));
        expect(await pendingPaths(pageB)).toEqual([FERN]);
    });

    test('a conflict that arrives while a choice applies shows on the Sync issues page after it', async ({ browser }, testInfo) => {
        await startPausable(testInfo, 'local-edit-before-reconcile');
        seedWorld(A, GLADE);
        seedWorld(A, FERN);
        const { pageA, pageB } = await conflictOnB(browser, ['Glade']);
        expect(await listPopupConflicts(pageB)).toEqual([{ path: GLADE, stale: false }]);
        // B's Sync now also gave A the conflict; A's window is closed so A can edit.
        await expect.poll(() => pendingPaths(pageA), { timeout: 60_000 }).toEqual([GLADE]);
        await reloadAndAwait(pageA, A.baseURL);
        await closeSyncPopup(pageA);
        await selectWorldBook(pageA, 'Fern Hollow');
        await addWorldEntry(pageA, { key: 'fern', content: 'from A: the ferns uncurl at dawn.' });
        await expect.poll(() => fileText(A, FERN), { timeout: 30_000 }).toContain('from A');
        // B's window covers its World Info panel, so B's edit comes from outside Luker.
        fs.writeFileSync(path.join(userRootOf(B), ...FERN.split('/')), JSON.stringify({ entries: {}, note: 'from B: the ferns stay curled.' }));
        // B's page checks the status every 30 s; start right after a check
        // so the new conflict reaches B before the next one shows it.
        await waitForStatusChecks(pageB, await statusChecks(pageB) + 1);
        // Hold the popup's next status read. Direct reads below carry no CSRF
        // header, so the test can still observe the conflict the popup has
        // not seen yet.
        let releaseStatus;
        let capturedStatus;
        const statusBarrier = new Promise(resolve => { releaseStatus = resolve; });
        const statusCaptured = new Promise(resolve => { capturedStatus = resolve; });
        let heldStatus = false;
        await pageB.route('**/api/sync/v1/status', async route => {
            if (heldStatus || !route.request().headers()['x-csrf-token']) return route.continue();
            heldStatus = true;
            const response = await route.fetch();
            capturedStatus();
            await statusBarrier;
            await route.fulfill({ response });
        });
        await statusCaptured;
        const syncedSince = Date.now();
        await openLanSyncPanel(pageA);
        expect(await clickSyncNow(pageA, 'B device')).toBe('warning');
        await waitForBackgroundSync(pageB, { since: syncedSince });
        await expect.poll(() => pendingPaths(pageB), { timeout: 60_000 }).toEqual([FERN, GLADE]);
        expect(await listPopupConflicts(pageB)).toEqual([{ path: GLADE, stale: false }]);
        await chooseConflictVersion(pageB, GLADE, await conflictChoiceShowing(pageB, GLADE, 'from B'));
        arm('local-edit-before-reconcile');
        const applied = applyConflictChoices(pageB);
        await reached('local-edit-before-reconcile');
        // Complete the real pre-apply response during Apply. A new server
        // read now correctly waits for the local mutation's read barrier.
        const checksBeforeRelease = await statusChecks(pageB);
        releaseStatus();
        await waitForStatusChecks(pageB, checksBeforeRelease + 1);
        release('local-edit-before-reconcile');
        expect(await applied).toBe('success');
        await waitForSyncPopup(pageB);
        // The Sync issues page stays open after its last choice applies, so
        // the conflict the apply discovered arrives with the next status read.
        await expect.poll(() => listPopupConflicts(pageB), { timeout: 60_000 }).toEqual([{ path: FERN, stale: false }]);
        await pageB.unroute('**/api/sync/v1/status');
    });

    test('labels and paths from the other device render as text', async ({ browser }, testInfo) => {
        await start(testInfo);
        const rawLabel = '<img src=x onerror="window.__syncXss = 1">\u0007\tFen  Watch';
        const label = normalizeDeviceLabel(rawLabel);
        expect(label).toBe('<img src=x onerror="window.__syncXss = 1"> Fen Watch');
        const world = 'worlds/<img src=y onerror="window.__syncXss = 2">.json';
        const worldFile = server => path.join(userRootOf(server), ...world.split('/'));
        const worldDocument = content => JSON.stringify({ entries: { 0: { uid: 1, displayIndex: 0, comment: '', content, key: ['lore'] } } });
        fs.writeFileSync(worldFile(A), worldDocument('base'));
        const { pageA, pageB } = await pairedPages(browser, rawLabel);
        fs.writeFileSync(worldFile(A), worldDocument('edited on A'));
        fs.writeFileSync(worldFile(B), worldDocument('edited on B'));
        await openLanSyncPanel(pageB);
        expect(await clickSyncNow(pageB, 'A device')).toBe('warning');
        await waitForSyncPopup(pageB);
        await reloadAndAwait(pageA, A.baseURL);
        await waitForSyncPopup(pageA);
        for (const page of [pageA, pageB]) {
            expect(await listPopupConflicts(page)).toEqual([{ path: world, stale: false }]);
            await expect(syncPopup(page).locator('.dw-conflict-head b')).toHaveText(world);
            const bCard = await conflictChoiceShowing(page, world, 'edited on B');
            const aCard = await conflictChoiceShowing(page, world, 'edited on A');
            await expect(conflictRow(page, world).locator(`.dw-version[data-v="${bCard}"] .dw-version-head`)).toHaveText(new RegExp(`^Version from ${RegExp.escape(label)}`));
            await expect(conflictRow(page, world).locator(`.dw-version[data-v="${aCard}"] .dw-version-head`)).toHaveText(new RegExp(`^Version from ${RegExp.escape(HOST_LABEL)}`));
            await expect(syncPopup(page).locator('img')).toHaveCount(0);
            expect(await page.evaluate(() => window.__syncXss)).toBeUndefined();
        }
    });
});
