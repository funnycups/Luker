import { beforeAll, afterAll, afterEach, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import git from 'isomorphic-git';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { startRustfsContainer } from '../../e2e/_lib/s3-container.js';
import { startS3Proxy } from '../../e2e/_lib/s3-proxy.js';
import { startLanDevice } from '../_lib/lan-devices.js';
import { until } from '../_lib/until.js';
import { syncService as s } from '../../../src/sync/sync-service.js';
import { prepareS3Backend, prepareS3Unlock } from '../../../src/sync/backends/s3/setup.js';
import { createS3BackendEntry, patchS3BackendEntry, readRegistry, setBackendSettings, setSchedule, recordLastSync } from '../../../src/sync/state.js';
import { getShadowPaths } from '../../../src/sync/shadow.js';
import { commitLocalEdit, readUndoPoint } from '../../../src/sync/pipeline/cycle.js';
import { S3Backend } from '../../../src/sync/backends/s3/backend.js';
import { readIndexedPacks } from '../../../src/sync/backends/s3/packs.js';
import { atomicFs } from '../../../src/sync/pipeline/atomic-fs.js';
import { readCommitFiles, readBlobBytes } from '../../../src/sync/pipeline/git-tree.js';
import { reviewedChoice } from '../_lib/conflict-choices.js';

let storage, admin, proxy, replacementProxy, base;
const devices = [], gates = [], releases = [];
const phrase = 'maintenance lifetime private phrase';
const barrier = () => {
    let enter, release;
    const result = { reached: new Promise(r => { enter = r; }), released: new Promise(r => { release = r; }), enter: () => enter(), release: () => release() };
    releases.push(result.release); return result;
};
const hold = (d, method, suffix) => {
    const gate = proxy.addFault({ match: { method, keySuffix: `${d.entry.s3.prefix}/${suffix}` }, once: true, hold: 'after-upstream-response' });
    gates.push(gate); return gate;
};
const entry = async d => (await readRegistry({ userRoot: d.userRoot })).backends[d.id];
const previous = async d => ({ ...await entry(d), backendId: d.id });
async function device(s3, categories = ['worlds']) {
    const d = await startLanDevice(); devices.push(d);
    d.id = `s3-${randomBytes(16).toString('hex')}`;
    s3 ??= (await prepareS3Backend({ owner: d.owner, input: { ...base, prefix: randomBytes(16).toString('hex'), passphrase: phrase } })).s3;
    d.entry = await createS3BackendEntry({ userRoot: d.userRoot, backendId: d.id, label: 'Storage', categories, s3 });
    d.shadow = getShadowPaths({ userRoot: d.userRoot, peerId: d.id });
    d.run = () => s.trigger(d.owner, d.id, 'manual');
    return d;
}
beforeAll(async () => {
    storage = await startRustfsContainer();
    const credentials = { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey };
    admin = new S3Client({ endpoint: storage.endpoint, region: storage.region, credentials, forcePathStyle: true, maxAttempts: 1 });
    const bucket = `lifetime-${randomBytes(8).toString('hex')}`;
    await admin.send(new CreateBucketCommand({ Bucket: bucket }));
    proxy = await startS3Proxy({ upstream: storage.endpoint, credentials, region: storage.region });
    replacementProxy = await startS3Proxy({ upstream: storage.endpoint, credentials, region: storage.region });
    base = { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey, endpoint: proxy.endpoint, bucket, region: storage.region, forcePathStyle: true };
    // Budget includes a cold pull of the pinned real storage image.
}, 240_000);
afterEach(async () => {
    for (const release of releases.splice(0)) release();
    for (const gate of gates.splice(0)) gate.release();
    for (const d of devices.splice(0)) await d.close();
});
afterAll(async () => { await proxy?.close(); await replacementProxy?.close(); admin?.destroy(); await storage?.stop(); });

test.each(['GET', 'PUT'])('category acknowledgement drains an admitted %s and subsequent drives never apply the disabled selection', async method => {
    const source = await device(); source.write('worlds/remote.json', 'initial'); expect(await source.run()).toMatchObject({ ok: true });
    const d = await device(source.entry.s3); expect(await d.run()).toMatchObject({ ok: true });
    source.write('worlds/remote.json', 'old admitted selection'); expect(await source.run()).toMatchObject({ ok: true });
    if (method === 'PUT') d.write('worlds/local.json', 'publish before acknowledgement');
    // PUT deliberately captures an immutable pack, not keyinfo/probe traffic.
    const gate = method === 'GET' ? hold(d, 'GET', 'head') : proxy.addFault({ match: { method: 'PUT', keySuffix: undefined }, once: true, hold: 'after-upstream-response' });
    if (method === 'PUT') gates.push(gate);
    const run = d.run(); const request = await gate.reached;
    expect(request.upstreamStatus).toBe(200);
    expect(request.relativeKey).toMatch(method === 'PUT' ? /\/packs\// : /\/head$/);
    let responseAt = null;
    const settings = d.call('POST', `/backends/${d.id}`, { body: { categories: ['themes'] } }).then(result => { responseAt = process.hrtime.bigint(); return result; });
    await until(() => d.requests.includes(`POST /api/sync/v1/backends/${d.id}`));
    // The shadow and registry remain usable while the transport owns admission.
    await s.withShadowLock(d.userRoot, d.id, async () => { expect(responseAt).toBeNull(); });
    expect((await d.call('POST', '/schedule', { body: { idleSeconds: 3600, pollSeconds: 3600 } })).status).toBe(200);
    expect(responseAt).toBeNull();
    gate.release(); expect(await run).toMatchObject({ ok: true });
    expect(await settings).toMatchObject({ status: 200, body: { backend: { categories: ['themes'] } } });
    // The old admitted cycle may apply before the response; it is not retroactively disabled.
    expect(d.read('worlds/remote.json')).toBe('old admitted selection');
    const acknowledged = d.read('worlds/remote.json');
    const liveWrites = [];
    let observedWrite;
    const writeObserved = new Promise(resolve => { observedWrite = resolve; });
    const watcher = fs.watch(path.join(d.userRoot, 'worlds'), (_event, filename) => {
        if (filename === 'remote.json') {
            liveWrites.push({ at: process.hrtime.bigint(), bytes: d.read('worlds/remote.json') }); observedWrite();
        }
    });
    d.write('worlds/remote.json', 'disabled live edit');
    try {
        source.write('worlds/later.json', 'remote after acknowledgement'); expect(await source.run()).toMatchObject({ ok: true });
        expect(await d.run()).toMatchObject({ ok: true });
        expect(d.read('worlds/remote.json')).toBe('disabled live edit'); expect(d.read('worlds/later.json')).toBeNull();
        await writeObserved;
        expect(liveWrites.length).toBeGreaterThan(0);
        expect(liveWrites.every(write => write.at > responseAt && write.bytes === 'disabled live edit')).toBe(true);
    } finally { watcher.close(); }
    expect(acknowledged).toBe('old admitted selection'); expect(responseAt).not.toBeNull();
    expect((await d.call('POST', `/backends/${d.id}`, { body: { categories: ['worlds'] } })).status).toBe(200);
    expect(await d.run()).toMatchObject({ ok: true });
    expect(d.read('worlds/later.json')).toBe('remote after acknowledgement');
    expect(d.read('worlds/remote.json')).toBe('disabled live edit');
});

test.each(['edit', 'unlock'])('%s maintenance drains a real GET while manual, poll and local routes resume with fresh contexts', async kind => {
    const d = await device(); d.write('worlds/base.json', 'base'); expect(await d.run()).toMatchObject({ ok: true });
    const gate = hold(d, 'GET', 'head'); const active = d.run(); await gate.reached;
    const prepared = kind === 'edit'
        ? await prepareS3Backend({ owner: d.owner, previous: await previous(d), input: { endpoint: replacementProxy.endpoint } })
        : await prepareS3Unlock({ owner: d.owner, previous: await previous(d), passphrase: phrase });
    const entered = barrier(); let acknowledged = false;
    const control = s.withBackendMaintenance(d.owner, d.id, async (_registry, commit) => {
        await patchS3BackendEntry({ userRoot: d.userRoot, backendId: d.id, expectedS3: prepared.expectedS3, s3Patch: kind === 'edit' ? prepared.s3 : { derivedKey: prepared.derivedKey }, categories: ['themes'], assertAlive: commit.assertAlive });
        entered.enter(); await entered.released; acknowledged = true;
    });
    const manual = s.trigger(d.owner, d.id, 'manual');
    const poll = s.trigger(d.owner, d.id, 'poll', { waitForResult: false });
    let localEntered = false;
    const local = s.withLocalMutationContexts(d.owner, [d.id], async contexts => {
        expect(acknowledged).toBe(true); expect(contexts.get(d.id).categories).toEqual(['themes']);
        localEntered = true; await commitLocalEdit(contexts.get(d.id), async () => null);
    });
    let settled = 0;
    const routes = [
        d.call('POST', '/conflicts/resolve', { body: [{ path: 'worlds/absent.json', choice: 'current', review: { backendId: d.id, selectedOid: null, recordVersions: { [d.id]: 'a'.repeat(40) }, currentVersions: { [d.id]: null } } }] }),
        d.call('POST', '/notices/dismiss', { body: { paths: ['worlds/absent.json'] } }),
        d.call('POST', `/backends/${d.id}/undo`),
    ].map(p => p.then(result => { settled++; return result; }));
    await until(() => d.requests.includes(`POST /api/sync/v1/backends/${d.id}/undo`));
    expect(localEntered).toBe(false); expect(settled).toBe(0);
    gate.release(); expect(await active).toMatchObject({ ok: true }); await entered.reached;
    expect(localEntered).toBe(false); expect(settled).toBe(0);
    const before = proxy.requests.length;
    const replacementBefore = replacementProxy.requests.length;
    entered.release(); await control; expect(await manual).toMatchObject({ ok: true }); expect(await poll).toBeNull(); await local;
    const results = await Promise.all(routes);
    expect(results[0]).toMatchObject({ status: 200, body: { ok: true, results: [{ applied: false, committedBackends: [] }] } });
    expect(results[1]).toMatchObject({ status: 200, body: { ok: true, results: [{ backends: [] }] } });
    expect(results[2]).toMatchObject({ status: 404, body: { code: 'NO_BACKUP_TAG' } });
    // Both endpoints forward to genuine storage; observe the fresh drive positively.
    expect(proxy.requests.slice(before).filter(r => r.relativeKey.endsWith('/head'))).toHaveLength(kind === 'edit' ? 0 : 1);
    expect(replacementProxy.requests.slice(replacementBefore).filter(r => r.relativeKey.endsWith('/head'))).toHaveLength(kind === 'edit' ? 1 : 0);
});

test.each(['resolve', 'dismiss', 'undo'])('actionable queued %s commits after GET and maintenance without snapshotting disabled live edits', async operation => {
    const categories = ['worlds', 'chats', 'themes'];
    const source = await device(undefined, categories);
    const chat = 'chats/Seraphina/c.jsonl';
    const chatBytes = text => `${JSON.stringify({ user_name: 'U', character_name: 'Seraphina', chat_metadata: {} })}\n${JSON.stringify({ name: 'Seraphina', is_user: false, mes: text })}\n`;
    source.write('worlds/action.json', 'before'); source.write('themes/disabled.css', 'before');
    source.write(chat, chatBytes('before'));
    expect(await source.run()).toMatchObject({ ok: true });
    const d = await device(source.entry.s3, categories); expect(await d.run()).toMatchObject({ ok: true });
    source.write('worlds/action.json', 'remote after');
    source.write(chat, chatBytes('remote after'));
    if (operation === 'resolve') d.write('worlds/action.json', 'local after');
    if (operation === 'dismiss') fs.unlinkSync(path.join(d.userRoot, chat));
    expect(await source.run()).toMatchObject({ ok: true }); expect(await d.run()).toMatchObject({ ok: true });
    const pending = (await d.call('GET', '/status')).body;
    const point = await readUndoPoint(d.shadow.gitDir);
    const headBefore = await git.resolveRef({ fs: atomicFs, gitdir: d.shadow.gitDir, ref: 'refs/heads/main' });
    const filesBefore = await readCommitFiles({ gitdir: d.shadow.gitDir, commitOid: headBefore });
    let route, body, target, chosenBytes, fixtureState, expectedFixture;
    if (operation === 'resolve') {
        const conflict = pending.conflicts.find(row => row.path === 'worlds/action.json');
        const live = d.read(conflict.path);
        const ours = (await readBlobBytes({ gitdir: d.shadow.gitDir, oid: conflict.ours })).toString();
        const choice = ours === live ? 'theirs' : 'ours';
        chosenBytes = (await readBlobBytes({ gitdir: d.shadow.gitDir, oid: conflict[choice] })).toString();
        fixtureState = chosenBytes !== live; expectedFixture = true;
        target = conflict.path; route = '/conflicts/resolve'; body = [reviewedChoice(conflict, choice)];
    } else if (operation === 'dismiss') {
        fixtureState = pending.notices.map(({ path, kind }) => ({ path, kind })); expectedFixture = [{ path: chat, kind: 'restored' }];
        target = chat; chosenBytes = d.read(chat); route = '/notices/dismiss'; body = { paths: [chat] };
    } else {
        fixtureState = { hasPoint: Boolean(point), live: d.read('worlds/action.json') }; expectedFixture = { hasPoint: true, live: 'remote after' };
        target = 'worlds/action.json'; chosenBytes = 'before'; route = `/backends/${d.id}/undo`;
    }
    expect(fixtureState).toEqual(expectedFixture);
    const gate = hold(d, 'GET', 'head'); const active = d.run(); await gate.reached;
    const entered = barrier(); let acknowledged = false;
    const prepared = await prepareS3Unlock({ owner: d.owner, previous: await previous(d), passphrase: phrase });
    const maintenance = s.withBackendMaintenance(d.owner, d.id, async (_registry, commit) => {
        await patchS3BackendEntry({ userRoot: d.userRoot, backendId: d.id, expectedS3: prepared.expectedS3, s3Patch: { derivedKey: prepared.derivedKey }, categories: ['worlds', 'chats'], assertAlive: commit.assertAlive });
        entered.enter(); await entered.released; acknowledged = true;
    });
    let settled = false;
    const action = d.call('POST', route, { body }).then(result => { settled = true; expect(acknowledged).toBe(true); return result; });
    await until(() => d.requests.includes(`POST /api/sync/v1${route}`));
    await s.withShadowLock(d.userRoot, d.id, async () => { expect(settled).toBe(false); });
    gate.release(); expect(await active).toMatchObject({ ok: true }); await entered.reached;
    d.write('themes/disabled.css', 'disabled live edit'); expect(settled).toBe(false);
    entered.release(); await maintenance;
    const result = await action; expect(result.status).toBe(200);
    const expectedBodies = {
        resolve: { ok: true, results: [{ path: target, applied: true, committedBackends: [d.id] }] },
        dismiss: { ok: true, results: [{ path: target, backends: [d.id] }] },
        undo: { ok: true, committed: true, reverted: expect.arrayContaining([target]), propagation: { ok: true } },
    };
    expect(result.body).toMatchObject(expectedBodies[operation]);
    await until(() => d.idle());
    const after = (await d.call('GET', '/status')).body;
    expect(after.conflicts.filter(row => row.path === target)).toEqual([]);
    expect(after.notices.filter(row => row.path === target)).toEqual([]);
    expect(d.read(target)).toBe(chosenBytes); expect(d.read('themes/disabled.css')).toBe('disabled live edit');
    const headAfter = await git.resolveRef({ fs: atomicFs, gitdir: d.shadow.gitDir, ref: 'refs/heads/main' });
    expect(headAfter).not.toBe(headBefore);
    const filesAfter = await readCommitFiles({ gitdir: d.shadow.gitDir, commitOid: headAfter });
    expect(filesAfter.get('themes/disabled.css')).toEqual(filesBefore.get('themes/disabled.css'));
    const expectedPoint = operation === 'undo' ? null : point;
    expect(await readUndoPoint(d.shadow.gitDir)).toEqual(expectedPoint);
});

test.each(['prepare', 'maintenance'])('removal during %s invalidates installs and queued routes without remote publication or resurrection', async boundary => {
    const d = await device(); d.write('worlds/unpublished.json', 'must stay local');
    const gate = hold(d, 'GET', 'keyinfo.json');
    const entered = barrier();
    const pending = boundary === 'prepare'
        ? d.call('POST', `/backends/${d.id}/s3`, { body: { s3: { endpoint: proxy.endpoint } } })
        : s.withBackendMaintenance(d.owner, d.id, async (_registry, commit) => {
            // Maintenance itself performs no network. Hold an entered control with a fixture barrier instead.
            gate.cancel(); entered.enter(); await entered.released;
            return patchS3BackendEntry({ userRoot: d.userRoot, backendId: d.id, expectedS3: d.entry.s3, s3Patch: { endpoint: storage.endpoint }, assertAlive: commit.assertAlive });
        }).catch(error => ({ status: 404, body: { code: error.code } }));
    if (boundary === 'prepare') await gate.reached; else await entered.reached;
    // Preparation is an operation, not maintenance: explicitly queue final control
    // before HTTP arrivals so all routes below must wait for admission.
    const finalControl = s.withBackendMaintenance(d.owner, d.id, async () => { throw new Error('removed control must not enter'); }).catch(error => error);
    let settled = 0;
    const track = promise => promise.then(result => { settled++; return result; });
    const queued = track(d.call('POST', `/backends/${d.id}/sync`));
    const resolve = track(d.call('POST', '/conflicts/resolve', { body: [{ path: 'worlds/unpublished.json', choice: 'current', review: { backendId: d.id, selectedOid: null, recordVersions: { [d.id]: 'a'.repeat(40) }, currentVersions: { [d.id]: null } } }] }));
    const undo = track(d.call('POST', `/backends/${d.id}/undo`));
    await until(() => [`/backends/${d.id}/sync`, '/conflicts/resolve', `/backends/${d.id}/undo`].every(route => d.requests.includes(`POST /api/sync/v1${route}`)));
    // A completed independent registry route gives received handlers an async turn
    // to reach the blocked service while the admitted prepare/control cannot drain.
    expect((await d.call('GET', '/backends')).status).toBe(200); expect(settled).toBe(0);
    const removal = s.removeBackend(d.owner, d.id);
    const before = proxy.requests.length;
    gate.release(); entered.release();
    expect(await pending).toMatchObject({ status: 404, body: { code: 'UNKNOWN_BACKEND' } });
    await removal;
    expect(await finalControl).toMatchObject({ code: 'UNKNOWN_BACKEND' });
    expect(await queued).toMatchObject({ status: 404, body: { code: 'UNKNOWN_BACKEND' } });
    expect(await resolve).toMatchObject({ status: 200, body: { ok: true, results: [{ path: 'worlds/unpublished.json', backends: [], committedBackends: [], applied: false }] } });
    expect(await undo).toMatchObject({ status: 404, body: { code: 'UNKNOWN_BACKEND' } });
    expect(await entry(d)).toBeUndefined(); expect(fs.existsSync(d.shadow.peerDir)).toBe(false);
    expect(proxy.requests.slice(before).filter(r => r.method === 'PUT' && !r.relativeKey.includes('/.probe/'))).toEqual([]);
    const missingStart = proxy.requests.length;
    expect(await d.call('POST', `/backends/${d.id}/unlock`, { body: { passphrase: phrase } })).toMatchObject({ status: 404, body: { code: 'UNKNOWN_BACKEND' } });
    expect(proxy.requests).toHaveLength(missingStart);
    expect(d.read('worlds/unpublished.json')).toBe('must stay local');
});

test('removal of an admitted pack download prevents installation, live application and head publication', async () => {
    const source = await device(); source.write('worlds/remote.json', 'remote closure'); expect(await source.run()).toMatchObject({ ok: true });
    const d = await device(source.entry.s3);
    // Use the immutable pack actually published by the healthy source cycle.
    const published = proxy.requests.findLast(r => r.method === 'PUT' && r.relativeKey.startsWith(`${source.entry.s3.prefix}/packs/`));
    const packGate = proxy.addFault({ match: { method: 'GET', relativeKey: published.relativeKey }, once: true, hold: 'after-upstream-response' });
    gates.push(packGate);
    const inspected = barrier();
    const run = s.withBackendOperation(d.owner, d.id, 'drive', async lease => {
        await commitLocalEdit(await lease.context(), async () => null);
        const backend = new S3Backend({ id: d.id, owner: d.owner, entry: d.entry, lease });
        try {
            const remote = await backend.readHead();
            await expect(backend.fetchInto([remote.oid], [])).rejects.toMatchObject({ code: 'UNKNOWN_BACKEND' });
            // Admission keeps removal's final shadow deletion pending, so an
            // install-then-delete regression cannot erase this evidence.
            await s.withShadowLock(d.userRoot, d.id, async () => {
                expect(fs.existsSync(d.shadow.gitDir)).toBe(true);
                await expect(git.readCommit({ fs: atomicFs, gitdir: d.shadow.gitDir, oid: remote.oid })).rejects.toMatchObject({ code: 'NotFoundError' });
                expect(await readIndexedPacks(d.shadow)).toEqual({ v: 1, packs: {} });
                expect(fs.readdirSync(path.join(d.shadow.gitDir, 'objects/pack'))).toEqual([]);
            });
            inspected.enter(); await inspected.released;
        } finally { await backend.close(); }
    });
    expect((await packGate.reached).upstreamStatus).toBe(200);
    const removal = s.removeBackend(d.owner, d.id);
    const before = proxy.requests.length;
    let removed = false; const removedResult = removal.then(() => { removed = true; });
    packGate.release(); await Promise.race([inspected.reached, run]);
    expect(removed).toBe(false); expect(fs.existsSync(d.shadow.peerDir)).toBe(true);
    inspected.release(); await run; await removedResult;
    expect(d.read('worlds/remote.json')).toBeNull(); expect(fs.existsSync(d.shadow.peerDir)).toBe(false); expect(await entry(d)).toBeUndefined();
    expect(proxy.requests.slice(before).filter(r => r.method === 'PUT')).toEqual([]);
});

test('a conditional-write loser yields to maintenance and resumes with fresh selection and transport', async () => {
    const a = await device(); a.write('worlds/base.json', 'base'); expect(await a.run()).toMatchObject({ ok: true });
    const b = await device(a.entry.s3); expect(await b.run()).toMatchObject({ ok: true });
    a.write('worlds/a.json', 'A'); b.write('worlds/b.json', 'B');
    const gate = hold(a, 'GET', 'head'); const first = a.run(); await gate.reached;
    expect(await b.run()).toMatchObject({ ok: true });
    const maintenance = s.withBackendMaintenance(a.owner, a.id, (_registry, commit) => patchS3BackendEntry({ userRoot: a.userRoot, backendId: a.id, expectedS3: a.entry.s3, s3Patch: { endpoint: storage.endpoint }, categories: ['themes'], assertAlive: commit.assertAlive }));
    gate.release(); await maintenance;
    const boundary = proxy.requests.length;
    // The continuation is still the original manual waiter, not a replacement trigger.
    expect(await first).toMatchObject({ ok: true });
    expect(proxy.requests.filter(r => r.relativeKey === `${a.entry.s3.prefix}/head` && r.upstreamStatus === 412)).toHaveLength(1);
    expect(proxy.requests.slice(boundary).filter(r => r.relativeKey.endsWith('/head'))).toEqual([]);
    expect(a.read('worlds/b.json')).toBeNull();
    expect((await entry(a)).categories).toEqual(['themes']);
});

test.each([0, 1, 2])('nested failure releases FIFO maintenance and other genuine S3 backends progress, repetition %s', async () => {
    const d = await device(), other = await device(); other.write('worlds/other.json', 'independent');
    const gate = hold(d, 'GET', 'head'); const active = d.run(); await gate.reached;
    const order = [];
    const failed = s.withBackendMaintenance(d.owner, d.id, async () => {
        await expect(s.withBackendMaintenance(d.owner, d.id, async () => {})).rejects.toMatchObject({ code: 'SYNC_MAINTENANCE_REENTRANT' });
        order.push('failure'); throw new Error('fixture control failure');
    });
    const rejected = failed.catch(error => error);
    const next = s.withBackendMaintenance(d.owner, d.id, async () => { order.push('next'); });
    const otherId = `s3-${'0'.repeat(32)}`;
    await createS3BackendEntry({ userRoot: d.userRoot, backendId: otherId, label: 'Other storage', categories: ['worlds'], s3: other.entry.s3 });
    const grouped = s.withLocalMutationContexts(d.owner, [d.id, otherId], async contexts => {
        expect(contexts.size).toBe(2); order.push('grouped');
    });
    // All-or-release: the grouped waiter must not retain other's admission.
    await s.withBackendMaintenance(d.owner, otherId, async () => {});
    d.write('worlds/independent.json', 'other backend progresses');
    expect(await s.trigger(d.owner, otherId, 'manual')).toMatchObject({ ok: true, outcome: { pushed: true } });
    gate.release(); expect(await active).toMatchObject({ ok: true });
    const [failure] = await Promise.all([rejected, next, grouped]); expect(failure.message).toBe('fixture control failure');
    expect(order).toEqual(['failure', 'next', 'grouped']); expect(await d.run()).toMatchObject({ ok: true });
});

test('overlapping real credential preparations compare expected S3 while preserving current unrelated registry fields', async () => {
    const d = await device();
    const gate = hold(d, 'GET', 'keyinfo.json');
    const stale = prepareS3Backend({ owner: d.owner, previous: await previous(d), input: { accessKeyId: base.accessKeyId, secretAccessKey: base.secretAccessKey } });
    await gate.reached;
    const fresh = await prepareS3Backend({ owner: d.owner, previous: await previous(d), input: { endpoint: storage.endpoint, accessKeyId: base.accessKeyId, secretAccessKey: base.secretAccessKey } });
    const committing = s.withBackendMaintenance(d.owner, d.id, (_registry, commit) => patchS3BackendEntry({ userRoot: d.userRoot, backendId: d.id, expectedS3: fresh.expectedS3, s3Patch: fresh.s3, assertAlive: commit.assertAlive }));
    await Promise.all([
        setBackendSettings({ userRoot: d.userRoot, backendId: d.id, label: 'Latest label', categories: ['themes'] }),
        setSchedule({ userRoot: d.userRoot, idleSeconds: 17, pollSeconds: 39 }),
        recordLastSync({ userRoot: d.userRoot, backendId: d.id, success: { head: 'e'.repeat(40) } }),
    ]);
    gate.release(); const old = await stale; await committing;
    await expect(s.withBackendMaintenance(d.owner, d.id, (_registry, commit) => patchS3BackendEntry({ userRoot: d.userRoot, backendId: d.id, expectedS3: old.expectedS3, s3Patch: old.s3, assertAlive: commit.assertAlive }))).rejects.toMatchObject({ code: 'S3_SETTINGS_CHANGED' });
    const registry = await readRegistry({ userRoot: d.userRoot });
    expect(registry.backends[d.id]).toMatchObject({ label: 'Latest label', categories: ['themes'], s3: { endpoint: storage.endpoint }, lastSync: { head: 'e'.repeat(40) } });
    expect(registry.schedule).toEqual({ idleSeconds: 17, pollSeconds: 39 });
});
