// Observations for real-server crash/race tests. Mutations remain DOM gestures.
import fs from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { registryOf, reloadS3Page } from './sync-s3.js';
import { addS3Backend, backendCard, waitForBackendSync, closeAllPopups, openLanSyncPanel, clickSyncNow, userRootOf, shadowMain } from './sync.js';
import { decryptObject } from '../../../src/sync/backends/s3/crypto.js';
import { decodeHead } from '../../../src/sync/backends/s3/layout.js';
import { getShadowPaths } from '../../../src/sync/shadow.js';
import { hasCompleteClosure } from '../../../src/sync/objects.js';
import { inspectPack, validatePackIndex } from '../../../src/sync/backends/s3/pack-integrity.js';

export const entryOf = device => Object.entries(registryOf(device.server).backends).find(([, entry]) => entry.label === 'Cloud');
export const pathsOf = device => getShadowPaths({ userRoot: userRootOf(device.server), peerId: entryOf(device)[0] });

export function publishedHead(device, envelope) {
    const settings = entryOf(device)[1].s3;
    return decodeHead(decryptObject({ key: Buffer.from(settings.derivedKey, 'base64'), keyId: settings.keyId,
        context: settings, domain: 'head', relativeKey: 'head', envelope }));
}

export async function pair(fixture, browser, envA = {}, envB = {}) {
    const options = await fixture.options();
    const proxyA = await fixture.proxy(), proxyB = await fixture.proxy();
    const a = await fixture.device(browser, 'race-a', envA), b = await fixture.device(browser, 'race-b', envB);
    for (const [device, proxy] of [[a, proxyA], [b, proxyB]]) {
        await addS3Backend(device.page, { ...options, endpoint: proxy.endpoint });
        await waitForBackendSync(device.page, { label: 'Cloud' });
        await closeAllPopups(device.page);
    }
    await manual(a);
    return { a, b, proxyA, proxyB, options };
}

export async function startManual(device) {
    await closeAllPopups(device.page);
    await openLanSyncPanel(device.page);
    await backendCard(device.page, 'Cloud').locator('[data-act="sync-now"]').click();
}

export async function manual(device) {
    await closeAllPopups(device.page);
    await openLanSyncPanel(device.page);
    expect(await clickSyncNow(device.page, 'Cloud', 120_000)).toBe('success');
    await waitForBackendSync(device.page, { label: 'Cloud' });
    await closeAllPopups(device.page);
}

export async function remoteHead(fixture, options, device) {
    const settings = entryOf(device)[1].s3;
    const result = await fixture.client().send(new GetObjectCommand({ Bucket: options.bucket, Key: 'shared/head' }));
    const envelope = Buffer.from(await result.Body.transformToByteArray());
    const payload = decryptObject({ key: Buffer.from(settings.derivedKey, 'base64'), keyId: settings.keyId,
        context: settings, domain: 'head', relativeKey: 'head', envelope });
    return { head: decodeHead(payload), payload, envelope, etag: result.ETag };
}

export async function remotePacks(fixture, options) {
    const result = await fixture.client().send(new ListObjectsV2Command({ Bucket: options.bucket, Prefix: 'shared/packs/' }));
    expect(result.IsTruncated).toBe(false);
    return (result.Contents ?? []).map(object => ({ name: object.Key.split('/').at(-1), size: object.Size }));
}

export async function assertLocal(device) {
    const paths = pathsOf(device), oid = await shadowMain(device.server, entryOf(device)[0]);
    expect(await hasCompleteClosure({ dir: paths.workdir, gitdir: paths.gitDir, oid, verify: true })).toBe(true);
    const ledgerFile = path.join(paths.peerDir, 's3-packs.json');
    const ledger = fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, 'utf8')) : { v: 1, packs: {} };
    expect(ledger.v).toBe(1);
    if (fs.existsSync(ledgerFile)) expect(fs.statSync(ledgerFile).mode & 0o777).toBe(0o600);
    for (const record of Object.values(ledger.packs)) {
        const pack = fs.readFileSync(path.join(paths.gitDir, 'objects/pack', record.filename));
        const index = fs.readFileSync(path.join(paths.gitDir, 'objects/pack', record.filename.replace('.pack', '.idx')));
        const inspection = await inspectPack(pack);
        validatePackIndex({ pack, index, inspection });
        expect(pack.length + 41).toBe(record.size);
    }
    expect(fs.readdirSync(paths.peerDir).filter(name => name.startsWith('.luker-staging-s3-'))).toEqual([]);
    return { oid, ledger };
}

export async function restart(device) {
    const port = device.server.port, root = device.server.dataRoot;
    await device.server.restart({ extraEnv: { LUKER_SYNC_FAILPOINT: '', LUKER_SYNC_FAILPOINT_ARM: '' } });
    expect(device.server.port).toBe(port);
    expect(device.server.dataRoot).toBe(root);
    await reloadS3Page(device.page);
    await manual(device);
}
