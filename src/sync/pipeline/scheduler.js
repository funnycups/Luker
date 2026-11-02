import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';

import { syncError } from '../errors.js';
import { setDirtyListener } from '../in-progress-gate.js';
import { closeSyncSessionsFor } from '../session.js';
import { readRegistry, recordLastSync, removeBackendCompletely, resolveDeviceLabel } from '../state.js';
import { createConflictPolicy } from './conflict-policy.js';
import { runSyncCycle } from './cycle.js';
import { runAfterReconcile, runBeforeSnapshot } from './sync-hooks.js';

/** @typedef {import('./sync-hooks.js').SyncOwner} SyncOwner */
/** @typedef {import('./cycle.js').CycleOutcome} CycleOutcome */
/**
 * @typedef {object} OperationLease
 * @property {() => Promise<void>} assertAlive Rejects removal, not pending maintenance.
 * @property {<T>(fn: () => Promise<T>) => Promise<T>} withLocal Checks liveness inside the shadow lock.
 * @property {() => Promise<import('./local-ops.js').LocalContext>} context Loads once within this admission.
 */
/**
 * @typedef {{ ok: true, outcome: CycleOutcome | null, conflicts: number, stalled: string[] | null } | { ok: false, code: string, message: string }} RunResult
 */

const MS_PER_SECOND = 1000;

/**
 * Run sync cycles per backend of each user. A trigger during a run of the
 * same backend coalesces into one follow-up run; backends run
 * independently of each other.
 *
 * @param {{
 *   makeBackend: (owner: SyncOwner, backendId: string, entry: object, registry: object, options: {lease: OperationLease}) => object,
 *   makeIncomingBackend: (owner: SyncOwner, backendId: string, entry: object) => object | null,
 *   listOwners: () => Promise<SyncOwner[]>,
 *   getEngine: () => object,
 *   timers?: { setTimeout: Function, clearTimeout: Function },
 *   now?: () => number,
 * }} deps
 */
export function createScheduler({ makeBackend, makeIncomingBackend, listOwners, getEngine, timers = { setTimeout, clearTimeout }, now = Date.now }) {
    const states = new Map();
    const locks = new Map();
    const owners = new Map();
    const schedules = new Map();
    const idleTimers = new Map();
    const lastDirtyAt = new Map();
    const pollTimers = new Map();
    const maintenanceScope = new AsyncLocalStorage();
    let started = false;
    let stopped = false;
    // Dirty marks from the write gate carry the resolved root, so every
    // per-user map is keyed by it.
    const rootOf = userRoot => path.resolve(userRoot);
    const keyOf = (userRoot, backendId) => `${rootOf(userRoot)}\u0000${backendId}`;

    function stateOf(userRoot, backendId) {
        const key = keyOf(userRoot, backendId);
        if (!states.has(key)) states.set(key, { userRoot: rootOf(userRoot), backendId, running: false, operations: 0, rerun: false, removing: false, waiters: [], changed: [], controls: [], activeControl: null, continuation: null });
        return states.get(key);
    }

    const unknown = id => syncError('UNKNOWN_BACKEND', `No sync backend ${id}`);
    const controlled = state => Boolean(state.activeControl || state.controls.length);
    function changed(state) {
        for (const resolve of state.changed.splice(0)) resolve();
    }
    const waitForChange = state => new Promise(resolve => state.changed.push(resolve));

    function pumpControl(owner, state) {
        if (state.removing || state.activeControl || state.operations || !state.controls.length) return;
        const token = state.controls.shift();
        state.activeControl = token;
        const run = withShadowLock(owner.userRoot, state.backendId, async () => {
            if (state.removing) throw unknown(state.backendId);
            const registry = await readRegistry({ userRoot: owner.userRoot });
            if (state.removing || (!token.allowMissing && !registry.backends[state.backendId])) throw unknown(state.backendId);
            const commit = { assertAlive() { if (state.removing) throw unknown(state.backendId); } };
            return maintenanceScope.run(keyOf(owner.userRoot, state.backendId), () => token.fn(registry, commit));
        });
        const finish = () => {
            state.activeControl = null;
            changed(state);
            pumpControl(owner, state);
            kickDrive(owner, state);
        };
        run.then(value => { finish(); token.resolve(value); }, error => { finish(); token.reject(error); });
    }

    // Admission and control transitions are synchronous. Counters cover
    // context reads as well as network work; they never hold a local lock.
    function admit(owner, backendId, state) {
        if (state.removing) throw unknown(backendId);
        state.operations += 1;
        let released = false;
        const assertAlive = async () => {
            if (released || state.removing) throw unknown(backendId);
            const registry = await readRegistry({ userRoot: owner.userRoot });
            if (released || state.removing || !registry.backends[backendId]) throw unknown(backendId);
        };
        let loaded;
        const lease = {
            assertAlive,
            withLocal: async fn => {
                await assertAlive();
                return withShadowLock(owner.userRoot, backendId, async () => {
                    await assertAlive();
                    return fn();
                });
            },
            context: async () => {
                await assertAlive();
                loaded ??= loadContext(owner, backendId, lease);
                return (await loaded).ctx;
            },
        };
        return { lease, release() {
            if (released) return;
            released = true;
            state.operations -= 1;
            changed(state);
            pumpControl(owner, state);
            kickDrive(owner, state);
        } };
    }

    async function acquire(owner, backendId) {
        const state = stateOf(owner.userRoot, backendId);
        for (;;) {
            if (state.removing) throw unknown(backendId);
            if (!controlled(state)) return admit(owner, backendId, state);
            await waitForChange(state);
        }
    }

    /**
     * @template T
     * @param {SyncOwner} owner
     * @param {string} backendId
     * @param {'drive'|'local-step'|'local-mutation'|'prepare'} kind
     * @param {(lease: OperationLease) => Promise<T>} fn
     * @returns {Promise<T>}
     */
    async function withBackendOperation(owner, backendId, kind, fn) {
        const admission = await acquire(owner, backendId);
        try {
            await admission.lease.assertAlive();
            return await fn(admission.lease);
        } finally { admission.release(); }
    }

    async function withIncomingOfferOperation(owner, backendId, fn) {
        const state = stateOf(owner.userRoot, backendId);
        if (state.removing) throw syncError('PEER_FORGOTTEN', `No sync backend ${backendId}`);
        if (controlled(state)) throw syncError('SYNC_BACKEND_MAINTENANCE', 'The sync backend is undergoing maintenance');
        const admission = admit(owner, backendId, state);
        try {
            await admission.lease.assertAlive();
            return await fn(admission.lease);
        } finally { admission.release(); }
    }

    // Retain the state object, not just a registry existence check. Removal
    // invalidates it even after its map entry is cleared or recreated.
    function captureBackendIdentity(owner, backendId) {
        const state = stateOf(owner.userRoot, backendId);
        return { assertAlive() {
            if (state.removing || states.get(keyOf(owner.userRoot, backendId)) !== state) throw unknown(backendId);
        } };
    }

    function withBackendMaintenance(owner, backendId, fn, { allowMissing = false } = {}) {
        if (maintenanceScope.getStore() === keyOf(owner.userRoot, backendId)) return Promise.reject(syncError('SYNC_MAINTENANCE_REENTRANT', 'Cannot nest maintenance of the same backend'));
        const state = stateOf(owner.userRoot, backendId);
        if (state.removing) return Promise.reject(unknown(backendId));
        const promise = new Promise((resolve, reject) => state.controls.push({ fn, resolve, reject, allowMissing }));
        pumpControl(owner, state);
        return promise;
    }

    async function withLocalMutationContexts(owner, ids, fn, { requireAll = false, allowPreparationErrors = false } = {}) {
        const targets = [...new Set(ids)].sort();
        for (;;) {
            const admissions = [];
            let blocked = null;
            try {
                for (const id of targets) {
                    const state = stateOf(owner.userRoot, id);
                    if (state.removing) { if (requireAll) throw unknown(id); continue; }
                    if (controlled(state)) { blocked = state; break; }
                    admissions.push([id, admit(owner, id, state)]);
                }
                if (!blocked) {
                    const contexts = new Map();
                    for (const [id, { lease }] of admissions) {
                        try {
                            contexts.set(id, await lease.context());
                        } catch (error) {
                            if (requireAll) throw error;
                            if (error?.code === 'UNKNOWN_BACKEND') continue;
                            if (!allowPreparationErrors) throw error;
                            // Pending aggregation must see this backend, but no
                            // failed preparation may supply a mutable context.
                            const reject = async () => { throw error; };
                            contexts.set(id, { lease: { ...lease, withLocal: reject, context: reject }, withRead: reject, withMutation: reject, lockShadow: reject });
                        }
                    }
                    return await fn(contexts);
                }
            } finally { for (const [, admission] of admissions) admission.release(); }
            // Never retain an earlier backend's lease across this wait:
            // its maintenance could be waiting for this grouped mutation.
            if (!blocked.removing && controlled(blocked)) await waitForChange(blocked);
        }
    }

    function withShadowLock(userRoot, backendId, fn) {
        const key = keyOf(userRoot, backendId);
        const run = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
        const tail = run.catch(() => undefined);
        locks.set(key, tail);
        tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
        return run;
    }

    async function loadContext(owner, backendId, lease = null) {
        const registry = await readRegistry({ userRoot: owner.userRoot });
        const entry = registry.backends[backendId];
        if (!entry) throw syncError('UNKNOWN_BACKEND', `No sync backend ${backendId}`);
        if (entry.kind === 's3' && lease) {
            const backend = makeBackend(owner, backendId, entry, registry, { lease });
            try { await backend.prepareLocal(); } finally { await backend.close(); }
        }
        const ctx = {
            userRoot: owner.userRoot, handle: owner.handle, directories: owner.directories, backendId,
            categories: [...entry.categories], engine: owner.engine ?? getEngine(),
            lockShadow: fn => lease ? lease.withLocal(fn) : withBackendOperation(owner, backendId, 'local-mutation', admitted => admitted.withLocal(fn)),
            lease,
            withRead: fn => lease ? lease.withLocal(fn) : withBackendOperation(owner, backendId, 'local-mutation', async admitted => {
                await admitted.context();
                return admitted.withLocal(fn);
            }),
            withMutation: async fn => {
                if (!lease) return withBackendOperation(owner, backendId, 'local-mutation', async admitted => fn(await admitted.context()));
                await lease.assertAlive();
                return fn(ctx);
            },
            withMutationContexts: (ids, fn, options) => withLocalMutationContexts(owner, ids, fn, options),
            beforeSnapshot: () => runBeforeSnapshot(owner),
            onLiveApplied: report => runAfterReconcile(owner, report),
            getDeviceLabel: async () => resolveDeviceLabel(await readRegistry({ userRoot: owner.userRoot }), owner),
            onConflicts: createConflictPolicy({ directories: owner.directories }),
        };
        return { ctx, entry, registry };
    }

    // Reruns continue while they make progress. Two live-changed reruns in a
    // row with the same snapshot and the same skipped paths mean nothing
    // outside sync is changing those paths, so another run would repeat. Two
    // remote-moved reruns in a row with the same remote head and ETag mean the
    // provider keeps refusing the same conditional write.
    //
    // Conflicts count once per cycle that moved main past them: a synced
    // cycle, or a remote-moved one whose merge was applied before its push
    // lost the race. A live-changed or local-moved cycle leaves main where
    // it was, so the next cycle reports the same conflicts again; only a
    // final live-changed outcome counts.
    async function settle(ctx, state, progress = { previous: null, remote: null, conflicts: 0 }, allowYield = true) {
        let { previous, remote, conflicts } = progress;
        for (;;) {
            if (state.removing) throw syncError('UNKNOWN_BACKEND', `Sync backend ${ctx.backendId} is being removed`);
            const outcome = await runSyncCycle(ctx);
            if (outcome.status !== 'rerun') return { outcome, stalled: null, conflicts: conflicts + outcome.conflicts.length };
            if (outcome.reason === 'remote-moved') {
                conflicts += outcome.conflicts.length;
                const current = { remoteHead: outcome.remoteHead, remoteEtag: outcome.remoteEtag ?? null };
                if (remote && remote.remoteHead === current.remoteHead && remote.remoteEtag === current.remoteEtag) {
                    throw syncError('SYNC_NO_PROGRESS', 'The remote head did not change across conditional-write retries');
                }
                remote = current;
                previous = null;
            } else if (outcome.reason === 'live-changed') {
                remote = null;
                const current = { localHead: outcome.localHead, skipped: [...outcome.reconcile.skipped].sort() };
                if (previous && previous.localHead === current.localHead && isDeepStrictEqual(previous.skipped, current.skipped)) {
                    return { outcome, stalled: current.skipped, conflicts: conflicts + outcome.conflicts.length };
                }
                previous = current;
            } else {
                previous = null;
                remote = null;
            }
            if (allowYield && controlled(state)) return { kind: 'yielded', progress: { previous, remote, conflicts } };
            await new Promise(resolve => setImmediate(resolve));
        }
    }

    /**
     * A backend being removed records no `lastSync`: its entry is deleted
     * once the run ends.
     *
     * @returns {Promise<RunResult>}
     */
    async function runOnce(owner, backendId, { network = true, lease, continuation = null } = {}) {
        const recordingIdentity = captureBackendIdentity(owner, backendId);
        try {
            const ctx = await lease.context();
            const { backends, ...rest } = await readRegistry({ userRoot: owner.userRoot });
            const entry = backends[backendId];
            const registry = { ...rest, backends };
            await lease.assertAlive();
            const state = stateOf(owner.userRoot, backendId);
            let conflicts = continuation?.conflicts ?? 0;
            let last = continuation?.last ?? { outcome: null, stalled: null };
            let stepKind = continuation?.stepKind ?? 'incoming';
            const incoming = makeIncomingBackend(owner, backendId, entry);
            if (incoming && stepKind === 'incoming') {
                const step = await settle({ ...ctx, backend: incoming }, state, continuation?.progress, network);
                if (step.kind === 'yielded') return { kind: 'yielded', continuation: { stepKind, conflicts, last, progress: step.progress } };
                conflicts += step.conflicts;
                last = { outcome: step.outcome, stalled: step.stalled };
            }
            if (network) {
                if (stepKind === 'incoming' && controlled(state)) return { kind: 'yielded', continuation: { stepKind: 'network', conflicts, last } };
                stepKind = 'network';
                const backend = makeBackend(owner, backendId, entry, registry, { lease });
                backend.lease = lease;
                try {
                    const step = await settle({ ...ctx, backend }, state, continuation?.stepKind === 'network' ? continuation.progress : undefined);
                    if (step.kind === 'yielded') return { kind: 'yielded', continuation: { stepKind, conflicts, last, progress: step.progress } };
                    conflicts += step.conflicts;
                    last = { outcome: step.outcome, stalled: step.stalled ?? last.stalled };
                } finally {
                    if (typeof backend.close === 'function') await backend.close();
                }
                await lease.assertAlive();
                await recordLastSync({ userRoot: owner.userRoot, backendId, assertAlive: recordingIdentity.assertAlive, success: { head: last.outcome?.localHead ?? null, mergeCase: last.outcome?.mergeCase ?? null, stalled: last.stalled } });
            }
            return { ok: true, outcome: last.outcome, conflicts, stalled: last.stalled };
        } catch (error) {
            const code = typeof error?.code === 'string' && error.code ? error.code : 'SYNC_FAILED';
            const message = String(error?.message || error);
            if (network && code !== 'UNKNOWN_BACKEND' && !isRemoving(owner.userRoot, backendId)) {
                try {
                    await recordLastSync({ userRoot: owner.userRoot, backendId, assertAlive: recordingIdentity.assertAlive, error: { code, message } });
                } catch (recordError) {
                    if (recordError?.code === 'UNKNOWN_BACKEND') return { ok: false, code: recordError.code, message: recordError.message };
                    console.error('[sync] could not record a sync error', recordError);
                }
            }
            return { ok: false, code, message };
        }
    }

    async function drive(owner, backendId, state) {
        state.running = true;
        const pending = state.continuation;
        state.continuation = null;
        const waiters = pending?.waiters ?? state.waiters.splice(0);
        if (!pending) state.rerun = false;
        try {
            const result = await withBackendOperation(owner, backendId, 'drive', lease => runOnce(owner, backendId, { lease, continuation: pending?.continuation }));
            if (result.kind === 'yielded' && state.removing) {
                for (const resolve of waiters) resolve({ ok: false, code: 'UNKNOWN_BACKEND', message: `No sync backend ${backendId}` });
            } else if (result.kind === 'yielded') state.continuation = { continuation: result.continuation, waiters };
            else for (const resolve of waiters) resolve(result);
        } catch (error) {
            for (const resolve of waiters) resolve({ ok: false, code: error?.code || 'SYNC_FAILED', message: String(error?.message || error) });
        } finally {
            state.running = false;
            changed(state);
            kickDrive(owner, state);
        }
    }

    function kickDrive(owner, state) {
        if (state.running || controlled(state) || state.removing) return;
        if (state.continuation || state.rerun || state.waiters.length) drive(owner, state.backendId, state).catch(error => console.error('[sync] drive failed', error));
    }

    /**
     * A backend missing from the registry gets `UNKNOWN_BACKEND` and no
     * state.
     *
     * @param {SyncOwner} owner
     * @param {string} backendId
     * @param {string} reason
     * @returns {Promise<RunResult>}
     */
    async function trigger(owner, backendId, reason, { waitForResult = true } = {}) {
        rememberOwner(owner);
        const unknown = { ok: false, code: 'UNKNOWN_BACKEND', message: `No sync backend ${backendId}` };
        if (isRemoving(owner.userRoot, backendId)) return unknown;
        const { backends } = await readRegistry({ userRoot: owner.userRoot });
        if (!backends[backendId]) return unknown;
        const state = stateOf(owner.userRoot, backendId);
        if (state.removing) return unknown;
        const result = waitForResult ? new Promise(resolve => state.waiters.push(resolve)) : null;
        state.rerun = true;
        kickDrive(owner, state);
        return result;
    }

    async function triggerAll(owner, reason, options) {
        const { backends } = await readRegistry({ userRoot: owner.userRoot });
        return Promise.all(Object.keys(backends).map(backendId => trigger(owner, backendId, reason, options)));
    }

    /**
     * Apply what LAN peers pushed to this device without contacting any
     * peer. Runs beside a network step of the same backend; the shadow
     * lock orders their sections.
     *
     * @returns {Promise<RunResult>}
     */
    async function runLocalStep(owner, backendId, lease = null) {
        rememberOwner(owner);
        try {
            if (lease) return await runOnce(owner, backendId, { network: false, lease });
            return await withBackendOperation(owner, backendId, 'local-step', admitted => runOnce(owner, backendId, { network: false, lease: admitted }));
        } catch (error) {
            return { ok: false, code: error?.code || 'SYNC_FAILED', message: String(error?.message || error) };
        }
    }

    function removeBackend(owner, backendId) {
        const state = stateOf(owner.userRoot, backendId);
        if (state.removal) return state.removal;
        state.removing = true;
        const result = { ok: false, code: 'UNKNOWN_BACKEND', message: `No sync backend ${backendId}` };
        for (const resolve of state.waiters.splice(0)) resolve(result);
        if (state.continuation) for (const resolve of state.continuation.waiters) resolve(result);
        state.continuation = null;
        state.rerun = false;
        for (const token of state.controls.splice(0)) token.reject(unknown(backendId));
        changed(state);
        closeSyncSessionsFor({ userRoot: owner.userRoot, peerId: backendId });
        state.removal = (async () => {
            while (state.operations || state.activeControl) await waitForChange(state);
            await withShadowLock(owner.userRoot, backendId, () => removeBackendCompletely({ userRoot: owner.userRoot, backendId }));
            if (!(await readRegistry({ userRoot: owner.userRoot })).backends[backendId]) {
                const key = keyOf(owner.userRoot, backendId);
                if (states.get(key) === state) states.delete(key);
            }
        })();
        return state.removal;
    }

    function isRemoving(userRoot, backendId) {
        return states.get(keyOf(userRoot, backendId))?.removing === true;
    }

    // Only a started service polls.
    function armPoll(owner) {
        if (!started) return;
        const root = rootOf(owner.userRoot);
        const schedule = schedules.get(root);
        if (pollTimers.has(root)) timers.clearTimeout(pollTimers.get(root));
        pollTimers.delete(root);
        if (!schedule) return;
        pollTimers.set(root, timers.setTimeout(async () => {
            pollTimers.delete(root);
            try {
                await triggerAll(owner, 'poll', { waitForResult: false });
            } catch (error) {
                console.error('[sync] poll failed', error);
            } finally {
                if (!stopped) armPoll(owner);
            }
        }, schedule.pollSeconds * MS_PER_SECOND));
    }

    async function reschedule(owner) {
        const { schedule } = await readRegistry({ userRoot: owner.userRoot });
        const root = rootOf(owner.userRoot);
        const previous = schedules.get(root);
        schedules.set(root, { ...schedule });
        armPoll(owner);
        if (idleTimers.has(root) && previous?.idleSeconds !== schedule.idleSeconds) armIdle(root);
    }

    // The idle delay counts from the last dirty mark, also when a saved
    // schedule re-arms a pending timer.
    function armIdle(userRoot) {
        const owner = owners.get(userRoot);
        const schedule = schedules.get(userRoot);
        const delay = Math.max(0, schedule.idleSeconds * MS_PER_SECOND - (now() - lastDirtyAt.get(userRoot)));
        if (idleTimers.has(userRoot)) timers.clearTimeout(idleTimers.get(userRoot));
        idleTimers.set(userRoot, timers.setTimeout(() => {
            idleTimers.delete(userRoot);
            return triggerAll(owner, 'idle').catch(error => console.error('[sync] idle sync failed', error));
        }, delay));
    }

    function markDirty({ userRoot: dirtyRoot }) {
        const userRoot = rootOf(dirtyRoot);
        const owner = owners.get(userRoot);
        if (!owner) return;
        const schedule = schedules.get(userRoot);
        if (!schedule) {
            reschedule(owner)
                .then(() => markDirty({ userRoot }))
                .catch(error => console.error('[sync] could not read the sync schedule', error));
            return;
        }
        if (stopped) return;
        lastDirtyAt.set(userRoot, now());
        armIdle(userRoot);
    }

    function rememberOwner(owner) {
        owners.set(rootOf(owner.userRoot), owner);
        if (started && !pollTimers.has(rootOf(owner.userRoot))) {
            reschedule(owner).catch(error => console.error('[sync] could not schedule sync', error));
        }
    }

    function ownerFor(userRoot) {
        return owners.get(rootOf(userRoot)) ?? null;
    }

    async function start() {
        started = true;
        stopped = false;
        setDirtyListener(markDirty);
        for (const owner of await listOwners()) {
            owners.set(rootOf(owner.userRoot), owner);
            await reschedule(owner);
            triggerAll(owner, 'startup').catch(error => console.error('[sync] startup sync failed', error));
        }
    }

    function stop() {
        stopped = true;
        started = false;
        setDirtyListener(null);
        for (const timer of idleTimers.values()) timers.clearTimeout(timer);
        for (const timer of pollTimers.values()) timers.clearTimeout(timer);
        idleTimers.clear();
        pollTimers.clear();
    }

    function getRunning(userRoot) {
        const running = {};
        const root = rootOf(userRoot);
        for (const state of states.values()) {
            if (state.userRoot === root) running[state.backendId] = state.running;
        }
        return running;
    }

    async function contextFor(owner, backendId) {
        return (await loadContext(owner, backendId)).ctx;
    }

    return {
        start, stop, rememberOwner, ownerFor, trigger, triggerAll, markDirty, runLocalStep,
        withShadowLock, contextFor, reschedule, removeBackend, isRemoving, getRunning,
        withBackendOperation, withIncomingOfferOperation, withBackendMaintenance, withLocalMutationContexts,
        captureBackendIdentity,
    };
}
