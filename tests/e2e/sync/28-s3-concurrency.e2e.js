/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- Parameterized genuine provider outcomes require distinct assertions. */
import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { s3Fixture, createReadyWorldBook, selectReadyWorldBook, reloadS3Page, awaitS3Page, backendRow, registryOf } from '../_lib/sync-s3.js';
import { pair, manual, startManual, remoteHead, assertLocal, entryOf, publishedHead, pathsOf } from '../_lib/s3-races.js';
import { addWorldEntry } from '../_lib/ui-worldinfo.js';
import { readUserFile, openLanSyncPanel, closeAllPopups, addS3Backend, waitForBackendSync, fillS3Form, shadowMain, waitForSyncPopup, conflictChoiceShowing, chooseConflictVersion, applyConflictChoices, clickBackendMenu } from '../_lib/sync.js';
import { accountWindow, answerWindowConfirm } from '../_lib/account-window.js';
import { blobOidOf, readCommitFiles } from '../../../src/sync/pipeline/git-tree.js';

test.afterEach(async ({}, info) => {
    for (const error of info.errors) console.error(error.message);
});

const fixture = s3Fixture(test);
// Several genuine server initializations and cryptographic transfers, not a
// product timeout. Gates synchronize requests without elapsed-time sleeps.
test.describe.configure({ timeout: 300_000 });

test('pinned head reads cause a genuine 412 and retain every published pack through convergence', async ({ browser }) => {
    const { a, b, proxyA, proxyB, options } = await pair(fixture, browser);
    await createReadyWorldBook(a.page, 'North Gate');
    await createReadyWorldBook(b.page, 'South Gate');
    const initial = await remoteHead(fixture, options, a);
    const proxies = [proxyA, proxyB];
    const from = proxies.map(proxy => proxy.requests.length);
    const firstCas = () => proxies.map((proxy, i) => proxy.requests.slice(from[i]).find(record => record.method === 'PUT' && record.relativeKey === 'shared/head'));
    const gates = proxies.map(proxy => proxy.addFault({ match: { method: 'GET', keySuffix: '/head' }, hold: 'after-upstream-response' }));
    try {
        await Promise.all([startManual(a), startManual(b)]);
        const records = await Promise.all(gates.map(gate => gate.reached));
        expect(records.map(record => record.upstreamStatus)).toEqual([200, 200]);
        expect(records.map(record => record.upstreamHeaders.etag)).toEqual([initial.etag, initial.etag]);
        gates.forEach(gate => gate.release());
        await expect.poll(() => firstCas().map(record => record?.upstreamStatus).sort((a, b) => a - b), { timeout: 60_000 }).toEqual([200, 412]);
        expect(firstCas().map(record => record.headers['if-match'])).toEqual([initial.etag, initial.etag]);
        await manual(a); await manual(b); await manual(a);
        const final = await remoteHead(fixture, options, a);
        const published = [...initial.head.packs.map(pack => pack.name)];
        // Failed CAS attempts leave immutable orphans; only successfully
        // published pack references must remain inherited by subsequent heads.
        for (const proxy of [proxyA, proxyB]) {
            for (const request of proxy.requests.filter(record => record.method === 'PUT' && record.relativeKey === 'shared/head' && record.upstreamStatus === 200)) {
                const published = publishedHead(a, request.body);
                expect(final.head.packs).toEqual(expect.arrayContaining(published.packs));
            }
        }
        expect(final.head.packs.map(pack => pack.name)).toEqual(expect.arrayContaining(published));
        for (const device of [a, b]) {
            expect(readUserFile(device.server, 'worlds/North Gate.json')).not.toBeNull();
            expect(readUserFile(device.server, 'worlds/South Gate.json')).not.toBeNull();
            expect((await assertLocal(device)).oid).toBe(final.head.commit);
        }
    } finally { gates.forEach(gate => gate.release()); }
});

for (const laterWriter of [false, true]) {
    test(`lost successful head response ${laterWriter ? 'detects a later writer conflict' : 'recovers the exact published payload'}`, async ({ browser }) => {
        const { a, b, proxyA, options } = await pair(fixture, browser);
        await createReadyWorldBook(a.page, 'Lost Response');
        const lost = proxyA.addFault({ match: { method: 'PUT', keySuffix: '/head' }, hold: 'after-upstream-response', dropResponseAfterUpstreamSuccess: true });
        const recovery = proxyA.addFault({ match: { method: 'GET', keySuffix: '/head', attempt: 2 }, hold: 'before-forward' });
        const schedule = registryOf(a.server).schedule;
        expect(schedule).toEqual({ idleSeconds: 3600, pollSeconds: 3600 });
        const started = Date.now(), since = entryOf(a)[1].lastSync.at;
        const syncPath = `/api/sync/v1/backends/${entryOf(a)[0]}/sync`;
        const manualRequests = [];
        const observeTrigger = request => {
            if (request.method() === 'POST' && new URL(request.url()).pathname === syncPath) manualRequests.push(request);
        };
        a.page.on('request', observeTrigger);
        const completed = a.page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === syncPath, { timeout: 120_000 });
        completed.catch(() => {});
        let laterPayload;
        let laterEtag;
        let laterFile;
        try {
            await startManual(a);
            expect((await lost.reached).upstreamStatus).toBe(200);
            const published = await remoteHead(fixture, options, a);
            if (laterWriter) {
                await createReadyWorldBook(b.page, 'Later Writer');
                laterFile = readUserFile(b.server, 'worlds/Later Writer.json');
                expect(laterFile).not.toBeNull();
                await manual(b);
                const later = await remoteHead(fixture, options, b);
                laterPayload = later.payload;
                laterEtag = later.etag;
                expect(later.payload.equals(published.payload)).toBe(false);
                expect(later.head.packs).toEqual(expect.arrayContaining(published.head.packs));
            }
            lost.release();
            const recoveryRead = await recovery.reached;
            const beforeRecovery = proxyA.requests.filter(record => record.method === 'PUT' && record.relativeKey === 'shared/head').length;
            recovery.release();
            expect((await completed).ok()).toBe(true);
            await waitForBackendSync(a.page, { label: 'Cloud', since });
            const recovered = await remoteHead(fixture, options, a);
            const followingReads = proxyA.requests.filter(record => record.id > recoveryRead.id && record.method === 'GET' && record.relativeKey === 'shared/head');
            expect(manualRequests).toHaveLength(1);
            // No idle/poll deadline can arrive inside this observation window.
            expect(Date.now() - started).toBeLessThan(Math.min(schedule.idleSeconds, schedule.pollSeconds) * 1000);
            if (!laterWriter) {
                expect(recovered.payload).toEqual(published.payload);
                expect(followingReads).toHaveLength(0);
                expect(proxyA.requests.filter(record => record.method === 'PUT' && record.relativeKey === 'shared/head')).toHaveLength(beforeRecovery);
            } else {
                // Only the original manual request has run on A. Payload
                // inequality must cause a fresh cycle before it acknowledges.
                expect(followingReads).toHaveLength(1);
                expect(followingReads[0]).toMatchObject({ upstreamStatus: 200, upstreamHeaders: expect.objectContaining({ etag: laterEtag }), responseDelivered: true });
                expect(readUserFile(a.server, 'worlds/Later Writer.json')).toBe(laterFile);
                expect(laterPayload.equals(published.payload)).toBe(false);
                expect(recoveryRead.upstreamHeaders.etag).toBe(laterEtag);
                expect(recovered.payload).toEqual(laterPayload);
                expect(recovered.head.packs).toEqual(expect.arrayContaining(published.head.packs));
                expect((await assertLocal(a)).oid).toBe(recovered.head.commit);
            }
            await manual(b); await manual(a);
            const final = await remoteHead(fixture, options, a);
            expect(final.head.packs).toEqual(expect.arrayContaining(published.head.packs));
            await assertLocal(a); await assertLocal(b);
        } finally { lost.release(); recovery.release(); a.page.off('request', observeTrigger); }
    });
}

test('download paused after snapshot preserves a newer DOM edit and the follow-up publishes it', async ({ browser }) => {
    const { a, b, proxyB, options } = await pair(fixture, browser);
    const rel = 'worlds/Remote Moonwell.json';
    await createReadyWorldBook(a.page, 'Remote Moonwell');
    await manual(a); await manual(b);
    const base = readUserFile(b.server, rel);
    expect(base).not.toBeNull();
    await reloadS3Page(a.page);
    await selectReadyWorldBook(a.page, 'Remote Moonwell');
    await addWorldEntry(a.page, { key: 'moonwell', content: 'The remote keeper changes the moonwell.' });
    // Incompressible lore keeps the genuine pack larger than its first HTTP
    // chunk; otherwise forwarding that chunk can finish the whole download.
    const archive = randomBytes(128 * 1024).toString('base64');
    await addWorldEntry(a.page, { key: 'archive', content: archive });
    await expect.poll(() => Object.values(JSON.parse(readUserFile(a.server, rel)).entries).some(entry => entry.content === archive), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => readUserFile(a.server, rel), { timeout: 30_000 }).toContain('remote keeper');
    const incoming = readUserFile(a.server, rel);
    expect(incoming).not.toBe(base);
    await manual(a);
    const published = await remoteHead(fixture, options, a);
    const incomingFiles = await readCommitFiles({ gitdir: pathsOf(a).gitDir, commitOid: published.head.commit });
    expect(incomingFiles.get(rel)?.oid).toBe(blobOidOf(Buffer.from(incoming)));
    const gate = proxyB.addFault({ match: { method: 'GET', keyPrefix: 'shared/packs/' }, hold: 'after-first-body-chunk' });
    const rerun = proxyB.addFault({ match: { method: 'GET', keySuffix: '/head', attempt: 2 }, hold: 'before-forward' });
    const editor = await b.context.newPage();
    // Await this navigation's startup; reloading here aborts its bootstrap.
    await editor.goto(b.server.baseURL); await awaitS3Page(editor);
    const completed = b.page.waitForResponse(response => response.request().method() === 'POST'
        && new URL(response.url()).pathname === `/api/sync/v1/backends/${entryOf(b)[0]}/sync`, { timeout: 120_000 });
    completed.catch(() => {});
    try {
        await startManual(b);
        const download = await gate.reached;
        expect(download.upstreamStatus).toBe(200);
        expect(download.bytesObserved).toBeGreaterThan(0);
        expect(download.bytesObserved, 'the download gate must leave original response bytes pending').toBeLessThan(Number(download.upstreamHeaders['content-length']));
        // fetchInto follows cycle snapshot; this is the genuine pack response
        // body. This very path differs between the snapshot and incoming tree.
        const snapshot = await readCommitFiles({ gitdir: pathsOf(b).gitDir, commitOid: await shadowMain(b.server, entryOf(b)[0]) });
        expect(snapshot.get(rel)?.oid).toBe(blobOidOf(Buffer.from(base)));
        expect(snapshot.get(rel)?.oid).not.toBe(incomingFiles.get(rel)?.oid);
        await selectReadyWorldBook(editor, 'Remote Moonwell');
        const saved = editor.waitForResponse(response => ['/api/worldinfo/edit', '/api/worldinfo/patch'].includes(new URL(response.url()).pathname)
            && (response.request().postData() ?? '').includes('newer lantern'));
        saved.catch(() => {});
        await addWorldEntry(editor, { key: 'lantern', content: 'A newer lantern edit survives the old snapshot.' });
        expect((await saved).ok()).toBe(true);
        await expect.poll(() => readUserFile(b.server, rel), { timeout: 30_000 }).toContain('newer lantern');
        const newer = readUserFile(b.server, rel);
        expect(newer).not.toBe(incoming);
        gate.release();
        const boundary = await Promise.race([rerun.reached.then(() => 'rerun'), completed.then(() => 'completed')]);
        // The incoming reconcile has now attempted this changed path. Before
        // the fresh cycle can merge anything, live CAS must have preserved it.
        expect(readUserFile(b.server, rel)).toBe(newer);
        expect(boundary, 'the skipped incoming write must request a fresh cycle').toBe('rerun');
        const freshSnapshot = await readCommitFiles({ gitdir: pathsOf(b).gitDir, commitOid: await shadowMain(b.server, entryOf(b)[0]) });
        expect(freshSnapshot.get(rel)?.oid).toBe(blobOidOf(Buffer.from(newer)));
        rerun.release();
        const response = await completed;
        expect(response.ok()).toBe(true);
        expect((await response.json()).pendingConflicts).toBe(1);
        await waitForBackendSync(b.page, { label: 'Cloud' });
        const followUp = await remoteHead(fixture, options, b);
        expect((await assertLocal(b)).oid).toBe(followUp.head.commit);
        const pending = await b.page.evaluate(async () => (await fetch('/api/sync/v1/status')).json());
        expect(pending.conflicts).toHaveLength(1);
        expect(pending.conflicts[0].path).toBe(rel);
        expect([pending.conflicts[0].ours, pending.conflicts[0].theirs]).toEqual(expect.arrayContaining([
            blobOidOf(Buffer.from(incoming)), blobOidOf(Buffer.from(newer)),
        ]));
        // Canonical merge roles can provisionally keep either version. The
        // follow-up published both; select the newer version through the UI.
        await waitForSyncPopup(b.page);
        await chooseConflictVersion(b.page, rel, await conflictChoiceShowing(b.page, rel, 'newer lantern'));
        expect(await applyConflictChoices(b.page)).toBe('success');
        await manual(b); await manual(a);
        const final = await remoteHead(fixture, options, b);
        for (const device of [a, b]) {
            expect(readUserFile(device.server, rel)).toBe(newer);
            expect((await assertLocal(device)).oid).toBe(final.head.commit);
        }
    } finally { gate.release(); rerun.release(); await editor.close(); }
});

for (const action of ['edit', 'remove']) {
    test(`pending DOM ${action} drains admitted network while another backend continues`, async ({ browser }) => {
        const { a, proxyA } = await pair(fixture, browser);
        const other = await fixture.options();
        await closeAllPopups(a.page);
        await openLanSyncPanel(a.page);
        await addS3Backend(a.page, { ...other, label: 'Other' });
        await waitForBackendSync(a.page, { label: 'Other' });
        const otherBefore = Object.values(registryOf(a.server).backends).find(entry => entry.label === 'Other').lastSync.at;
        const id = entryOf(a)[0];
        // Backend cards are deliberately locked in the tab that started
        // Sync. A separate real tab can request maintenance.
        const control = await a.context.newPage();
        await control.goto(a.server.baseURL); await awaitS3Page(control);
        await openLanSyncPanel(control);
        // APP_READY reads pending status through the same admission boundary.
        // Finish startup before holding maintenance, without bypassing it.
        const tab = await a.context.newPage();
        await tab.goto(a.server.baseURL); await awaitS3Page(tab);
        await openLanSyncPanel(tab);
        const gate = proxyA.addFault({ match: { method: 'GET', keySuffix: '/head' }, hold: 'before-forward' });
        try {
            await startManual(a); await gate.reached;
            let acknowledged = false;
            const sent = control.waitForRequest(r => new URL(r.url()).pathname === `/api/sync/v1/backends/${id}${action === 'edit' ? '/s3' : ''}` && r.method() === (action === 'edit' ? 'POST' : 'DELETE'));
            const response = control.waitForResponse(r => new URL(r.url()).pathname === `/api/sync/v1/backends/${id}${action === 'edit' ? '/s3' : ''}` && r.request().method() === (action === 'edit' ? 'POST' : 'DELETE')).then(r => { acknowledged = true; return r; });
            response.catch(() => {});
            if (action === 'edit') {
                await clickBackendMenu(control, 'Cloud', 'edit');
                await fillS3Form(control, { label: 'Renamed Cloud' });
                await accountWindow(control).locator('[data-act="s3-save"]').click();
            } else {
                await clickBackendMenu(control, 'Cloud', 'remove');
                await answerWindowConfirm(control);
            }
            await sent;
            // Another browser tab performs an independent DOM sync while the
            // first dialog awaits its real maintenance acknowledgement.
            await backendRow(tab, 'Other').locator('[data-act="sync-now"]').click();
            await waitForBackendSync(tab, { label: 'Other', since: otherBefore });
            expect(acknowledged).toBe(false);
            expect(registryOf(a.server).backends[id].label).toBe('Cloud');
            gate.release();
            expect((await response).ok()).toBe(true);
            if (action === 'edit') expect(registryOf(a.server).backends[id].label).toBe('Renamed Cloud');
            else expect(registryOf(a.server).backends[id]).toBeUndefined();
        } finally { gate.release(); await Promise.all([control.close(), tab.close()]); }
    });
}
