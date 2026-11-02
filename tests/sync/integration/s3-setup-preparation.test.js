import { afterAll, afterEach, beforeAll, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { startRustfsContainer } from '../../e2e/_lib/s3-container.js';
import { startS3Proxy } from '../../e2e/_lib/s3-proxy.js';
import { prepareS3Backend, prepareS3Unlock } from '../../../src/sync/backends/s3/setup.js';
import { createS3Client } from '../../../src/sync/backends/s3/client.js';
import { createS3BackendEntry, patchS3BackendEntry, readRegistry, setBackendSettings, recordLastSync, setSchedule, setDeviceLabel } from '../../../src/sync/state.js';
import { syncService } from '../../../src/sync/sync-service.js';

let storage, admin, proxy, base;
const roots = [];
const phrase = 'a private setup phrase';
const owner = () => {
    const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 's3-setup-')); roots.push(userRoot);
    return { userRoot, handle: 'setup', getCurrentProfile: async () => ({ enabled: true, admin: true }) };
};
const input = () => ({ ...base, prefix: randomBytes(16).toString('hex'), passphrase: phrase });
const previousFor = async (o, s3) => {
    const backendId = `s3-${randomBytes(16).toString('hex')}`;
    const entry = await createS3BackendEntry({ userRoot: o.userRoot, backendId, label: 'Setup', categories: ['worlds'], s3 });
    return { backendId, ...entry };
};
async function readInfo(o, settings) {
    const client = createS3Client({ owner: o, settings });
    try { const result = await client.get('keyinfo.json'); return result ? JSON.parse(await result.body.transformToString()) : null; }
    finally { await client.close(); }
}
async function writeInfo(o, settings, value) {
    const client = createS3Client({ owner: o, settings });
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    try { await client.put('keyinfo.json', bytes, { contentLength: bytes.length }); } finally { await client.close(); }
}
beforeAll(async () => {
    storage = await startRustfsContainer();
    const credentials = { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey };
    admin = new S3Client({ endpoint: storage.endpoint, region: storage.region, credentials, forcePathStyle: true, maxAttempts: 1 });
    const bucket = `setup-${randomBytes(8).toString('hex')}`;
    await admin.send(new CreateBucketCommand({ Bucket: bucket }));
    proxy = await startS3Proxy({ upstream: storage.endpoint, credentials, region: storage.region });
    base = { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey, endpoint: proxy.endpoint, bucket, region: storage.region, forcePathStyle: true };
}, 240_000);
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
afterAll(async () => { await proxy?.close(); admin?.destroy(); await storage?.stop(); });

test('Add probes real conditional writes then initializes canonical keyinfo without persisting phrase', async () => {
    const o = owner(), submitted = input();
    const result = await prepareS3Backend({ owner: o, input: submitted });
    const info = await readInfo(o, result.s3);
    expect(result.s3.keyId).toBe(info.keyId);
    expect(Buffer.from(result.s3.derivedKey, 'base64')).toHaveLength(32);
    expect(result.expectedS3).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(phrase);
    expect((await readRegistry({ userRoot: o.userRoot })).backends).toEqual({});
    const requests = proxy.requests.filter(r => r.relativeKey.startsWith(`${submitted.prefix}/`));
    expect(requests.filter(r => r.upstreamStatus === 412)).toHaveLength(2);
    expect(requests.find(r => r.relativeKey.endsWith('keyinfo.json') && r.method === 'PUT').headers['if-none-match']).toBe('*');
});

test('Add names the If-Match quote option when a provider rejects a quoted current ETag', async () => {
    const o = owner(), submitted = input();
    const fault = proxy.addFault({ match: { method: 'PUT', keyPrefix: submitted.prefix }, rejectQuotedIfMatch: true, repeat: true });
    try {
        await expect(prepareS3Backend({ owner: o, input: submitted })).rejects.toMatchObject({ code: 'S3_IF_MATCH_QUOTES_UNSUPPORTED' });
        const result = await prepareS3Backend({ owner: o, input: { ...submitted, stripIfMatchQuotes: true } });
        expect(result.s3.stripIfMatchQuotes).toBe(true);
    } finally { fault.cancel(); }
});

test.each([true, false])('two actual missing GETs race one conditional initialization; same phrase=%s', async same => {
    const a = owner(), b = owner(), submitted = input();
    const match = { method: 'GET', keySuffix: `${submitted.prefix}/keyinfo.json` };
    const first = proxy.addFault({ match, once: true, hold: 'after-upstream-response' });
    const second = proxy.addFault({ match, once: true, hold: 'after-upstream-response' });
    const pa = prepareS3Backend({ owner: a, input: submitted });
    const pb = prepareS3Backend({ owner: b, input: { ...submitted, passphrase: same ? phrase : 'other private phrase' } });
    const settled = Promise.allSettled([pa, pb]);
    try {
        expect((await first.reached).upstreamStatus).toBe(404);
        expect((await second.reached).upstreamStatus).toBe(404);
    } finally { first.release(); second.release(); }
    const results = await settled;
    const successes = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    expect(successes).toHaveLength(same ? 2 : 1);
    expect(same ? successes[0] : results.find(r => r.status === 'rejected').reason.code).toEqual(same ? successes[1] : 'S3_WRONG_PASSPHRASE');
    const info = await readInfo(a, successes[0].s3);
    expect(info.keyId).toBe(successes[0].s3.keyId);
    const puts = proxy.requests.filter(r => r.method === 'PUT' && r.relativeKey === `${submitted.prefix}/keyinfo.json`);
    expect(puts.map(r => r.upstreamStatus).sort()).toEqual([200, 412]);
    for (const o of [a, b]) expect((await readRegistry({ userRoot: o.userRoot })).backends).toEqual({});
});

test('successful keyinfo PUT response loss performs one recovery GET and never resends', async () => {
    const o = owner(), submitted = input();
    const fault = proxy.addFault({ match: { method: 'PUT', keySuffix: `${submitted.prefix}/keyinfo.json` }, once: true, dropResponseAfterUpstreamSuccess: true });
    const result = await prepareS3Backend({ owner: o, input: submitted });
    expect((await fault.reached).upstreamStatus).toBe(200);
    const requests = proxy.requests.filter(r => r.relativeKey === `${submitted.prefix}/keyinfo.json`);
    expect(requests.map(r => r.method)).toEqual(['GET', 'PUT', 'GET']);
    expect(result.s3.keyId).toBe((await readInfo(o, result.s3)).keyId);
});

test('failed recovery GET surfaces failure without a retry loop', async () => {
    const o = owner(), submitted = input();
    proxy.addFault({ match: { method: 'PUT', keySuffix: `${submitted.prefix}/keyinfo.json` }, once: true, dropResponseAfterUpstreamSuccess: true });
    proxy.addFault({ match: { method: 'GET', keySuffix: `${submitted.prefix}/keyinfo.json`, attempt: 2 }, once: true, dropResponseAfterUpstreamSuccess: true });
    await expect(prepareS3Backend({ owner: o, input: submitted })).rejects.toMatchObject({ code: 'UNREACHABLE' });
    expect(proxy.requests.filter(r => r.relativeKey === `${submitted.prefix}/keyinfo.json`).map(r => r.method)).toEqual(['GET', 'PUT', 'GET']);
});

test('Edit rejects namespace change before transport and accepts normalized namespace and endpoint relocation', async () => {
    const o = owner(), initial = await prepareS3Backend({ owner: o, input: input() });
    const previous = await previousFor(o, initial.s3);
    const before = proxy.requests.length;
    const network = { resolveAll: () => { throw new Error('must not construct/dial'); } };
    for (const change of [{ bucket: 'other' }, { prefix: 'other' }]) {
        await expect(prepareS3Backend({ owner: o, previous, input: change, network })).rejects.toMatchObject({ code: 'S3_SETTINGS_INVALID' });
    }
    expect(proxy.requests).toHaveLength(before);
    const moved = await prepareS3Backend({ owner: o, previous, input: { endpoint: storage.endpoint, prefix: `/${previous.s3.prefix}/`, accessKeyId: '', secretAccessKey: '' } });
    expect(moved.s3).toEqual({ ...previous.s3, endpoint: storage.endpoint });
    expect(moved.expectedS3).toEqual(previous.s3);
    await syncService.withBackendMaintenance(o, previous.backendId, () => patchS3BackendEntry({ userRoot: o.userRoot, backendId: previous.backendId, expectedS3: moved.expectedS3, s3Patch: { endpoint: moved.s3.endpoint } }));
});

test('invalid replacement credentials preserve entry and ledger; omitted credentials verify retained key', async () => {
    const o = owner(), initial = await prepareS3Backend({ owner: o, input: input() });
    const previous = await previousFor(o, initial.s3);
    const ledger = path.join(o.userRoot, '.sync', previous.backendId, 's3-packs.json');
    fs.mkdirSync(path.dirname(ledger), { recursive: true }); fs.writeFileSync(ledger, 'unchanged-ledger');
    await expect(prepareS3Backend({ owner: o, previous, input: { accessKeyId: base.accessKeyId, secretAccessKey: 'private-invalid' } })).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect((await prepareS3Backend({ owner: o, previous, input: {} })).s3).toEqual(previous.s3);
    expect((await readRegistry({ userRoot: o.userRoot })).backends[previous.backendId]).toEqual(initialEntry(previous));
    expect(fs.readFileSync(ledger, 'utf8')).toBe('unchanged-ledger');
});
function initialEntry({ backendId: _backendId, ...entry }) { return entry; }

test.each(['malformed', 'wrong-key'])('Unlock repairs only derivedKey after stored key failure: %s', async kind => {
    const o = owner(), initial = await prepareS3Backend({ owner: o, input: input() });
    const previous = await previousFor(o, { ...initial.s3, derivedKey: kind === 'malformed' ? 'invalid' : randomBytes(32).toString('base64') });
    await expect(prepareS3Backend({ owner: o, previous, input: {} })).rejects.toMatchObject({ code: kind === 'malformed' ? 'S3_STORED_KEY_INVALID' : 'S3_STORED_KEY_REJECTED' });
    await expect(prepareS3Unlock({ owner: o, previous, passphrase: 'wrong' })).rejects.toMatchObject({ code: 'S3_WRONG_PASSPHRASE' });
    const start = proxy.requests.length;
    const repaired = await prepareS3Unlock({ owner: o, previous, passphrase: phrase });
    expect(Object.keys(repaired).sort()).toEqual(['derivedKey', 'expectedS3']);
    expect(repaired.derivedKey).toBe(initial.s3.derivedKey);
    expect(proxy.requests.slice(start).map(r => r.method)).toEqual(['GET']);
    await syncService.withBackendMaintenance(o, previous.backendId, () => patchS3BackendEntry({ userRoot: o.userRoot, backendId: previous.backendId, expectedS3: repaired.expectedS3, s3Patch: { derivedKey: repaired.derivedKey } }));
    expect((await readRegistry({ userRoot: o.userRoot })).backends[previous.backendId].s3).toEqual(initial.s3);
});

test('Unlock invalid local ID rejects before network; changed remote identity never rotates', async () => {
    const o = owner(), initial = await prepareS3Backend({ owner: o, input: input() });
    const previous = await previousFor(o, { ...initial.s3, keyId: '' });
    const start = proxy.requests.length;
    await expect(prepareS3Unlock({ owner: o, previous, passphrase: phrase })).rejects.toMatchObject({ code: 'S3_LOCAL_KEY_ID_INVALID' });
    expect(proxy.requests).toHaveLength(start);
    const changed = await previousFor(o, { ...initial.s3, keyId: 'f'.repeat(16) });
    const ledger = path.join(o.userRoot, '.sync', changed.backendId, 's3-packs.json');
    fs.mkdirSync(path.dirname(ledger), { recursive: true }); fs.writeFileSync(ledger, 'identity-ledger');
    const networkStart = proxy.requests.length;
    await expect(prepareS3Unlock({ owner: o, previous: changed, passphrase: phrase })).rejects.toMatchObject({ code: 'S3_KEY_MISMATCH' });
    expect((await readRegistry({ userRoot: o.userRoot })).backends[previous.backendId].s3.keyId).toBe('');
    expect((await readRegistry({ userRoot: o.userRoot })).backends[changed.backendId]).toEqual(initialEntry(changed));
    expect(fs.readFileSync(ledger, 'utf8')).toBe('identity-ledger');
    expect(proxy.requests.slice(networkStart).map(r => r.method)).toEqual(['GET']);
});

test('network preparation permits unrelated registry writes and releases admission before maintenance commit', async () => {
    const o = owner(), initial = await prepareS3Backend({ owner: o, input: input() });
    const previous = await previousFor(o, initial.s3);
    const gate = proxy.addFault({ match: { method: 'GET', keySuffix: `${previous.s3.prefix}/keyinfo.json` }, once: true, hold: 'after-upstream-response' });
    const preparing = prepareS3Backend({ owner: o, previous, input: { region: previous.s3.region } });
    await gate.reached;
    let entered = false;
    const maintenance = syncService.withBackendMaintenance(o, previous.backendId, async () => { entered = true; });
    await Promise.all([
        setBackendSettings({ userRoot: o.userRoot, backendId: previous.backendId, label: 'Latest label', categories: ['characters'] }),
        setSchedule({ userRoot: o.userRoot, idleSeconds: 12, pollSeconds: 34 }),
        setDeviceLabel({ userRoot: o.userRoot, label: 'Latest device' }),
        recordLastSync({ userRoot: o.userRoot, backendId: previous.backendId, success: { head: 'd'.repeat(40) } }),
    ]);
    expect(entered).toBe(false);
    gate.release();
    const result = await preparing;
    await maintenance;
    await syncService.withBackendMaintenance(o, previous.backendId, (_registry, commit) => patchS3BackendEntry({ userRoot: o.userRoot, backendId: previous.backendId, expectedS3: result.expectedS3, s3Patch: { endpoint: result.s3.endpoint }, assertAlive: commit.assertAlive }));
    const registry = await readRegistry({ userRoot: o.userRoot });
    expect(registry.backends[previous.backendId]).toMatchObject({ label: 'Latest label', categories: ['characters'], lastSync: { head: 'd'.repeat(40) } });
    expect(registry.schedule).toEqual({ idleSeconds: 12, pollSeconds: 34 });
    expect(registry.device.label).toBe('Latest device');
});

test('concurrent credential commit invalidates prepared result without restoring old secrets', async () => {
    const o = owner(), initial = await prepareS3Backend({ owner: o, input: input() });
    const previous = await previousFor(o, initial.s3);
    const prepared = await prepareS3Backend({ owner: o, previous, input: {} });
    const newer = await patchS3BackendEntry({ userRoot: o.userRoot, backendId: previous.backendId, expectedS3: previous.s3, s3Patch: { accessKeyId: 'new-private-access', secretAccessKey: 'new-private-secret' } });
    await expect(syncService.withBackendMaintenance(o, previous.backendId, () => patchS3BackendEntry({ userRoot: o.userRoot, backendId: previous.backendId, expectedS3: prepared.expectedS3, s3Patch: prepared.s3 }))).rejects.toMatchObject({ code: 'S3_SETTINGS_CHANGED' });
    expect((await readRegistry({ userRoot: o.userRoot })).backends[previous.backendId]).toEqual(newer);
});

test('cleanup response loss warns but valid setup succeeds without head or pack writes', async () => {
    const o = owner(), submitted = input();
    const fault = proxy.addFault({ match: { method: 'DELETE', keySuffix: undefined }, once: true, dropResponseAfterUpstreamSuccess: true });
    const result = await prepareS3Backend({ owner: o, input: submitted });
    expect((await fault.reached).upstreamStatus).toBe(204);
    const client = createS3Client({ owner: o, settings: result.s3 });
    try { expect((await client.list('.probe/')).objects).toEqual([]); } finally { await client.close(); }
    expect(proxy.requests.filter(r => r.relativeKey.startsWith(`${submitted.prefix}/`) && r.method === 'PUT').every(r => r.relativeKey.includes('/.probe/') || r.relativeKey.endsWith('/keyinfo.json'))).toBe(true);
});

test('half credential pair and extra private input reject locally; explicit phrase verifies Edit', async () => {
    const o = owner(), initial = await prepareS3Backend({ owner: o, input: input() });
    const previous = await previousFor(o, initial.s3);
    const start = proxy.requests.length;
    for (const invalid of [{ accessKeyId: 'only-access' }, { secretAccessKey: 'only-secret' }, { derivedKey: initial.s3.derivedKey }, { keyId: initial.s3.keyId }]) {
        await expect(prepareS3Backend({ owner: o, previous, input: invalid })).rejects.toMatchObject({ code: 'S3_SETTINGS_INVALID' });
    }
    expect(proxy.requests).toHaveLength(start);
    expect((await prepareS3Backend({ owner: o, previous, input: { accessKeyId: base.accessKeyId, secretAccessKey: base.secretAccessKey, passphrase: phrase } })).s3).toEqual(previous.s3);
    await expect(prepareS3Backend({ owner: o, previous, input: { passphrase: 'wrong-private-phrase' } })).rejects.toMatchObject({ code: 'S3_WRONG_PASSPHRASE' });
    expect((await readRegistry({ userRoot: o.userRoot })).backends[previous.backendId]).toEqual(initialEntry(previous));
});

test('unsupported actual conditional writes reject preparation before metadata initialization', async () => {
    const o = owner(), submitted = input();
    const fault = proxy.addFault({ match: { method: 'PUT', keySuffix: undefined, attempt: 2 }, once: true, stripHeaders: ['if-none-match'] });
    await expect(prepareS3Backend({ owner: o, input: submitted })).rejects.toMatchObject({ code: 'CONDITIONAL_WRITES_UNSUPPORTED' });
    expect((await fault.reached).upstreamStatus).toBe(200);
    expect(await readInfo(o, submitted)).toBeNull();
    expect((await readRegistry({ userRoot: o.userRoot })).backends).toEqual({});
});

test('Edit never initializes missing metadata or accepts a different authenticated remote ID', async () => {
    const o = owner(), initial = await prepareS3Backend({ owner: o, input: input() });
    const previous = await previousFor(o, initial.s3);
    const client = createS3Client({ owner: o, settings: initial.s3 });
    try { await client.delete('keyinfo.json'); } finally { await client.close(); }
    const start = proxy.requests.length;
    await expect(prepareS3Backend({ owner: o, previous, input: { passphrase: phrase } })).rejects.toMatchObject({ code: 'S3_KEYINFO_MISSING' });
    const { s3 } = await prepareS3Backend({ owner: o, input: { ...base, prefix: initial.s3.prefix, passphrase: phrase } });
    expect(s3.keyId).not.toBe(initial.s3.keyId);
    await expect(prepareS3Backend({ owner: o, previous, input: { passphrase: phrase } })).rejects.toMatchObject({ code: 'S3_KEY_MISMATCH' });
    expect(proxy.requests.slice(start).filter(r => r.method === 'PUT' && r.relativeKey.endsWith('/keyinfo.json'))).toHaveLength(1);
    expect((await readRegistry({ userRoot: o.userRoot })).backends[previous.backendId]).toEqual(initialEntry(previous));
});

test.each(['json', 'tuple', 'oversized', 'tamper'])('malformed existing keyinfo is never initialized again: %s', async kind => {
    const o = owner(), initial = await prepareS3Backend({ owner: o, input: input() });
    const info = await readInfo(o, initial.s3);
    const bad = kind === 'json' ? '{bad' : kind === 'tuple' ? { ...info, N: 2 } : kind === 'oversized' ? { ...info, verifier: 'A'.repeat(100000) } : { ...info, verifier: Buffer.from(info.verifier, 'base64').map((v, i) => i === 30 ? v ^ 1 : v).toString('base64') };
    await writeInfo(o, initial.s3, bad);
    const start = proxy.requests.length;
    const settings = { ...initial.s3 };
    delete settings.keyId; delete settings.derivedKey;
    await expect(prepareS3Backend({ owner: o, input: { ...settings, passphrase: phrase } })).rejects.toMatchObject({ code: kind === 'tuple' ? 'S3_FORMAT_UNSUPPORTED' : kind === 'tamper' ? 'S3_WRONG_PASSPHRASE' : 'S3_KEYINFO_INVALID' });
    expect(proxy.requests.slice(start).some(r => r.method === 'GET' && r.relativeKey.endsWith('keyinfo.json'))).toBe(true);
    expect(proxy.requests.slice(start).filter(r => r.method === 'PUT' && r.relativeKey.endsWith('keyinfo.json'))).toEqual([]);
});

test('removal during actual network invalidates preparation and drains before deletion', async () => {
    const o = owner(), initial = await prepareS3Backend({ owner: o, input: input() });
    const previous = await previousFor(o, initial.s3);
    const gate = proxy.addFault({ match: { method: 'GET', keySuffix: `${previous.s3.prefix}/keyinfo.json` }, once: true, hold: 'after-upstream-response' });
    const pending = prepareS3Backend({ owner: o, previous, input: {} });
    const rejected = pending.catch(error => error);
    await gate.reached;
    const removing = syncService.removeBackend(o, previous.backendId);
    gate.release();
    expect(await rejected).toMatchObject({ code: 'UNKNOWN_BACKEND' });
    await removing;
    expect((await readRegistry({ userRoot: o.userRoot })).backends).toEqual({});
});
