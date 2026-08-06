// public/scripts/extensions/connection-manager/max-retries.js
//
// Standalone helper for reading a connection profile's max-request-retries
// setting and the sibling retry-status-blacklist setting. Lives in its own
// file (rather than index.js) so consumers like core LLM entry points can
// import it without inducing a circular dependency with connection-manager/
// index.js (which imports from openai.js).

import { extension_settings } from '../../extensions.js';

/**
 * Clamp arbitrary input into the supported retry range [0, 5].
 * Non-numeric / NaN / negative -> 0 (disabled).
 * @param {unknown} value
 * @returns {number}
 */
export function clampMaxRetries(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.max(0, Math.min(5, Math.floor(n)));
}

/**
 * Parse a "retry status blacklist" input into a normalized sorted array of
 * HTTP status codes. Accepts either an array of numbers or a string (comma /
 * whitespace / semicolon separated). Non-integer tokens are dropped; codes
 * outside [100, 599] are dropped (RFC 9110 status-code range); duplicates
 * collapse.
 *
 * @param {unknown} value
 * @returns {number[]} sorted ascending, deduplicated
 */
export function parseRetryStatusBlacklist(value) {
    if (value === null || value === undefined) return [];
    /** @type {string[]} */
    let tokens;
    if (Array.isArray(value)) {
        tokens = value.map(v => String(v));
    } else {
        tokens = String(value).split(/[\s,;]+/);
    }
    const codes = new Set();
    for (const raw of tokens) {
        const trimmed = String(raw).trim();
        if (!trimmed) continue;
        const n = Number(trimmed);
        if (!Number.isFinite(n) || !Number.isInteger(n)) continue;
        if (n < 100 || n > 599) continue;
        codes.add(n);
    }
    return Array.from(codes).sort((a, b) => a - b);
}

/**
 * Format a normalized blacklist array back to display string.
 * @param {number[]} codes
 * @returns {string}
 */
export function formatRetryStatusBlacklist(codes) {
    if (!Array.isArray(codes) || codes.length === 0) return '';
    return codes.join(', ');
}

/**
 * Resolve the network-layer retry count from a connection profile.
 *
 * Lookup priority:
 *   1. `profileName` (case-sensitive) — used by `generateTask` callers that
 *      already know which profile they're targeting via `apiPresetName`.
 *      Without this, plugin requests would always read the main-chat
 *      profile's setting instead of the profile they actually dispatched on.
 *   2. The active profile (`selectedProfile`) — fallback for main-chat
 *      requests that don't pass a name.
 *
 * Returns 0 when nothing resolves, the field is unset, or out of range.
 * @param {string} [profileName] Optional profile name to look up first.
 * @returns {number}
 */
export function getMaxRequestRetries(profileName = '') {
    const profile = resolveProfile(profileName);
    return clampMaxRetries(profile?.['max-request-retries']);
}

/**
 * Resolve the per-profile retry status blacklist. Same lookup priority as
 * `getMaxRequestRetries`. Returns an empty array when nothing resolves or
 * the field is unset — callers treat that as "no additional exclusions".
 *
 * @param {string} [profileName] Optional profile name to look up first.
 * @returns {number[]}
 */
export function getRetryStatusBlacklist(profileName = '') {
    const profile = resolveProfile(profileName);
    return parseRetryStatusBlacklist(profile?.['retry-status-blacklist']);
}

/**
 * @param {string} profileName
 * @returns {any|null}
 */
function resolveProfile(profileName) {
    const cmSettings = extension_settings?.connectionManager;
    const profiles = cmSettings?.profiles;
    if (!Array.isArray(profiles) || profiles.length === 0) return null;

    const trimmedName = String(profileName || '').trim();
    if (trimmedName) {
        const named = profiles.find(p => p?.name === trimmedName);
        if (named) return named;
    }

    const activeProfileId = cmSettings?.selectedProfile;
    if (!activeProfileId) return null;
    return profiles.find(p => p.id === activeProfileId) || null;
}

