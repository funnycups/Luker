import crypto from 'node:crypto';
import path from 'node:path';

import { Cache } from '../util.js';

/**
 * Token TTL for an active LAN-sync session.
 *
 * A token may be consumed many times (one logical sync does many object
 * fetches), unlike the one-shot tokens in `src/lan-migration.js`. Every
 * use renews it, so a session expires only after this long without use.
 */
export const SYNC_SESSION_TTL_MS = 10 * 60 * 1000;

/**
 * Header carrying the shared pairing secret on cross-server
 * `/session/offer` calls. The secret is minted by the peer's
 * `/session/offer` during the pairing-code handshake, embedded in the
 * offer response, and persisted on both sides' peer registry entries. It
 * authenticates every later "Sync now" offer call; see
 * `resolveUserFromPeerSecret` in `src/endpoints/sync.js`.
 */
export const PEER_SECRET_HEADER = 'X-Sync-Peer-Secret';

/**
 * Header carrying a one-time pairing code on the FIRST cross-server
 * `/session/offer` call. The code is minted by `/pair/start`, embedded
 * in the pairing link, and exchanged for a durable peer secret. It has
 * the same 10-minute lifetime as the link itself, so a screenshot of the
 * QR code stops working shortly after pairing.
 */
export const PAIR_CODE_HEADER = 'X-Sync-Pair-Code';

/**
 * Pairing codes live as long as the pairing link is documented to be
 * valid. Unlike sync session tokens, they are single-use: the first
 * successful `/session/offer` consumes the code and returns the durable
 * secret the two sides use from then on.
 */
export const PAIR_CODE_TTL_MS = 10 * 60 * 1000;

const PAIRING_CODES = new Cache(PAIR_CODE_TTL_MS);

const SESSIONS = new Cache(SYNC_SESSION_TTL_MS);
const TOKEN_PATTERN = /^[a-f0-9]{64}$/i;

/**
 * Coerce arbitrary input to a canonical 64-hex token, or `''` if it
 * isn't one. Lowercased so a hex string typed in either case still hits
 * the same Cache key the issuer stored.
 *
 * @param {unknown} token
 * @returns {string}
 */
function normalizeToken(token) {
    const value = String(token ?? '').trim().toLowerCase();
    return TOKEN_PATTERN.test(value) ? value : '';
}

/**
 * Issue a new sync-session token bound to (handle, peerId).
 *
 * The returned token is a 32-byte hex string. `payload` is stored
 * verbatim (plus `createdAt`/`expiresAt`) and returned by every
 * subsequent `consumeSyncSession` call until it goes unused for the TTL
 * or `closeSyncSession` is invoked.
 *
 * `userRoot` is captured at issue time so token-gated routes never
 * have to look up `getUserDirectories(handle)` again — they would
 * otherwise be at the mercy of the per-handle directory cache, which
 * tests rotate per case. Binding the data root to the session also
 * keeps the protocol simple: a token IS the authority to read/write
 * that one user's shadow repo, no extra plumbing.
 *
 * @param {{ handle: string, peerId: string, userRoot: string, categories?: string[] }} payload
 * @returns {{ token: string, expiresAt: number }}
 */
export function createSyncSession(payload) {
    if (!payload?.handle || !payload?.peerId || !payload?.userRoot) {
        throw new Error('createSyncSession requires handle, peerId, and userRoot');
    }
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + SYNC_SESSION_TTL_MS;
    SESSIONS.set(token, { ...payload, userRoot: path.resolve(payload.userRoot), createdAt: Date.now(), expiresAt });
    return { token, expiresAt };
}

/**
 * Look up the payload bound to a session token.
 *
 * Unlike `consumeLanMigrationOffer`, this does NOT remove the token on
 * read — every hit renews it for another `SYNC_SESSION_TTL_MS`, so it
 * stays valid until it goes unused that long or `closeSyncSession` is
 * called. Returns `null` on unknown or
 * malformed tokens so callers can use a straightforward truthy check.
 *
 * @param {string} token
 * @returns {{ handle: string, peerId: string, userRoot: string, categories?: string[], createdAt: number, expiresAt: number } | null}
 */
export function consumeSyncSession(token) {
    const normalized = normalizeToken(token);
    if (!normalized) return null;
    const payload = SESSIONS.get(normalized);
    if (!payload) return null;
    SESSIONS.set(normalized, payload);
    return payload;
}

/**
 * Invalidate a session token immediately. Subsequent consumes return
 * null. Safe to call with unknown or malformed input.
 *
 * @param {string} token
 */
export function closeSyncSession(token) {
    const normalized = normalizeToken(token);
    if (normalized) SESSIONS.remove(normalized);
}

/**
 * Invalidate every session issued for one backend, identified by the
 * user data root and the peer id it syncs with. Roots compare in resolved
 * form, as `createSyncSession` stores them.
 *
 * @param {{ userRoot: string, peerId: string }} args
 */
export function closeSyncSessionsFor({ userRoot, peerId }) {
    const root = path.resolve(userRoot);
    for (const [token, entry] of SESSIONS.cache) {
        if (entry.value?.userRoot === root && entry.value?.peerId === peerId) SESSIONS.remove(token);
    }
}

/**
 * Mint a one-time pairing code bound to (handle, peerId).
 *
 * The code travels in the pairing link. The accepting device presents it
 * on its FIRST `/session/offer`; the offer handler verifies it against
 * this cache, then consumes it so a leaked link cannot be replayed. The
 * durable per-peer secret that replaces it is minted by the offer
 * handler itself and returned in the offer response.
 *
 * @param {{ handle: string, peerId: string }} payload
 * @returns {string}
 */
export function createPairingCode(payload) {
    if (!payload?.handle || !payload?.peerId) {
        throw new Error('createPairingCode requires handle and peerId');
    }
    const code = crypto.randomBytes(32).toString('hex');
    PAIRING_CODES.set(code, { ...payload, createdAt: Date.now() });
    return code;
}

/**
 * Verify and consume a one-time pairing code. Returns the bound payload
 * on success; `null` for unknown, malformed, already-consumed, or
 * handle/peerId-mismatched codes. Consumption is the replay gate — a
 * second offer presenting the same code fails. The handle and peerId
 * checks run BEFORE consumption so a probe with the right code but wrong
 * binding cannot burn the code for its legitimate owner.
 *
 * @param {string} code
 * @param {{ handle: string, peerId: string }} binding
 * @returns {{ handle: string, peerId: string, createdAt: number } | null}
 */
export function consumePairingCode(code, binding) {
    const normalized = normalizeToken(code);
    if (!normalized) return null;
    const payload = PAIRING_CODES.get(normalized);
    if (!payload) return null;
    // A restored code is re-inserted with a fresh cache expiry; the
    // creation time keeps it within the lifetime of its link.
    if (Date.now() - payload.createdAt >= PAIR_CODE_TTL_MS) {
        PAIRING_CODES.remove(normalized);
        return null;
    }
    if (!binding?.peerId || payload.peerId !== binding.peerId) return null;
    if (!binding?.handle || payload.handle !== binding.handle) return null;
    PAIRING_CODES.remove(normalized);
    return payload;
}

/**
 * Put back a code `consumePairingCode` returned, for an offer that failed
 * after consuming it. The code stays bound to the same handle and peerId
 * and still expires when its link does.
 *
 * @param {string} code
 * @param {{ handle: string, peerId: string, createdAt: number }} payload the value `consumePairingCode` returned
 */
export function restorePairingCode(code, payload) {
    const normalized = normalizeToken(code);
    if (!normalized || !payload) return;
    PAIRING_CODES.set(normalized, payload);
}
