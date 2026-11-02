/**
 * LAN-sync HTTP router.
 *
 * Mounted at `/api/sync/v1/`. Bearer-token auth is enforced per-route via
 * `requireSyncToken` for every `/session/*` path. The `/health` route
 * reports the LAN protocol version and needs no credentials, so a peer can
 * probe reachability and compatibility before pairing.
 *
 * See `src/middleware/basicAuth.js` for the matching bypass pattern
 * that lets `/health` and `/session/*` requests skip basic auth.
 */
import { atomicFs } from '../sync/pipeline/atomic-fs.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import git from 'isomorphic-git';

import { hasCompleteClosure, readObjectForWire, writeObjectFromWireStream } from '../sync/objects.js';
import { getShadowPaths } from '../sync/shadow.js';
import { syncError } from '../sync/errors.js';
import { pausepoint, PAUSEPOINTS } from '../sync/pipeline/failpoints.js';
import { createSyncSession, closeSyncSession, consumeSyncSession, createPairingCode, consumePairingCode, restorePairingCode, PEER_SECRET_HEADER, PAIR_CODE_HEADER } from '../sync/session.js';
import { assertSafeBackendId, readRegistry, setLanSecret, setLanPeerBaseUrl, setLanPeerDeviceLabel, resolveDeviceLabel, upsertLanBackend } from '../sync/state.js';
import { SYNC_CATEGORIES } from '../sync/categories.js';
import { getRequestBaseUrl } from '../express-common.js';
import { buildLanBaseUrlCandidates } from '../util.js';
import { LAN_PROTOCOL, pickCallbackBaseUrl, checkPairCallback } from '../sync/backends/lan/callback.js';
import { describeFetchFailure, peerErrorCode } from '../sync/backends/lan/client.js';
import { incomingRefFor } from '../sync/backends/lan/incoming.js';
import { defaultUserStore, ownerFromUser, syncService } from '../sync/sync-service.js';
import { guardedLanFetch } from '../sync/net-guard.js';
import { createBackendsRouter, statusForSyncCode, syncResponse } from './sync-backends.js';
import { createS3Router } from './sync-s3.js';


const TOKEN_HEADER_PATTERN = /^Bearer\s+([a-f0-9]{64})$/i;

/**
 * Shared pairing secret shape: 32 random bytes rendered as 64 hex chars.
 */
const PEER_SECRET_PATTERN = /^[a-f0-9]{64}$/i;

/**
 * 40-hex git object id. Lowercase canonical form; the matchers tolerate
 * mixed case on input and downstream code lowercases before any comparison.
 */
const OID_PATTERN = /^[a-f0-9]{40}$/i;

const ALLOWED_OBJECT_TYPES = ['blob', 'tree', 'commit', 'tag'];

/** Oid a ref compare-and-swap uses for an absent ref. */
const ZERO_OID = '0'.repeat(40);

/**
 * @param {string} gitdir
 * @param {string} ref
 * @returns {Promise<string | null>}
 */
async function resolveRefOrNull(gitdir, ref) {
    try {
        return await git.resolveRef({ fs: atomicFs, gitdir, ref });
    } catch (error) {
        if (error.code === 'NotFoundError') return null;
        throw error;
    }
}

function extractToken(request) {
    const header = String(request.get('Authorization') || '');
    const match = TOKEN_HEADER_PATTERN.exec(header);
    return match ? match[1].toLowerCase() : '';
}

// User routes share a pre-parser guard; peer protocol routes above them
// authenticate with their session token or bounded pairing offer instead.
function requireSyncUser(request, response, next) {
    const user = request.user;
    if (!user?.profile?.handle || !user?.directories?.root) {
        return response.status(401).json({ error: 'Auth required' });
    }
    return next();
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
 * The backend must still be registered, not being removed, and its
 * shadow must exist: the offer's local step creates the shadow before a
 * session is issued, and a removed backend's shadow is never recreated.
 * Otherwise this throws `PEER_FORGOTTEN`.
 *
 * @param {{ userRoot: string, peerId: string }} session
 * @returns {Promise<import('../sync/shadow.js').ShadowPaths>}
 */
async function shadowFor(session) {
    const { userRoot, peerId } = session;
    if (!userRoot) throw new Error('Sync session missing userRoot');
    if (syncService.isRemoving(userRoot, peerId)) throw syncError('PEER_FORGOTTEN', `No sync backend ${peerId}`);
    const entry = (await readRegistry({ userRoot })).backends[peerId];
    const paths = getShadowPaths({ userRoot, peerId });
    if (entry?.kind !== 'lan' || !fs.existsSync(path.join(paths.gitDir, 'HEAD'))) {
        throw syncError('PEER_FORGOTTEN', `No sync backend ${peerId}`);
    }
    return paths;
}

function sendPeerForgotten(response) {
    return response.status(404).json({ error: 'PEER_FORGOTTEN', code: 'PEER_FORGOTTEN' });
}

const PEER_ID_SUFFIX_BYTES = 4; // 8 hex chars

/**
 * Sanitize a Luker handle into the prefix half of a peerId
 * (`<sanitized-handle>@<suffix>`).
 *
 * Exported because both `generatePeerId` and the handle-mismatch gate
 * on `/session/offer` + `/pair/accept` need to compare against the same
 * sanitized form, and the same replacements are duplicated client-side in
 * `public/scripts/lan-sync.js` for the pre-flight check. Keep this
 * helper and the client-side replacements in sync. A dot that starts the
 * handle or is followed by another dot becomes `_`, so the peerId is a
 * valid git ref component.
 *
 * @param {string} handle
 * @returns {string}
 */
export function sanitizeHandleForPeerId(handle) {
    return String(handle || 'peer').replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.(?=\.)/g, '_').replace(/^\./, '_');
}

function generatePeerId(handle) {
    return `${sanitizeHandleForPeerId(handle)}@${crypto.randomBytes(PEER_ID_SUFFIX_BYTES).toString('hex')}`;
}

/**
 * Constant-time comparison of two hex strings. Both sides are expected
 * to be 64-hex pairing secrets; malformed input (odd length, non-hex)
 * fails the length check before `timingSafeEqual` can throw.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function secretsMatch(a, b) {
    const bufA = Buffer.from(String(a || ''), 'hex');
    const bufB = Buffer.from(String(b || ''), 'hex');
    if (bufA.length === 0 || bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Resolve the user a LAN peer is offering to sync as from the pairing
 * credential the offer carries.
 *
 * Two credentials exist, both scoped to one (handle, peerId) registry
 * entry:
 *
 *   - The one-time pairing code (`X-Sync-Pair-Code`), minted by
 *     `/pair/start` and embedded in the pairing link. It is consumed on
 *     the first successful offer, so a leaked link dies shortly after
 *     pairing; that offer mints the durable secret.
 *   - The durable peer secret (`X-Sync-Peer-Secret`), stored on both
 *     sides and presented on every later offer.
 *
 * Only users whose sanitized handle equals the peerId prefix and who hold
 * a LAN backend with that exact id are candidates. No candidate handle →
 * 412 `HANDLE_MISMATCH`; no candidate holding the backend → 404
 * `PEER_FORGOTTEN`; no candidate accepting the credential → 401
 * `PEER_AUTH_FAILED`.
 *
 * @param {{ userStore: typeof defaultUserStore, peerId: string, pairCode: string, presentedSecret: string }} args
 * @returns {Promise<{ status: 200, user: { profile: object, directories: Record<string, string> }, issuedSecret?: string, consumedCode?: object } | { status: number, code: string, extra?: object }>}
 */
async function resolveOfferUser({ userStore, peerId, pairCode, presentedSecret }) {
    const prefix = peerId.split('@')[0];
    const allHandles = await userStore.listHandles();
    const handles = allHandles.filter(handle => sanitizeHandleForPeerId(handle) === prefix);
    if (handles.length === 0) {
        return { status: 412, code: 'HANDLE_MISMATCH', extra: { gotHandle: prefix, expectedHandle: allHandles.length === 1 ? sanitizeHandleForPeerId(allHandles[0]) : null } };
    }
    let registered = false;
    for (const handle of handles) {
        const profile = await userStore.getProfile(handle);
        if (!profile || profile.enabled === false) continue;
        const directories = userStore.getDirectories(handle);
        const entry = (await readRegistry({ userRoot: directories.root })).backends[peerId];
        if (entry?.kind !== 'lan') continue;
        registered = true;
        if (pairCode) {
            const consumedCode = consumePairingCode(pairCode, { handle, peerId });
            if (consumedCode) {
                return { status: 200, user: { profile, directories }, consumedCode, issuedSecret: crypto.randomBytes(32).toString('hex') };
            }
        } else if (entry.lan.syncSecret && secretsMatch(entry.lan.syncSecret, presentedSecret)) {
            return { status: 200, user: { profile, directories } };
        }
    }
    return registered ? { status: 401, code: 'PEER_AUTH_FAILED' } : { status: 404, code: 'PEER_FORGOTTEN' };
}

/**
 * Build the sync router. `userStore` supplies the users, directories and
 * storage engines the routes act on.
 *
 * @param {{ userStore?: typeof defaultUserStore }} [options]
 * @returns {import('express').Router}
 */
export function createSyncRouter({ userStore = defaultUserStore, network } = {}) {
    const router = express.Router();

    router.get('/health', (_request, response) => {
        response.json({ ok: true, protocol: LAN_PROTOCOL });
    });

    /**
     * Return the per-session manifest:
     *   - `handle`, `peerId`, `expiresAt` — session-binding metadata copied
     *     from the token payload so the peer can sanity-check it's talking
     *     to the right user.
     *   - `headOid` — the shadow's `refs/heads/main`, or `null` before the
     *     first commit. The peer fetches from it.
     *   - `incomingOid` — the newest commit the peer pushed here, the
     *     shadow's `refs/incoming/<peerId>`, or `null`. The peer
     *     compares against it when it moves that ref.
     *
     * The shadow already exists here: the offer's local step created it
     * before issuing the session. A backend removed since then gets 404
     * `PEER_FORGOTTEN`.
     */
    router.get('/session/manifest', requireSyncToken, async (request, response) => {
        const { handle, peerId, expiresAt } = request.syncSession;
        try {
            const shadow = await shadowFor(request.syncSession);
            const headOid = await resolveRefOrNull(shadow.gitDir, 'refs/heads/main');
            const incomingOid = await resolveRefOrNull(shadow.gitDir, incomingRefFor(peerId));
            response.json({ handle, peerId, expiresAt, headOid, incomingOid });
        } catch (e) {
            if (e.code === 'PEER_FORGOTTEN') return sendPeerForgotten(response);
            console.error('[sync] manifest failed', e);
            response.status(500).json({ error: 'Internal error' });
        }
    });

    /**
     * Stream a single git object back to the peer in wire format.
     *
     * Body: raw, unwrapped object bytes (`application/octet-stream`). Type and
     * canonical oid travel out-of-band in `X-Object-Type` / `X-Object-Oid` so
     * the receiver can route to `writeObjectFromWireStream` without re-parsing.
     *
     * `readObjectForWire` returns `NotFoundError` for missing oids, which we
     * map to 404. There is no size cap on object reads: the responder serves
     * whatever lives in its ODB and the peer's streaming receive handles
     * arbitrarily large bodies without buffering them in RAM.
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
            if (e.code === 'PEER_FORGOTTEN') return sendPeerForgotten(response);
            if (e.code === 'NotFoundError') return response.status(404).json({ error: 'Not found' });
            console.error('[sync] object read failed', e);
            response.status(500).json({ error: 'Internal error' });
        }
    });

    /**
     * Accept a single git object from the peer and land it in the local shadow.
     *
     * Body: raw object bytes streamed directly off the request. No body parser
     * is mounted on this route — `writeObjectFromWireStream` pipes the request
     * into a tmp file under the shadow's gitdir, so the responder's heap never
     * grows by the body's full size even for gigabyte-scale objects. The peer
     * decides what to send; we decide what to keep, by hashing the received
     * bytes in their wrapped form (type prefix + length + NUL + body) and
     * comparing against `X-Object-Oid` before `git.writeObject` runs. A wrong
     * oid (sender bug, transport corruption, hostile peer) is rejected and the
     * tmp file cleaned up without the object ever reaching the ODB.
     *
     * `X-Object-Type` and `X-Object-Oid` headers carry the metadata; the type
     * is checked against `ALLOWED_OBJECT_TYPES` before we start the pipe so a
     * malformed header rejects with 400 without touching disk.
     */
    router.post(
        '/session/object',
        requireSyncToken,
        async (request, response) => {
            const oid = String(request.get('X-Object-Oid') || '').toLowerCase();
            const type = String(request.get('X-Object-Type') || '').toLowerCase();
            if (!OID_PATTERN.test(oid)) {
                return response.status(400).json({ error: 'Missing/invalid X-Object-Oid' });
            }
            if (!ALLOWED_OBJECT_TYPES.includes(type)) {
                return response.status(400).json({ error: 'Invalid X-Object-Type' });
            }
            const { userRoot, peerId } = request.syncSession;
            try {
                const shadow = await shadowFor(request.syncSession);
                // A removal queued on the shadow lock deletes the shadow, so
                // each section that writes into it checks the backend again.
                await writeObjectFromWireStream({
                    dir: shadow.workdir,
                    gitdir: shadow.gitDir,
                    oid,
                    type,
                    stream: request,
                    withLock: fn => syncService.withShadowLock(userRoot, peerId, async () => {
                        await shadowFor(request.syncSession);
                        return fn();
                    }),
                });
                response.json({ oid });
            } catch (e) {
                if (e.code === 'PEER_FORGOTTEN') return sendPeerForgotten(response);
                console.error('[sync] object write failed', e);
                response.status(500).json({ error: 'Internal error' });
            }
        },
    );

    /**
     * Compare-and-swap the session peer's incoming ref,
     * `refs/incoming/<peerId>`, from `expectedOid` to `newOid`; an
     * all-zero oid means the ref is absent. No other ref is accepted, and
     * neither `main` nor live data is touched: the next incoming step
     * merges the ref into both.
     *
     * The target's objects must all be present, since the incoming step
     * reads the ref without checking: an incomplete closure gets 422
     * `INCOMPLETE_OBJECTS`, and a target that is not a commit gets 422
     * `NOT_A_COMMIT`. A mismatch gets 409 with the current oid. The
     * closure check, the compare and the write run under the backend's
     * shadow lock, so they are ordered against the incoming step, against
     * removal and against each other.
     */
    router.post('/session/ref', requireSyncToken, express.json(), async (request, response) => {
        const { userRoot, peerId } = request.syncSession;
        const ref = String(request.body?.ref || '');
        const expectedOid = String(request.body?.expectedOid || '').toLowerCase() || ZERO_OID;
        const newOid = String(request.body?.newOid || '').toLowerCase();
        try {
            await shadowFor(request.syncSession);
            if (ref !== incomingRefFor(peerId)) {
                return response.status(400).json({ error: 'Invalid ref' });
            }
            if (!OID_PATTERN.test(newOid)) {
                return response.status(400).json({ error: 'Invalid newOid' });
            }
            await pausepoint(PAUSEPOINTS.SESSION_REF_BEFORE_LOCK);
            // A removal queued on the lock ahead of this section deletes the
            // shadow, so the checks run again inside it.
            const swap = await syncService.withShadowLock(userRoot, peerId, async () => {
                const shadow = await shadowFor(request.syncSession);
                if (!await hasCompleteClosure({ dir: shadow.workdir, gitdir: shadow.gitDir, oid: newOid })) {
                    return { status: 422, body: { error: 'Objects of the target commit are missing', code: 'INCOMPLETE_OBJECTS' } };
                }
                const { type } = await git.readObject({ fs: atomicFs, gitdir: shadow.gitDir, oid: newOid, format: 'content' });
                if (type !== 'commit') {
                    return { status: 422, body: { error: 'The target is not a commit', code: 'NOT_A_COMMIT' } };
                }
                const currentOid = await resolveRefOrNull(shadow.gitDir, ref);
                if ((currentOid ?? ZERO_OID) !== expectedOid) return { status: 409, body: { error: 'Ref changed', currentOid } };
                // `force` because a merge commit need not descend from the
                // previous value; the compare above is the gate.
                await git.writeRef({ fs: atomicFs, gitdir: shadow.gitDir, ref, value: newOid, force: true });
                return null;
            });
            if (swap) return response.status(swap.status).json(swap.body);
            response.json({ ref, oid: newOid });
        } catch (e) {
            if (e.code === 'PEER_FORGOTTEN') return sendPeerForgotten(response);
            console.error('[sync] ref write failed', e);
            response.status(500).json({ error: 'Internal error' });
        }
    });

    /**
     * Ask this device to sync with the session peer after the peer moved
     * the incoming ref. The run happens in the background; the response
     * does not wait for it.
     */
    router.post('/session/notify', requireSyncToken, async (request, response) => {
        const { owner, peerId } = request.syncSession;
        try {
            await shadowFor(request.syncSession);
        } catch (e) {
            if (e.code === 'PEER_FORGOTTEN') return sendPeerForgotten(response);
            console.error('[sync] notify failed', e);
            return response.status(500).json({ error: 'Internal error' });
        }
        syncService.trigger(owner, peerId, 'notify').catch(error => console.error('[sync] notified sync failed', error));
        response.status(202).json({ ok: true });
    });

    /**
     * Issue a sync-session token to a paired LAN device. The caller is
     * another Luker server: it presents the one-time pairing code
     * (`X-Sync-Pair-Code`) on its first offer and the durable peer secret
     * (`X-Sync-Peer-Secret`) on every later one. Both bind to one
     * registered LAN backend of one user; the offer body's categories are
     * ignored, the backend's stored ones apply.
     *
     * Before the token is returned the incoming step runs: live data is
     * snapshotted into the shadow's `main` and anything the peer pushed to
     * `refs/incoming/<peerId>` is merged into live, so the peer reads a
     * current head. That step waits only on this backend's shadow lock.
     * A secret traded for a pairing code is stored only once the offer
     * succeeds; a failed offer leaves the code usable for a retry.
     *
     * An authenticated offer also refreshes `peerBaseUrl` from its
     * `callback`, limited to the address the request came from.
     * `request.socket.remoteAddress` is used on purpose: forwarded headers
     * are not trusted for this decision.
     */
    router.post('/session/offer', express.json({ limit: '16kb' }), async (request, response) => {
        const peerId = String(request.body?.peerId || '').trim();
        if (!peerId) return response.status(400).json({ error: 'peerId required' });
        const protocol = Number(request.body?.protocol);
        if (!Number.isFinite(protocol) || protocol < LAN_PROTOCOL) {
            return response.status(426).json({ error: 'This Luker version is too old for the other device', code: 'PEER_PROTOCOL_OUTDATED' });
        }
        const pairCode = String(request.get(PAIR_CODE_HEADER) || '').trim().toLowerCase();
        const presentedSecret = String(request.get(PEER_SECRET_HEADER) || '').trim().toLowerCase();
        if (!pairCode && !PEER_SECRET_PATTERN.test(presentedSecret)) {
            return response.status(401).json({ error: 'A pairing code or peer secret is required', code: 'PEER_AUTH_REQUIRED' });
        }
        // A pairing code consumed by this offer is put back unless the offer
        // succeeds, so the peer can retry with it; while the offer runs no
        // other offer can use it.
        let consumedCode = null;
        let succeeded = false;
        const forgotten = () => sendPeerForgotten(response);
        try {
            const resolved = await resolveOfferUser({ userStore, peerId, pairCode, presentedSecret });
            if (resolved.status !== 200) return response.status(resolved.status).json({ error: resolved.code, code: resolved.code, ...resolved.extra });
            const { user, issuedSecret } = resolved;
            consumedCode = resolved.consumedCode ?? null;
            const userRoot = user.directories.root;
            const owner = ownerFromUser(user, userStore);
            syncService.rememberOwner(owner);
            await pausepoint(PAUSEPOINTS.OFFER_BEFORE_ADMISSION, userRoot);
            return await syncService.withIncomingOfferOperation(owner, peerId, async lease => {
                await pausepoint(PAUSEPOINTS.OFFER_AFTER_ADMISSION, userRoot);
                const picked = pickCallbackBaseUrl({ callback: request.body?.callback, remoteAddress: request.socket.remoteAddress });
                const entry = (await readRegistry({ userRoot })).backends[peerId];
                if (!entry?.lan) return forgotten();
                if (consumedCode) await checkPairCallback({ owner, baseUrl: picked, network });
                if (syncService.isRemoving(userRoot, peerId)) return forgotten();
                const local = await syncService.runLocalStep(owner, peerId, lease);
                if (!local.ok && local.code === 'UNKNOWN_BACKEND') return forgotten();
                if (!local.ok) return response.status(500).json({ error: local.message, code: local.code });
                await lease.withLocal(async () => {
                    if (picked && entry.lan.peerBaseUrl !== picked) await setLanPeerBaseUrl({ userRoot, backendId: peerId, peerBaseUrl: picked });
                    await setLanPeerDeviceLabel({ userRoot, backendId: peerId, peerDeviceLabel: request.body?.label });
                    if (issuedSecret) await setLanSecret({ userRoot, backendId: peerId, syncSecret: issuedSecret });
                });
                // Removal closes the backend's sessions as it starts and deletes
                // the registry entry before it ends. Registry reads queue behind
                // writes, so an entry read here means the removal had not ended;
                // `isRemoving` then tells whether it has begun. Nothing may await
                // between the read and the issue.
                const registry = await readRegistry({ userRoot });
                if (!registry.backends[peerId]?.lan || syncService.isRemoving(userRoot, peerId)) return forgotten();
                const deviceLabel = resolveDeviceLabel(registry, owner);
                const { token, expiresAt } = createSyncSession({ handle: user.profile.handle, peerId, userRoot, directories: user.directories, owner });
                succeeded = true;
                return response.json({
                    token, expiresAt, url: `${getRequestBaseUrl(request)}/api/sync/v1/session/manifest`, peerId,
                    deviceLabel, protocol: LAN_PROTOCOL, syncSecret: issuedSecret,
                });
            });
        } catch (error) {
            if (error?.code === 'UNKNOWN_BACKEND' || error?.code === 'PEER_FORGOTTEN') return forgotten();
            if (error?.code === 'SYNC_BACKEND_MAINTENANCE') return response.status(409).json({ error: error.message, code: error.code });
            if (error?.code === 'SYNC_PRIVATE_ADDRESS') return response.status(403).json({ error: error.message, code: error.code });
            if (error?.code === 'PEER_CALLBACK_UNREACHABLE') return response.status(502).json({ error: error.message, code: error.code });
            console.error('[sync] offer failed', error);
            return response.status(500).json({ error: String(error?.message || error), code: error?.code || 'SYNC_FAILED' });
        } finally {
            if (consumedCode && !succeeded) restorePairingCode(pairCode, consumedCode);
        }
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
     * Admin/registry endpoints for the LAN Sync UI.
     *
     * These are NOT part of the peer-to-peer sync protocol — they expose the
     * server-local sync registry (`<userRoot>/.sync/state.json`) to the user's
     * own browser so the panel can list and manage backends (see
     * `./sync-backends.js`) and pair new devices. All require the standard basic-auth flow (so
     * `request.user` is populated); none accept the sync session bearer token,
     * which is exclusively for cross-peer object transfer.
     *
     * Why a `/pair/start` + `/pair/accept` split:
     *   - `/pair/start` runs on the device that's GENERATING the pairing
     *     handle. It allocates a new `peerId`, registers it locally as
     *     "expecting a peer", and returns the URL/QR payload the other
     *     device needs.
     *   - `/pair/accept` runs on the device that's CONSUMING the URL. It
     *     does the outbound `/session/offer` and the first sync so the user only
     *     types the peer's basic-auth credentials once (in the accept
     *     form) — they never leave the user's own browser → server → peer
     *     hop. This is the only reason these endpoints exist as separate
     *     wrappers around the lower-level protocol routes.
     */
    router.use(requireSyncUser);
    router.use(createS3Router({ userStore, network }));
    router.use(createBackendsRouter({ userStore }));

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
     * Report whether LAN Sync can run on this server. Every storage engine is
     * supported (the sync pipeline routes SQL-engine data through the per-record
     * materializer); the route is kept as a stable forward-compatible surface
     * so the UI can branch on `available: false` if a future blocker
     * (read-only mount, missing git binary, etc.) needs to be surfaced.
     *
     * Shape: `{ available: true }` when sync works; `{ available: false,
     * reason: '<code>', ... }` when blocked. No `false` branch is wired today.
     */
    router.get('/availability', (_request, response) => {
        response.json({ available: true });
    });

    /**
     * Generate a new pairing handle for THIS device to share with a not-yet-paired
     * peer. Allocates a fresh `peerId`, records it locally as "expecting a peer",
     * and returns the payload the UI turns into a QR / shareable URL.
     *
     * The returned `peerBaseUrl` is derived from the current request's host
     * header, so a user who pairs while on Wi-Fi gets a LAN URL, and one on
     * loopback gets `http://127.0.0.1:<port>` (mostly useful for tests).
     * `candidateBaseUrls` carries the same origin with each reachable interface
     * address substituted, so the UI can default the link to an address a peer
     * can actually reach instead of the loopback one. Empty when this server is
     * loopback-only.
     *
     * Returning the categories the user selected lets the OTHER device pre-fill
     * its accept form with the same selection — pairing implies shared scope.
     */
    router.post('/pair/start', express.json({ limit: '4kb' }), async (request, response) => {
        const user = request.user;
        if (!user?.profile?.handle || !user?.directories?.root) {
            return response.status(401).json({ error: 'Auth required' });
        }

        const label = String(request.body?.label || '').trim() || 'Unnamed device';
        const categories = Array.isArray(request.body?.categories)
            ? request.body.categories.map(String)
            : [];
        if (!categories.length) {
            return response.status(400).json({ error: 'categories required' });
        }

        syncService.rememberOwner(ownerFromUser(user, userStore));
        const peerId = generatePeerId(user.profile.handle);
        try {
            await upsertLanBackend({ userRoot: user.directories.root, backendId: peerId, label, categories });
        } catch (e) {
            console.error('[sync] pair/start record failed', e);
            return response.status(500).json({ error: e.message });
        }

        // Mint the one-time pairing code that travels in the link. It is
        // consumed by the accepting device's first `/session/offer`, which
        // returns the durable peer secret both sides then use. The code
        // expires with the link, so a leaked screenshot cannot mint a
        // session later.
        const pairCode = createPairingCode({ handle: user.profile.handle, peerId });

        const peerBaseUrl = getRequestBaseUrl(request);
        // The request host is the loopback address when the app was opened
        // through it, which a peer cannot reach. When this server listens
        // beyond loopback, hand the UI the reachable alternatives so it can
        // default the link to one of them instead of the loopback address.
        const candidateBaseUrls = buildLanBaseUrlCandidates(peerBaseUrl, globalThis.COMMAND_LINE_ARGS);
        response.json({ peerId, label, peerBaseUrl, candidateBaseUrls, categories, pairCode });
    });

    /**
     * Consume a pairing link from the other device and run the first sync.
     *
     * Body: `peerBaseUrl` and `remotePeerId` come from the link and name the
     * other device and the backend id it allocated; `label` and
     * `categories` are this device's settings for the backend; `pairCode`
     * is the one-time code from the link; `peerAuth` holds optional
     * basic-auth credentials for the other device, stored for later syncs.
     *
     * Everything that can be checked locally is checked before any network
     * call. Then the other device's health is read, so a device too old for
     * this protocol is refused before it sees the pairing code. The offer
     * trades the pairing code for the durable secret; only once it succeeds
     * is the backend recorded, so a failed pairing stores no credentials.
     * Failures of the offer keep the status the peer returned and carry
     * `stage: 'offer'`. The answer is that of `POST /backends/:id/sync` for
     * the first sync, plus `backendId` and `label`.
     */
    router.post('/pair/accept', express.json({ limit: '4kb' }), async (request, response) => {
        const user = request.user;
        if (!user?.profile?.handle || !user?.directories?.root) {
            return response.status(401).json({ error: 'Auth required' });
        }

        const body = request.body ?? {};
        const peerBaseUrl = String(body.peerBaseUrl || '').trim();
        const remotePeerId = String(body.remotePeerId || '').trim();
        const label = String(body.label || '').trim() || 'Unnamed device';
        const categories = Array.isArray(body.categories) ? body.categories.map(String) : [];
        const peerAuth = body.peerAuth && typeof body.peerAuth === 'object' ? body.peerAuth : null;
        const pairCode = String(body.pairCode || '').trim().toLowerCase();

        if (!peerBaseUrl || !remotePeerId) {
            return response.status(400).json({ error: 'peerBaseUrl and remotePeerId required' });
        }
        if (!categories.length) {
            return response.status(400).json({ error: 'categories required' });
        }
        try {
            assertSafeBackendId(remotePeerId);
        } catch (e) {
            return response.status(400).json({ error: e.message, code: e.code });
        }

        // The other device minted `remotePeerId` from its own user's handle.
        // Pairing two different users would merge one user's data into the
        // other's, so the handles must match; two real accounts with the
        // same handle on different servers are accepted by design.
        const expectedHandle = sanitizeHandleForPeerId(user.profile.handle);
        const remotePeerIdPrefix = remotePeerId.split('@')[0];
        if (expectedHandle !== remotePeerIdPrefix) {
            return response.status(412).json({
                error: 'Handle mismatch',
                code: 'HANDLE_MISMATCH',
                expectedHandle,
                gotHandle: remotePeerIdPrefix,
            });
        }

        const owner = ownerFromUser(user, userStore);
        syncService.rememberOwner(owner);
        const fetchPeer = guardedLanFetch(owner, network);
        const peerApi = `${peerBaseUrl.replace(/\/+$/, '')}/api/sync/v1`;
        const basicAuth = peerAuth?.username && peerAuth?.password
            ? { Authorization: `Basic ${Buffer.from(`${peerAuth.username}:${peerAuth.password}`, 'utf8').toString('base64')}` }
            : {};
        const offerFailure = (status, code, error, extra = {}) => response.status(status).json({ error, code, stage: 'offer', ...extra });
        const outdated = () => offerFailure(426, 'PEER_PROTOCOL_OUTDATED', 'The Luker version of the other device is too old');

        // A pairing link used again after a pairing that already succeeded
        // has no live code left; the stored secret then authenticates
        // instead.
        let offerRequest;
        const acceptanceIdentity = syncService.captureBackendIdentity(owner, remotePeerId);
        let existingAcceptance;
        try {
            const registry = await readRegistry({ userRoot: owner.userRoot });
            acceptanceIdentity.assertAlive();
            existingAcceptance = Boolean(registry.backends[remotePeerId]);
            const storedSecret = registry.backends[remotePeerId]?.lan?.syncSecret;
            const credential = storedSecret ? { [PEER_SECRET_HEADER]: storedSecret } : (pairCode ? { [PAIR_CODE_HEADER]: pairCode } : {});
            offerRequest = {
                method: 'POST',
                headers: { ...basicAuth, 'Content-Type': 'application/json', ...credential },
                body: JSON.stringify({ peerId: remotePeerId, label: resolveDeviceLabel(registry, owner), protocol: LAN_PROTOCOL, callback: owner.selfCallback() }),
            };
        } catch (e) {
            console.error('[sync] pair/accept could not prepare the offer', e);
            return response.status(500).json({ error: String(e?.message || e), code: 'SYNC_FAILED' });
        }

        let offer;
        try {
            const health = await fetchPeer(`${peerApi}/health`, { headers: basicAuth });
            const healthBody = await health.json().catch(() => null);
            if (!(Number(healthBody?.protocol) >= LAN_PROTOCOL)) return outdated();
            const offerResponse = await fetchPeer(`${peerApi}/session/offer`, offerRequest);
            const offerBody = await offerResponse.json().catch(() => undefined);
            if (!offerResponse.ok) {
                return offerFailure(offerResponse.status, peerErrorCode(offerResponse.status, offerBody), String(offerBody?.error || `Peer returned ${offerResponse.status}`));
            }
            if (offerBody === undefined || !(Number(offerBody?.protocol) >= LAN_PROTOCOL)) return outdated();
            offer = offerBody;
        } catch (e) {
            if (e?.code === 'SYNC_PRIVATE_ADDRESS') return offerFailure(403, e.code, e.message);
            return offerFailure(502, 'PEER_UNREACHABLE', 'The other device could not be reached', { detail: describeFetchFailure(e) });
        }
        const offerToken = String(offer?.token || '');
        if (!offerToken) return offerFailure(502, 'PEER_ERROR', 'The other device returned no session token');

        // Close the pairing session before entering any local control queue.
        await fetchPeer(`${peerApi}/session/close`, { method: 'POST', headers: { Authorization: `Bearer ${offerToken}` } })
            .catch(error => console.warn('[sync] could not close the pairing session', describeFetchFailure(error)));

        try {
            acceptanceIdentity.assertAlive();
            await syncService.withBackendMaintenance(owner, remotePeerId, (_registry, commit) => upsertLanBackend({
                userRoot: owner.userRoot, backendId: remotePeerId, label, categories, peerBaseUrl, peerAuth,
                syncSecret: offer.syncSecret, peerDeviceLabel: offer.deviceLabel, requireExisting: existingAcceptance,
                assertAlive: () => { acceptanceIdentity.assertAlive(); commit.assertAlive(); },
            }), { allowMissing: !existingAcceptance });
        } catch (e) {
            if (e?.code !== 'UNKNOWN_BACKEND') console.error('[sync] pair/accept could not record the backend', e);
            return response.status(statusForSyncCode(e?.code)).json({ error: e.message, code: e?.code || 'SYNC_FAILED', stage: 'record' });
        }

        try {
            const { status, body: result } = await syncResponse(owner, remotePeerId, await syncService.trigger(owner, remotePeerId, 'manual'));
            response.status(status).json({ ...result, backendId: remotePeerId, label });
        } catch (e) {
            const code = typeof e?.code === 'string' && e.code ? e.code : 'SYNC_FAILED';
            const status = statusForSyncCode(code);
            if (status === 500) console.error('[sync] pair/accept first sync failed', e);
            response.status(status).json({ ok: false, code, error: String(e?.message || e), backendId: remotePeerId, label });
        }
    });

    return router;
}

export const router = createSyncRouter();
