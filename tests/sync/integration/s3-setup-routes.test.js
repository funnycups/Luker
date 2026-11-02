import { beforeAll, afterAll, afterEach, expect, test } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { startRustfsContainer } from '../../e2e/_lib/s3-container.js';
import { startS3Proxy } from '../../e2e/_lib/s3-proxy.js';
import { startLanDevice, pair } from '../_lib/lan-devices.js';
import { readRegistry, patchS3BackendEntry } from '../../../src/sync/state.js';
import { syncService } from '../../../src/sync/sync-service.js';
import fs from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';
import { getShadowPaths } from '../../../src/sync/shadow.js';
import { commitLocalEdit, readUndoPoint } from '../../../src/sync/pipeline/cycle.js';
import { CONFLICTS_PATH, writeEntries } from '../../../src/sync/pipeline/conflict-records.js';
import { atomicFs } from '../../../src/sync/pipeline/atomic-fs.js';
import { upsertLanBackend } from '../../../src/sync/state.js';
import { syncResponse } from '../../../src/endpoints/sync-backends.js';
import { until } from '../_lib/until.js';
import { PAUSEPOINTS } from '../../../src/sync/pipeline/failpoints.js';
import express from 'express';
import request from 'supertest';
import { createSyncRouter } from '../../../src/endpoints/sync.js';
import { readCommitFiles } from '../../../src/sync/pipeline/git-tree.js';
import { reviewedChoice } from '../_lib/conflict-choices.js';

let storage, admin, proxy, base;
const devices = [];
beforeAll(async () => {
    storage = await startRustfsContainer();
    const credentials = { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey };
    admin = new S3Client({ endpoint: storage.endpoint, region: storage.region, credentials, forcePathStyle: true, maxAttempts: 1 });
    const bucket = `routes-${randomBytes(8).toString('hex')}`; await admin.send(new CreateBucketCommand({ Bucket: bucket }));
    proxy = await startS3Proxy({ upstream: storage.endpoint, credentials, region: storage.region });
    base = { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey, endpoint: proxy.endpoint, bucket, region: storage.region, forcePathStyle: true };
}, 240_000);
afterEach(async () => { for (const d of devices.splice(0)) { const registry = await readRegistry({ userRoot: d.userRoot }); for (const id of Object.keys(registry.backends)) await syncService.removeBackend(d.owner, id); await d.close(); } });
afterAll(async () => { await proxy?.close(); admin?.destroy(); await storage?.stop(); });
const phrase = 'route private phrase';
async function device() { const d = await startLanDevice(); devices.push(d); return d; }
const input = () => ({ label: 'Encrypted hub', categories: ['worlds'], passphrase: phrase, s3: { ...base, prefix: randomBytes(16).toString('hex') } });
test('all S3 setup and device routes require browser authentication before network', async () => {
    const app = express(); app.use('/api/sync/v1', createSyncRouter());
    const before = proxy.requests.length;
    for (const route of ['/backends/s3', '/backends/s3-test/s3', '/backends/s3-test/unlock', '/device']) {
        expect((await request(app).post(`/api/sync/v1${route}`).send(input())).status).toBe(401);
    }
    expect(proxy.requests).toHaveLength(before);
});
test('authenticated create persists sanitized 201 and starts a genuine background cycle; edit, unlock and device return 200', async () => {
    const d = await device(); d.write('worlds/one.json', '{}');
    const submitted = input();
    const gate = proxy.addFault({ match: { method: 'GET', keySuffix: `${submitted.s3.prefix}/head` }, once: true, hold: 'after-upstream-response' });
    const created = await d.call('POST', '/backends/s3', { body: submitted });
    expect(created).toMatchObject({ status: 201, body: { backendId: expect.stringMatching(/^s3-/), backend: { kind: 's3', label: submitted.label } } });
    const id = created.body.backendId;
    try { await gate.reached; expect((await readRegistry({ userRoot: d.userRoot })).backends[id].kind).toBe('s3'); } finally { gate.release(); }
    expect(await syncService.trigger(d.owner, id, 'manual')).toMatchObject({ ok: true });
    const previous = (await readRegistry({ userRoot: d.userRoot })).backends[id];
    for (const secret of [phrase, base.accessKeyId, base.secretAccessKey, previous.s3.derivedKey]) expect(JSON.stringify(created.body)).not.toContain(secret);
    expect(await d.call('POST', `/backends/${id}/s3`, { body: { label: 'Moved endpoint', s3: { endpoint: storage.endpoint } } })).toMatchObject({ status: 200, body: { backend: { label: 'Moved endpoint' } } });
    expect((await readRegistry({ userRoot: d.userRoot })).backends[id].s3.endpoint).toBe(storage.endpoint);
    expect(await d.call('POST', `/backends/${id}/s3`, { body: { s3: { stripIfMatchQuotes: true } } })).toMatchObject({ status: 200, body: { backend: { s3: { stripIfMatchQuotes: true } } } });
    const current = (await readRegistry({ userRoot: d.userRoot })).backends[id];
    await patchS3BackendEntry({ userRoot: d.userRoot, backendId: id, expectedS3: current.s3, s3Patch: { derivedKey: randomBytes(32).toString('base64') } });
    expect(await d.call('POST', `/backends/${id}/unlock`, { body: { passphrase: 'wrong' } })).toMatchObject({ status: 422, body: { code: 'S3_WRONG_PASSPHRASE' } });
    const unlocked = await d.call('POST', `/backends/${id}/unlock`, { body: { passphrase: phrase } });
    expect(unlocked.status).toBe(200); expect(JSON.stringify(unlocked.body)).not.toContain(previous.s3.derivedKey);
    expect((await readRegistry({ userRoot: d.userRoot })).backends[id].s3.derivedKey).toBe(previous.s3.derivedKey);
    expect(await d.call('POST', '/device', { body: { label: ' Workstation ' } })).toMatchObject({ status: 200, body: { device: { label: 'Workstation' } } });
});
test('namespace changes and generic private field bypasses reject locally with 400 and preserve settings', async () => {
    const d = await device(); const submitted = input();
    const created = await d.call('POST', '/backends/s3', { body: submitted }); expect(created.status).toBe(201);
    const id = created.body.backendId; await syncService.trigger(d.owner, id, 'manual');
    const original = (await readRegistry({ userRoot: d.userRoot })).backends[id].s3;
    const before = proxy.requests.length;
    for (const change of [{ bucket: 'other' }, { prefix: 'other' }]) expect(await d.call('POST', `/backends/${id}/s3`, { body: { s3: change } })).toMatchObject({ status: 400, body: { code: 'S3_SETTINGS_INVALID' } });
    for (const change of [{ kind: 'lan' }, { s3: { bucket: 'other' } }, { derivedKey: 'secret' }, { passphrase: phrase }, { keyId: '0'.repeat(16) }, { accessKeyId: 'secret' }]) expect(await d.call('POST', `/backends/${id}`, { body: change })).toMatchObject({ status: 400 });
    expect(proxy.requests).toHaveLength(before);
    expect((await readRegistry({ userRoot: d.userRoot })).backends[id].s3).toEqual(original);
});
async function create(d, settings = input()) {
    const response = await d.call('POST', '/backends/s3', { body: settings }); expect(response.status).toBe(201);
    await syncService.trigger(d.owner, response.body.backendId, 'manual');
    return response.body.backendId;
}
test('status prepares corrupt unrelated indexes before pending reads even when loose objects mask them', async () => {
    const d = await device(); d.write('worlds/one.json', '{}'); const id = await create(d);
    const paths = getShadowPaths({ userRoot: d.userRoot, peerId: id });
    fs.writeFileSync(path.join(paths.gitDir, 'objects/pack', `pack-${'e'.repeat(40)}.idx`), 'corrupt unrelated index');
    expect(await d.call('GET', '/status')).toMatchObject({ status: 200, body: { ok: true } });
    expect(fs.readdirSync(path.join(paths.gitDir, 'objects/pack')).some(n => n.startsWith(`pack-${'e'.repeat(40)}`))).toBe(false);
    expect(fs.readdirSync(paths.peerDir).some(n => n.startsWith('.s3-invalid-'))).toBe(true);
});
test('S3 malformed pending records retain readable LAN rows and grouped application errors; pending count never becomes zero', async () => {
    const d = await device(); d.write('worlds/one.json', '{}'); const id = await create(d);
    await commitLocalEdit(await syncService.contextFor(d.owner, id), async ({ gitdir, files }) => ({
        files: new Map([...files, [CONFLICTS_PATH, { oid: await git.writeBlob({ fs: atomicFs, gitdir, blob: Buffer.from('{bad') }), mode: '100644' }]]), message: 'corrupt pending metadata fixture',
    }));
    const lan = 'u@0123abcd'; await upsertLanBackend({ userRoot: d.userRoot, backendId: lan, label: 'LAN', categories: ['worlds'] });
    await commitLocalEdit(await syncService.contextFor(d.owner, lan), async ({ gitdir, files }) => {
        const oid = await git.writeBlob({ fs: atomicFs, gitdir, blob: Buffer.from('{}') });
        await writeEntries({ gitdir, files, path: CONFLICTS_PATH, entries: { 'worlds/one.json': { kept: oid, ours: oid, theirs: oid, oursDevice: 'Fixture A', theirsDevice: 'Fixture B', mergeParents: ['a'.repeat(40), 'b'.repeat(40)], createdAt: '2026-10-01T00:00:00.000Z' } } });
        return { files, message: 'readable pending fixture' };
    });
    expect(await d.call('GET', '/status')).toMatchObject({ status: 200, body: { ok: false, conflicts: [{ path: 'worlds/one.json', backends: [lan] }], errors: { [id]: { code: 'PENDING_READ_FAILED' } }, backends: { [id]: { pendingError: { code: 'PENDING_READ_FAILED' } } } } });
    await expect(syncResponse(d.owner, id, { ok: true, conflicts: 0, stalled: null })).rejects.toMatchObject({ code: 'PENDING_READ_FAILED' });
    const [shown] = (await d.call('GET', '/status')).body.conflicts;
    const before = proxy.requests.length;
    expect(await d.call('POST', '/conflicts/resolve', { body: [reviewedChoice(shown, 'current')] })).toMatchObject({ status: 200, body: { ok: false, results: [{ applied: false, committedBackends: [lan], errors: { [id]: { code: 'PENDING_READ_FAILED' } } }] } });
    expect(proxy.requests.slice(before).some(r => r.method === 'PUT')).toBe(false);
});
test('unrepairable S3 pending blob preserves healthy LAN resolution and releases failed preparation leases', async () => {
    const d = await device(), peer = await device();
    d.write('worlds/one.json', '{}'); const id = await create(d);
    const lan = await pair(d, peer, { categories: ['worlds'] });
    const addRecord = async backendId => commitLocalEdit(await syncService.contextFor(d.owner, backendId), async ({ gitdir, files }) => {
        const oid = await git.writeBlob({ fs: atomicFs, gitdir, blob: Buffer.from('{}') });
        await writeEntries({ gitdir, files, path: CONFLICTS_PATH, entries: { 'worlds/one.json': { kept: oid, ours: oid, theirs: oid, oursDevice: 'A', theirsDevice: 'B', mergeParents: [], createdAt: '2026-10-15T00:00:00.000Z' } } });
        return { files, message: 'unpublished pending fixture' };
    });
    await addRecord(id); await addRecord(lan);
    expect(await d.call('POST', `/backends/${lan}/sync`)).toMatchObject({ status: 200 });
    await until(async () => (await peer.call('GET', '/status')).body.conflicts.length === 1);
    await until(() => d.idle() && peer.idle());
    const paths = getShadowPaths({ userRoot: d.userRoot, peerId: id });
    const main = await git.resolveRef({ fs: atomicFs, gitdir: paths.gitDir, ref: 'refs/heads/main' });
    const metadata = (await readCommitFiles({ gitdir: paths.gitDir, commitOid: main })).get(CONFLICTS_PATH).oid;
    fs.unlinkSync(path.join(paths.gitDir, 'objects', metadata.slice(0, 2), metadata.slice(2)));
    const [shown] = (await d.call('GET', '/status')).body.conflicts;
    const before = proxy.requests.length;
    expect(await d.call('POST', '/conflicts/resolve', { body: [reviewedChoice(shown, 'current')] })).toMatchObject({ status: 200, body: { ok: false, errors: { [id]: { code: 'PENDING_READ_FAILED' } }, results: [{ applied: false, committedBackends: [lan], errors: { [id]: { code: 'PENDING_READ_FAILED' } } }] } });
    await until(() => d.idle() && peer.idle());
    expect(proxy.requests.slice(before).filter(r => r.relativeKey.endsWith('/head') && r.method === 'PUT')).toEqual([]);
    expect(proxy.requests.slice(before).filter(r => r.relativeKey.endsWith('/keyinfo.json'))).toHaveLength(1);
    expect(await git.resolveRef({ fs: atomicFs, gitdir: paths.gitDir, ref: 'refs/heads/main' })).toBe(main);
    expect(fs.existsSync(path.join(paths.gitDir, 'objects', metadata.slice(0, 2), metadata.slice(2)))).toBe(false);
    expect(d.read('worlds/one.json')).toBe('{}');
    await until(async () => (await peer.call('GET', '/status')).body.conflicts.length === 0);
    expect((await d.call('GET', '/status')).body.conflicts).toEqual([]);
    const undo = await d.call('POST', `/backends/${id}/undo`);
    expect(undo).toMatchObject({ status: 409, body: { code: 'S3_INCOMPLETE_OBJECTS' } });
    let entered = false;
    await syncService.withBackendMaintenance(d.owner, id, async () => { entered = true; });
    expect(entered).toBe(true);
    await syncService.removeBackend(d.owner, id);
    expect(fs.existsSync(paths.peerDir)).toBe(false);
});
test.each([true, false])('S3 undo distinguishes uncommitted obstruction and committed offline propagation; obstruction=%s', async blocked => {
    const source = await device(); source.write('worlds/d/x.json', 'before'); const settings = input(); const sourceId = await create(source, settings);
    const target = await device(); const targetId = await create(target, settings);
    if (blocked) fs.unlinkSync(path.join(source.userRoot, 'worlds/d/x.json')); else source.write('worlds/d/x.json', 'after');
    expect(await source.call('POST', `/backends/${sourceId}/sync`)).toMatchObject({ status: 200 });
    expect(await target.call('POST', `/backends/${targetId}/sync`)).toMatchObject({ status: 200 });
    const gitdir = getShadowPaths({ userRoot: target.userRoot, peerId: targetId }).gitDir;
    const point = await readUndoPoint(gitdir); expect(point).not.toBeNull();
    if (blocked) { if (fs.existsSync(path.join(target.userRoot, 'worlds/d'))) fs.rmdirSync(path.join(target.userRoot, 'worlds/d')); target.write('worlds/d', 'obstruction'); }
    else proxy.addFault({ match: { method: 'GET', keySuffix: `${settings.s3.prefix}/keyinfo.json` }, once: true, dropResponseAfterUpstreamSuccess: true });
    const before = proxy.requests.length;
    const result = await target.call('POST', `/backends/${targetId}/undo`);
    expect(result).toMatchObject(blocked ? { status: 409, body: { ok: false, committed: false, code: 'UNDO_NOT_COMMITTED', propagation: null } } : { status: 502, body: { ok: false, committed: true, reverted: ['worlds/d/x.json'], propagation: { ok: false, code: 'UNREACHABLE' } } });
    expect(result.body).not.toHaveProperty('reconcile');
    expect(await readUndoPoint(gitdir)).toEqual(blocked ? point : null);
    expect(proxy.requests.slice(before).filter(r => r.method === 'PUT' && r.relativeKey.endsWith('/head'))).toEqual([]);
    expect(target.read(blocked ? 'worlds/d' : 'worlds/d/x.json')).toBe(blocked ? 'obstruction' : 'before');
});
test('real LAN and S3 conflicts group immutable commit identities and reject a replaced record admitted before local locks', async () => {
    const a = await device(), b = await device();
    await a.call('POST', '/device', { body: { label: 'Writer A' } });
    await b.call('POST', '/device', { body: { label: 'Writer B' } });
    a.write('worlds/w.json', 'base');
    const settings = input(); const aid = await create(a, settings), bid = await create(b, settings);
    const lan = await pair(a, b, { categories: ['worlds'] });
    a.write('worlds/w.json', 'A edit'); b.write('worlds/w.json', 'B edit');
    expect(await a.call('POST', `/backends/${aid}/sync`)).toMatchObject({ status: 200 });
    expect(await b.call('POST', `/backends/${bid}/sync`)).toMatchObject({ status: 200 });
    expect(await b.call('POST', `/backends/${lan}/sync`)).toMatchObject({ status: 200 });
    await until(() => a.idle() && b.idle());
    const status = await b.call('GET', '/status');
    const row = status.body.conflicts.find(c => c.path === 'worlds/w.json');
    expect(row.backends.sort()).toEqual([bid, lan].sort());
    expect([row.oursDevice, row.theirsDevice].sort()).toEqual(['Writer A', 'Writer B']);
    const pause = path.join(b.userRoot, 'choice-barrier'); fs.mkdirSync(pause);
    const oldPoint = process.env.LUKER_SYNC_PAUSEPOINT, oldDir = process.env.LUKER_SYNC_PAUSE_DIR;
    process.env.LUKER_SYNC_PAUSEPOINT = PAUSEPOINTS.CONFLICT_CHOICES_AFTER_READ;
    process.env.LUKER_SYNC_PAUSE_DIR = pause;
    fs.writeFileSync(path.join(pause, `${PAUSEPOINTS.CONFLICT_CHOICES_AFTER_READ}.arm`), '');
    const resolving = b.call('POST', '/conflicts/resolve', { body: [reviewedChoice(row, 'current')] });
    try {
        await until(() => fs.existsSync(path.join(pause, `${PAUSEPOINTS.CONFLICT_CHOICES_AFTER_READ}.reached`)));
        await commitLocalEdit(await syncService.contextFor(b.owner, bid), async ({ gitdir, files }) => {
            await writeEntries({ gitdir, files, path: CONFLICTS_PATH, entries: { [row.path]: { kept: row.current, ours: row.ours, theirs: row.theirs, oursDevice: 'Replacement', theirsDevice: 'Replacement', mergeParents: [], createdAt: '2026-10-15T00:00:00.000Z' } } });
            return { files, message: 'replace admitted record fixture' };
        });
    } finally {
        fs.writeFileSync(path.join(pause, `${PAUSEPOINTS.CONFLICT_CHOICES_AFTER_READ}.release`), '');
    }
    try {
        expect(await resolving).toMatchObject({ status: 200, body: { ok: true, results: [{ applied: false, committedBackends: [lan] }] } });
        expect((await b.call('GET', '/status')).body.conflicts.find(c => c.backends.includes(bid)).oursDevice).toBe('Replacement');
    } finally {
        if (oldPoint === undefined) delete process.env.LUKER_SYNC_PAUSEPOINT; else process.env.LUKER_SYNC_PAUSEPOINT = oldPoint;
        if (oldDir === undefined) delete process.env.LUKER_SYNC_PAUSE_DIR; else process.env.LUKER_SYNC_PAUSE_DIR = oldDir;
    }
});
