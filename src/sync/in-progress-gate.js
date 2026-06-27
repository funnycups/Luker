/**
 * In-flight LAN-sync write-gate (spec §4.4).
 *
 * While a sync is mid-flight for a given handle, user-initiated save
 * endpoints must refuse with HTTP 409 so the live tree cannot move
 * under the orchestrator's feet. Without this gate, the
 * snapshot→shadow walk and the reconcile→live rename are both racing
 * the same files that `/api/chats/save`, `/api/settings/save`,
 * `/api/presets/save` etc. are still rewriting on the 1-second
 * debounce — the user-visible failure modes are "the edit I made
 * during a sync vanished" (caught in the snapshot but overwritten by
 * the reconcile) and "the engine handle points at a stale inode"
 * (SQLite mode, after `closeHandle` swaps the DB file).
 *
 * The per-(userRoot, peerId) FIFO queue in
 * `src/sync/orchestrator.js` already serializes orchestrator-side
 * operations for one pairing. This gate sits one level higher: it
 * blocks USER WRITES (the half the queue can't see, because save
 * endpoints don't enqueue) while ANY sync — initiator pull, responder
 * `/session/ref` reconcile, undo — is in progress for the same handle.
 *
 * Granularity: per `handle`. The spec's example list of endpoints
 * (`/api/saveSettings`, `/api/chat/save`, ...) is all per-user, and a
 * handle's data root is the unit of contention the orchestrator's
 * snapshot/reconcile mutates. A second peer paired to the same handle
 * starts a parallel sync? Both syncs mark their (peerId, since) entry
 * into the same handle set; the gate stays closed for writes until
 * BOTH clear. Two distinct handles syncing in the same process are
 * fully independent.
 *
 * Why a Set of (peerId, since) instead of a boolean: a sync can fail
 * to clear (bug, killed process) and we want each registration paired
 * with its own clear call so a buggy/early clear from peer A doesn't
 * accidentally unlock writes while peer B is still syncing. The
 * `since` timestamp is also useful for the diagnostic `/api/sync/v1/
 * status` view and for logging "this gate has been held for X ms".
 *
 * Process-local — there is no cross-process coordination because Luker
 * is a single-process server and a second instance pointed at the
 * same data root would defeat `write-file-atomic` regardless.
 */

/**
 * @typedef {{ peerId: string, since: number }} InFlightEntry
 */

/**
 * Map of handle → Set of in-flight registrations. Empty Set is removed
 * from the map so `isSyncInProgress` can use a single Map lookup
 * instead of `has + size`.
 *
 * @type {Map<string, Map<string, InFlightEntry>>}
 */
const IN_FLIGHT = new Map();

/**
 * Path patterns whose request methods must be gated. Derived from spec
 * §4.4 ("`/api/saveSettings`, `/api/chat/save`, etc.") expanded to the
 * full set of user-initiated write paths under the same routers — see
 * `src/endpoints/{chats,settings,presets,themes,quick-replies,moving-ui,
 * worldinfo,characters}.js`.
 *
 * Read endpoints (`/get`, `/list`, `/recent`, `/search`, `/export`,
 * `/snapshot` (the read kind on characters)) are NOT gated — letting
 * the UI keep showing data during a sync is harmless and avoids a UX
 * regression where opening a chat suddenly 409s.
 *
 * The orchestrator's own `/api/sync/v1/**` routes are NEVER gated
 * (a sync mid-flight needs them) — that exclusion is handled by where
 * the middleware is mounted (after `/api/sync/v1`, before everything
 * else; see `src/server-main.js`).
 *
 * Pattern semantics: each entry is matched against `req.path` (the
 * mount-relative path under the gated mount point). The middleware
 * runs at the root, so `req.path` is `/api/chats/save` etc.
 *
 * `/api/users/me/settings/save` is the admin self-settings update —
 * not in the explicit gated list but its target is `settings.json`
 * by way of `getSettingsRepo().save`, so gating it keeps the same
 * file from being clobbered.
 */
const GATED_PATHS = [
    /^\/api\/chats\/(save|append|patch|meta|meta\/patch|state\/patch|state\/delete|rename|delete|import|group\/save|group\/append|group\/patch|group\/meta|group\/meta\/patch|group\/import|group\/delete)$/i,
    /^\/api\/settings\/(save|patch|make-snapshot|restore-snapshot|load-snapshot)$/i,
    /^\/api\/presets\/(save|patch|delete|restore|state\/patch|state\/delete|state\/delete-all|state\/rename)$/i,
    /^\/api\/themes\/(save|delete)$/i,
    /^\/api\/quick-replies\/(save|delete)$/i,
    /^\/api\/moving-ui\/save$/i,
    /^\/api\/worldinfo\/(edit|patch|delete|import)$/i,
    /^\/api\/characters\/(create|rename|edit|edit-avatar|edit-attribute|merge-attributes|delete|import|duplicate|state\/set|state\/patch|state\/delete)$/i,
    /^\/api\/backgrounds\/(rename|delete|upload)$/i,
    /^\/api\/assets\/(get|download|delete)$/i,
    /^\/api\/avatars\/(upload|delete)$/i,
    /^\/api\/files\/(upload|delete)$/i,
    /^\/api\/sysprompt\/(save|delete)$/i,
    /^\/api\/instruct\/(save|delete)$/i,
    /^\/api\/context\/(save|delete)$/i,
    /^\/api\/reasoning\/(save|delete)$/i,
    /^\/api\/users\/me\/settings\/save$/i,
];

/**
 * Retry-After hint (ms) returned to clients. A typical LAN sync of a
 * couple thousand small files runs sub-second to a few seconds; 5s
 * gives the client a sensible debounce without making the user feel
 * stuck. The client-side `saveChatDebounced` is itself 1s, so 5s is
 * well past one debounce cycle.
 *
 * Exported so client code (and tests) share the same number — never
 * hardcode "5000" in a second place.
 */
export const SYNC_GATE_RETRY_AFTER_MS = 5_000;

/**
 * Mark a sync as in-flight for `(handle, peerId)`. Idempotent for the
 * same `(handle, peerId)` pair — re-marking just refreshes the
 * `since` timestamp, which is harmless (this happens if the
 * orchestrator's queue replays the same registration after a
 * recoverable error). Always pair with `clearSyncInProgress` in a
 * `try/finally`.
 *
 * @param {string} handle
 * @param {string} peerId
 */
export function markSyncInProgress(handle, peerId) {
    if (!handle || !peerId) return;
    let bucket = IN_FLIGHT.get(handle);
    if (!bucket) {
        bucket = new Map();
        IN_FLIGHT.set(handle, bucket);
    }
    bucket.set(peerId, { peerId, since: Date.now() });
}

/**
 * Clear an in-flight marker. Safe to call when no marker exists (the
 * orchestrator's `try/finally` runs unconditionally, even on errors
 * before `markSyncInProgress` reached its line).
 *
 * @param {string} handle
 * @param {string} peerId
 */
export function clearSyncInProgress(handle, peerId) {
    if (!handle || !peerId) return;
    const bucket = IN_FLIGHT.get(handle);
    if (!bucket) return;
    bucket.delete(peerId);
    if (bucket.size === 0) IN_FLIGHT.delete(handle);
}

/**
 * Snapshot of every in-flight sync for `handle`. Returns an array
 * (possibly empty); the gate middleware checks `.length` and the
 * `/api/sync/v1/status`-style introspection (if added later) can use
 * the timestamps. Returns a copy so callers cannot mutate the
 * registry by reference.
 *
 * @param {string} handle
 * @returns {InFlightEntry[]}
 */
export function getInFlightSyncs(handle) {
    const bucket = IN_FLIGHT.get(handle);
    if (!bucket) return [];
    return Array.from(bucket.values());
}

/**
 * Test-only — drop every in-flight registration. Production code
 * must never call this; the orchestrator's `try/finally` is the only
 * legitimate way to clear marks.
 */
export function _resetInFlightForTests() {
    IN_FLIGHT.clear();
}

/**
 * Match against the user-write path pattern list. Exported for tests
 * that want to validate the registry without mounting the middleware.
 *
 * @param {string} requestPath
 * @returns {boolean}
 */
export function isGatedPath(requestPath) {
    if (typeof requestPath !== 'string' || !requestPath) return false;
    for (const pattern of GATED_PATHS) {
        if (pattern.test(requestPath)) return true;
    }
    return false;
}

/**
 * Express middleware. Returns 409 with a structured body if the
 * request targets a gated path AND a sync is in flight for the
 * request's user.
 *
 * Resolves the handle off `request.user.profile.handle` — the same
 * field every gated endpoint uses for its own writes (so a request
 * without a user populated falls through unchanged; the underlying
 * endpoint will reject it for its own reasons).
 *
 * Method filter: only POST/PUT/PATCH/DELETE — GET and HEAD on the
 * pattern set is impossible by construction (the registry is
 * write-only), but the explicit method guard keeps the middleware
 * cheap on the common read path.
 *
 * @returns {import('express').RequestHandler}
 */
export function syncInProgressMiddleware() {
    return function (request, response, next) {
        const method = String(request.method || '').toUpperCase();
        if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH' && method !== 'DELETE') {
            return next();
        }
        const requestPath = typeof request.path === 'string'
            ? request.path
            : String(request.originalUrl || '').split('?')[0];
        if (!isGatedPath(requestPath)) return next();

        const handle = request?.user?.profile?.handle;
        if (!handle) return next();

        const inFlight = getInFlightSyncs(handle);
        if (inFlight.length === 0) return next();

        response.setHeader('Retry-After', Math.ceil(SYNC_GATE_RETRY_AFTER_MS / 1000));
        return response.status(409).json({
            error: 'SYNC_IN_PROGRESS',
            message: 'A LAN sync is in progress for this user. The save was refused; the client should retry after the sync completes.',
            retryAfterMs: SYNC_GATE_RETRY_AFTER_MS,
            peers: inFlight.map(e => ({ peerId: e.peerId, since: e.since })),
        });
    };
}
