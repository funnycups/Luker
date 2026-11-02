import { beforeAll, afterAll, afterEach, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import git from 'isomorphic-git';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { startRustfsContainer } from '../../e2e/_lib/s3-container.js';
import { startS3Proxy } from '../../e2e/_lib/s3-proxy.js';
import { makeDevice, readAllReachable } from '../_lib/devices.js';
import { S3Backend } from '../../../src/sync/backends/s3/backend.js';
import { prepareS3Backend } from '../../../src/sync/backends/s3/setup.js';
import { createS3BackendEntry, readRegistry } from '../../../src/sync/state.js';
import { syncService } from '../../../src/sync/sync-service.js';
import { getShadowPaths } from '../../../src/sync/shadow.js';
import { atomicFs } from '../../../src/sync/pipeline/atomic-fs.js';
import { hasCompleteClosure } from '../../../src/sync/objects.js';
import { createS3Client } from '../../../src/sync/backends/s3/client.js';
import { decryptObject, encryptObject } from '../../../src/sync/backends/s3/crypto.js';
import { decodeHead } from '../../../src/sync/backends/s3/layout.js';
import { runSyncCycle } from '../../../src/sync/pipeline/cycle.js';
import { commitLocalEdit } from '../../../src/sync/pipeline/cycle.js';
import { until } from '../_lib/until.js';
import { patchS3BackendEntry } from '../../../src/sync/state.js';
import { inspectPack } from '../../../src/sync/backends/s3/pack-integrity.js';

let storage, admin, proxy, base;
const devices = [];
beforeAll(async () => {
    storage = await startRustfsContainer();
    const credentials = { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey };
    admin = new S3Client({ endpoint: storage.endpoint, region: storage.region, credentials, forcePathStyle: true, maxAttempts: 1 });
    const bucket = `backend-${randomBytes(8).toString('hex')}`;
    await admin.send(new CreateBucketCommand({ Bucket: bucket }));
    proxy = await startS3Proxy({ upstream: storage.endpoint, credentials, region: storage.region });
    base = { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey, endpoint: proxy.endpoint, bucket, region: storage.region, forcePathStyle: true };
}, 240_000);
afterEach(async () => { for (const d of devices.splice(0)) { await syncService.removeBackend(d.owner, d.id); d.cleanup(); } });
afterAll(async () => { await proxy?.close(); admin?.destroy(); await storage?.stop(); });
async function device(s3) {
    const d = makeDevice({ categories: ['worlds'] }); devices.push(d);
    d.owner = { ...d.ctx, getCurrentProfile: async () => ({ enabled: true, admin: true }) };
    d.id = `s3-${randomBytes(16).toString('hex')}`;
    s3 ??= (await prepareS3Backend({ owner: d.owner, input: { ...base, prefix: randomBytes(16).toString('hex'), passphrase: 'backend private phrase' } })).s3;
    d.entry = await createS3BackendEntry({ userRoot: d.userRoot, backendId: d.id, label: 'S3', categories: ['worlds'], s3 });
    d.shadow = getShadowPaths({ userRoot: d.userRoot, peerId: d.id });
    d.run = () => syncService.trigger(d.owner, d.id, 'manual');
    d.admitted = fn => syncService.withBackendOperation(d.owner, d.id, 'drive', async lease => {
        const backend = new S3Backend({ id: d.id, owner: d.owner, entry: d.entry, lease });
        try { return await fn(backend, lease); } finally { await backend.close(); }
    });
    return d;
}
async function head(d) {
    const transport = createS3Client({ owner: d.owner, settings: d.entry.s3 });
    try {
        const result = await transport.get('head');
        const envelope = Buffer.from(await result.body.transformToByteArray());
        expect(envelope.subarray(0, 4).toString()).toBe('LKSR');
        return decodeHead(decryptObject({ key: Buffer.from(d.entry.s3.derivedKey, 'base64'), keyId: d.entry.s3.keyId, context: d.entry.s3, domain: 'head', relativeKey: 'head', envelope }));
    } finally { await transport.close(); }
}
test('shared scheduler publishes encrypted closure and incremental nonempty packs; unchanged cycle writes none', async () => {
    const a = await device(); a.write('worlds/one.json', '{"one":1}');
    expect(await a.run()).toMatchObject({ ok: true, outcome: { pushed: true } });
    const initial = await head(a); expect(initial.packs).toHaveLength(1);
    const b = await device(a.entry.s3);
    expect(await b.run()).toMatchObject({ ok: true });
    expect(b.read('worlds/one.json')).toBe('{"one":1}');
    expect(await hasCompleteClosure({ dir: b.shadow.workdir, gitdir: b.shadow.gitDir, oid: initial.commit, verify: true })).toBe(true);
    a.write('worlds/two.json', '{"two":2}'); expect(await a.run()).toMatchObject({ ok: true });
    const updated = await head(a); expect(updated.packs).toHaveLength(2); expect(updated.packs[0]).toEqual(initial.packs[0]);
    const oldObjects = await readAllReachable(a.shadow.gitDir, initial.commit);
    const newObjects = await readAllReachable(a.shadow.gitDir, updated.commit);
    const expected = [...newObjects].filter(oid => !oldObjects.has(oid)).sort();
    const transport = createS3Client({ owner: a.owner, settings: a.entry.s3 });
    try {
        const relativeKey = `packs/${updated.packs[1].name}`;
        const result = await transport.get(relativeKey);
        const envelope = Buffer.from(await result.body.transformToByteArray());
        const pack = decryptObject({ key: Buffer.from(a.entry.s3.derivedKey, 'base64'), keyId: a.entry.s3.keyId, context: a.entry.s3, domain: 'pack', relativeKey, envelope });
        const { objects } = await inspectPack(pack);
        expect(objects.map(object => object.oid).sort()).toEqual(expected);
        expect(expected.length).toBeGreaterThan(0);
        expect(objects.some(object => oldObjects.has(object.oid))).toBe(false);
    } finally { await transport.close(); }
    const before = proxy.requests.filter(r => r.method === 'PUT').length;
    expect(await a.run()).toMatchObject({ ok: true, outcome: { pushed: false } });
    expect(proxy.requests.filter(r => r.method === 'PUT')).toHaveLength(before);
    const puts = proxy.requests.filter(r => r.method === 'PUT' && r.relativeKey.startsWith(`${a.entry.s3.prefix}/packs/`));
    expect(puts).toHaveLength(2); for (const put of puts) expect(put.headers['if-none-match']).toBe('*');
    expect(fs.readdirSync(a.shadow.peerDir).filter(n => n.startsWith('.luker-staging-s3-'))).toEqual([]);
});
test('a quoted If-Match rejected against an unchanged head names the quote option and the option recovers', async () => {
    const a = await device(); a.write('worlds/base.json', '{}');
    expect(await a.run()).toMatchObject({ ok: true, outcome: { pushed: true } });
    const suffix = `${a.entry.s3.prefix}/head`;
    const fault = proxy.addFault({ match: { method: 'PUT', keySuffix: suffix }, rejectQuotedIfMatch: true, repeat: true });
    try {
        a.write('worlds/one.json', '{}');
        expect(await a.run()).toMatchObject({ ok: false, code: 'S3_IF_MATCH_QUOTES_UNSUPPORTED' });
        expect((await readRegistry({ userRoot: a.userRoot })).backends[a.id].lastSync.error.code).toBe('S3_IF_MATCH_QUOTES_UNSUPPORTED');
        const current = (await readRegistry({ userRoot: a.userRoot })).backends[a.id];
        a.entry = await patchS3BackendEntry({ userRoot: a.userRoot, backendId: a.id, expectedS3: current.s3, s3Patch: { stripIfMatchQuotes: true } });
        expect(await a.run()).toMatchObject({ ok: true, outcome: { pushed: true } });
    } finally { fault.cancel(); }
});

test('two immutable observations race genuine conditional head writes; loser leaves orphan and next cycle retains current packs', async () => {
    const a = await device(); a.write('worlds/base.json', '{}'); expect(await a.run()).toMatchObject({ ok: true });
    const b = await device(a.entry.s3); expect(await b.run()).toMatchObject({ ok: true });
    a.write('worlds/a.json', '{}'); b.write('worlds/b.json', '{}');
    const match = { method: 'GET', keySuffix: `${a.entry.s3.prefix}/head` };
    const ga = proxy.addFault({ match, once: true, hold: 'after-upstream-response' });
    const gb = proxy.addFault({ match, once: true, hold: 'after-upstream-response' });
    const runs = Promise.all([a.run(), b.run()]);
    try { await Promise.all([ga.reached, gb.reached]); } finally { ga.release(); gb.release(); }
    expect((await runs).every(r => r.ok)).toBe(true);
    expect(proxy.requests.filter(r => r.method === 'PUT' && r.relativeKey === `${a.entry.s3.prefix}/head` && r.upstreamStatus === 412)).toHaveLength(1);
    expect((await head(a)).packs).toHaveLength(3);
    expect(await a.run()).toMatchObject({ ok: true }); expect(await b.run()).toMatchObject({ ok: true });
    expect(a.read('worlds/b.json')).toBe('{}'); expect(b.read('worlds/a.json')).toBe('{}');
});
test.each([false, true])('lost successful head response recovers once without resend; recovery failure=%s', async failedRead => {
    const a = await device(); a.write('worlds/one.json', '{}');
    const suffix = `${a.entry.s3.prefix}/head`;
    proxy.addFault({ match: { method: 'PUT', keySuffix: suffix }, once: true, dropResponseAfterUpstreamSuccess: true });
    if (failedRead) proxy.addFault({ match: { method: 'GET', keySuffix: suffix, attempt: 2 }, once: true, dropResponseAfterUpstreamSuccess: true });
    expect(await a.run()).toMatchObject(failedRead ? { ok: false, code: 'UNREACHABLE' } : { ok: true, outcome: { pushed: true } });
    expect(proxy.requests.filter(r => r.relativeKey === suffix).map(r => r.method)).toEqual(['GET', 'PUT', 'GET']);
    expect(await a.run()).toMatchObject({ ok: true, outcome: { pushed: false } });
});
test.each(['invalid', 'wrong-key', 'invalid-id', 'changed-id'])('stored %s fails without publication or KDF', async kind => {
    const a = await device(); a.write('worlds/one.json', '{}');
    const entry = structuredClone(a.entry);
    if (kind === 'invalid-id') entry.s3.keyId = 'INVALID';
    else if (kind === 'changed-id') entry.s3.keyId = randomBytes(8).toString('hex');
    else entry.s3.derivedKey = kind === 'invalid' ? 'invalid' : randomBytes(32).toString('base64');
    const before = proxy.requests.length;
    await expect(syncService.withBackendOperation(a.owner, a.id, 'drive', async lease => {
        let backend;
        try { backend = new S3Backend({ id: a.id, owner: a.owner, entry, lease }); await backend.readHead(); }
        finally { await backend?.close(); }
    })).rejects.toMatchObject({ code: kind === 'invalid-id' ? 'S3_LOCAL_KEY_ID_INVALID' : kind === 'changed-id' ? 'S3_KEY_MISMATCH' : kind === 'invalid' ? 'S3_STORED_KEY_INVALID' : 'S3_STORED_KEY_REJECTED' });
    expect(proxy.requests.slice(before).some(r => r.method === 'PUT')).toBe(false);
});
test('pack quarantine runs before snapshot and repairs published main without losing live edits', async () => {
    const a = await device(); a.write('worlds/one.json', '{}'); expect(await a.run()).toMatchObject({ ok: true });
    const b = await device(a.entry.s3); expect(await b.run()).toMatchObject({ ok: true });
    const packdir = path.join(b.shadow.gitDir, 'objects/pack');
    const index = fs.readdirSync(packdir).find(n => n.endsWith('.idx'));
    fs.writeFileSync(path.join(packdir, index), 'broken index');
    b.write('worlds/local.json', '{"local":true}');
    expect(await b.run()).toMatchObject({ ok: true });
    expect(b.read('worlds/local.json')).toBe('{"local":true}');
    expect((await head(b)).packs).toHaveLength(2);
    expect(fs.readdirSync(b.shadow.peerDir).some(n => n.startsWith('.s3-invalid-'))).toBe(true);
});
test('unpublished incomplete main fails before snapshot and preserves refs and live data', async () => {
    const a = await device(); a.write('worlds/one.json', '{}'); expect(await a.run()).toMatchObject({ ok: true });
    const missing = 'd'.repeat(40);
    await git.writeRef({ fs: atomicFs, gitdir: a.shadow.gitDir, ref: 'refs/heads/main', value: missing, force: true });
    a.write('worlds/local.json', 'unpublished live');
    expect(await a.run()).toMatchObject({ ok: false, code: 'S3_INCOMPLETE_OBJECTS' });
    expect(await git.resolveRef({ fs: atomicFs, gitdir: a.shadow.gitDir, ref: 'refs/heads/main' })).toBe(missing);
    expect(a.read('worlds/local.json')).toBe('unpublished live');
    expect((await readRegistry({ userRoot: a.userRoot })).backends[a.id].lastSync.error.code).toBe('S3_INCOMPLETE_OBJECTS');
});
test('head response loss with a subsequent writer is conflict, not success by commit alone', async () => {
    const a = await device(); a.write('worlds/base.json', '{}'); expect(await a.run()).toMatchObject({ ok: true });
    const b = await device(a.entry.s3); expect(await b.run()).toMatchObject({ ok: true });
    a.write('worlds/a.json', '{}'); b.write('worlds/b.json', '{}');
    const suffix = `${a.entry.s3.prefix}/head`;
    const fault = proxy.addFault({ match: { method: 'PUT', keySuffix: suffix }, once: true, hold: 'after-upstream-response', dropResponseAfterUpstreamSuccess: true });
    const first = a.admitted(async (backend, lease) => runSyncCycle({ ...await lease.context(), backend }));
    try {
        expect((await fault.reached).upstreamStatus).toBe(200);
        expect(await b.run()).toMatchObject({ ok: true });
    } finally { fault.release(); }
    expect(await first).toMatchObject({ status: 'rerun', reason: 'remote-moved', pushed: false });
    expect(await a.run()).toMatchObject({ ok: true });
    expect(a.read('worlds/b.json')).toBe('{}');
});
test('fetch and staging stay bound to the quoted ETag observation; caller mutation and stale CAS cannot publish', async () => {
    const a = await device(); a.write('worlds/base.json', '{}'); expect(await a.run()).toMatchObject({ ok: true });
    await a.admitted(async backend => {
        const observed = await backend.readHead();
        expect(observed.etag).toMatch(/^".*"$/);
        expect(Object.isFrozen(observed)).toBe(true);
        const before = proxy.requests.length;
        await backend.fetchInto([observed.oid], []);
        expect(proxy.requests.slice(before).filter(r => r.relativeKey.endsWith('/head'))).toEqual([]);
        await backend.pushObjects(observed.oid, observed.oid);
        await expect(backend.casHead('"different"', observed.oid)).rejects.toMatchObject({ code: 'S3_HEAD_INVALID' });
        expect(proxy.requests.slice(before).filter(r => r.method === 'PUT')).toEqual([]);
    });
});
test('lost response does not accept a differently encoded decrypted payload with the same commit and packs', async () => {
    const a = await device(); a.write('worlds/base.json', '{}'); expect(await a.run()).toMatchObject({ ok: true });
    a.write('worlds/a.json', '{}');
    const fault = proxy.addFault({ match: { method: 'PUT', keySuffix: `${a.entry.s3.prefix}/head` }, once: true, hold: 'after-upstream-response', dropResponseAfterUpstreamSuccess: true });
    const first = a.admitted(async (backend, lease) => runSyncCycle({ ...await lease.context(), backend }));
    try {
        await fault.reached;
        const published = await head(a);
        const transport = createS3Client({ owner: a.owner, settings: a.entry.s3 });
        try {
            const bytes = encryptObject({ key: Buffer.from(a.entry.s3.derivedKey, 'base64'), keyId: a.entry.s3.keyId, context: a.entry.s3, domain: 'head', relativeKey: 'head', plaintext: Buffer.from(JSON.stringify(published, null, 2)) });
            await transport.put('head', bytes, { contentLength: bytes.length });
        } finally { await transport.close(); }
    } finally { fault.release(); }
    expect(await first).toMatchObject({ status: 'rerun', reason: 'remote-moved', pushed: false });
});
test('local mutation repairs a quarantined published main within admission before snapshotting live edits', async () => {
    const a = await device(); a.write('worlds/base.json', '{}'); expect(await a.run()).toMatchObject({ ok: true });
    const b = await device(a.entry.s3); expect(await b.run()).toMatchObject({ ok: true });
    const packdir = path.join(b.shadow.gitDir, 'objects/pack');
    fs.writeFileSync(path.join(packdir, fs.readdirSync(packdir).find(n => n.endsWith('.idx'))), 'damaged');
    b.write('worlds/local.json', 'unpublished edit');
    const result = await commitLocalEdit(await syncService.contextFor(b.owner, b.id), async ({ files }) => ({ files, message: 'local mutation after repair' }));
    expect(result.committed).toBe(true);
    expect(b.read('worlds/local.json')).toBe('unpublished edit');
    expect(fs.readdirSync(b.shadow.peerDir).some(n => n.startsWith('.s3-invalid-'))).toBe(true);
});
test('maintenance drains the whole admitted transfer and a later cycle captures edited settings', async () => {
    const a = await device(); a.write('worlds/base.json', '{}'); expect(await a.run()).toMatchObject({ ok: true });
    a.write('worlds/local.json', 'edit');
    const gate = proxy.addFault({ match: { method: 'PUT', keySuffix: undefined }, once: true, hold: 'after-upstream-response' });
    const run = a.run(); await gate.reached;
    let entered = false;
    const maintenance = syncService.withBackendMaintenance(a.owner, a.id, (_registry, commit) => {
        entered = true;
        return patchS3BackendEntry({ userRoot: a.userRoot, backendId: a.id, expectedS3: a.entry.s3, s3Patch: { endpoint: storage.endpoint }, assertAlive: commit.assertAlive });
    });
    try {
        await syncService.withShadowLock(a.userRoot, a.id, async () => { expect(entered).toBe(false); });
    } finally { gate.release(); }
    expect(await run).toMatchObject({ ok: true }); await maintenance;
    const before = proxy.requests.length;
    expect(await a.run()).toMatchObject({ ok: true }); expect(proxy.requests).toHaveLength(before);
});
test('removal during pack upload drains the counted request then deletes stage and shadow without recreation', async () => {
    const a = await device(); a.write('worlds/base.json', '{}'); expect(await a.run()).toMatchObject({ ok: true });
    a.write('worlds/local.json', 'edit');
    const gate = proxy.addFault({ match: { method: 'PUT', keySuffix: undefined }, once: true, hold: 'after-upstream-response' });
    const run = a.run(); await gate.reached;
    const removal = syncService.removeBackend(a.owner, a.id);
    try { await until(() => syncService.isRemoving(a.userRoot, a.id)); }
    finally { gate.release(); }
    expect(await run).toMatchObject({ ok: false, code: 'UNKNOWN_BACKEND' }); await removal;
    expect(fs.existsSync(a.shadow.peerDir)).toBe(false);
    expect((await readRegistry({ userRoot: a.userRoot })).backends[a.id]).toBeUndefined();
});
test.each(['tuple', 'identity', 'malformed'])('cycle validates remote keyinfo %s before any head read or publication', async kind => {
    const a = await device();
    const transport = createS3Client({ owner: a.owner, settings: a.entry.s3 });
    try {
        const original = await transport.get('keyinfo.json'); const info = JSON.parse(await original.body.transformToString());
        const value = kind === 'tuple' ? { ...info, N: 2 } : kind === 'identity' ? { ...info, keyId: '0'.repeat(16) } : { ...info, verifier: 'invalid' };
        const bytes = Buffer.from(JSON.stringify(value)); await transport.put('keyinfo.json', bytes, { contentLength: bytes.length });
    } finally { await transport.close(); }
    const before = proxy.requests.length;
    await expect(a.admitted(backend => backend.readHead())).rejects.toMatchObject({ code: kind === 'tuple' ? 'S3_FORMAT_UNSUPPORTED' : 'S3_KEYINFO_INVALID' });
    expect(proxy.requests.slice(before).map(r => r.method)).toEqual(['GET']);
});
test('actual immutable pack collision fails without overwriting the remote orphan or publishing head', async () => {
    const a = await device(); a.write('worlds/base.json', '{}'); expect(await a.run()).toMatchObject({ ok: true });
    const original = await head(a);
    a.write('worlds/local.json', 'edit');
    const gate = proxy.addFault({ match: { method: 'PUT' }, once: true, hold: 'before-forward' });
    const run = a.run();
    const record = await gate.reached;
    const transport = createS3Client({ owner: a.owner, settings: { ...a.entry.s3, endpoint: storage.endpoint } });
    const key = record.relativeKey.slice(a.entry.s3.prefix.length + 1);
    try {
        expect(key).toMatch(/^packs\/[a-f0-9]{32}$/);
        await transport.put(key, Buffer.from('retain orphan'), { contentLength: 13, ifNoneMatch: '*' });
    } finally { gate.release(); }
    try {
        expect(await run).toMatchObject({ ok: false, code: 'PRECONDITION_FAILED' });
        const orphan = await transport.get(key); expect(await orphan.body.transformToString()).toBe('retain orphan');
        expect(await head(a)).toEqual(original);
    } finally { await transport.close(); }
});
