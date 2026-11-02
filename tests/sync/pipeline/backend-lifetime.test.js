import { afterEach, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { startLanDevice, pair } from '../_lib/lan-devices.js';
import { syncService as s } from '../../../src/sync/sync-service.js';
import { upsertLanBackend, readRegistry, setBackendSettings } from '../../../src/sync/state.js';
import { commitLocalEdit } from '../../../src/sync/pipeline/cycle.js';
import { getShadowPaths } from '../../../src/sync/shadow.js';
import { PAUSEPOINTS } from '../../../src/sync/pipeline/failpoints.js';
import { LanBackend } from '../../../src/sync/backends/lan/client.js';
import git from 'isomorphic-git';
import { atomicFs } from '../../../src/sync/pipeline/atomic-fs.js';

const devices = [];
const ID = 'u@1234abcd';
const barrier = () => {
    let enter, release;
    return { reached: new Promise(r => { enter = r; }), released: new Promise(r => { release = r; }), enter: () => enter(), release: () => release() };
};
async function device() {
    const d = await startLanDevice();
    devices.push(d);
    for (const id of [ID, 'zother']) await upsertLanBackend({ userRoot: d.userRoot, backendId: id, categories: ['worlds'], label: id });
    return d;
}
afterEach(async () => { for (const d of devices.splice(0)) await d.close(); });

test('maintenance drains admitted mutations without blocking their later local sections', async () => {
    const d = await device();
    const held = barrier();
    const order = [];
    const active = s.withBackendOperation(d.owner, ID, 'local-mutation', async lease => {
        held.enter();
        await held.released;
        await commitLocalEdit(await lease.context(), async () => null);
        order.push('active');
    });
    await held.reached;
    const control = s.withBackendMaintenance(d.owner, ID, async () => { order.push('control'); });
    const queued = s.withLocalMutationContexts(d.owner, [ID], async contexts => {
        await commitLocalEdit(contexts.get(ID), async () => null);
        order.push('queued');
    });
    await s.withLocalMutationContexts(d.owner, ['zother'], async contexts => { await commitLocalEdit(contexts.get('zother'), async () => null); });
    expect(order).toEqual([]);
    held.release();
    await Promise.all([active, control, queued]);
    expect(order).toEqual(['active', 'control', 'queued']);
});

test('maintenance is FIFO, rejects recursion and releases after failure', async () => {
    const d = await device();
    const held = barrier();
    const order = [];
    const first = s.withBackendMaintenance(d.owner, ID, async () => {
        held.enter();
        await held.released;
        await expect(s.withBackendMaintenance(d.owner, ID, async () => {})).rejects.toMatchObject({ code: 'SYNC_MAINTENANCE_REENTRANT' });
        order.push('first');
        throw new Error('control failed');
    });
    const rejected = first.then(value => ({ value }), error => ({ error }));
    await held.reached;
    const second = s.withBackendMaintenance(d.owner, ID, async () => { order.push('second'); });
    held.release();
    const [outcome] = await Promise.all([rejected, second]);
    expect(outcome).toMatchObject({ error: expect.objectContaining({ message: 'control failed' }) });
    expect(order).toEqual(['first', 'second']);
    await s.withBackendOperation(d.owner, ID, 'prepare', async lease => { await lease.assertAlive(); });
});

test('grouped acquisition releases earlier leases before waiting for another backend', async () => {
    const d = await device();
    const held = barrier();
    const control = s.withBackendMaintenance(d.owner, 'zother', async () => { held.enter(); await held.released; });
    await held.reached;
    const grouped = s.withLocalMutationContexts(d.owner, [ID, 'zother'], async contexts => { expect([...contexts.keys()]).toEqual([ID, 'zother']); });
    await s.withBackendMaintenance(d.owner, ID, async () => {});
    held.release();
    await Promise.all([control, grouped]);
});

test('removal cancels queued mutations before repository creation and stops admitted sections', async () => {
    const d = await device();
    const held = barrier();
    const active = s.withBackendOperation(d.owner, ID, 'prepare', async lease => {
        held.enter(); await held.released;
        await expect(lease.withLocal(async () => {})).rejects.toMatchObject({ code: 'UNKNOWN_BACKEND' });
    });
    await held.reached;
    const maintenance = s.withBackendMaintenance(d.owner, ID, async () => { throw new Error('must not enter'); });
    const cancelled = maintenance.then(value => ({ value }), error => ({ error }));
    const queued = s.withLocalMutationContexts(d.owner, [ID], async contexts => { expect(contexts.size).toBe(0); });
    const removal = s.removeBackend(d.owner, ID);
    held.release();
    const [, outcome] = await Promise.all([active, cancelled, queued, removal]);
    expect(outcome).toMatchObject({ error: expect.objectContaining({ code: 'UNKNOWN_BACKEND' }) });
    expect(fs.existsSync(getShadowPaths({ userRoot: d.userRoot, peerId: ID }).peerDir)).toBe(false);
});

test('incoming offers reject pending maintenance immediately and restore consumed pairing codes', async () => {
    const d = await device();
    const start = await d.call('POST', '/pair/start', { body: { categories: ['worlds'] } });
    const id = start.body.peerId;
    const held = barrier();
    const control = s.withBackendMaintenance(d.owner, id, async () => { held.enter(); await held.released; });
    await held.reached;
    const body = { peerId: id, protocol: 2, callback: d.userStore.selfCallback() };
    expect(await d.offer(body, { pairCode: start.body.pairCode })).toMatchObject({ status: 409, body: { code: 'SYNC_BACKEND_MAINTENANCE' } });
    expect(fs.existsSync(getShadowPaths({ userRoot: d.userRoot, peerId: id }).peerDir)).toBe(false);
    expect((await readRegistry({ userRoot: d.userRoot })).backends[id].lan.syncSecret).toBe('');
    held.release(); await control;
    expect((await d.offer(body, { pairCode: start.body.pairCode })).status).toBe(200);
});

test('settings acknowledgement waits for old-selection work and queued contexts reload categories', async () => {
    const d = await device();
    const held = barrier();
    const active = s.withBackendOperation(d.owner, ID, 'drive', async lease => {
        expect((await lease.context()).categories).toEqual(['worlds']);
        held.enter(); await held.released;
        await lease.withLocal(async () => {});
    });
    await held.reached;
    let acknowledged = false;
    const settings = d.call('POST', `/backends/${ID}`, { body: { categories: ['characters'] } }).then(r => { acknowledged = true; return r; });
    // A control queued synchronously establishes an observable drain boundary.
    const control = s.withBackendMaintenance(d.owner, ID, async () => {});
    expect(acknowledged).toBe(false);
    held.release();
    await Promise.all([active, settings, control]);
    await s.withLocalMutationContexts(d.owner, [ID], async contexts => { expect(contexts.get(ID).categories).toEqual(['characters']); });
});

async function reached(file) {
    while (!fs.existsSync(file)) await new Promise(resolve => setImmediate(resolve));
}

async function releasePause(dir, name) {
    // Wait until the fixture has consumed the release before re-arming.
    // HTTP completion can be observed before the watcher's cleanup turn.
    const file = path.join(dir, `${name}.release`);
    fs.writeFileSync(file, '');
    while (fs.existsSync(path.join(dir, `${name}.reached`))) await new Promise(resolve => setImmediate(resolve));
}

test('symmetric paired drives reject offers pending maintenance and settle both manual waiters', async () => {
    expect(PAUSEPOINTS.OFFER_BEFORE_ADMISSION).toBe('offer-before-admission');
    const A = await startLanDevice(); devices.push(A);
    const B = await startLanDevice(); devices.push(B);
    const id = await pair(A, B, { categories: ['worlds'] });
    // Finish pairing's notification epochs before arming offer barriers for
    // the manual epochs below. Running flags alone omit a trigger still
    // awaiting its registry read.
    await s.trigger(A.owner, id, 'manual');
    await s.trigger(B.owner, id, 'manual');
    while (!A.idle() || !B.idle()) await new Promise(resolve => setImmediate(resolve));
    const name = PAUSEPOINTS.OFFER_BEFORE_ADMISSION;
    const dir = path.join(A.userRoot, 'barriers'); fs.mkdirSync(dir);
    const dirs = [A, B].map(d => path.join(dir, path.basename(d.userRoot)));
    for (const folder of dirs) { fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, `${name}.arm`), ''); }
    process.env.LUKER_SYNC_PAUSEPOINT = name;
    process.env.LUKER_SYNC_PAUSE_DIR = dir;
    const snapshots = [];
    const controlHeld = barrier();
    try {
        A.write('worlds/a.json', 'A'); B.write('worlds/b.json', 'B');
        const runs = [A, B].map(d => d.call('POST', `/backends/${id}/sync`));
        await Promise.all(dirs.map(folder => reached(path.join(folder, `${name}.reached`))));
        for (const d of [A, B]) snapshots.push(await readRegistry({ userRoot: d.userRoot }));
        const controls = [A, B].map(d => s.withBackendMaintenance(d.owner, id, async () => { await controlHeld.released; }));
        for (const folder of dirs) fs.writeFileSync(path.join(folder, `${name}.release`), '');
        const results = await Promise.all(runs);
        controlHeld.release();
        expect(results).toEqual([expect.objectContaining({ status: 409, body: expect.objectContaining({ code: 'SYNC_BACKEND_MAINTENANCE', ok: false }) }), expect.objectContaining({ status: 409, body: expect.objectContaining({ code: 'SYNC_BACKEND_MAINTENANCE', ok: false }) })]);
        await Promise.all(controls);
        for (const [i, d] of [A, B].entries()) {
            expect((await readRegistry({ userRoot: d.userRoot })).backends[id].lan).toEqual(snapshots[i].backends[id].lan);
            expect(d.read(i === 0 ? 'worlds/b.json' : 'worlds/a.json')).toBeNull();
        }
    } finally {
        controlHeld.release();
        delete process.env.LUKER_SYNC_PAUSEPOINT; delete process.env.LUKER_SYNC_PAUSE_DIR;
        for (const folder of dirs) fs.writeFileSync(path.join(folder, `${name}.release`), '');
    }
});

test('accepted offers drain through maintenance and removal wins a delayed authenticated offer', async () => {
    expect(PAUSEPOINTS.OFFER_AFTER_ADMISSION).toBe('offer-after-admission');
    const d = await device();
    const start = await d.call('POST', '/pair/start', { body: { categories: ['worlds'] } });
    const id = start.body.peerId;
    const name = PAUSEPOINTS.OFFER_AFTER_ADMISSION;
    const root = path.join(d.userRoot, 'barriers');
    const dir = path.join(root, path.basename(d.userRoot)); fs.mkdirSync(dir, { recursive: true });
    process.env.LUKER_SYNC_PAUSEPOINT = name; process.env.LUKER_SYNC_PAUSE_DIR = root;
    fs.writeFileSync(path.join(dir, `${name}.arm`), '');
    try {
        const offer = d.offer({ peerId: id, protocol: 2, callback: d.userStore.selfCallback() }, { pairCode: start.body.pairCode });
        await reached(path.join(dir, `${name}.reached`));
        let maintained = false;
        const control = s.withBackendMaintenance(d.owner, id, async () => { maintained = true; });
        expect(maintained).toBe(false);
        await releasePause(dir, name);
        const result = await offer;
        expect(result.status).toBe(200);
        await control;
        expect(maintained).toBe(true);
        fs.writeFileSync(path.join(dir, `${name}.arm`), '');
        const delayed = d.offer({ peerId: id, protocol: 2 }, { secret: result.body.syncSecret });
        await reached(path.join(dir, `${name}.reached`));
        const removal = s.removeBackend(d.owner, id);
        await releasePause(dir, name);
        expect(await delayed).toMatchObject({ status: 404, body: { code: 'PEER_FORGOTTEN' } });
        await removal;
        expect(fs.existsSync(getShadowPaths({ userRoot: d.userRoot, peerId: id }).peerDir)).toBe(false);
    } finally {
        delete process.env.LUKER_SYNC_PAUSEPOINT; delete process.env.LUKER_SYNC_PAUSE_DIR;
        fs.writeFileSync(path.join(dir, `${name}.release`), '');
    }
});

test('an in-flight LAN fetch cannot install objects after removal marks the admitted lease', async () => {
    const held = barrier();
    let block = false;
    const A = await startLanDevice({ beforeRequest: async request => {
        if (block && request.path.includes('/session/object/')) { block = false; held.enter(); await held.released; }
    } }); devices.push(A);
    const B = await startLanDevice(); devices.push(B);
    const id = await pair(A, B, { categories: ['worlds'] });
    while (!A.idle() || !B.idle()) await new Promise(resolve => setImmediate(resolve));
    A.write('worlds/new.json', 'new remote content');
    await s.withLocalMutationContexts(A.owner, [id], contexts => commitLocalEdit(contexts.get(id), async () => null));
    const registry = await readRegistry({ userRoot: B.userRoot });
    const backend = new LanBackend({ id, owner: B.owner, userRoot: B.userRoot, entry: registry.backends[id], deviceLabel: 'B', callback: null });
    const head = await backend.readHead();
    block = true;
    const operation = s.withBackendOperation(B.owner, id, 'drive', async lease => {
        backend.lease = lease;
        await expect(backend.fetchInto([head.oid])).rejects.toMatchObject({ code: 'UNKNOWN_BACKEND' });
        const { gitDir } = getShadowPaths({ userRoot: B.userRoot, peerId: id });
        await expect(git.readCommit({ fs: atomicFs, gitdir: gitDir, oid: head.oid })).rejects.toMatchObject({ code: 'NotFoundError' });
    });
    await held.reached;
    const removal = s.removeBackend(B.owner, id);
    held.release();
    await Promise.all([operation, removal]);
    await backend.close();
});

test('removal during an entered maintenance preparation rejects its final registry commit', async () => {
    const d = await device();
    const held = barrier();
    const control = s.withBackendMaintenance(d.owner, ID, async (_registry, commit) => {
        held.enter(); await held.released;
        commit.assertAlive();
        throw new Error('must not publish');
    });
    const rejected = control.then(value => ({ value }), error => ({ error }));
    await held.reached;
    const removal = s.removeBackend(d.owner, ID);
    expect(s.removeBackend(d.owner, ID)).toBe(removal);
    held.release();
    const [outcome] = await Promise.all([rejected, removal]);
    expect(outcome).toMatchObject({ error: expect.objectContaining({ code: 'UNKNOWN_BACKEND' }) });
    expect((await readRegistry({ userRoot: d.userRoot })).backends[ID]).toBeUndefined();
});

test('a real LAN epoch drains before settings while queued manual and poll triggers coalesce', async () => {
    const held = barrier(); let blocking = false; let manifests = 0;
    const A = await startLanDevice({ beforeRequest: async request => {
        if (request.path.endsWith('/session/manifest')) {
            manifests += 1;
            if (blocking) { blocking = false; held.enter(); await held.released; }
        }
    } }); devices.push(A);
    const B = await startLanDevice(); devices.push(B);
    const id = await pair(A, B, { categories: ['worlds'] });
    while (!A.idle() || !B.idle()) await new Promise(resolve => setImmediate(resolve));
    manifests = 0; blocking = true;
    B.write('worlds/old.json', 'old selection');
    const first = s.trigger(B.owner, id, 'manual');
    await held.reached;
    let acknowledged = false;
    const maintenance = s.withBackendMaintenance(B.owner, id, async (_registry, commit) => {
        await setBackendSettings({ userRoot: B.userRoot, backendId: id, categories: ['characters'], assertAlive: commit.assertAlive });
        acknowledged = true;
    });
    const manual = s.trigger(B.owner, id, 'manual');
    const poll = s.trigger(B.owner, id, 'poll', { waitForResult: false });
    const mutations = s.withLocalMutationContexts(B.owner, [id], async contexts => {
        expect(acknowledged).toBe(true);
        expect(contexts.get(id).categories).toEqual(['characters']);
        await commitLocalEdit(contexts.get(id), async () => null);
    });
    expect(acknowledged).toBe(false);
    held.release();
    expect(await first).toMatchObject({ ok: true });
    await maintenance;
    const [m, p] = await Promise.all([manual, poll]);
    expect(p).toBeNull(); expect(m.ok).toBe(true);
    await mutations;
    expect(manifests).toBe(2);
});
