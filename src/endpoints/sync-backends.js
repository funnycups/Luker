/**
 * Routes the user's own browser uses to manage the sync backends and the
 * schedule. Mounted by `createSyncRouter`; every route needs a logged-in
 * user and acts only on that user's registry.
 */
import express from 'express';
import { syncError } from '../sync/errors.js';

import { buildConflictView, readConflictValue } from '../sync/conflict-diff/index.js';
import { applyConflictChoices, dismissNotices, isConflictChoiceList, undoLastSync } from '../sync/pipeline/local-ops.js';
import { readPendingState } from '../sync/pipeline/pending-status.js';
import { readBlobBytes } from '../sync/pipeline/git-tree.js';
import { assertSafePeerId, getShadowPaths } from '../sync/shadow.js';
import { assertSafeBackendId, clearLanPeerAuth, readRegistry, sanitizeRegistryForClient, setBackendSettings, setSchedule } from '../sync/state.js';
import { defaultUserStore, ownerFromUser, syncService } from '../sync/sync-service.js';

/** HTTP status of each sync failure code a route reports. */
const STATUS_BY_CODE = Object.freeze({
    S3_SETTINGS_INVALID: 400,
    INVALID_DEVICE_LABEL: 400,
    INVALID_BACKEND_SETTINGS: 400,
    S3_KEYINFO_INVALID: 400,
    S3_HEAD_INVALID: 400,
    S3_FORMAT_UNSUPPORTED: 400,
    S3_WRONG_PASSPHRASE: 422,
    CONDITIONAL_WRITES_UNSUPPORTED: 422,
    S3_IF_MATCH_QUOTES_UNSUPPORTED: 422,
    S3_STORED_KEY_INVALID: 409,
    S3_STORED_KEY_REJECTED: 409,
    S3_LOCAL_KEY_ID_INVALID: 409,
    S3_KEY_MISMATCH: 409,
    S3_KEYINFO_MISSING: 409,
    S3_SETTINGS_CHANGED: 409,
    PRECONDITION_FAILED: 409,
    S3_INCOMPLETE_OBJECTS: 409,
    S3_OBJECT_AUTH_FAILED: 409,
    S3_PACK_INVALID: 409,
    SYNC_PRIVATE_ADDRESS: 403,
    AUTH_FAILED: 401,
    BUCKET_NOT_FOUND: 404,
    UNREACHABLE: 502,
    SYNC_DNS_ERROR: 502,
    S3_PROVIDER_ERROR: 502,
    S3_SOURCE_ERROR: 502,
    SYNC_NO_PROGRESS: 502,
    INVALID_BACKEND_ID: 400,
    INVALID_CATEGORIES: 400,
    INVALID_CHOICES: 400,
    INVALID_PATHS: 400,
    INVALID_SCHEDULE: 400,
    PEER_AUTH_FAILED: 401,
    PEER_AUTH_REQUIRED: 401,
    PEER_FORGOTTEN: 404,
    UNKNOWN_BACKEND: 404,
    NO_BACKUP_TAG: 404,
    NO_BASE_URL: 409,
    SYNC_BACKEND_MAINTENANCE: 409,
    BACKEND_KIND_MISMATCH: 409,
    HANDLE_MISMATCH: 412,
    PEER_PROTOCOL_OUTDATED: 426,
    PEER_UNREACHABLE: 502,
});

/**
 * @param {string} code
 * @returns {number}
 */
export function statusForSyncCode(code) {
    return STATUS_BY_CODE[code] ?? 500;
}

/**
 * Undecided conflicts of one backend. A backend removed after its run
 * finished holds none.
 *
 * @param {import('../sync/pipeline/sync-hooks.js').SyncOwner} owner
 * @param {string} backendId
 * @returns {Promise<number>}
 */
async function countPendingConflicts(owner, backendId) {
    let ctx;
    try {
        ctx = await syncService.contextFor(owner, backendId);
    } catch (error) {
        if (error?.code === 'UNKNOWN_BACKEND') return 0;
        throw error;
    }
    const pending = await readPendingState(new Map([[backendId, ctx]]));
    if (pending.errors[backendId]) throw syncError('PENDING_READ_FAILED', pending.errors[backendId].message);
    return pending.conflicts.length;
}

/**
 * The response to a sync the user started: the run result, the backend's
 * recorded `lastSync`, and `pendingConflicts`, the conflicts the backend
 * holds undecided. A run that merges nothing can still leave conflicts
 * pending that another run recorded.
 *
 * @param {import('../sync/pipeline/sync-hooks.js').SyncOwner} owner
 * @param {string} backendId
 * @param {import('../sync/pipeline/scheduler.js').RunResult} result
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function syncResponse(owner, backendId, result) {
    if (!result.ok) return { status: statusForSyncCode(result.code), body: { ok: false, code: result.code, error: result.message } };
    const lastSync = (await readRegistry({ userRoot: owner.userRoot })).backends[backendId]?.lastSync ?? null;
    return { status: 200, body: { ok: true, lastSync, conflicts: result.conflicts, pendingConflicts: await countPendingConflicts(owner, backendId), stalled: result.stalled } };
}

const OID_PATTERN = /^[a-f0-9]{40}$/;

/**
 * An empty query value means a deleted side, an absent one is invalid and
 * a malformed one is false. The route reports each case differently.
 */
function queryOid(value) {
    if (typeof value !== 'string') return undefined;
    if (value === '') return null;
    const oid = value.toLowerCase();
    return OID_PATTERN.test(oid) ? oid : false;
}

const isPathList = paths => Array.isArray(paths) && paths.every(item => typeof item === 'string');

/**
 * Local contexts of every backend of the owner, keyed by backend id. A
 * backend being removed is left out.
 *
 * @param {import('../sync/pipeline/sync-hooks.js').SyncOwner} owner
 * @param {object} registry
 */
async function contextsOf(owner, registry) {
    const ctxByBackend = new Map();
    for (const backendId of Object.keys(registry.backends)) {
        if (syncService.isRemoving(owner.userRoot, backendId)) continue;
        try {
            ctxByBackend.set(backendId, await syncService.contextFor(owner, backendId));
        } catch (error) {
            if (error?.code !== 'UNKNOWN_BACKEND') throw error;
        }
    }
    return ctxByBackend;
}

/**
 * Sync each backend in the background, so the local edit reaches the
 * other devices without the response waiting for them.
 */
function triggerInBackground(owner, backendIds) {
    for (const backendId of new Set(backendIds)) {
        syncService.trigger(owner, backendId, 'manual').catch(error => console.error(`[sync] run of ${backendId} failed`, error));
    }
}

function sendError(response, error) {
    const code = typeof error?.code === 'string' && error.code ? error.code : 'SYNC_FAILED';
    const status = statusForSyncCode(code);
    if (status === 500) console.error('[sync] backend route failed', error);
    return response.status(status).json({ code, error: String(error?.message || error) });
}

/**
 * @param {{ userStore?: typeof defaultUserStore }} [options]
 * @returns {import('express').Router}
 */
export function createBackendsRouter({ userStore = defaultUserStore } = {}) {
    const router = express.Router();

    /**
     * Resolve the logged-in user's owner, or answer 401.
     *
     * @returns {import('../sync/pipeline/sync-hooks.js').SyncOwner | null}
     */
    function ownerOf(request, response) {
        const user = request.user;
        if (!user?.profile?.handle || !user?.directories?.root) {
            response.status(401).json({ error: 'Auth required' });
            return null;
        }
        const owner = ownerFromUser(user, userStore);
        syncService.rememberOwner(owner);
        return owner;
    }

    /**
     * Read the two recorded versions of one conflict, or answer the
     * validation/backend/not-found error and return null. Shared by the
     * navigation and value routes so both see exactly the same blobs.
     */
    async function conflictVersions(request, response) {
        const owner = ownerOf(request, response);
        if (!owner) return null;
        const backendId = String(request.query.backendId ?? '');
        const relPath = typeof request.query.path === 'string' ? request.query.path : '';
        const ours = queryOid(request.query.ours);
        const theirs = queryOid(request.query.theirs);
        if (!backendId || !relPath || ours === undefined || theirs === undefined || ours === false || theirs === false || (ours === null && theirs === null)) {
            response.status(400).json({ code: 'INVALID_DIFF_REQUEST', error: 'Expected backendId, path and at least one version oid' });
            return null;
        }
        try {
            assertSafeBackendId(backendId);
            const registry = await readRegistry({ userRoot: owner.userRoot });
            if (!registry.backends[backendId]) {
                response.status(404).json({ code: 'UNKNOWN_BACKEND', error: `No sync backend ${backendId}` });
                return null;
            }
            const { gitDir } = getShadowPaths({ userRoot: owner.userRoot, peerId: backendId });
            const ctx = await syncService.contextFor(owner, backendId);
            const [left, right] = await ctx.withRead(() => Promise.all([
                ours === null ? null : readBlobBytes({ gitdir: gitDir, oid: ours }),
                theirs === null ? null : readBlobBytes({ gitdir: gitDir, oid: theirs }),
            ]));
            return { path: relPath, left, right };
        } catch (error) {
            if (error?.code === 'NotFoundError' || error?.code === 'ObjectTypeError') {
                response.status(404).json({ code: 'NOT_FOUND', error: 'Not found' });
                return null;
            }
            sendError(response, error);
            return null;
        }
    }

    router.get('/backends', async (request, response) => {
        const owner = ownerOf(request, response);
        if (!owner) return;
        try {
            const registry = await readRegistry({ userRoot: owner.userRoot });
            response.json({ ...sanitizeRegistryForClient(registry), running: syncService.getRunning(owner.userRoot) });
        } catch (error) {
            sendError(response, error);
        }
    });

    router.post('/backends/:id', express.json(), async (request, response) => {
        const owner = ownerOf(request, response);
        if (!owner) return;
        try {
            const backendId = String(request.params.id);
            assertSafeBackendId(backendId);
            if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)
                || Object.keys(request.body).some(field => !['label', 'categories'].includes(field))) {
                throw syncError('INVALID_BACKEND_SETTINGS', 'Only label and categories may be updated here');
            }
            await syncService.withBackendMaintenance(owner, backendId, (_registry, commit) => setBackendSettings({ userRoot: owner.userRoot, backendId, label: request.body?.label, categories: request.body?.categories, assertAlive: commit.assertAlive }));
            const registry = await readRegistry({ userRoot: owner.userRoot });
            response.json({ backend: sanitizeRegistryForClient(registry).backends[backendId] });
            triggerInBackground(owner, [backendId]);
        } catch (error) {
            sendError(response, error);
        }
    });

    /**
     * Remove a backend and its shadow. Idempotent. Any id that is safe as a
     * path segment is accepted, so an id that is not a valid ref component
     * can still be removed.
     */
    router.delete('/backends/:id', async (request, response) => {
        const owner = ownerOf(request, response);
        if (!owner) return;
        const backendId = String(request.params.id);
        try {
            assertSafePeerId(backendId);
        } catch (error) {
            return response.status(400).json({ code: 'INVALID_BACKEND_ID', error: error.message });
        }
        try {
            await syncService.removeBackend(owner, backendId);
            response.status(204).end();
        } catch (error) {
            sendError(response, error);
        }
    });

    router.delete('/backends/:id/auth', async (request, response) => {
        const owner = ownerOf(request, response);
        if (!owner) return;
        try {
            const backendId = String(request.params.id);
            assertSafeBackendId(backendId);
            try {
                await syncService.withBackendMaintenance(owner, backendId, (_registry, commit) => clearLanPeerAuth({ userRoot: owner.userRoot, backendId, assertAlive: commit.assertAlive }));
            } catch (error) { if (error?.code !== 'UNKNOWN_BACKEND') throw error; }
            response.json({ ok: true });
        } catch (error) {
            sendError(response, error);
        }
    });

    /**
     * Sync one backend now. A run already in progress is followed by one
     * more run, whose result this returns.
     */
    router.post('/backends/:id/sync', async (request, response) => {
        const owner = ownerOf(request, response);
        if (!owner) return;
        const backendId = String(request.params.id);
        try {
            assertSafeBackendId(backendId);
            const { status, body } = await syncResponse(owner, backendId, await syncService.trigger(owner, backendId, 'manual'));
            response.status(status).json(body);
        } catch (error) {
            if (error?.code === 'INVALID_BACKEND_ID') return response.status(400).json({ ok: false, code: error.code, error: error.message });
            sendError(response, error);
        }
    });

    /**
     * Pending conflicts and notices of every backend, and the state of
     * each backend.
     */
    router.get('/status', async (request, response) => {
        const owner = ownerOf(request, response);
        if (!owner) return;
        try {
            const registry = await readRegistry({ userRoot: owner.userRoot });
            const ctxByBackend = await contextsOf(owner, registry);
            const { conflicts, notices, errors } = await readPendingState(ctxByBackend);
            const running = syncService.getRunning(owner.userRoot);
            const backends = {};
            for (const [backendId, { kind, label, lastSync }] of Object.entries(sanitizeRegistryForClient(registry).backends)) {
                if (!ctxByBackend.has(backendId)) continue;
                backends[backendId] = { kind, label, running: Boolean(running[backendId]), lastSync: lastSync ?? null, pendingError: errors[backendId] ?? null };
            }
            response.json({ conflicts, notices, backends, errors, ok: Object.keys(errors).length === 0 });
        } catch (error) {
            sendError(response, error);
        }
    });

    /** Bytes of one blob in the shadow of a backend, such as a version a conflict recorded. */
    router.get('/blob/:backendId/:oid', async (request, response) => {
        const owner = ownerOf(request, response);
        if (!owner) return;
        const backendId = String(request.params.backendId);
        const oid = String(request.params.oid).toLowerCase();
        if (!OID_PATTERN.test(oid)) return response.status(400).json({ code: 'INVALID_OID', error: 'Invalid oid' });
        try {
            assertSafeBackendId(backendId);
            const registry = await readRegistry({ userRoot: owner.userRoot });
            if (!registry.backends[backendId]) return response.status(404).json({ code: 'UNKNOWN_BACKEND', error: `No sync backend ${backendId}` });
            const { gitDir } = getShadowPaths({ userRoot: owner.userRoot, peerId: backendId });
            const ctx = await syncService.contextFor(owner, backendId);
            const bytes = await ctx.withRead(() => readBlobBytes({ gitdir: gitDir, oid }));
            response.set('Content-Type', 'application/octet-stream');
            response.send(bytes);
        } catch (error) {
            if (error?.code === 'NotFoundError' || error?.code === 'ObjectTypeError') return response.status(404).json({ code: 'NOT_FOUND', error: 'Not found' });
            sendError(response, error);
        }
    });

    /**
     * The navigation tree of the two recorded versions. The browser never
     * receives full blobs or value text here, so a multi-megabyte preset
     * cannot stall layout. `secrets.json` values are masked before the
     * tree is built.
     */
    router.get('/conflicts/diff', async (request, response) => {
        const versions = await conflictVersions(request, response);
        if (!versions) return;
        response.json(buildConflictView(versions).view);
    });

    /**
     * One page of one node's value. The client asks only after the user
     * opens a field, and asks again with the returned `nextOffset` to
     * continue a cut value.
     */
    router.get('/conflicts/value', async (request, response) => {
        const nodeId = typeof request.query.nodeId === 'string' ? request.query.nodeId : '';
        if (!/^\d+$/.test(nodeId)) {
            return response.status(400).json({ code: 'INVALID_NODE', error: 'Expected a numeric nodeId' });
        }
        const offsetText = request.query.offset === undefined ? '0' : request.query.offset;
        const offset = typeof offsetText === 'string' && /^\d+$/.test(offsetText) ? Number(offsetText) : NaN;
        if (!Number.isSafeInteger(offset)) {
            return response.status(400).json({ code: 'INVALID_OFFSET', error: 'Expected a non-negative integer offset' });
        }
        const versions = await conflictVersions(request, response);
        if (!versions) return;
        try {
            response.json(readConflictValue({ ...versions, nodeId, offset }));
        } catch (error) {
            if (error?.code === 'UNKNOWN_NODE') return response.status(404).json({ code: 'UNKNOWN_NODE', error: error.message });
            if (error?.code === 'INVALID_OFFSET') return response.status(400).json({ code: 'INVALID_OFFSET', error: error.message });
            sendError(response, error);
        }
    });

    /** Body: `[{ path, choice, review }]`, binding the displayed preview and current versions. */
    router.post('/conflicts/resolve', express.json({ limit: '1mb' }), async (request, response) => {
        const owner = ownerOf(request, response);
        if (!owner) return;
        if (!isConflictChoiceList(request.body)) {
            return response.status(400).json({ code: 'INVALID_CHOICES', error: 'Conflict choices require distinct paths and the displayed record and current-version evidence. Refresh pending records before choosing.' });
        }
        try {
            const registry = await readRegistry({ userRoot: owner.userRoot });
            const choices = request.body;
            const results = await syncService.withLocalMutationContexts(owner, Object.keys(registry.backends), contexts => applyConflictChoices(contexts, choices), { allowPreparationErrors: true });
            triggerInBackground(owner, results.flatMap(result => result.committedBackends));
            const errors = Object.assign({}, ...results.map(result => result.errors));
            response.json({ ok: Object.keys(errors).length === 0, results, ...(Object.keys(errors).length ? { errors } : {}) });
        } catch (error) {
            sendError(response, error);
        }
    });

    /** Body: `{ paths }`, the notice paths to dismiss. */
    router.post('/notices/dismiss', express.json(), async (request, response) => {
        const owner = ownerOf(request, response);
        if (!owner) return;
        if (!isPathList(request.body?.paths)) {
            return response.status(400).json({ code: 'INVALID_PATHS', error: 'expected { paths } with a list of paths' });
        }
        try {
            const registry = await readRegistry({ userRoot: owner.userRoot });
            const results = await syncService.withLocalMutationContexts(owner, Object.keys(registry.backends), contexts => dismissNotices(contexts, request.body.paths), { allowPreparationErrors: true });
            triggerInBackground(owner, results.flatMap(result => result.committedBackends));
            const errors = Object.assign({}, ...results.map(result => result.errors));
            response.json({ ok: results.every(result => result.applied), results, ...(Object.keys(errors).length ? { errors } : {}) });
        } catch (error) {
            sendError(response, error);
        }
    });

    /**
     * Revert what the last sync of a backend changed, then sync it so the
     * revert reaches the other device.
     */
    router.post('/backends/:id/undo', async (request, response) => {
        const owner = ownerOf(request, response);
        if (!owner) return;
        const backendId = String(request.params.id);
        try {
            assertSafeBackendId(backendId);
            const undo = await syncService.withLocalMutationContexts(owner, [backendId], contexts => undoLastSync(contexts.get(backendId)), { requireAll: true });
            if (!undo.committed) return response.status(409).json({ ok: false, ...undo, code: 'UNDO_NOT_COMMITTED', error: 'The undo was not committed.', propagation: null });
            const propagation = await syncService.trigger(owner, backendId, 'manual');
            const lastSync = (await readRegistry({ userRoot: owner.userRoot })).backends[backendId]?.lastSync ?? null;
            if (!propagation.ok) return response.status(statusForSyncCode(propagation.code)).json({ ok: false, ...undo, propagation, lastSync, code: propagation.code, error: propagation.message });
            response.json({ ok: true, ...undo, propagation, lastSync });
        } catch (error) {
            sendError(response, error);
        }
    });

    router.post('/schedule', express.json(), async (request, response) => {
        const owner = ownerOf(request, response);
        if (!owner) return;
        try {
            const schedule = await setSchedule({ userRoot: owner.userRoot, idleSeconds: request.body?.idleSeconds, pollSeconds: request.body?.pollSeconds });
            await syncService.reschedule(owner);
            response.json({ schedule });
        } catch (error) {
            sendError(response, error);
        }
    });

    return router;
}
