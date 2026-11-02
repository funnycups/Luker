import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import { createScheduler } from '../../../src/sync/pipeline/scheduler.js';
import { registerSyncHooks } from '../../../src/sync/pipeline/sync-hooks.js';
import { upsertLanBackend, readRegistry, setSchedule, recordLastSync, updateRegistry } from '../../../src/sync/state.js';
import { getGateState, _resetGateForTests } from '../../../src/sync/in-progress-gate.js';
import { IncomingRefBackend } from '../../../src/sync/backends/lan/incoming.js';
import { syncError } from '../../../src/sync/errors.js';
import { getShadowPaths } from '../../../src/sync/shadow.js';
import { CONTRACT_HARNESSES } from '../../storage/harness/contract-harness.js';
import { withNestedDirs } from '../_lib/nested-dirs.js';
import { DirectoryBackend } from '../_lib/directory-backend.js';
import { makeDevice, makeRemote, remoteHead } from '../_lib/devices.js';
import { localWasOurs } from '../_lib/merge-roles.js';
import { commitFiles } from '../_lib/commits.js';
import git from 'isomorphic-git';
import { atomicFs } from '../../../src/sync/pipeline/atomic-fs.js';

function manualTimers() {
    const pending = new Set();
    return {
        pending,
        setTimeout(fn, ms) { const t = { fn, ms }; pending.add(t); return t; },
        clearTimeout(t) { pending.delete(t); },
        async fire(ms) {
            for (const t of [...pending]) {
                if (t.ms !== ms) continue;
                pending.delete(t);
                await t.fn();
            }
        },
    };
}

function gate() {
    let reach;
    let release;
    const reached = new Promise(resolve => { reach = resolve; });
    const released = new Promise(resolve => { release = resolve; });
    return { reached, release, wait: () => { reach(); return released; } };
}

describe('sync scheduler', () => {
    const cleanups = [];
    let remotes;
    let timers;
    let readHeads;
    let gates;
    let probes;
    let backendHooks;

    const ownerOf = d => ({ handle: 'u', displayName: 'u', userRoot: d.userRoot, directories: d.directories, engine: d.ctx.engine });
    const scheduler = (extra = {}) => createScheduler({
        makeBackend: (owner, id) => {
            const backend = new DirectoryBackend({ id, remoteDir: remotes[id], userRoot: owner.userRoot });
            const read = backend.readHead.bind(backend);
            backend.readHead = async () => {
                readHeads[id] = (readHeads[id] ?? 0) + 1;
                if (probes[id]) await probes[id](owner);
                if (gates[id]) await gates[id].wait();
                return read();
            };
            if (backendHooks[id]) Object.assign(backend.hooks, backendHooks[id]);
            delete backendHooks[id];
            return backend;
        },
        makeIncomingBackend: () => null,
        listOwners: async () => [],
        getEngine: () => { throw new Error('every test owner carries its engine'); },
        timers,
        ...extra,
    });
    async function device(ids = ['r1']) {
        const d = makeDevice({ remoteDir: remotes.r1 });
        cleanups.push(() => d.cleanup());
        for (const id of ids) await upsertLanBackend({ userRoot: d.userRoot, backendId: id, label: id, categories: ['characters', 'worlds'] });
        return d;
    }

    beforeEach(async () => {
        _resetGateForTests();
        remotes = {};
        for (const id of ['r1', 'r2']) {
            const r = await makeRemote();
            remotes[id] = r.remoteDir;
            cleanups.push(r.cleanup);
        }
        timers = manualTimers();
        readHeads = {};
        gates = {};
        probes = {};
        backendHooks = {};
    });
    afterEach(async () => {
        for (const done of cleanups.splice(0).reverse()) await done();
    });

    test('a trigger during a run gives exactly one follow-up run', async () => {
        const d = await device();
        const s = scheduler();
        const held = gate();
        gates.r1 = held;
        const first = s.trigger(ownerOf(d), 'r1', 'manual');
        await held.reached;
        delete gates.r1;
        const a = s.trigger(ownerOf(d), 'r1', 'idle');
        const b = s.trigger(ownerOf(d), 'r1', 'poll');
        held.release();
        const [r0, ra, rb] = await Promise.all([first, a, b]);
        expect(r0.ok && ra.ok).toBe(true);
        expect(ra).toBe(rb);
        expect(readHeads.r1).toBe(2);
    });
    test('cycle reruns run until settled within one trigger', async () => {
        const A = makeDevice({ remoteDir: remotes.r1 });
        cleanups.push(() => A.cleanup());
        A.write('characters/x.png', 'V1');
        const { runSyncCycle } = await import('../../../src/sync/pipeline/cycle.js');
        await runSyncCycle({ ...A.ctx, backendId: 'r1', backend: new DirectoryBackend({ id: 'r1', remoteDir: remotes.r1, userRoot: A.userRoot }) });
        const d = await device();
        const s = scheduler();
        await s.trigger(ownerOf(d), 'r1', 'manual');
        A.write('characters/x.png', 'V2');
        await runSyncCycle({ ...A.ctx, backendId: 'r1', backend: new DirectoryBackend({ id: 'r1', remoteDir: remotes.r1, userRoot: A.userRoot }) });
        let edited = false;
        probes.r1 = async () => { if (!edited) { edited = true; d.write('characters/x.png', 'USER'); } };
        readHeads.r1 = 0;
        const aHead = await remoteHead(remotes.r1);
        const result = await s.trigger(ownerOf(d), 'r1', 'manual');
        expect(result).toMatchObject({ ok: true, stalled: null });
        expect(readHeads.r1).toBe(2);
        const userKept = await localWasOurs(getShadowPaths({ userRoot: d.userRoot, peerId: 'r1' }).gitDir, result.outcome.localHead, aHead);
        expect(d.read('characters/x.png')).toBe(userKept ? 'USER' : 'V2');
    });

    test('a remote-moved rerun that never changes the remote head stops with no progress', async () => {
        const d = await device();
        d.write('characters/x.png', 'V1');
        const s = scheduler({
            makeBackend: (owner, id) => {
                const backend = new DirectoryBackend({ id, remoteDir: remotes[id], userRoot: owner.userRoot });
                backend.casHead = async () => ({ ok: false, reason: 'conflict' });
                return backend;
            },
        });
        const result = await s.trigger(ownerOf(d), 'r1', 'manual');
        expect(result).toMatchObject({ ok: false, code: 'SYNC_NO_PROGRESS' });
        expect((await readRegistry({ userRoot: d.userRoot })).backends.r1.lastSync.error.code).toBe('SYNC_NO_PROGRESS');
    });

    test('a skip that never changes stops as stalled', async () => {
        const sqlite = CONTRACT_HARNESSES.find(h => h.name === 'SqliteEngine');
        const h = withNestedDirs(await sqlite.make());
        cleanups.push(() => h.cleanup());
        fs.mkdirSync(h.dirs.chats, { recursive: true });
        const orphan = await commitFiles(remotes.r1, { 'chats/Seraphina/c1.luker-state.mg.json': '{"v":1}' });
        await git.writeRef({ fs: atomicFs, gitdir: remotes.r1, ref: 'refs/heads/main', value: orphan, force: true });
        await upsertLanBackend({ userRoot: h.dirs.root, backendId: 'r1', label: 'r1', categories: ['chats'] });
        const owner = { handle: h.handle, displayName: h.handle, userRoot: h.dirs.root, directories: h.dirs, engine: h.engine };
        const result = await scheduler().trigger(owner, 'r1', 'manual');
        expect(result).toMatchObject({ ok: true, stalled: ['chats/Seraphina/c1.luker-state.mg.json'] });
        expect(readHeads.r1).toBe(2);
        expect((await readRegistry({ userRoot: h.dirs.root })).backends.r1.lastSync.stalled).toEqual(['chats/Seraphina/c1.luker-state.mg.json']);
    }, 60_000);

    test('the idle timer resets on each dirty mark', async () => {
        const d = await device();
        const s = scheduler();
        s.rememberOwner(ownerOf(d));
        await s.reschedule(ownerOf(d));
        s.markDirty({ handle: 'u', userRoot: d.userRoot });
        const first = [...timers.pending].find(t => t.ms === 60_000);
        s.markDirty({ handle: 'u', userRoot: d.userRoot });
        const idle = [...timers.pending].filter(t => t.ms === 60_000);
        expect(idle).toHaveLength(1);
        expect(idle[0]).not.toBe(first);
        expect(timers.pending.has(first)).toBe(false);
        await timers.fire(60_000);
        expect(readHeads.r1).toBe(1);
    });

    test('a saved idle delay applies to the pending idle timer', async () => {
        const d = await device();
        const s = scheduler({ now: () => 1_000_000 });
        s.rememberOwner(ownerOf(d));
        await s.reschedule(ownerOf(d));
        s.markDirty({ handle: 'u', userRoot: d.userRoot });
        await setSchedule({ userRoot: d.userRoot, idleSeconds: 3600, pollSeconds: 300 });
        await s.reschedule(ownerOf(d));
        expect([...timers.pending].map(t => t.ms)).toEqual([3_600_000]);
        await timers.fire(3_600_000);
        expect(readHeads.r1).toBe(1);
    });

    test('a changed idle delay counts from the last dirty mark', async () => {
        const d = await device();
        let clock = 1_000_000;
        const s = scheduler({ now: () => clock });
        s.rememberOwner(ownerOf(d));
        await s.reschedule(ownerOf(d));
        s.markDirty({ handle: 'u', userRoot: d.userRoot });
        clock += 50_000;
        await setSchedule({ userRoot: d.userRoot, idleSeconds: 120, pollSeconds: 300 });
        await s.reschedule(ownerOf(d));
        expect([...timers.pending].map(t => t.ms)).toEqual([70_000]);
        await setSchedule({ userRoot: d.userRoot, idleSeconds: 30, pollSeconds: 300 });
        await s.reschedule(ownerOf(d));
        expect([...timers.pending].map(t => t.ms)).toEqual([0]);
        await timers.fire(0);
        expect(readHeads.r1).toBe(1);
    });

    test('rescheduling with an unchanged idle delay keeps the pending idle timer', async () => {
        const d = await device();
        const s = scheduler();
        s.rememberOwner(ownerOf(d));
        await s.reschedule(ownerOf(d));
        s.markDirty({ handle: 'u', userRoot: d.userRoot });
        const pending = [...timers.pending].find(t => t.ms === 60_000);
        await setSchedule({ userRoot: d.userRoot, idleSeconds: 60, pollSeconds: 900 });
        await s.reschedule(ownerOf(d));
        const idle = [...timers.pending].filter(t => t.ms === 60_000);
        expect(idle).toHaveLength(1);
        expect(idle[0]).toBe(pending);
    });

    test('a dirty mark for the resolved path of an un-normalized owner root arms the idle timer', async () => {
        const d = await device();
        const owner = { ...ownerOf(d), userRoot: `${d.userRoot}${path.sep}sub${path.sep}..` };
        const s = scheduler();
        s.rememberOwner(owner);
        await s.reschedule(owner);
        s.markDirty({ handle: 'u', userRoot: path.resolve(owner.userRoot) });
        expect([...timers.pending].filter(t => t.ms === 60_000)).toHaveLength(1);
        expect(s.ownerFor(d.userRoot)).toBe(owner);
        await timers.fire(60_000);
        expect(readHeads.r1).toBe(1);
    });

    test('the idle timer fires one run per backend', async () => {
        const d = await device(['r1', 'r2']);
        const s = scheduler();
        s.rememberOwner(ownerOf(d));
        await s.reschedule(ownerOf(d));
        s.markDirty({ handle: 'u', userRoot: d.userRoot });
        await timers.fire(60_000);
        expect(readHeads).toEqual({ r1: 1, r2: 1 });
    });

    test('poll arms only once started, re-arms after each fire and follows the saved schedule', async () => {
        const d = await device();
        await setSchedule({ userRoot: d.userRoot, idleSeconds: 2, pollSeconds: 7 });
        const s = scheduler();
        await s.reschedule(ownerOf(d));
        expect(timers.pending.size).toBe(0);
        await s.start();
        await s.reschedule(ownerOf(d));
        await timers.fire(7000);
        while (s.getRunning(d.userRoot).r1) await new Promise(resolve => setImmediate(resolve));
        expect(readHeads.r1).toBe(1);
        expect([...timers.pending].filter(t => t.ms === 7000)).toHaveLength(1);
        s.stop();
        expect(timers.pending.size).toBe(0);
    });

    test('nothing re-arms after stop', async () => {
        const d = await device();
        const s = scheduler();
        s.rememberOwner(ownerOf(d));
        await s.reschedule(ownerOf(d));
        s.stop();
        await s.reschedule(ownerOf(d));
        s.markDirty({ handle: 'u', userRoot: d.userRoot });
        expect(timers.pending.size).toBe(0);
    });

    test('backends of one user run independently', async () => {
        const d = await device(['r1', 'r2']);
        const s = scheduler();
        const held = gate();
        gates.r1 = held;
        const blocked = s.trigger(ownerOf(d), 'r1', 'manual');
        await held.reached;
        expect((await s.trigger(ownerOf(d), 'r2', 'manual')).ok).toBe(true);
        expect(s.getRunning(d.userRoot)).toEqual({ r1: true, r2: false });
        held.release();
        expect((await blocked).ok).toBe(true);
    });

    test('two backends of one user never hold the writer lock together', async () => {
        const { runSyncCycle } = await import('../../../src/sync/pipeline/cycle.js');
        const source = makeDevice({ remoteDir: remotes.r1 });
        cleanups.push(() => source.cleanup());
        source.write('characters/a.png', 'A');
        for (const id of ['r1', 'r2']) {
            await runSyncCycle({ ...source.ctx, backendId: id, backend: new DirectoryBackend({ id, remoteDir: remotes[id], userRoot: source.userRoot }) });
        }
        const d = await device(['r1', 'r2']);
        const seen = [];
        cleanups.push(registerSyncHooks({ afterReconcile: async () => { seen.push(getGateState(d.userRoot)); } }));
        const s = scheduler();
        await Promise.all([s.trigger(ownerOf(d), 'r1', 'manual'), s.trigger(ownerOf(d), 'r2', 'manual')]);
        expect(seen).toHaveLength(2);
        for (const state of seen) expect(state).toMatchObject({ writerHeld: true, readers: 0 });
        expect(d.read('characters/a.png')).toBe('A');
    });

    test('runLocalStep does not wait for a running network step', async () => {
        const d = await device();
        const s = scheduler({ makeIncomingBackend: (owner, id) => new IncomingRefBackend({ id, userRoot: owner.userRoot }) });
        const held = gate();
        gates.r1 = held;
        const network = s.trigger(ownerOf(d), 'r1', 'manual');
        await held.reached;
        expect(await s.runLocalStep(ownerOf(d), 'r1')).toMatchObject({ ok: true });
        held.release();
        expect((await network).ok).toBe(true);
    });

    test('a trigger for a backend missing from the registry leaves no state', async () => {
        const d = await device();
        const s = scheduler();
        expect(await s.trigger(ownerOf(d), 'r9', 'manual')).toMatchObject({ ok: false, code: 'UNKNOWN_BACKEND' });
        expect(s.getRunning(d.userRoot)).toEqual({});
        expect(s.isRemoving(d.userRoot, 'r9')).toBe(false);
    });

    test('an error is recorded in lastSync and not retried', async () => {
        const d = await device();
        const s = scheduler();
        probes.r1 = async () => { throw syncError('PEER_UNREACHABLE', 'ECONNREFUSED'); };
        expect(await s.trigger(ownerOf(d), 'r1', 'manual')).toEqual({ ok: false, code: 'PEER_UNREACHABLE', message: 'ECONNREFUSED' });
        expect((await readRegistry({ userRoot: d.userRoot })).backends.r1.lastSync.error).toMatchObject({ code: 'PEER_UNREACHABLE', message: 'ECONNREFUSED' });
        expect(readHeads.r1).toBe(1);
        expect(timers.pending.size).toBe(0);
    });

    test.each(['success', 'error'])('a queued lastSync %s checks removal inside its registry callback', async kind => {
        const d = await device();
        const s = scheduler();
        const owner = ownerOf(d);
        const identity = s.captureBackendIdentity(owner, 'r1');
        const before = (await readRegistry({ userRoot: d.userRoot })).backends.r1.lastSync;
        const held = gate();
        const shadowHeld = gate();
        let removal;
        const operation = s.withBackendOperation(owner, 'r1', 'drive', async lease => {
            await lease.assertAlive();
            const blocker = updateRegistry({ userRoot: d.userRoot }, () => held.wait());
            await held.reached;
            const recording = recordLastSync({ userRoot: d.userRoot, backendId: 'r1', assertAlive: identity.assertAlive,
                ...(kind === 'success' ? { success: { head: null, mergeCase: 'none', stalled: null } } : { error: { code: 'PEER_UNREACHABLE', message: 'offline' } }),
            });
            const rejected = recording.then(value => ({ value }), error => ({ error }));
            const shadow = s.withShadowLock(d.userRoot, 'r1', () => shadowHeld.wait());
            await shadowHeld.reached;
            removal = s.removeBackend(owner, 'r1');
            held.release();
            await blocker;
            try {
                expect(await rejected).toMatchObject({ error: expect.objectContaining({ code: 'UNKNOWN_BACKEND' }) });
                expect((await readRegistry({ userRoot: d.userRoot })).backends.r1.lastSync).toEqual(before);
            } finally { shadowHeld.release(); await shadow; }
        });
        // Do not await removal from inside its own admitted operation.
        try { await operation; } finally { await removal; }
    });

    test('a backend factory that throws resolves every waiter and leaks no rejection', async () => {
        const d = await device();
        const rejections = [];
        const onRejection = reason => rejections.push(reason);
        process.on('unhandledRejection', onRejection);
        cleanups.push(() => process.off('unhandledRejection', onRejection));
        const s = scheduler({ makeBackend: () => { throw syncError('BACKEND_UNAVAILABLE', 'not here'); } });
        const results = await Promise.all([s.trigger(ownerOf(d), 'r1', 'manual'), s.trigger(ownerOf(d), 'r1', 'idle')]);
        for (const result of results) expect(result).toMatchObject({ ok: false, code: 'BACKEND_UNAVAILABLE' });
        await new Promise(resolve => setImmediate(resolve));
        expect(rejections).toEqual([]);
        expect(s.getRunning(d.userRoot)).toEqual({ r1: false });
    });

    test('success records head and mergeCase', async () => {
        const d = await device();
        d.write('characters/a.png', 'A');
        const result = await scheduler().trigger(ownerOf(d), 'r1', 'manual');
        const { lastSync } = (await readRegistry({ userRoot: d.userRoot })).backends.r1;
        expect(lastSync).toMatchObject({ head: result.outcome.localHead, mergeCase: 'pairing-push', error: null, stalled: null });
        expect(typeof lastSync.at).toBe('number');
    });

    test('sync hooks run around a cycle', async () => {
        const d = await device();
        d.write('characters/a.png', 'A');
        const order = [];
        cleanups.push(registerSyncHooks({
            beforeSnapshot: async owner => { order.push(['before', owner.userRoot]); },
            afterReconcile: async (owner, report) => { order.push(['after', report.written]); },
        }));
        const B = await device();
        await scheduler().trigger(ownerOf(d), 'r1', 'manual');
        await scheduler().trigger(ownerOf(B), 'r1', 'manual');
        expect(order).toEqual([['before', d.userRoot], ['before', B.userRoot], ['after', ['characters/a.png']]]);
    });

    test('an unknown backend id yields UNKNOWN_BACKEND', async () => {
        const d = await device();
        expect(await scheduler().trigger(ownerOf(d), 'nope', 'manual')).toMatchObject({ ok: false, code: 'UNKNOWN_BACKEND' });
    });

    test('removing a backend waits for its run and stays removed', async () => {
        const d = await device();
        d.write('characters/a.png', 'A');
        const s = scheduler();
        const held = gate();
        gates.r1 = held;
        const run = s.trigger(ownerOf(d), 'r1', 'manual');
        await held.reached;
        const removal = s.removeBackend(ownerOf(d), 'r1');
        expect(await s.trigger(ownerOf(d), 'r1', 'idle')).toMatchObject({ ok: false, code: 'UNKNOWN_BACKEND' });
        held.release();
        await Promise.all([run, removal]);
        expect((await readRegistry({ userRoot: d.userRoot })).backends.r1).toBeUndefined();
        expect(fs.existsSync(getShadowPaths({ userRoot: d.userRoot, peerId: 'r1' }).peerDir)).toBe(false);
    });

    test('a run that ends during removal records no lastSync', async () => {
        const d = await device();
        d.write('characters/a.png', 'A');
        const s = scheduler();
        const held = gate();
        gates.r1 = held;
        const run = s.trigger(ownerOf(d), 'r1', 'manual');
        await held.reached;
        const removal = s.removeBackend(ownerOf(d), 'r1');
        let releaseShadow;
        const shadowHeld = s.withShadowLock(d.userRoot, 'r1', () => new Promise(resolve => { releaseShadow = resolve; }));
        held.release();
        expect(await run).toMatchObject({ ok: false, code: 'UNKNOWN_BACKEND' });
        expect((await readRegistry({ userRoot: d.userRoot })).backends.r1.lastSync.at).toBeNull();
        releaseShadow();
        await Promise.all([shadowHeld, removal]);
        expect((await readRegistry({ userRoot: d.userRoot })).backends.r1).toBeUndefined();
    });

    test('conflicts sum the incoming step and the network step', async () => {
        const { runSyncCycle } = await import('../../../src/sync/pipeline/cycle.js');
        const d = await device();
        const s = scheduler({ makeIncomingBackend: (owner, id) => new IncomingRefBackend({ id, userRoot: owner.userRoot }) });
        d.write('worlds/w.json', 'B0');
        await s.trigger(ownerOf(d), 'r1', 'manual');
        const A = makeDevice({ remoteDir: remotes.r1 });
        cleanups.push(() => A.cleanup());
        const ctxA = { ...A.ctx, backendId: 'r1', backend: new DirectoryBackend({ id: 'r1', remoteDir: remotes.r1, userRoot: A.userRoot }) };
        await runSyncCycle(ctxA);
        A.write('worlds/w.json', 'A1');
        await runSyncCycle({ ...ctxA, backend: new DirectoryBackend({ id: 'r1', remoteDir: remotes.r1, userRoot: A.userRoot }) });
        d.write('worlds/w.json', 'B1');
        expect(await s.trigger(ownerOf(d), 'r1', 'manual')).toMatchObject({ ok: true, conflicts: 1 });
    });
    test('conflicts of a merge whose push lost the race still count', async () => {
        const { runSyncCycle } = await import('../../../src/sync/pipeline/cycle.js');
        const d = await device();
        const s = scheduler();
        d.write('worlds/w.json', 'B0');
        await s.trigger(ownerOf(d), 'r1', 'manual');
        const A = makeDevice({ remoteDir: remotes.r1 });
        cleanups.push(() => A.cleanup());
        const cycleA = () => runSyncCycle({ ...A.ctx, backendId: 'r1', backend: new DirectoryBackend({ id: 'r1', remoteDir: remotes.r1, userRoot: A.userRoot }) });
        await cycleA();
        A.write('worlds/w.json', 'A1');
        await cycleA();
        d.write('worlds/w.json', 'B1');
        backendHooks.r1 = {
            beforeCasHead: async () => {
                A.write('characters/other.png', 'O');
                await cycleA();
            },
        };
        readHeads.r1 = 0;
        expect(await s.trigger(ownerOf(d), 'r1', 'manual')).toMatchObject({ ok: true, conflicts: 1, outcome: { status: 'synced', pushed: true } });
        expect(readHeads.r1).toBe(2);
        expect(d.read('characters/other.png')).toBe('O');
    });

    test('a rerun yields to maintenance retaining its conflicts and original manual waiter', async () => {
        const { runSyncCycle } = await import('../../../src/sync/pipeline/cycle.js');
        const d = await device();
        const s = scheduler();
        d.write('worlds/w.json', 'B0');
        await s.trigger(ownerOf(d), 'r1', 'manual');
        const A = makeDevice({ remoteDir: remotes.r1 }); cleanups.push(A.cleanup);
        const cycleA = () => runSyncCycle({ ...A.ctx, backendId: 'r1', backend: new DirectoryBackend({ id: 'r1', remoteDir: remotes.r1, userRoot: A.userRoot }) });
        await cycleA(); A.write('worlds/w.json', 'A1'); await cycleA();
        d.write('worlds/w.json', 'B1');
        const held = gate();
        let maintenance;
        let next;
        let completed = false;
        const before = (await readRegistry({ userRoot: d.userRoot })).backends.r1.lastSync;
        backendHooks.r1 = { beforeCasHead: async () => {
            A.write('characters/other.png', 'O'); await cycleA();
            maintenance = s.withBackendMaintenance(ownerOf(d), 'r1', async () => {
                expect(completed).toBe(false);
                expect((await readRegistry({ userRoot: d.userRoot })).backends.r1.lastSync).toEqual(before);
                await held.wait();
            });
            next = s.trigger(ownerOf(d), 'r1', 'manual');
        } };
        readHeads.r1 = 0;
        const first = s.trigger(ownerOf(d), 'r1', 'manual').then(result => { completed = true; return result; });
        await held.reached;
        expect(readHeads.r1).toBe(1);
        held.release(); await maintenance;
        expect(await first).toMatchObject({ ok: true, conflicts: 1 });
        expect(await next).toMatchObject({ ok: true, conflicts: 0 });
        expect(readHeads.r1).toBe(3);
    });
});
