/**
 * LAN-sync HTTP router.
 *
 * Mounted at `/api/sync/v1/`. Bearer-token auth is enforced per-route via
 * `requireSyncToken` for every `/session/*` path. The `/health` route is
 * gated only by the surrounding basic-auth middleware so a peer can probe
 * reachability without a sync token.
 *
 * See `docs/superpowers/specs/lan-sync.md` §2.2 / §2.4 for the protocol
 * shape and `src/middleware/basicAuth.js` for the matching bypass pattern
 * that lets `/session/*` requests skip basic auth (they carry their own
 * token instead).
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

import express from 'express';
import git from 'isomorphic-git';

import { readObjectForWire, writeObjectFromWire } from '../sync/objects.js';
import { ensureShadowRepo, snapshotLiveToShadow, reconcileShadowToLive, assertSafePeerId } from '../sync/shadow.js';
import { createSyncSession, closeSyncSession, consumeSyncSession } from '../sync/session.js';
import {
    runPull,
    syncQueueKey,
    queueOnKey,
    undoLastSync,
    snapshotSqliteIntoShadowIfNeeded,
    closeSqliteEngineHandleIfNeeded,
} from '../sync/orchestrator.js';
import { markSyncInProgress, clearSyncInProgress } from '../sync/in-progress-gate.js';
import { readSyncState, recordPeer, removePeerCompletely } from '../sync/state.js';
import { SYNC_CATEGORIES } from '../sync/categories.js';
import { getStorageEngine } from '../storage/index.js';
import { getRequestBaseUrl } from '../express-common.js';

export const router = express.Router();

const TOKEN_HEADER_PATTERN = /^Bearer\s+([a-f0-9]{64})$/i;

/**
 * 40-hex git object id. Lowercase canonical form; the matchers tolerate
 * mixed case on input and downstream code lowercases before any comparison.
 */
const OID_PATTERN = /^[a-f0-9]{40}$/i;

/**
 * Hard cap on the request body size for `POST /session/object`. Matches the
 * read-side limit in `src/sync/objects.js` so an oversized payload is
 * rejected by Express before it ever reaches our handler — otherwise an
 * attacker could exhaust memory just by streaming bytes into the
 * raw-body parser.
 *
 * Set to 1 GiB (not the spec's original 25 MB): the SQLite-mode whole-DB
 * snapshot blob is hundreds of MB for a real `data/default-user`. See
 * `src/sync/objects.js`'s MAX_OBJECT_BYTES comment for full reasoning.
 */
const MAX_OBJECT_BYTES = 1024 * 1024 * 1024;

const ALLOWED_OBJECT_TYPES = ['blob', 'tree', 'commit', 'tag'];

function extractToken(request) {
    const header = String(request.get('Authorization') || '');
    const match = TOKEN_HEADER_PATTERN.exec(header);
    return match ? match[1].toLowerCase() : '';
}

function requireSyncToken(request, response, next) {
    const token = extractToken(request);
    if (!token) {
        return response.status(401).json({ error: 'Missing sync token' });
    }
    const session = consumeSyncSession(token);
    if (!session) {
        return response.status(401).json({ error: 'Invalid or expired sync token' });
    }
    request.syncSession = session;
    next();
}

/**
 * Resolve the shadow repo for the authenticated session. The session token
 * binds (handle, peerId, userRoot), so derivation runs purely off the
 * payload `createSyncSession` stored at offer time — there is no `req.user`
 * to consult on token-gated routes: `/session/*` paths (except `/offer`)
 * are explicitly exempt from basic auth (see `src/middleware/basicAuth.js`),
 * so the request never went through the user-loading middleware that
 * would otherwise populate it.
 *
 * Capturing `userRoot` at offer time also keeps token-gated routes
 * independent of the per-handle directory cache in `src/users.js`. Tests
 * rotate `globalThis.DATA_ROOT` per case, so a stale cache entry could
 * otherwise silently point a later test at the previous test's tmp dir.
 *
 * Idempotent: `ensureShadowRepo` is a no-op when the shadow already exists,
 * so we can safely call this on every request without bookkeeping.
 *
 * @param {{ userRoot: string, peerId: string }} session
 * @returns {Promise<import('../sync/shadow.js').ShadowPaths>}
 */
async function shadowFor(session) {
    const { userRoot, peerId } = session;
    if (!userRoot) throw new Error('Sync session missing userRoot');
    return ensureShadowRepo({ userRoot, peerId });
}

router.get('/health', (_request, response) => {
    response.json({ ok: true });
});

/**
 * Return the per-session manifest the peer needs to start a pull:
 *   - `handle`, `peerId`, `expiresAt` — session-binding metadata copied
 *     from the token payload so the peer can sanity-check it's talking
 *     to the right user.
 *   - `headOid` — the shadow's current `refs/heads/main` oid (or
 *     `null` if no commit has landed yet). The pulling peer uses this
 *     as the entry point of `fetchMissingObjects`.
 *
 * `ensureShadowRepo` is idempotent; calling it here is what lets a peer
 * GET /session/manifest immediately after pairing without a separate
 * "create shadow" handshake.
 */
router.get('/session/manifest', requireSyncToken, async (request, response) => {
    const { handle, peerId, expiresAt } = request.syncSession;
    try {
        const shadow = await shadowFor(request.syncSession);
        let headOid = null;
        try {
            headOid = await git.resolveRef({
                fs,
                dir: shadow.workdir,
                gitdir: shadow.gitDir,
                ref: 'main',
            });
        } catch (e) {
            // `NotFoundError` is the documented isomorphic-git surface
            // for a ref that has never been written. A brand-new shadow
            // (e.g. the peer is about to receive its first pair-init
            // snapshot) reports `headOid: null`; the puller's
            // orchestrator already handles that as the "first pair"
            // path. Any other error propagates to the 500 handler.
            if (e.code !== 'NotFoundError') throw e;
        }
        response.json({ handle, peerId, expiresAt, headOid });
    } catch (e) {
        console.error('[sync] manifest failed', e);
        response.status(500).json({ error: 'Internal error' });
    }
});

/**
 * Stream a single git object back to the peer in wire format.
 *
 * Body: raw, unwrapped object bytes (`application/octet-stream`). Type and
 * canonical oid travel out-of-band in `X-Object-Type` / `X-Object-Oid` so
 * the receiver can route to `writeObjectFromWire` without re-parsing.
 *
 * `readObjectForWire` returns `NotFoundError` for missing oids, which we
 * map to 404, and throws `OBJECT_TOO_LARGE` for objects above the wire
 * limit — that's a 413 rather than 500 so the peer's sync loop can
 * surface a meaningful error to the user instead of retrying.
 */
router.get('/session/object/:oid', requireSyncToken, async (request, response) => {
    const oid = String(request.params.oid).toLowerCase();
    if (!OID_PATTERN.test(oid)) {
        return response.status(400).json({ error: 'Invalid oid' });
    }
    try {
        const shadow = await shadowFor(request.syncSession);
        const obj = await readObjectForWire({ dir: shadow.workdir, gitdir: shadow.gitDir, oid });
        response.set('Content-Type', 'application/octet-stream');
        response.set('X-Object-Type', obj.type);
        response.set('X-Object-Oid', obj.oid);
        response.send(obj.body);
    } catch (e) {
        if (e.code === 'NotFoundError') return response.status(404).json({ error: 'Not found' });
        if (e.code === 'OBJECT_TOO_LARGE') return response.status(413).json({ error: e.message });
        console.error('[sync] object read failed', e);
        response.status(500).json({ error: 'Internal error' });
    }
});

/**
 * Accept a single git object from the peer and land it in the local shadow.
 *
 * Body: raw object bytes. `X-Object-Type` and `X-Object-Oid` headers carry
 * the metadata; we re-hash on write inside `writeObjectFromWire` so a wrong
 * `X-Object-Oid` (sender bug, transport corruption, hostile peer) is caught
 * before the object is reachable.
 *
 * `express.raw` is route-scoped rather than mounted at the router level so
 * other routes (`/session/manifest`, `/session/ref`) keep JSON parsing
 * semantics. The `limit` matches `MAX_OBJECT_BYTES` so Express rejects
 * oversize payloads at the parser before our handler runs.
 */
router.post(
    '/session/object',
    requireSyncToken,
    express.raw({ type: 'application/octet-stream', limit: MAX_OBJECT_BYTES }),
    async (request, response) => {
        const oid = String(request.get('X-Object-Oid') || '').toLowerCase();
        const type = String(request.get('X-Object-Type') || '').toLowerCase();
        if (!OID_PATTERN.test(oid)) {
            return response.status(400).json({ error: 'Missing/invalid X-Object-Oid' });
        }
        if (!ALLOWED_OBJECT_TYPES.includes(type)) {
            return response.status(400).json({ error: 'Invalid X-Object-Type' });
        }
        try {
            const shadow = await shadowFor(request.syncSession);
            await writeObjectFromWire({
                dir: shadow.workdir,
                gitdir: shadow.gitDir,
                oid,
                type,
                body: request.body,
            });
            response.json({ oid });
        } catch (e) {
            if (e.code === 'OBJECT_TOO_LARGE') return response.status(413).json({ error: e.message });
            console.error('[sync] object write failed', e);
            response.status(500).json({ error: 'Internal error' });
        }
    },
);

/**
 * Compare-and-swap a ref. The receiver supplies the oid it believes the ref
 * currently points at; the handler only updates the ref if its actual oid
 * matches, otherwise it returns 409 with the current value so the caller can
 * re-fetch and retry.
 *
 * This is the synchronization gate for the push protocol (spec §5.3): two
 * concurrent peers racing to advance `refs/heads/main` cannot both win.
 * Absent CAS, a second push could silently overwrite the first.
 *
 * `force: true` is intentional and safe here: the CAS check above is the
 * concurrency gate, and `git.writeRef` without `force` would refuse to
 * update a fast-forward-incompatible ref — which is exactly what a sync
 * merge commit (two parents, neither an ancestor of the other) looks like.
 */
router.post('/session/ref', requireSyncToken, express.json(), async (request, response) => {
    const ref = String(request.body?.ref || '');
    const expectedOid = String(request.body?.expectedOid || '').toLowerCase();
    const newOid = String(request.body?.newOid || '').toLowerCase();
    if (!ref.startsWith('refs/heads/')) {
        return response.status(400).json({ error: 'Invalid ref' });
    }
    if (!OID_PATTERN.test(newOid)) {
        return response.status(400).json({ error: 'Invalid newOid' });
    }
    try {
        const shadow = await shadowFor(request.syncSession);
        let currentOid = null;
        try {
            currentOid = await git.resolveRef({ fs, dir: shadow.workdir, gitdir: shadow.gitDir, ref });
        } catch (e) {
            // `NotFoundError` is the documented isomorphic-git surface for a
            // ref that has never been written — treat as "currently absent",
            // which compares equal to the all-zero expectedOid. Any other
            // error (corruption, I/O) propagates to the 500 handler.
            if (e.code !== 'NotFoundError') throw e;
        }
        const currentLower = (currentOid ?? '0'.repeat(40)).toLowerCase();
        const expectedLower = expectedOid || '0'.repeat(40);
        if (currentLower !== expectedLower) {
            return response.status(409).json({ error: 'Ref changed', currentOid });
        }
        await git.writeRef({
            fs,
            dir: shadow.workdir,
            gitdir: shadow.gitDir,
            ref,
            value: newOid,
            force: true,
        });

        // Responder-side reconcile (spec §4.2: "On the responder ...
        // does steps 1-4 ... and 10"): once the puller's push lands on
        // refs/heads/main, materialize the merged tree into the
        // workdir and write it back into live, so the responding user's
        // data picks up the puller's edits without waiting for a manual
        // pull from this side.
        //
        // Scoped to `refs/heads/main` so unit-test ref writes against
        // other heads (the http-objects tests use `main` too but only
        // for CAS exercising, never with real commits behind the oid)
        // don't trigger a reconcile attempt that has nothing to do.
        //
        // `directories` is captured into the session payload at
        // /session/offer time so the token-gated route can resolve it
        // without going back through req.user (which is unavailable
        // here — /session/* is in the basic-auth bypass list).
        //
        // Queued on the same (userRoot, peerId) key as `runPull` so that
        // a `/session/ref` arriving while THIS side is mid-`runPull`
        // for the same pairing waits for the local pull to finish
        // instead of racing it (puller-responder race in code review
        // Issue 2). The CAS-successful ref write above already
        // committed the new HEAD into the shadow, so the queue wait
        // only delays the live-materialization step, not the push
        // acknowledgement — meaning the worst-case effect is "peer's
        // edits land in our live tree a few seconds late", not data
        // loss.
        //
        // Cross-peer races (peer P1 and peer P2 both pushing to this
        // same user's live tree at the same time) are still possible:
        // each (userRoot, peerId) pair has its own queue, so P1's and
        // P2's reconciles can interleave. The spec §4.4 model assumes
        // one peer sync at a time and `write-file-atomic` keeps
        // per-file writes consistent; a per-userRoot live-write lock
        // is more complexity than v1 needs.
        if (ref === 'refs/heads/main') {
            const { userRoot, peerId, categories, directories, handle } = request.syncSession;
            if (directories && Array.isArray(categories)) {
                try {
                    await queueOnKey(syncQueueKey(userRoot, peerId), async () => {
                        // Spec §4.4: the responder reconcile rewrites
                        // this user's live tree (and may swap their
                        // SQLite file), so user-initiated writes on
                        // this side must be gated for the duration.
                        // Marked inside the queue body so a queued
                        // reconcile that hasn't started yet doesn't
                        // pre-emptively 409 user writes — and cleared
                        // in `finally` so a reconcile error doesn't
                        // strand the user behind a permanent 409.
                        markSyncInProgress(handle, peerId);
                        try {
                            await git.checkout({
                                fs,
                                dir: shadow.workdir,
                                gitdir: shadow.gitDir,
                                ref: 'main',
                                force: true,
                            });
                            await reconcileShadowToLive({
                                userRoot,
                                peerId,
                                directories,
                                enabledCategoryIds: categories,
                            });
                            // SQLite mode (spec §6.3): the reconcile above
                            // may have swapped this user's live DB file via
                            // `write-file-atomic`'s rename. Drop the cached
                            // engine handle so the next storage read picks
                            // up the post-rename inode instead of the
                            // unlinked old one. Shared with the puller-side
                            // orchestrator so both ends use one gating rule
                            // (see `closeSqliteEngineHandleIfNeeded` doc for
                            // the full set of no-op conditions).
                            closeSqliteEngineHandleIfNeeded({ shadow, handle, categories });
                        } finally {
                            clearSyncInProgress(handle, peerId);
                        }
                    });
                } catch (e) {
                    // Reconcile failure shouldn't roll back the ref —
                    // the puller's view of "push succeeded" is correct
                    // (the shadow IS at newOid), and the user can
                    // recover by pulling on this side. Log and proceed.
                    console.error('[sync] responder reconcile failed', e);
                }
            }
        }

        response.json({ ref, oid: newOid });
    } catch (e) {
        console.error('[sync] ref write failed', e);
        response.status(500).json({ error: 'Internal error' });
    }
});

/**
 * Issue a sync-session token for the current authenticated user. The peer
 * uses the returned `token` (plus `url`, which points at this server's
 * `/session/manifest`) to drive the rest of the sync protocol; subsequent
 * `/session/*` routes accept the token via `Authorization: Bearer …` and
 * skip basic auth (see `src/middleware/basicAuth.js`).
 *
 * Auth model: `/session/offer` itself is NOT in the basic-auth bypass
 * pattern — it goes through the standard middleware so `req.user` is
 * populated. This is what binds the issued token to the authenticated
 * handle: a peer cannot mint a token for someone else's data root.
 *
 * Storage-mode gate (spec §6.3): refuses with 412 when the configured
 * storage engine is `mysql` or `postgres`. Those modes keep the bulk of
 * user data on an external database the Luker process doesn't own;
 * file-level sync would only round-trip the metadata sidecars and silently
 * miss everything else, so we make the unsupported state explicit at the
 * earliest point instead of letting the user discover it after a long
 * snapshot.
 *
 * `userRoot` is captured into the session payload here so token-gated
 * routes can resolve the shadow repo purely from `request.syncSession`,
 * without going back through the per-handle directory cache.
 */
router.post('/session/offer', express.json({ limit: '16kb' }), async (request, response) => {
    const user = request.user;
    if (!user?.profile?.handle || !user?.directories?.root) {
        return response.status(401).json({ error: 'Auth required' });
    }

    const handle = user.profile.handle;
    const peerId = String(request.body?.peerId || '').trim();
    const label = String(request.body?.label || '').trim();
    const categories = Array.isArray(request.body?.categories)
        ? request.body.categories.map(String)
        : [];

    if (!peerId) {
        return response.status(400).json({ error: 'peerId required' });
    }

    const engine = getStorageEngine();
    if (engine.kind === 'mysql' || engine.kind === 'postgres') {
        return response.status(412).json({
            error: `Sync is unavailable in storage mode ${engine.kind}`,
        });
    }

    const { token, expiresAt } = createSyncSession({
        handle,
        peerId,
        userRoot: user.directories.root,
        directories: user.directories,
        categories,
    });

    // Spec §4.1 "pair init" — the responder's shadow MUST advance to a
    // commit that reflects current live data BEFORE the peer pulls.
    // Otherwise the peer fetches a stale (or absent) HEAD and never
    // sees the live state the user just enabled for sync.
    //
    // Running here, on the user's authenticated offer call, scopes the
    // file walk to a user-initiated event rather than firing on every
    // unauthenticated GET /session/manifest from the peer. The same
    // call site is also where the user's category selection is fresh,
    // so the snapshot honors exactly the categories that were just
    // toggled.
    //
    // SQLite-mode (spec §6.3): the live `luker-storage.sqlite` cannot
    // be raw-copied without corruption, so VACUUM-INTO a consistent
    // copy into the shadow workdir BEFORE the file walk runs.
    // `snapshotLiveToShadow` is taught (in `src/sync/shadow.js`) to
    // route the `'database'` category's source path through that
    // workdir copy, so the standard snapshot commits the staged blob
    // without touching the live file. No-op in fs mode or when the
    // user opted out of the `'database'` category.
    //
    // `snapshotLiveToShadow` is idempotent (commits only when the tree
    // actually differs), so a re-offer with no live edits is cheap.
    try {
        if (categories.includes('database') && engine.kind === 'sqlite') {
            // Shared with the orchestrator's pre-snapshot step: ensure
            // the shadow then stage a VACUUM-INTO snapshot at
            // `<workdir>/luker-storage.sqlite`. `ensureShadowRepo` is
            // idempotent, and `snapshotSqliteIntoShadowIfNeeded`
            // self-gates on engine kind + DB-file presence + category
            // selection — keeping the gating in one helper means the
            // offer path and the puller's `runPull` cannot drift.
            const shadow = await ensureShadowRepo({ userRoot: user.directories.root, peerId });
            await snapshotSqliteIntoShadowIfNeeded({
                shadow,
                directories: user.directories,
                categories,
            });
        }
        await snapshotLiveToShadow({
            userRoot: user.directories.root,
            peerId,
            directories: user.directories,
            enabledCategoryIds: categories,
        });
    } catch (e) {
        console.error('[sync] offer snapshot failed', e);
        return response.status(500).json({ error: 'Snapshot failed' });
    }

    const baseUrl = getRequestBaseUrl(request);
    const url = `${baseUrl}/api/sync/v1/session/manifest`;
    response.json({ token, expiresAt, url, peerId, label });
});

/**
 * Invalidate the session token from the bearer header. The route is
 * token-gated so a third party cannot enumerate-and-revoke other peers'
 * sessions, and the bearer is what we're closing anyway.
 *
 * Returns `{ ok: true }` after `closeSyncSession` so the peer can confirm
 * the cleanup landed; subsequent requests with the same token will get
 * 401 from `requireSyncToken`.
 */
router.post('/session/close', requireSyncToken, (request, response) => {
    const token = extractToken(request);
    closeSyncSession(token);
    response.json({ ok: true });
});

/**
 * User-facing entry point for "Sync with peer".
 *
 * Drives the 10-step orchestrator (`runPull` in `src/sync/orchestrator.js`)
 * end-to-end: snapshot local data → fetch peer's missing objects →
 * merge → reconcile → push merged HEAD back to peer.
 *
 * Authentication is the standard basic-auth flow (`/pull` is NOT in the
 * `/session/*` bypass pattern in `src/middleware/basicAuth.js` — only
 * the responder-side routes the peer's sync session token speaks to are
 * exempt). The body's `offerToken` is the OTHER peer's session token,
 * obtained from their `/session/offer` and relayed by the user (e.g. as
 * part of a QR-code pairing flow).
 *
 * Storage-mode gate matches `/session/offer` (spec §6.3): mysql/postgres
 * users can't run file-level sync because the bulk of their data lives
 * outside the file tree. Returns 412 with a coded message rather than
 * letting the orchestrator start work it will only abandon.
 *
 * Concurrency: a second `/pull` request for the same (userRoot, peerId)
 * does NOT 409 — it waits behind any in-flight sync on the
 * orchestrator's per-key FIFO queue. This matches users' mental model
 * of "click Sync, then click it again", and serializes correctly with
 * responder reconciles triggered by `/session/ref` posts from the peer.
 *
 * Error mapping:
 *   - `PEER_REF_CHANGED` → 409 with `retry: true` (peer's main moved
 *     between our manifest fetch and our ref push; caller should retry
 *     the whole pull rather than partially re-push)
 *   - `PEER_TIMEOUT` → 504 (peer's `/session/*` HTTP call exceeded
 *     `PEER_FETCH_TIMEOUT_MS`; usually a peer that walked off Wi-Fi
 *     mid-sync — caller can retry once the network is back)
 *   - anything else → 500 with the message echoed for diagnostics
 */
router.post('/pull', express.json({ limit: '1mb' }), async (request, response) => {
    const user = request.user;
    if (!user?.profile?.handle || !user?.directories?.root) {
        return response.status(401).json({ error: 'Auth required' });
    }

    const engine = getStorageEngine();
    if (engine.kind === 'mysql' || engine.kind === 'postgres') {
        return response.status(412).json({
            error: `Sync is unavailable in storage mode ${engine.kind}`,
        });
    }

    const body = request.body ?? {};
    const peerId = String(body.peerId || '').trim();
    const peerLabel = String(body.peerLabel || '').trim();
    const peerBaseUrl = String(body.peerBaseUrl || '').trim();
    const offerToken = String(body.offerToken || '').trim();
    const categories = Array.isArray(body.categories) ? body.categories.map(String) : null;
    const resolutions = (body.resolutions && typeof body.resolutions === 'object')
        ? body.resolutions
        : undefined;

    if (!peerId || !peerBaseUrl || !offerToken || !categories) {
        return response.status(400).json({ error: 'Missing required fields' });
    }

    try {
        const result = await runPull({
            userRoot: user.directories.root,
            handle: user.profile.handle,
            directories: user.directories,
            peerId,
            peerLabel,
            peerBaseUrl,
            offerToken,
            categories,
            resolutions,
        });
        response.json(result);
    } catch (e) {
        if (e.code === 'PEER_REF_CHANGED') {
            return response.status(409).json({ error: e.message, retry: true });
        }
        if (e.code === 'PEER_TIMEOUT') {
            return response.status(504).json({ error: e.message });
        }
        console.error('[sync] pull failed', e);
        response.status(500).json({ error: e.message });
    }
});

/**
 * Rewind this user's shadow for a given peer to the most recent
 * `sync-backup-*` tag and reconcile that state back into live (spec
 * §4.6 — "Undo last sync"). Undo is strictly local: it touches THIS
 * user's data only; the peer is unaffected until the next sync.
 *
 * Authentication is the standard basic-auth flow, mirroring `/pull`
 * (`/undo` is NOT in the `/session/*` bypass — only the responder-side
 * routes the peer's sync session token speaks to are exempt).
 *
 * 404 vs 500 mapping: `NO_BACKUP_TAG` is the documented "nothing to
 * undo yet" state (a peer that has only ever done one sync, where the
 * pair-init pull doesn't plant a tag) — a 404 is the semantically
 * correct surface so the UI can render "no prior sync to undo" rather
 * than a generic server error.
 */
router.post('/undo', express.json({ limit: '16kb' }), async (request, response) => {
    const user = request.user;
    if (!user?.profile?.handle || !user?.directories?.root) {
        return response.status(401).json({ error: 'Auth required' });
    }
    const peerId = String(request.body?.peerId || '').trim();
    if (!peerId) {
        return response.status(400).json({ error: 'peerId required' });
    }
    try {
        const result = await undoLastSync({
            userRoot: user.directories.root,
            handle: user.profile.handle,
            peerId,
            directories: user.directories,
        });
        response.json(result);
    } catch (e) {
        if (e.code === 'NO_BACKUP_TAG') {
            return response.status(404).json({ error: e.message });
        }
        console.error('[sync] undo failed', e);
        response.status(500).json({ error: e.message });
    }
});

/**
 * Admin/registry endpoints for the LAN Sync UI.
 *
 * These are NOT part of the peer-to-peer sync protocol — they expose the
 * server-local sync registry (`<userRoot>/.sync/state.json`) to the user's
 * own browser so the panel can list paired peers, kick off new pairings,
 * and forget old ones. All require the standard basic-auth flow (so
 * `request.user` is populated); none accept the sync session bearer token,
 * which is exclusively for cross-peer object transfer.
 *
 * Why a `/pair/start` + `/pair/accept` split:
 *   - `/pair/start` runs on the device that's GENERATING the pairing
 *     handle. It allocates a new `peerId`, registers it locally as
 *     "expecting a peer", and returns the URL/QR payload the other
 *     device needs.
 *   - `/pair/accept` runs on the device that's CONSUMING the URL. It
 *     does the outbound `/session/offer` + `runPull` so the user only
 *     types the peer's basic-auth credentials once (in the accept
 *     form) — they never leave the user's own browser → server → peer
 *     hop. This is the only reason these endpoints exist as separate
 *     wrappers around the lower-level protocol routes.
 */

const PEER_ID_SUFFIX_BYTES = 4; // 8 hex chars

function generatePeerId(handle) {
    const safeHandle = String(handle || 'peer').replace(/[^A-Za-z0-9._-]/g, '_');
    const suffix = crypto.randomBytes(PEER_ID_SUFFIX_BYTES).toString('hex');
    return `${safeHandle}@${suffix}`;
}

/**
 * List paired peers for the authenticated user. Returns the raw registry
 * shape from `readSyncState` so the UI can render rows verbatim — label,
 * categories, pairedAt, lastSyncAt, lastSyncedOid.
 *
 * Empty result is `{ peers: {} }` (never 404) so the UI can render an
 * empty-state without branching on HTTP status.
 */
router.get('/peers', (request, response) => {
    const user = request.user;
    if (!user?.profile?.handle || !user?.directories?.root) {
        return response.status(401).json({ error: 'Auth required' });
    }
    const state = readSyncState({ userRoot: user.directories.root });
    response.json({ peers: state.peers });
});

/**
 * Expose the server-side `SYNC_CATEGORIES` registry so the LAN Sync UI
 * can render category checkboxes without duplicating the list. Functions
 * (`paths[].from`) are stripped because they can't survive JSON, and the
 * UI doesn't need them — only the id/displayKey/descriptionKey/syncDefault
 * shape feeds the user's choices.
 *
 * Re-fetched on every panel open so adding a category server-side appears
 * immediately in the UI with no client rebuild.
 */
router.get('/categories', (_request, response) => {
    response.json({
        categories: SYNC_CATEGORIES.map(cat => ({
            id: cat.id,
            displayKey: cat.displayKey,
            descriptionKey: cat.descriptionKey,
            conflictMode: cat.conflictMode,
            syncDefault: cat.syncDefault,
            warnings: cat.warnings ?? [],
        })),
    });
});

/**
 * Report whether LAN Sync can run on this server. Storage modes
 * `mysql` and `postgres` keep the bulk of user data on an external
 * database the Luker process doesn't own — file-level sync would only
 * round-trip metadata sidecars and silently miss everything else. The
 * UI uses this to render a "sync unavailable" banner instead of letting
 * the user fill out a pair form that will only fail at submit.
 *
 * Shape: `{ available: true }` when sync works; `{ available: false,
 * reason: 'storage_mode', mode: '<kind>' }` when blocked. Future blockers
 * (read-only mounts, etc.) can extend the `reason` enum without breaking
 * existing UI handling.
 */
router.get('/availability', (_request, response) => {
    const engine = getStorageEngine();
    if (engine.kind === 'mysql' || engine.kind === 'postgres') {
        return response.json({
            available: false,
            reason: 'storage_mode',
            mode: engine.kind,
        });
    }
    response.json({ available: true });
});

/**
 * Forget a peer — removes the registry entry AND deletes the on-disk shadow
 * repo under `<userRoot>/.sync/<peerId>/`. Idempotent: 204 even when the peer
 * isn't registered (the absence is the desired state, calling it again is a
 * no-op).
 *
 * Returns 400 only when the supplied `:peerId` fails the safety pattern in
 * `assertSafePeerId` — we never want a malformed id to slip through into the
 * shadow path arithmetic.
 */
router.delete('/peers/:peerId', async (request, response) => {
    const user = request.user;
    if (!user?.profile?.handle || !user?.directories?.root) {
        return response.status(401).json({ error: 'Auth required' });
    }
    const peerId = String(request.params.peerId || '').trim();
    try {
        assertSafePeerId(peerId);
    } catch (e) {
        return response.status(400).json({ error: e.message });
    }
    try {
        await removePeerCompletely({ userRoot: user.directories.root, peerId });
        response.status(204).end();
    } catch (e) {
        console.error('[sync] forget peer failed', e);
        response.status(500).json({ error: e.message });
    }
});

/**
 * Rename or re-tag a registered peer. Used by the UI's "Edit peer" inline
 * action; also covers "Update category selection" since `recordPeer` writes
 * the categories array alongside the label.
 *
 * `pairedAt` is preserved by `recordPeer` so re-labeling doesn't make a
 * long-paired peer look new.
 */
router.post('/peers/:peerId/label', express.json({ limit: '4kb' }), async (request, response) => {
    const user = request.user;
    if (!user?.profile?.handle || !user?.directories?.root) {
        return response.status(401).json({ error: 'Auth required' });
    }
    const peerId = String(request.params.peerId || '').trim();
    try {
        assertSafePeerId(peerId);
    } catch (e) {
        return response.status(400).json({ error: e.message });
    }
    const label = String(request.body?.label || '').trim();
    const categories = Array.isArray(request.body?.categories)
        ? request.body.categories.map(String)
        : [];
    if (!label) {
        return response.status(400).json({ error: 'label required' });
    }
    try {
        await recordPeer({ userRoot: user.directories.root, peerId, label, categories });
        response.json({ ok: true });
    } catch (e) {
        console.error('[sync] relabel peer failed', e);
        response.status(500).json({ error: e.message });
    }
});

/**
 * Generate a new pairing handle for THIS device to share with a not-yet-paired
 * peer. Allocates a fresh `peerId`, records it locally as "expecting a peer",
 * and returns the payload the UI turns into a QR / shareable URL.
 *
 * The returned `peerBaseUrl` is derived from the current request's host
 * header, so a user who pairs while on Wi-Fi gets a LAN URL, and one on
 * loopback gets `http://127.0.0.1:<port>` (mostly useful for tests). The
 * UI may overwrite this in the share-link before showing the QR — the
 * `lan-migration.js` flow has a precedent for prompting the user to confirm
 * the host when it looks like loopback.
 *
 * Returning the categories the user selected lets the OTHER device pre-fill
 * its accept form with the same selection — pairing implies shared scope.
 */
router.post('/pair/start', express.json({ limit: '4kb' }), async (request, response) => {
    const user = request.user;
    if (!user?.profile?.handle || !user?.directories?.root) {
        return response.status(401).json({ error: 'Auth required' });
    }

    const engine = getStorageEngine();
    if (engine.kind === 'mysql' || engine.kind === 'postgres') {
        return response.status(412).json({
            error: `Sync is unavailable in storage mode ${engine.kind}`,
        });
    }

    const label = String(request.body?.label || '').trim() || 'Unnamed device';
    const categories = Array.isArray(request.body?.categories)
        ? request.body.categories.map(String)
        : [];
    if (!categories.length) {
        return response.status(400).json({ error: 'categories required' });
    }

    const peerId = generatePeerId(user.profile.handle);
    try {
        await recordPeer({ userRoot: user.directories.root, peerId, label, categories });
    } catch (e) {
        console.error('[sync] pair/start record failed', e);
        return response.status(500).json({ error: e.message });
    }

    const peerBaseUrl = getRequestBaseUrl(request);
    response.json({ peerId, label, peerBaseUrl, categories });
});

/**
 * "Sync now" — re-run sync against an already-paired peer using the
 * `peerBaseUrl` stored in the registry. This is what the UI's per-peer
 * Sync button calls.
 *
 * The caller does NOT supply `peerBaseUrl` or `categories`; both come
 * from the recorded peer entry. Optional `peerAuth` (forwarded as basic
 * auth on the outbound `/session/offer` call) and `resolutions` (for
 * the conflict round-trip) match `/pair/accept`'s payload shape.
 *
 * Same `runPull` error mapping as `/pull`: `PEER_REF_CHANGED` → 409 with
 * `retry: true`, `PEER_TIMEOUT` → 504. A registered peer with no recorded
 * `peerBaseUrl` (legacy entry from earlier code) returns 412 with a
 * coded body so the UI can fall back to prompting the user once for the
 * URL.
 */
router.post('/peers/:peerId/sync', express.json({ limit: '4kb' }), async (request, response) => {
    const user = request.user;
    if (!user?.profile?.handle || !user?.directories?.root) {
        return response.status(401).json({ error: 'Auth required' });
    }

    const engine = getStorageEngine();
    if (engine.kind === 'mysql' || engine.kind === 'postgres') {
        return response.status(412).json({
            error: `Sync is unavailable in storage mode ${engine.kind}`,
        });
    }

    const peerId = String(request.params.peerId || '').trim();
    try {
        assertSafePeerId(peerId);
    } catch (e) {
        return response.status(400).json({ error: e.message });
    }

    const state = readSyncState({ userRoot: user.directories.root });
    const peer = state.peers[peerId];
    if (!peer) {
        return response.status(404).json({ error: 'Unknown peer' });
    }
    if (!peer.peerBaseUrl) {
        return response.status(412).json({
            error: 'No base URL recorded for this peer',
            code: 'NO_BASE_URL',
        });
    }

    const body = request.body ?? {};
    const peerAuth = body.peerAuth && typeof body.peerAuth === 'object' ? body.peerAuth : null;
    const resolutions = (body.resolutions && typeof body.resolutions === 'object') ? body.resolutions : undefined;

    // Mint a fresh session token at the peer via /session/offer.
    const headers = { 'Content-Type': 'application/json' };
    if (peerAuth?.username && peerAuth?.password) {
        const creds = Buffer.from(`${peerAuth.username}:${peerAuth.password}`, 'utf8').toString('base64');
        headers['Authorization'] = `Basic ${creds}`;
    }

    // The peerId we send to A's /session/offer is the id A previously
    // allocated for THIS pairing (via A's /pair/start, returned to us at
    // /pair/accept time and stored on the peer entry). Reusing it ensures
    // A's per-peer shadow under `/.sync/<peerId>/` is the SAME directory
    // on every sync — otherwise each new sync session would create a
    // fresh empty shadow on A's side and every commit would be a root,
    // breaking the ancestry walk that gives us fast-forwards.
    let offerResult;
    try {
        const offerResponse = await fetch(`${peer.peerBaseUrl.replace(/\/+$/, '')}/api/sync/v1/session/offer`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                peerId,
                label: user.profile.name || user.profile.handle,
                categories: peer.categories || [],
            }),
        });
        if (!offerResponse.ok) {
            const text = await offerResponse.text();
            let parsed;
            try { parsed = JSON.parse(text); } catch { parsed = { error: text.slice(0, 256) }; }
            return response.status(offerResponse.status).json({
                error: parsed.error || `Peer returned ${offerResponse.status}`,
                stage: 'offer',
            });
        }
        offerResult = await offerResponse.json();
    } catch (e) {
        console.error('[sync] sync-now offer failed', e);
        return response.status(502).json({ error: e.message, stage: 'offer' });
    }

    const offerToken = String(offerResult?.token || '');
    if (!offerToken) {
        return response.status(502).json({ error: 'Peer returned no token', stage: 'offer' });
    }

    try {
        const result = await runPull({
            userRoot: user.directories.root,
            handle: user.profile.handle,
            directories: user.directories,
            peerId,
            peerLabel: peer.label || peerId,
            peerBaseUrl: peer.peerBaseUrl,
            offerToken,
            categories: peer.categories || [],
            resolutions,
        });
        response.json({ ...result, peerId, label: peer.label || peerId });
    } catch (e) {
        if (e.code === 'PEER_REF_CHANGED') {
            return response.status(409).json({ error: e.message, retry: true, stage: 'pull' });
        }
        if (e.code === 'PEER_TIMEOUT') {
            return response.status(504).json({ error: e.message, stage: 'pull' });
        }
        console.error('[sync] sync-now pull failed', e);
        response.status(500).json({ error: e.message, stage: 'pull' });
    }
});

/**
 * Consume a pairing handle from the other device and run the first full sync.
 *
 * Inputs (body):
 *   - `peerBaseUrl`     — the OTHER device's base URL, from the QR
 *   - `remotePeerId`    — the peerId the OTHER device allocated for us
 *   - `label`           — what to call the OTHER device locally
 *   - `categories`      — what to sync on this first run (may differ from the
 *                          other device's; the spec says per-session selection
 *                          is fine)
 *   - `peerAuth`        — optional `{ username, password }` if the OTHER
 *                          device has basic-auth enabled. Forwarded as a
 *                          standard `Authorization: Basic` header on our
 *                          outbound `/session/offer` call. Never persisted.
 *
 * Flow:
 *   1. POST `peerBaseUrl + /api/sync/v1/session/offer` with our peerId +
 *      label + categories. Returns `{ token, expiresAt, url, peerId, label }`.
 *   2. `recordPeer` locally so the peer shows up in subsequent `GET /peers`.
 *   3. `runPull` with the returned token. Same response shape as
 *      `POST /pull` — either success or a conflict descriptor.
 *
 * Same `runPull` error mapping as `/pull`: `PEER_REF_CHANGED` → 409,
 * `PEER_TIMEOUT` → 504, anything else → 500. The `/session/offer` call's own
 * failures are reported with the same status the peer returned (401 for bad
 * peer credentials, 412 for unsupported storage mode, etc.) so the UI can
 * disambiguate "your credentials were wrong" from "the other device isn't
 * reachable".
 */
router.post('/pair/accept', express.json({ limit: '4kb' }), async (request, response) => {
    const user = request.user;
    if (!user?.profile?.handle || !user?.directories?.root) {
        return response.status(401).json({ error: 'Auth required' });
    }

    const engine = getStorageEngine();
    if (engine.kind === 'mysql' || engine.kind === 'postgres') {
        return response.status(412).json({
            error: `Sync is unavailable in storage mode ${engine.kind}`,
        });
    }

    const body = request.body ?? {};
    const peerBaseUrl = String(body.peerBaseUrl || '').trim();
    const remotePeerId = String(body.remotePeerId || '').trim();
    const label = String(body.label || '').trim() || 'Unnamed device';
    const categories = Array.isArray(body.categories) ? body.categories.map(String) : [];
    const peerAuth = body.peerAuth && typeof body.peerAuth === 'object' ? body.peerAuth : null;
    // `resolutions` lets a second `/pair/accept` call (after the first
    // surfaced conflicts) finalize the merge with the user's picks. The
    // orchestrator's `runPullBody` runs `applyResolutions` instead of
    // returning the conflict set when this is provided. Without this,
    // the conflict-resolution Apply button on a fresh pair re-POSTs to
    // `/pair/accept` and gets the same conflict back unchanged.
    const resolutions = (body.resolutions && typeof body.resolutions === 'object') ? body.resolutions : undefined;

    if (!peerBaseUrl || !remotePeerId) {
        return response.status(400).json({ error: 'peerBaseUrl and remotePeerId required' });
    }
    if (!categories.length) {
        return response.status(400).json({ error: 'categories required' });
    }
    try {
        assertSafePeerId(remotePeerId);
    } catch (e) {
        return response.status(400).json({ error: e.message });
    }

    // Step 1: ask the OTHER device to mint a session token for us.
    const headers = { 'Content-Type': 'application/json' };
    if (peerAuth?.username && peerAuth?.password) {
        const creds = Buffer.from(`${peerAuth.username}:${peerAuth.password}`, 'utf8').toString('base64');
        headers['Authorization'] = `Basic ${creds}`;
    }

    // We send `remotePeerId` (the id A allocated for THIS link in /pair/start
    // and embedded in the QR/share URL) so A's per-peer shadow lives at a
    // stable path. Generating a fresh id every sync would make A treat each
    // sync as a brand-new peer and create a new empty shadow each time —
    // every commit would be a root with no parent, no ancestry, no fast-
    // forward path. Keep them in sync: same id, same shadow, same history.

    let offerResult;
    try {
        const offerResponse = await fetch(`${peerBaseUrl.replace(/\/+$/, '')}/api/sync/v1/session/offer`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                peerId: remotePeerId,
                label: user.profile.name || user.profile.handle,
                categories,
            }),
        });
        if (!offerResponse.ok) {
            const text = await offerResponse.text();
            let body;
            try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 256) }; }
            return response.status(offerResponse.status).json({
                error: body.error || `Peer returned ${offerResponse.status}`,
                stage: 'offer',
            });
        }
        offerResult = await offerResponse.json();
    } catch (e) {
        console.error('[sync] pair/accept offer failed', e);
        return response.status(502).json({ error: e.message, stage: 'offer' });
    }

    const offerToken = String(offerResult?.token || '');
    if (!offerToken) {
        return response.status(502).json({ error: 'Peer returned no token', stage: 'offer' });
    }

    // Step 2: register the OTHER device locally so it appears in /peers.
    try {
        await recordPeer({
            userRoot: user.directories.root,
            peerId: remotePeerId,
            label,
            categories,
            peerBaseUrl,
        });
    } catch (e) {
        console.error('[sync] pair/accept record failed', e);
        return response.status(500).json({ error: e.message, stage: 'record' });
    }

    // Step 3: drive the first pull, same path as `POST /pull`.
    try {
        const result = await runPull({
            userRoot: user.directories.root,
            handle: user.profile.handle,
            directories: user.directories,
            peerId: remotePeerId,
            peerLabel: label,
            peerBaseUrl,
            offerToken,
            categories,
            resolutions,
        });
        response.json({ ...result, peerId: remotePeerId, label });
    } catch (e) {
        if (e.code === 'PEER_REF_CHANGED') {
            return response.status(409).json({ error: e.message, retry: true, stage: 'pull' });
        }
        if (e.code === 'PEER_TIMEOUT') {
            return response.status(504).json({ error: e.message, stage: 'pull' });
        }
        console.error('[sync] pair/accept pull failed', e);
        response.status(500).json({ error: e.message, stage: 'pull' });
    }
});
