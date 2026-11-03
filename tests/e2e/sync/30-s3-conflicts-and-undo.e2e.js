import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import git from 'isomorphic-git';
import { readCommitFiles, readBlobBytes } from '../../../src/sync/pipeline/git-tree.js';
import { s3Fixture, createReadyWorldBook, selectReadyWorldBook, reloadS3Page, registryOf } from '../_lib/sync-s3.js';
import { pair, manual, entryOf, pathsOf, assertLocal } from '../_lib/s3-races.js';
import { addWorldEntry } from '../_lib/ui-worldinfo.js';
import { restoreChatCorpus, editCorpusChat, readChat, readChatData, COMPANIONS } from '../_lib/s3-chat.js';
import { inheritedEpoch } from '../_lib/s3-inherited.js';
import { openLanSyncPanel, closeAllPopups, clickSyncNow, readUserFile, waitForSyncPopup, syncPopup,
    listPopupConflicts, conflictChoiceShowing, chooseConflictVersion, applyConflictChoices,
    waitForStatusChecks, waitForBackendSync, clickUndoLastSync } from '../_lib/sync.js';

const fixture = s3Fixture(test);
test.use({ actionTimeout: 30_000 });
test.describe.configure({ timeout: 300_000 });
const REL = 'worlds/Shared Glade.json';

// eslint-disable-next-line playwright/expect-expect -- The shared epoch helper asserts exact parents, trees, records, notices and fork bytes.
for (const kind of ['device', 'historical', 'generic']) test(`identical ${kind} X and Y inherited over LAN produce exact S3 merge bytes after DOM relabeling`, async ({ browser }, testInfo) => {
    test.setTimeout(600_000);
    await inheritedEpoch(fixture, browser, testInfo, kind);
});

async function edit(device, name, text) {
    await closeAllPopups(device.page);
    await reloadS3Page(device.page);
    await waitForStatusChecks(device.page);
    await closeAllPopups(device.page);
    await selectReadyWorldBook(device.page, name);
    await addWorldEntry(device.page, { key: text, content: text });
    await expect.poll(() => readUserFile(device.server, `worlds/${name}.json`)).toContain(text);
}

async function conflict(browser) {
    const devices = await pair(fixture, browser);
    const { a, b } = devices;
    await createReadyWorldBook(a.page, 'Shared Glade');
    await manual(a); await manual(b);
    await edit(a, 'Shared Glade', 'Desk guards the moonwell');
    await edit(b, 'Shared Glade', 'Tablet guards the spring');
    await manual(a);
    await openLanSyncPanel(b.page);
    expect(await clickSyncNow(b.page, 'Cloud')).toBe('warning');
    await waitForSyncPopup(b.page);
    // Pending records must remain visible even after both heads are equal.
    await closeAllPopups(b.page);
    await openLanSyncPanel(a.page);
    expect(await clickSyncNow(a.page, 'Cloud')).toBe('warning');
    for (const device of [a, b]) {
        await reloadS3Page(device.page);
        await waitForSyncPopup(device.page);
        expect(await listPopupConflicts(device.page)).toEqual([{ path: REL, stale: false }]);
    }
    expect((await assertLocal(a)).oid).toBe((await assertLocal(b)).oid);
    return devices;
}

for (const resolution of ['current', 'theirs']) test(`stale S3 conflict ${resolution} preserves history and does not reopen after convergence`, async ({ browser }, testInfo) => {
    const { a, b } = await conflict(browser);
    await edit(b, 'Shared Glade', 'Later live moss edit');
    await openLanSyncPanel(b.page);
    expect(await clickSyncNow(b.page, 'Cloud')).toBe('warning');
    await reloadS3Page(b.page);
    await waitForSyncPopup(b.page);
    expect(await listPopupConflicts(b.page)).toEqual([{ path: REL, stale: true }]);
    const current = syncPopup(b.page).locator(`.dw-conflict[data-path=${JSON.stringify(REL)}] .dw-version[data-v="current"]`);
    await expect(current).toContainText('Later live moss edit');
    const selected = resolution === 'current' ? 'current' : await conflictChoiceShowing(b.page, REL, 'Desk guards the moonwell');
    await chooseConflictVersion(b.page, REL, selected);
    if (resolution === 'theirs') {
        expect(await applyConflictChoices(b.page)).toBe('confirm-cancelled');
        expect(readUserFile(b.server, REL)).toContain('Later live moss edit');
    }
    const resolvedSince = Date.now();
    const response = b.page.waitForResponse(r => r.url().endsWith('/conflicts/resolve'));
    expect(await applyConflictChoices(b.page, { confirmOverwrite: true })).toBe('success');
    expect(await (await response).json()).toMatchObject({ ok: true, results: [{ applied: true, committedBackends: [entryOf(b)[0]] }] });
    const expected = readUserFile(b.server, REL);
    expect(expected.includes('Later live moss edit')).toBe(resolution === 'current');
    fs.writeFileSync(testInfo.outputPath('after-resolve.json'), JSON.stringify({ resolvedSince, lastSync: registryOf(b.server).backends[entryOf(b)[0]].lastSync,
        staging: fs.readdirSync(pathsOf(b).peerDir).filter(name => name.startsWith('.luker-staging-s3-')),
        status: await b.page.evaluate(async () => (await fetch('/api/sync/v1/backends')).json()) }, null, 2));
    // The response commits locally and schedules propagation. Inspect its
    // objects only after that new background cycle has actually completed.
    await waitForBackendSync(b.page, { label: 'Cloud', since: resolvedSince });
    const local = await assertLocal(b);
    const propagated = await b.page.evaluate(async () => (await fetch('/api/sync/v1/backends')).json());
    expect(propagated.running[entryOf(b)[0]]).toBe(false);
    expect(propagated.backends[entryOf(b)[0]].lastSync.at).toBeGreaterThan(resolvedSince);
    expect(propagated.backends[entryOf(b)[0]].lastSync.error).toBeNull();
    fs.writeFileSync(testInfo.outputPath('after-propagation.json'), JSON.stringify({ resolvedSince, head: local.oid, status: propagated,
        staging: fs.readdirSync(pathsOf(b).peerDir).filter(name => name.startsWith('.luker-staging-s3-')) }, null, 2));
    const history = await git.log({ fs, gitdir: pathsOf(b).gitDir, ref: local.oid });
    const texts = await Promise.all(history.map(async ({ oid }) => {
        const file = (await readCommitFiles({ gitdir: pathsOf(b).gitDir, commitOid: oid })).get(REL);
        return file ? (await readBlobBytes({ gitdir: pathsOf(b).gitDir, oid: file.oid })).toString() : null;
    }));
    expect(texts.some(text => text?.includes('Later live moss edit'))).toBe(true);
    await manual(b); await manual(a);
    for (const device of [a, b]) {
        expect(readUserFile(device.server, REL)).toBe(expected);
        await reloadS3Page(device.page);
        await waitForStatusChecks(device.page);
        await expect(syncPopup(device.page)).toHaveCount(0);
    }
});

test('S3 undo creates a forward commit, propagates the revert and retains a later DOM edit', async ({ browser }) => {
    const { a, b } = await pair(fixture, browser);
    for (const name of ['Undo Grove', 'Edited Grove']) await createReadyWorldBook(a.page, name);
    await manual(a); await manual(b);
    for (const name of ['Undo Grove', 'Edited Grove']) await edit(a, name, 'Incoming cloud change');
    await manual(a); await manual(b);
    const incoming = (await assertLocal(b)).oid;
    await edit(b, 'Edited Grove', 'Later retained tablet edit');
    await openLanSyncPanel(b.page);
    const response = b.page.waitForResponse(r => r.url().endsWith('/undo'));
    expect(await clickUndoLastSync(b.page, 'Cloud')).toBe('warning');
    const result = await (await response).json();
    expect(result).toMatchObject({ ok: true, committed: true, propagation: { ok: true } });
    expect(result.reverted).toContain('worlds/Undo Grove.json');
    expect(result.keptEdited).toContain('worlds/Edited Grove.json');
    const log = await git.log({ fs, gitdir: pathsOf(b).gitDir, ref: (await assertLocal(b)).oid });
    expect(log.some(({ oid }) => oid === incoming)).toBe(true);
    expect(log.some(({ commit }) => commit.message.startsWith('undo sync sync-backup-'))).toBe(true);
    await manual(a);
    for (const device of [a, b]) {
        expect(readUserFile(device.server, 'worlds/Undo Grove.json')).not.toContain('Incoming cloud change');
        expect(readUserFile(device.server, 'worlds/Edited Grove.json')).toContain('Later retained tablet edit');
        await device.server.restart();
        await reloadS3Page(device.page);
        await manual(device);
        expect(readUserFile(device.server, 'worlds/Edited Grove.json')).toContain('Later retained tablet edit');
    }
});

test('group DOM editing guards the loaded record rather than rendering defaults', async ({ browser }, testInfo) => {
    const device = await fixture.device(browser, 'group-dom-patch');
    // This endpoint regression owns only the message patch and a neutral
    // companion. The SQL matrix independently retains its strict MG checks.
    await restoreChatCorpus(device, testInfo, { companions: { iter_studio: COMPANIONS.iter_studio } });
    const rel = 'group chats/gc1.jsonl';
    const before = await readChat(device.page, rel);
    await editCorpusChat(device, rel, 'A group edit after loading');
    await editCorpusChat(device, rel, 'Another group edit after reloading');
    const after = await readChat(device.page, rel);
    expect(after.slice(1, 3)).toEqual(before.slice(1, 3));
    expect(after[3].mes).toBe('Another group edit after reloading');
    expect(await readChatData(device.page, '/api/chats/state/get', { is_group: true, id: 'gc1', namespace: 'iter_studio' })).toEqual({ ok: true, data: COMPANIONS.iter_studio });
});
