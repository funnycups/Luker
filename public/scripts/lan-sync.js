/**
 * Sync helpers shared by the Data window (`data-window-sync.js`): endpoint
 * table, pairing links, backend/category/availability reads, undo, the
 * per-backend action lock and failure messages.
 *
 * Wire protocol details — none, that is the engine's concern. This
 * module only drives the routes of `src/endpoints/sync-backends.js`
 * (`/backends`, `/backends/:id/sync`, `/backends/:id/undo`, `/schedule`)
 * and the pairing routes of `src/endpoints/sync.js`.
 *
 * SYNC_CATEGORIES is fetched lazily from `/api/sync/v1/categories`. The
 * list isn't bundled into the frontend so adding a category server-side
 * automatically appears in the UI on next panel open, with no rebuild.
 */
import { t } from './i18n.js';
import { syncSettingsError } from './sync-s3.js';
import { getRequestHeaders } from '../script.js';

const ENDPOINTS = {
    backends: '/api/sync/v1/backends',
    backend: (id) => `/api/sync/v1/backends/${encodeURIComponent(id)}`,
    backendSync: (id) => `/api/sync/v1/backends/${encodeURIComponent(id)}/sync`,
    backendUndo: (id) => `/api/sync/v1/backends/${encodeURIComponent(id)}/undo`,
    backendAuth: (id) => `/api/sync/v1/backends/${encodeURIComponent(id)}/auth`,
    schedule: '/api/sync/v1/schedule',
    pairStart: '/api/sync/v1/pair/start',
    pairAccept: '/api/sync/v1/pair/accept',
    categories: '/api/sync/v1/categories',
    availability: '/api/sync/v1/availability',
};

/**
 * Pairing-link wire format. Carries the minimum needed for the consumer
 * to call `/pair/accept`. Versioned scheme so future fields can be
 * introduced without breaking existing clients.
 */
const PAIR_LINK_SCHEME = 'luker-sync';
const PAIR_LINK_VERSION = 'v1';

/**
 * Backends with a user action in progress. Module-level so the lock
 * outlives the surface that started the action and holds in every
 * window that shows the backend.
 * @type {Set<string>}
 */
export const pendingBackendActions = new Set();

/**
 * Claim the action lock of a backend.
 * @param {string} backendId
 * @returns {(() => void) | null} Releases the lock and announces it; null while another action holds it
 */
export function claimBackendAction(backendId) {
    if (pendingBackendActions.has(backendId)) return null;
    pendingBackendActions.add(backendId);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        pendingBackendActions.delete(backendId);
        document.dispatchEvent(new CustomEvent('sync-backend-actions-updated'));
    };
}

export { ENDPOINTS as SYNC_ENDPOINTS };

export function buildPairLink({ peerBaseUrl, peerId, label, categories, pairCode }) {
    const params = new URLSearchParams();
    params.set('base', peerBaseUrl);
    params.set('peer', peerId);
    params.set('label', label || '');
    params.set('cats', (categories || []).join(','));
    if (pairCode) {
        params.set('code', pairCode);
    }
    return `${PAIR_LINK_SCHEME}://pair/${PAIR_LINK_VERSION}?${params.toString()}`;
}

/**
 * Parse a pairing link previously built by `buildPairLink`. Returns null
 * on any malformed input; the caller falls back to manual-fields entry.
 * The function is intentionally lenient about scheme prefix so a user who
 * accidentally clipped the prefix can still paste the rest.
 */
export function parsePairLink(raw) {
    if (!raw || typeof raw !== 'string') return null;
    let trimmed = raw.trim();
    if (!trimmed) return null;
    // Accept both `luker-sync://pair/v1?...` and the bare query string.
    const queryIdx = trimmed.indexOf('?');
    if (queryIdx < 0) return null;
    const qs = trimmed.slice(queryIdx + 1);
    const params = new URLSearchParams(qs);
    const base = params.get('base');
    const peer = params.get('peer');
    if (!base || !peer) return null;
    return {
        peerBaseUrl: base,
        peerId: peer,
        label: params.get('label') || '',
        categories: (params.get('cats') || '').split(',').filter(Boolean),
        pairCode: params.get('code') || '',
    };
}

/**
 * Categories fetched once per panel open. Server-side `SYNC_CATEGORIES`
 * already speaks displayKey/descriptionKey i18n keys; we render directly
 * against them rather than maintaining a parallel UI registry.
 */
export async function loadCategories() {
    try {
        const res = await fetch(ENDPOINTS.categories, { headers: getRequestHeaders() });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (!Array.isArray(body?.categories) || body.categories.some(category => typeof category?.id !== 'string' || typeof category.displayKey !== 'string')) throw new Error('Invalid category response');
        return body.categories;
    } catch {
        throw new Error(t`Could not load sync categories. Check the connection and reopen Sync.`);
    }
}

/**
 * The sync backends, which of them are syncing now, and the schedule.
 *
 * @returns {Promise<{ backends: Record<string, any>, running: Record<string, boolean>, schedule: { idleSeconds?: number, pollSeconds?: number } }>}
 */
export async function loadBackends() {
    const res = await fetch(ENDPOINTS.backends, { headers: getRequestHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (![body?.backends, body?.running, body?.schedule, body?.device].every(value => value !== null && typeof value === 'object' && !Array.isArray(value))) throw new Error(t`Invalid sync backend response.`);
    return { backends: body.backends, running: body.running, schedule: body.schedule, device: body.device };
}

/**
 * Probe whether LAN Sync is available on this server. Returns the raw
 * `{available, reason?}` shape from `/availability`; today every storage
 * mode is supported and the route returns `{available: true}` — the
 * unreachable branch below covers the "server isn't responding" case so
 * the caller can render an honest error instead of crashing on a missing
 * field.
 */
export async function loadAvailability() {
    try {
        const res = await fetch(ENDPOINTS.availability, { headers: getRequestHeaders() });
        if (!res.ok) return { available: false, reason: 'unreachable' };
        return await res.json();
    } catch {
        return { available: false, reason: 'unreachable' };
    }
}

/**
 * Fetch the logged-in user's handle for the pairing pre-flight check.
 * Returns the handle string, `''` if the call succeeded but the response
 * had no handle, or `null` if the request failed entirely — `null` lets
 * the caller fall through to the server-side gate rather than blocking
 * the user on a transient network error.
 *
 * @returns {Promise<string | null>}
 */
export async function getCurrentHandleForSync() {
    try {
        const res = await fetch('/api/users/me', { headers: getRequestHeaders() });
        if (!res.ok) return null;
        const body = await res.json().catch(() => null);
        if (!body) return null;
        return String(body.handle || '');
    } catch {
        return null;
    }
}

export function englishFallbackForCategory(id) {
    return String(id)
        .split('-')
        .map(w => w[0]?.toUpperCase() + w.slice(1))
        .join(' ');
}

/**
 * Translated message for a sync failure code, or null when the code has
 * none and the server's own message is shown.
 *
 * @param {string} code
 * @param {any} body Error body of the route
 * @returns {string | null}
 */
function syncErrorCodeMessage(code, body = {}) {
    switch (code) {
        case 'UNDO_NOT_COMMITTED':
        case 'PENDING_READ_FAILED':
        case 'AUTH_FAILED':
        case 'BUCKET_NOT_FOUND':
        case 'UNREACHABLE':
        case 'SYNC_DNS_ERROR':
        case 'S3_LOCAL_KEY_ID_INVALID':
        case 'S3_KEY_MISMATCH':
        case 'S3_STORED_KEY_INVALID':
        case 'S3_STORED_KEY_REJECTED':
            return syncSettingsError(code);
        case 'RECONCILE_FAILED':
            return t`The other device could not apply the synced changes.`;
        case 'PEER_PROTOCOL_OUTDATED':
            return t`The peer's Luker version is too old. Upgrade it and sync again.`;
        case 'PEER_CALLBACK_UNREACHABLE':
            return t`The other device cannot connect back to this device. Enable LAN listening and check the firewall, then use the same pairing link again.`;
        case 'SYNC_PRIVATE_ADDRESS':
            return t`Outbound sync to private addresses is disabled for this account. Ask an administrator to enable it.`;
        case 'PEER_FORGOTTEN':
            return t`The other device no longer knows this device. Forget it and pair again.`;
        case 'SYNC_BACKEND_MAINTENANCE':
            return t`The other device is updating its sync settings. Sync again after it finishes.`;
        case 'NO_BASE_URL':
            return t`This device does not know the other device's address yet. Sync once from the other device.`;
        case 'INVALID_BACKEND_ID':
            return t`This device was paired by an older Luker version. Forget it and pair again.`;
        case 'PEER_AUTH_FAILED':
        case 'PEER_AUTH_REQUIRED':
            return t`Authentication to the other device failed. Forget and re-pair if its credentials changed.`;
        case 'HANDLE_MISMATCH':
            return t`This pairing link is for ${String(body.gotHandle || '')}, but you're logged in as ${String(body.expectedHandle || '')}. Pair from the matching account, or use the same handle on both devices.`;
        case 'PEER_UNREACHABLE': {
            // A failed offer carries the network cause in `detail`; a failed
            // run carries it as the message.
            const cause = String((body.stage === 'offer' ? body.detail : body.detail || body.error) || '').trim();
            return cause ? t`Could not reach the other device (${cause}).` : t`Could not reach the other device.`;
        }
        case 'SYNC_NO_PROGRESS':
            return t`Sync stopped because the remote copy did not change across repeated attempts. Check the backend and try again.`;
        default:
            return code?.startsWith('S3_') ? syncSettingsError(code) : null;
    }
}

/**
 * Log a sync failure and return the user-facing reason for it, as
 * `reportSyncError` shows it.
 *
 * @param {{ stage?: string, status?: number, code?: string, message?: string, body?: any, kind?: string }} [failure]
 * @returns {string}
 */
export function describeSyncFailure({ stage, status, code, message, body = {}, kind } = {}) {
    const shown = String(message || '').trim()
        || (code ? syncFailureReason(code, body, kind) : null)
        || String(body.error || '').trim()
        || `HTTP ${status || 0}`;
    const rawDetail = String(body.detail || body.error || '').trim();
    console.error(`[lan-sync] ${stage || 'sync'} failed`, {
        status,
        code,
        detail: rawDetail || undefined,
    });
    return shown;
}

/** The reason a failed sync shows, translated when its code is known. */
export function syncFailureReason(code, body, kind) {
    return syncErrorCodeMessage(code, body) || (kind === 's3' ? syncSettingsError(code) : null)
        || String(body?.error || '').trim() || String(code || '');
}

/**
 * Every address a peer could use to reach this device, from a `/pair/start`
 * answer: the request-derived origin first, then the reachable interface
 * addresses the server detected.
 *
 * @param {{ peerBaseUrl?: string, candidateBaseUrls?: string[] }} body
 * @returns {string[]}
 */
export function pairLinkBaseUrls(body) {
    const bases = [];
    for (const candidate of [body?.peerBaseUrl, ...(Array.isArray(body?.candidateBaseUrls) ? body.candidateBaseUrls : [])]) {
        const base = String(candidate || '').trim();
        if (base && !bases.includes(base)) bases.push(base);
    }
    return bases;
}

/**
 * The handle as it appears before the `@` of a peer id. MUST stay in sync
 * with `sanitizeHandleForPeerId` in `src/endpoints/sync.js` — both sides
 * need to agree on the sanitized form to compare correctly.
 *
 * @param {string} handle
 * @returns {string}
 */
export function sanitizeHandleForPeerId(handle) {
    return String(handle || 'peer').replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.(?=\.)/g, '_').replace(/^\./, '_');
}

/**
 * Revert the last sync of a backend, which then syncs again so the revert
 * reaches the other device.
 *
 * @param {string} backendId
 * @param {string} [kind] Backend kind, for S3-specific failure messages
 * @returns {Promise<{ nothingToUndo: true } | { nothingToUndo?: false, keptEdited: string[] }>} `keptEdited` lists files edited after the sync and left as they are
 * @throws {Error & { code?: string }} With a user-facing message when the undo failed
 */
export async function undoLastBackendSync(backendId, kind) {
    const res = await fetch(ENDPOINTS.backendUndo(backendId), {
        method: 'POST',
        headers: getRequestHeaders(),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 404 && body.code === 'NO_BACKUP_TAG') return { nothingToUndo: true };
    if (!res.ok || body.ok === false || body.committed === false || body.propagation?.ok === false) {
        const code = body.code || body.propagation?.code;
        const reason = syncFailureReason(code, body, kind);
        const diagnostic = body.reconcile ? ` ${JSON.stringify(body.reconcile)}` : '';
        throw Object.assign(new Error((reason || `HTTP ${res.status}`) + diagnostic), { code });
    }
    return { keptEdited: Array.isArray(body.keptEdited) ? body.keptEdited : [] };
}

/**
 * Message for a pairing that failed before it was saved, when it differs
 * from the one for a failed sync of a paired device.
 */
export function pairFailureMessage(body) {
    if (body.code === 'PEER_AUTH_FAILED' || body.code === 'PEER_AUTH_REQUIRED') {
        return t`Authentication to the other device failed. Check your credentials.`;
    }
    if (body.code === 'PEER_UNREACHABLE') {
        const cause = String(body.detail || '').trim();
        return cause
            ? t`Could not reach the other device (${cause}). Check the base URL and that the device is online.`
            : t`Could not reach the other device. Check the base URL and that the device is online.`;
    }
    return null;
}
