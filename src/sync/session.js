import crypto from 'node:crypto';

import { Cache } from '../util.js';

/**
 * Token TTL for an active LAN-sync session.
 *
 * A token may be consumed multiple times within this window (one logical
 * sync does many object fetches), unlike the one-shot tokens in
 * `src/lan-migration.js`.
 */
export const SYNC_SESSION_TTL_MS = 10 * 60 * 1000;

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
 * subsequent `consumeSyncSession` call until the TTL expires or
 * `closeSyncSession` is invoked.
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
    SESSIONS.set(token, { ...payload, createdAt: Date.now(), expiresAt });
    return { token, expiresAt };
}

/**
 * Look up the payload bound to a session token.
 *
 * Unlike `consumeLanMigrationOffer`, this does NOT remove the token on
 * read — it stays valid for repeated use until the TTL expires or
 * `closeSyncSession` is called. Returns `null` on unknown or
 * malformed tokens so callers can use a straightforward truthy check.
 *
 * @param {string} token
 * @returns {{ handle: string, peerId: string, userRoot: string, categories?: string[], createdAt: number, expiresAt: number } | null}
 */
export function consumeSyncSession(token) {
    const normalized = normalizeToken(token);
    if (!normalized) return null;
    return SESSIONS.get(normalized) ?? null;
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
