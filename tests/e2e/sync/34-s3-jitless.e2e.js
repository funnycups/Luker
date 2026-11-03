import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { s3Fixture, registryOf, createReadyWorldBook, selectReadyWorldBook, reloadS3Page, awaitS3Page, backendRow, backendError } from '../_lib/sync-s3.js';
import { accountWindow, formError } from '../_lib/account-window.js';
import { addS3Backend, fillS3Form, editSyncBackend, waitForBackendSync, closeAllPopups, openLanSyncPanel, clickSyncNow, setSyncSchedule, userRootOf, shadowMain, openAddBackend } from '../_lib/sync.js';
import { addWorldEntry } from '../_lib/ui-worldinfo.js';
import { hasCompleteClosure } from '../../../src/sync/objects.js';
import { getShadowPaths } from '../../../src/sync/shadow.js';
import { createResponseReadOwner } from '../_lib/response-reads.js';

const fixture = s3Fixture(test);
test.describe.configure({ timeout: 360_000 });
const file = 'worlds/Jitless Moonwell.json';
const bytesOf = device => fs.readFileSync(path.join(userRootOf(device.server), file));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function journey(a, b, options, manualRequests, checkpointOutput, testInfo) {
    await closeAllPopups(a.page);
    await createReadyWorldBook(a.page, 'Jitless Moonwell');
    await addWorldEntry(a.page, { key: 'guardian', content: 'The moonwell remembers the complete jitless journey.' });
    await expect.poll(() => Object.values(JSON.parse(bytesOf(a).toString()).entries).find(entry => entry.key.includes('guardian'))?.content).toBe('The moonwell remembers the complete jitless journey.');
    const original = bytesOf(a);
    await openLanSyncPanel(a.page);
    await addS3Backend(a.page, options);
    await waitForBackendSync(a.page, { label: 'Cloud' });
    await openAddBackend(b.page, 's3');
    await fillS3Form(b.page, { ...options, passphrase: 'incorrect jitless phrase' });
    const rejected = b.page.waitForResponse(response => new URL(response.url()).pathname === '/api/sync/v1/backends/s3');
    await accountWindow(b.page).locator('[data-act="s3-save"]').click();
    const wrong = await rejected;
    expect(wrong.status()).toBe(422);
    expect(await wrong.json()).toMatchObject({ code: 'S3_WRONG_PASSPHRASE' });
    await expect(formError(b.page)).toBeVisible();
    expect(Object.keys(registryOf(b.server).backends)).toEqual([]);
    await openLanSyncPanel(b.page);
    await addS3Backend(b.page, options);
    await waitForBackendSync(b.page, { label: 'Cloud' });
    expect(bytesOf(b)).toEqual(original);
    const originalSettings = Object.values(registryOf(b.server).backends)[0].s3;
    const relay = await fixture.proxy();
    const editedAt = Date.now();
    await editSyncBackend(b.page, 'Cloud', { endpoint: relay.endpoint });
    await waitForBackendSync(b.page, { label: 'Cloud', since: editedAt });
    expect(isDeepStrictEqual(Object.values(registryOf(b.server).backends)[0].s3, { ...originalSettings, endpoint: relay.endpoint })).toBe(true);
    await closeAllPopups(b.page);
    await reloadS3Page(b.page);
    await selectReadyWorldBook(b.page, 'Jitless Moonwell');
    await addWorldEntry(b.page, { key: 'return', content: 'The returning guardian preserves the original promise.' });
    await expect.poll(() => Object.values(JSON.parse(bytesOf(b).toString()).entries).find(entry => entry.key.includes('return'))?.content).toBe('The returning guardian preserves the original promise.');
    const edited = bytesOf(b);
    expect(JSON.parse(edited.toString())).toMatchObject(JSON.parse(original.toString()));
    await openLanSyncPanel(b.page);
    expect(await clickSyncNow(b.page, 'Cloud')).toBe('success');
    await closeAllPopups(b.page);
    await closeAllPopups(a.page);
    await openLanSyncPanel(a.page);
    expect(await clickSyncNow(a.page, 'Cloud')).toBe('success');
    expect(bytesOf(a)).toEqual(edited);
    const sourceId = Object.keys(registryOf(a.server).backends)[0];
    const beforeRestartHead = await shadowMain(a.server, sourceId);
    await closeAllPopups(a.page);
    await reloadS3Page(a.page);
    await selectReadyWorldBook(a.page, 'Jitless Moonwell');
    await addWorldEntry(a.page, { key: 'restart', content: 'A fresh process publishes this unsynchronized edit automatically.' });
    await expect.poll(() => Object.values(JSON.parse(bytesOf(a).toString()).entries).find(entry => entry.key.includes('restart'))?.content).toBe('A fresh process publishes this unsynchronized edit automatically.');
    const restarted = bytesOf(a);
    expect(JSON.parse(restarted.toString())).toMatchObject(JSON.parse(edited.toString()));
    await openLanSyncPanel(b.page);
    await setSyncSchedule(b.page, { idleSeconds: 3600, pollSeconds: 2 });
    await closeAllPopups(a.page);
    const manualBefore = manualRequests.length;
    expect(bytesOf(b)).toEqual(edited);
    expect(await shadowMain(a.server, sourceId)).toBe(beforeRestartHead);
    const since = Date.now();
    checkpointOutput(a);
    await a.server.restart({ jitless: true, extraEnv: { LUKER_FORCE_JITLESS: '1' } });
    expect(a.server.execArgv).toContain('--jitless');
    await a.page.goto(a.server.baseURL);
    await awaitS3Page(a.page);
    await waitForBackendSync(a.page, { label: 'Cloud', since });
    expect(await shadowMain(a.server, sourceId)).not.toBe(beforeRestartHead);
    await expect.poll(() => digest(bytesOf(b)), { timeout: 60_000 }).toBe(digest(restarted));
    await waitForBackendSync(b.page, { label: 'Cloud', since });
    const receiverRestartedAt = Date.now();
    checkpointOutput(b);
    await b.server.restart({ jitless: true, extraEnv: { LUKER_FORCE_JITLESS: '1' } });
    expect(b.server.execArgv).toContain('--jitless');
    await b.page.goto(b.server.baseURL);
    await awaitS3Page(b.page);
    await waitForBackendSync(b.page, { label: 'Cloud', since: receiverRestartedAt });
    expect(manualRequests).toHaveLength(manualBefore);
    for (const device of [a, b]) {
        expect(bytesOf(device)).toEqual(restarted);
        const id = Object.keys(registryOf(device.server).backends)[0];
        const paths = getShadowPaths({ userRoot: userRootOf(device.server), peerId: id });
        expect(await hasCompleteClosure({ dir: paths.workdir, gitdir: paths.gitDir, oid: await shadowMain(device.server, id), verify: true })).toBe(true);
        expect(fs.readdirSync(paths.peerDir).filter(name => name.startsWith('.luker-staging-s3-'))).toEqual([]);
    }
    expect(await shadowMain(a.server, Object.keys(registryOf(a.server).backends)[0])).toBe(await shadowMain(b.server, Object.keys(registryOf(b.server).backends)[0]));
    await openLanSyncPanel(b.page);
    await expect(backendRow(b.page)).toHaveCount(1);
    await expect(backendError(b.page)).toBeHidden();
    await testInfo.attach('actual-jitless-evidence', { body: JSON.stringify({ argv: [a.server.execArgv, b.server.execArgv], original: digest(original), edited: digest(edited), restarted: digest(restarted), automatic: true }), contentType: 'application/json' });
}

test('two actual-jitless servers add, reject a wrong phrase, edit, push, pull and automatically sync after restart', async ({ browser }, testInfo) => {
    const a = await fixture.device(browser, 'jitless-a', {}, { jitless: true });
    const b = await fixture.device(browser, 'jitless-b', {}, { jitless: true });
    for (const device of [a, b]) expect(device.server.execArgv).toContain('--jitless');
    const options = await fixture.options();
    const urls = [], messages = [], manualRequests = [];
    const reads = createResponseReadOwner();
    const secrets = () => [options.accessKeyId, options.secretAccessKey, options.passphrase,
        ...[a, b].flatMap(device => Object.values(registryOf(device.server).backends).map(backend => backend.s3.derivedKey))];
    const assertPrivate = values => {
        for (const secret of secrets()) expect(values.some(value => value.includes(secret))).toBe(false);
    };
    const checkpointOutput = device => assertPrivate(device.server.outputEpochs);
    const observeRequest = request => {
        urls.push(request.url());
        if (request.method() === 'POST' && /\/backends\/[^/]+\/sync$/.test(new URL(request.url()).pathname)) manualRequests.push(request.url());
    };
    const observeConsole = message => messages.push(message.text());
    const observeResponse = response => {
        if (new URL(response.url()).pathname.startsWith('/api/sync/')) reads.observe(response);
    };
    for (const { page } of [a, b]) {
        page.on('request', observeRequest); page.on('console', observeConsole); page.on('response', observeResponse);
    }
    let primary;
    const failures = [];
    try {
        await journey(a, b, options, manualRequests, checkpointOutput, testInfo);
    } catch (error) { primary = error; } finally {
        for (const { page } of [a, b]) {
            page.off('request', observeRequest); page.off('console', observeConsole); page.off('response', observeResponse);
        }
        if (primary) failures.push(primary);
        try { await reads.settle(); } catch (error) { failures.push(error); }
        try { assertPrivate([...reads.texts, ...urls, ...messages, ...a.server.outputEpochs, ...b.server.outputEpochs]); } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new globalThis.AggregateError(failures, 'Jitless journey and owned response settlement failed');
});
