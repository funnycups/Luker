import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';
import { s3Fixture, registryOf, backendRow, reloadS3Page, createReadyWorldBook, selectReadyWorldBook } from '../_lib/sync-s3.js';
import { addWorldEntry } from '../_lib/ui-worldinfo.js';
import { manual } from '../_lib/s3-races.js';
import { addS3Backend, waitForBackendSync, openLanSyncPanel, closeAllPopups, generatePairingLink, acceptPairingLink,
    waitForBackgroundSync, clickSyncNow, readUserFile, userRootOf, waitForSyncPopup, syncPopup,
    chooseConflictVersion, applyConflictChoices, waitForStatusChecks, editSyncBackend, clickForgetPeer, conflictRow } from '../_lib/sync.js';
import { windowToast } from '../_lib/account-window.js';

const fixture = s3Fixture(test);
test.describe.configure({ timeout: 360_000 });
const REL = 'worlds/Bridge Grove.json';
const status = page => page.evaluate(async () => (await (await fetch('/api/sync/v1/status')).json()));
const checks = page => page.evaluate(() => Number(document.body.dataset.syncStatusChecks || 0));
const row = page => conflictRow(page, REL);

async function lan(a, b) {
    await closeAllPopups(a.page); await openLanSyncPanel(a.page);
    const since = Date.now();
    const link = await generatePairingLink(a.page, { label: 'LAN B', categories: ['worlds'] });
    await closeAllPopups(b.page); await openLanSyncPanel(b.page);
    expect(await acceptPairingLink(b.page, link, { localLabel: 'LAN A', categories: ['worlds'] })).toBe('success');
    await waitForBackgroundSync(a.page, { since }); await waitForBackgroundSync(b.page, { since });
}

async function edit(device, text) {
    await reloadS3Page(device.page);
    await waitForStatusChecks(device.page);
    await closeAllPopups(device.page);
    await selectReadyWorldBook(device.page, 'Bridge Grove');
    await addWorldEntry(device.page, { key: text, content: text });
    await expect.poll(() => readUserFile(device.server, REL)).toContain(text);
}

async function grouped(browser) {
    const a = await fixture.device(browser, 'bridge-a'), b = await fixture.device(browser, 'bridge-b'), c = await fixture.device(browser, 'bridge-c');
    const options = await fixture.options();
    await lan(a, b);
    await addS3Backend(a.page, options); await waitForBackendSync(a.page, { label: 'Cloud' });
    await addS3Backend(c.page, options); await waitForBackendSync(c.page, { label: 'Cloud' });
    await closeAllPopups(b.page);
    await createReadyWorldBook(b.page, 'Bridge Grove');
    await addWorldEntry(b.page, { key: 'bridge', content: 'B originated this LAN to S3 book' });
    await openLanSyncPanel(b.page); expect(await clickSyncNow(b.page, 'LAN A')).toBe('success');
    await waitForBackgroundSync(a.page);
    await manual(a); await manual(c);
    for (const device of [a, b, c]) expect(readUserFile(device.server, REL)).toContain('B originated this LAN to S3 book');
    await edit(a, 'A retained live choice'); await edit(b, 'B divergent LAN choice'); await edit(c, 'C divergent S3 choice');
    await openLanSyncPanel(b.page); expect(await clickSyncNow(b.page, 'LAN A')).toBe('warning');
    await waitForBackgroundSync(a.page);
    await manual(c);
    await closeAllPopups(a.page); await openLanSyncPanel(a.page);
    expect(await clickSyncNow(a.page, 'Cloud')).toBe('warning');
    await waitForSyncPopup(a.page);
    const entries = Object.entries(registryOf(a.server).backends);
    const lanId = entries.find(([, entry]) => entry.kind === 'lan')[0], cloudId = entries.find(([, entry]) => entry.kind === 's3')[0];
    const pending = await status(a.page);
    expect(pending.ok).toBe(true);
    expect(pending.conflicts).toHaveLength(1);
    expect(pending.conflicts[0]).toMatchObject({ path: REL, backends: expect.arrayContaining([lanId, cloudId]) });
    expect(Object.keys(pending.conflicts[0].recordVersions).sort()).toEqual([lanId, cloudId].sort());
    await expect(row(a.page)).toHaveCount(1);
    return { a, b, c, lanId, cloudId, pending };
}

test('one readable grouped DOM choice commits matching records on LAN and S3 and reaches both peers', async ({ browser }) => {
    const { a, b, c, lanId, cloudId } = await grouped(browser);
    await chooseConflictVersion(a.page, REL, 'current');
    const response = a.page.waitForResponse(r => r.url().endsWith('/conflicts/resolve'));
    expect(await applyConflictChoices(a.page)).toBe('success');
    const result = await (await response).json();
    expect(result).toMatchObject({ ok: true, results: [{ path: REL, applied: true, committedBackends: expect.arrayContaining([lanId, cloudId]) }] });
    expect(result.errors ?? {}).toEqual({});
    expect(result.results[0].committedBackends).toHaveLength(2);
    const expected = readUserFile(a.server, REL);
    await manual(c);
    await expect.poll(() => readUserFile(b.server, REL), { timeout: 60_000 }).toBe(expected);
    expect(readUserFile(c.server, REL)).toBe(expected);
    expect((await status(a.page)).conflicts).toEqual([]);
    await closeAllPopups(a.page); await openLanSyncPanel(a.page);
    const cloudBefore = structuredClone(registryOf(a.server).backends[cloudId]);
    await editSyncBackend(a.page, 'LAN B', { label: 'LAN B renamed' });
    expect(registryOf(a.server).backends[cloudId]).toEqual(cloudBefore);
    await clickForgetPeer(a.page, 'LAN B renamed');
    await expect(backendRow(a.page, 'Cloud')).toHaveCount(1);
    expect(registryOf(a.server).backends[cloudId]).toEqual(cloudBefore);
    await manual(a); await manual(c);
    expect(readUserFile(c.server, REL)).toBe(expected);
});

test('an unreadable grouped backend preserves readable commitment and repairs without resurrecting its superseded choice', async ({ browser }, testInfo) => {
    const { a, b, c, lanId, cloudId, pending: shown } = await grouped(browser);
    await chooseConflictVersion(a.page, REL, 'current');
    const gitdir = path.join(userRootOf(a.server), '.sync', cloudId, 'repo.git');
    const head = await git.resolveRef({ fs, gitdir, ref: 'refs/heads/main' });
    const { oid } = await git.readBlob({ fs, gitdir, oid: head, filepath: '.luker-sync/conflicts.json' });
    const file = path.join(gitdir, 'objects', oid.slice(0, 2), oid.slice(2));
    const bytes = fs.readFileSync(file);
    // Narrow object-corruption fault. No registry, settings or record fixture writes.
    fs.writeFileSync(file, 'unreadable conflict object');
    try {
        const response = a.page.waitForResponse(r => r.url().endsWith('/conflicts/resolve'));
        expect(await applyConflictChoices(a.page)).toBe('error');
        const resolved = await response;
        const result = await resolved.json();
        const submitted = resolved.request().postDataJSON();
        const [entry] = shown.conflicts;
        expect(submitted).toEqual([{ path: REL, choice: 'current', review: {
            backendId: entry.backendId, selectedOid: entry.current, recordVersions: entry.recordVersions, currentVersions: entry.currentVersions,
        } }]);
        await testInfo.attach('reviewed-grouped-outcome', { body: JSON.stringify({ submitted, result, shown, live: readUserFile(a.server, REL) }), contentType: 'application/json' });
        expect(result).toMatchObject({ ok: false, errors: { [cloudId]: { code: 'PENDING_READ_FAILED' } }, results: [{ path: REL, applied: false, committedBackends: [lanId] }] });
        await expect(windowToast(a.page, 'Applied')).toHaveCount(0);
        await expect(windowToast(a.page, 'already handled on another device')).toHaveCount(0);
        const pending = await status(a.page);
        expect(pending.errors[cloudId].code).toBe('PENDING_READ_FAILED');
        expect(pending.conflicts).toEqual([]);
    } finally { fs.writeFileSync(file, bytes); }
    await waitForStatusChecks(a.page, await checks(a.page) + 1);
    await expect(row(a.page).locator('.dw-version[data-v="current"]')).toBeEnabled();
    const repaired = await status(a.page);
    expect(repaired.ok).toBe(true);
    expect(repaired.conflicts[0].backends).toEqual([cloudId]);
    expect(repaired.conflicts[0].recordVersions[lanId]).toBeUndefined();
    await chooseConflictVersion(a.page, REL, 'current');
    const response = a.page.waitForResponse(r => r.url().endsWith('/conflicts/resolve'));
    expect(await applyConflictChoices(a.page)).toBe('success');
    expect(await (await response).json()).toMatchObject({ ok: true, results: [{ applied: true, committedBackends: [cloudId] }] });
    const expected = readUserFile(a.server, REL);
    await manual(c);
    await expect.poll(() => readUserFile(b.server, REL), { timeout: 60_000 }).toBe(expected);
    expect(readUserFile(c.server, REL)).toBe(expected);
    for (const device of [a, b, c]) {
        await reloadS3Page(device.page); await waitForStatusChecks(device.page);
        await expect(syncPopup(device.page)).toHaveCount(0);
    }
});
