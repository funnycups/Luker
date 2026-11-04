import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { s3Fixture, backendError, registryOf, createReadyWorldBook as createWorldBook, reloadS3Page } from '../_lib/sync-s3.js';
import { addS3Backend, fillS3Form, editSyncBackend, unlockS3Backend, waitForBackendSync, closeAllPopups, openLanSyncPanel, clickSyncNow, shadowMain, userRootOf, openAddBackend, clickBackendMenu } from '../_lib/sync.js';
import { accountWindow, formError, pageHead } from '../_lib/account-window.js';
import { addWorldEntry } from '../_lib/ui-worldinfo.js';

/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- Table-driven genuine provider faults and encrypted object formats. */

const fixture = s3Fixture(test);
// Real KDF, server startup and actual SDK transfers, not a product timeout.
test.describe.configure({ timeout: 300_000 });

async function rejectAdd(page, options, code, status) {
    await openAddBackend(page, 's3');
    await fillS3Form(page, options);
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/sync/v1/backends/s3');
    await accountWindow(page).locator('[data-act="s3-save"]').click();
    const actual = await response;
    expect(actual.status()).toBe(status);
    expect(await actual.json()).toMatchObject({ code });
    await expect(formError(page)).toBeVisible();
    await cancelForm(page);
    await expect(accountWindow(page).locator('.dw-card[data-backend]')).toHaveCount(0);
}

/** Leave the form on the current Sync page with its Cancel button. */
async function cancelForm(page) {
    await accountWindow(page).locator('.dw-foot [data-act="back"]').click();
    await expect(pageHead(page)).toHaveAttribute('data-view', /^(list|add)$/);
    await openLanSyncPanel(page);
}

function observePublic(page, responses, urls, consoleMessages, pending) {
    page.on('request', r => urls.push(r.url()));
    page.on('console', m => consoleMessages.push(m.text()));
    page.on('response', r => {
        if (new URL(r.url()).pathname.startsWith('/api/sync/')) pending.push(r.text().then(text => responses.push(text)));
    });
}

function assertNoPhraseOnDisk(dir, phrase) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) assertNoPhraseOnDisk(file, phrase);
        else if (entry.isFile()) expect(fs.readFileSync(file).includes(Buffer.from(phrase)), file).toBe(false);
    }
}

test('Add encrypts a real snapshot and keeps credentials and the canonical derived key private', async ({ browser }) => {
    const { page: a, server: serverA } = await fixture.device(browser, 'private-a');
    const options = await fixture.options();
    const marker = `RP glade guardian ${randomBytes(12).toString('hex')}`;
    const responses = [], urls = [], consoleMessages = [], pending = [];
    observePublic(a, responses, urls, consoleMessages, pending);
    await closeAllPopups(a);
    await createWorldBook(a, 'Encrypted Glade');
    await addWorldEntry(a, { key: 'guardian', content: marker });
    await openLanSyncPanel(a);
    await addS3Backend(a, options);
    await waitForBackendSync(a, { label: 'Cloud' });
    const sdk = fixture.client();
    const objects = (await sdk.send(new ListObjectsV2Command({ Bucket: options.bucket, Prefix: options.prefix }))).Contents;
    const keys = objects.map(o => o.Key);
    expect(keys).toContain('shared/keyinfo.json');
    expect(keys).toContain('shared/head');
    expect(keys.filter(key => /^shared\/packs\/[a-f0-9]{32}$/.test(key)).length).toBeGreaterThan(0);
    expect(keys.filter(key => key.includes('/.probe/')), 'successful setup cleans its owned probes').toEqual([]);
    for (const key of keys) {
        const bytes = Buffer.from(await (await sdk.send(new GetObjectCommand({ Bucket: options.bucket, Key: key }))).Body.transformToByteArray());
        expect(bytes.includes(Buffer.from(marker))).toBe(false);
        expect(bytes.includes(Buffer.from(options.passphrase))).toBe(false);
        if (key !== 'shared/keyinfo.json') expect(bytes.subarray(0, 5)).toEqual(Buffer.from([76, 75, 83, 82, 1]));
        else expect(JSON.parse(bytes)).toMatchObject({ v: 1, kdf: 'scrypt', N: 131072, r: 8, p: 1 });
    }
    const file = path.join(userRootOf(serverA), '.sync/state.json');
    const privateBytes = fs.readFileSync(file, 'utf8');
    const state = registryOf(serverA);
    const id = Object.keys(state.backends)[0];
    const key = state.backends[id].s3.derivedKey;
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(Buffer.from(key, 'base64')).toHaveLength(32);
    expect(Buffer.from(key, 'base64').toString('base64')).toBe(key);
    expect(privateBytes).not.toContain(options.passphrase);
    assertNoPhraseOnDisk(path.join(userRootOf(serverA), '.sync'), options.passphrase);
    const { page: b, server: serverB } = await fixture.device(browser, 'private-b');
    observePublic(b, responses, urls, consoleMessages, pending);
    await rejectAdd(b, { ...options, passphrase: 'not the glade phrase' }, 'S3_WRONG_PASSPHRASE', 422);
    expect(Object.keys(registryOf(serverB).backends)).toEqual([]);
    await addS3Backend(b, options);
    await waitForBackendSync(b, { label: 'Cloud' });
    expect(fs.readFileSync(path.join(userRootOf(serverB), 'worlds/Encrypted Glade.json'), 'utf8')).toContain(marker);
    await reloadS3Page(a);
    await openLanSyncPanel(a);
    await Promise.all(pending);
    for (const secret of [options.accessKeyId, options.secretAccessKey, options.passphrase, key]) {
        expect(responses.join('\n')).not.toContain(secret);
        expect(urls.join('\n')).not.toContain(secret);
        expect(consoleMessages.join('\n')).not.toContain(secret);
        expect(serverA.output + serverB.output).not.toContain(secret);
    }
});

for (const kind of ['credentials', 'bucket', 'if-none-match', 'if-match']) {
    test(`Add rejects real storage ${kind} failure without admitting a backend`, async ({ browser }) => {
        const { page, server } = await fixture.device(browser, kind);
        const options = await fixture.options();
        let code, status;
        if (kind === 'credentials') {
            options.secretAccessKey = 'wrong-real-storage-secret';
            code = 'AUTH_FAILED'; status = 401;
        } else if (kind === 'bucket') {
            options.bucket = `absent-${randomBytes(8).toString('hex')}`;
            code = 'BUCKET_NOT_FOUND'; status = 404;
        } else {
            const proxy = await fixture.proxy();
            options.endpoint = proxy.endpoint;
            // The second PUT tests duplicate create; the third tests wrong ETag.
            proxy.addFault({ match: { method: 'PUT', attempt: kind === 'if-none-match' ? 2 : 3 }, stripHeaders: [kind] });
            code = 'CONDITIONAL_WRITES_UNSUPPORTED'; status = 422;
            await rejectAdd(page, options, code, status);
            const puts = proxy.requests.filter(r => r.method === 'PUT');
            const ignored = puts[kind === 'if-none-match' ? 1 : 2];
            expect(ignored.headers[kind]).toBeTruthy();
            expect(ignored.upstreamStatus).toBe(200);
            if (kind === 'if-match') expect(puts[1].upstreamStatus).toBe(412);
            expect(proxy.requests.some(r => r.relativeKey === 'shared/keyinfo.json')).toBe(false);
            expect(Object.keys(registryOf(server).backends)).toEqual([]);
            return;
        }
        await rejectAdd(page, options, code, status);
        // Authentication and missing-bucket faults also prevent the attempt's
        // cleanup DELETE. The deliberately generated diagnostic is sanitized.
        expect(server.output).toContain('S3 probe cleanup failed');
        expect(server.output).not.toContain(options.secretAccessKey);
        expect(Object.keys(registryOf(server).backends)).toEqual([]);
    });
}

test('Edit retains identity and history and Unlock refuses a changed remote ID before data writes', async ({ browser }) => {
    const { page, server } = await fixture.device(browser, 'edit');
    const options = await fixture.options();
    await closeAllPopups(page);
    await createWorldBook(page, 'History Glade');
    await addWorldEntry(page, { key: 'warden', content: 'The original guardian remembers the moonwell.' });
    await openLanSyncPanel(page);
    await addS3Backend(page, options);
    await waitForBackendSync(page, { label: 'Cloud' });
    const state = registryOf(server), id = Object.keys(state.backends)[0];
    const original = state.backends[id].s3;
    const oid = await shadowMain(server, id);
    const proxy = await fixture.proxy();
    const editedAt = Date.now();
    await editSyncBackend(page, 'Cloud', { endpoint: proxy.endpoint });
    await waitForBackendSync(page, { label: 'Cloud', since: editedAt });
    expect(Object.keys(registryOf(server).backends)).toEqual([id]);
    expect(await shadowMain(server, id)).toBe(oid);
    expect(registryOf(server).backends[id].s3).toMatchObject({ ...original, endpoint: proxy.endpoint });
    await clickBackendMenu(page, 'Cloud', 'edit');
    await fillS3Form(page, { accessKeyId: 'half-pair' });
    const badEdit = page.waitForResponse(r => r.url().endsWith(`/${id}/s3`));
    await accountWindow(page).locator('[data-act="s3-save"]').click();
    expect(await (await badEdit).json()).toMatchObject({ code: 'S3_SETTINGS_INVALID' });
    await expect(formError(page)).toBeVisible();
    expect(registryOf(server).backends[id].s3.accessKeyId).toBe(original.accessKeyId);
    expect(registryOf(server).backends[id].s3.secretAccessKey).toBe(original.secretAccessKey);
    await cancelForm(page);
    const sdk = fixture.client();
    const key = 'shared/keyinfo.json';
    const bytes = Buffer.from(await (await sdk.send(new GetObjectCommand({ Bucket: options.bucket, Key: key }))).Body.transformToByteArray());
    const changed = JSON.parse(bytes);
    changed.keyId = randomBytes(8).toString('hex');
    const verifier = Buffer.from(changed.verifier, 'base64');
    Buffer.from(changed.keyId, 'hex').copy(verifier, 5);
    changed.verifier = verifier.toString('base64');
    await sdk.send(new PutObjectCommand({ Bucket: options.bucket, Key: key, Body: JSON.stringify(changed) }));
    const from = proxy.requests.length;
    try {
        const sync = page.waitForResponse(r => r.url().endsWith(`/${id}/sync`));
        expect(await clickSyncNow(page, 'Cloud')).toBe('error');
        expect(await (await sync).json()).toMatchObject({ code: 'S3_KEY_MISMATCH' });
        await clickBackendMenu(page, 'Cloud', 'unlock');
        await accountWindow(page).locator('[data-model="top.form.pass"]').fill(options.passphrase);
        const unlock = page.waitForResponse(r => r.url().endsWith('/unlock'));
        await accountWindow(page).locator('[data-act="unlock-save"]').click();
        const rejected = await unlock;
        expect(rejected.status()).toBe(409);
        expect(await rejected.json()).toMatchObject({ code: 'S3_KEY_MISMATCH' });
        await expect(formError(page)).toContainText('Remove it and add it again');
        expect(proxy.requests.slice(from).filter(r => ['PUT', 'DELETE'].includes(r.method) && (r.relativeKey === 'shared/head' || r.relativeKey.startsWith('shared/packs/')))).toEqual([]);
        expect(registryOf(server).backends[id].s3.derivedKey).toBe(original.derivedKey);
        await cancelForm(page);
    } finally { await sdk.send(new PutObjectCommand({ Bucket: options.bucket, Key: key, Body: bytes })); }
    await unlockS3Backend(page, 'Cloud', options.passphrase);
    expect(registryOf(server).backends[id].s3.keyId).toBe(original.keyId);
    expect(await clickSyncNow(page, 'Cloud')).toBe('success');
    proxy.addFault({ match: { method: 'GET', keySuffix: '/keyinfo.json' }, dropConnection: true });
    expect(await clickSyncNow(page, 'Cloud')).toBe('error');
    await expect(backendError(page)).toContainText('The S3 endpoint could not be reached.');
    await closeAllPopups(page);
    await reloadS3Page(page);
    await openLanSyncPanel(page);
    await expect(backendError(page)).toContainText('The S3 endpoint could not be reached.');
    expect(registryOf(server).backends[id].lastSync.error).toBeTruthy();
});
