// public/scripts/extensions/connection-manager/request-timeout.js
//
// Standalone helper for reading a connection profile's request-timeout
// setting (seconds, 0 / absent = disabled). Lives in its own file so core
// LLM entry points can import it without a circular dependency on
// connection-manager/index.js. Profile resolution priority is shared with
// max-retries.js (exact name first, then the selected profile).

import { resolveProfile } from './max-retries.js';

/**
 * Coerce arbitrary input into a positive number of seconds.
 * Non-numeric / NaN / <= 0 -> 0 (disabled). No upper bound: the only
 * constraint is the user's own patience.
 * @param {unknown} value
 * @returns {number} seconds, 0 when disabled
 */
export function clampRequestTimeout(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n;
}

/**
 * Milliseconds for an already-resolved profile object.
 * @param {{['request-timeout']?: unknown}|null|undefined} profile
 * @returns {number} milliseconds, 0 when disabled
 */
export function getProfileRequestTimeoutMs(profile) {
    const seconds = clampRequestTimeout(profile?.['request-timeout']);
    return seconds > 0 ? Math.round(seconds * 1000) : 0;
}

/**
 * Milliseconds for a profile name (exact match first, then the selected
 * profile). Mirror of getMaxRequestRetries lookup semantics.
 * @param {string} [profileName]
 * @returns {number} milliseconds, 0 when disabled / no profile
 */
export function getRequestTimeoutMs(profileName = '') {
    return getProfileRequestTimeoutMs(resolveProfile(profileName));
}
