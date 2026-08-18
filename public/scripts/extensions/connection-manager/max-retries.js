// public/scripts/extensions/connection-manager/max-retries.js
//
// Standalone helper for reading a connection profile's max-request-retries
// setting and the sibling retry-status-whitelist setting. Lives in its own
// file (rather than index.js) so consumers like core LLM entry points can
// import it without inducing a circular dependency with connection-manager/
// index.js (which imports from openai.js).

import { extension_settings } from '../../extensions.js';

/**
 * Coerce arbitrary input into a non-negative integer retry count.
 * Non-numeric / NaN / negative -> 0 (disabled). No upper bound: the retry
 * budget is a user-facing UX knob with no downstream constraint (the
 * transport in `request-retry.js` loops `attempt <= maxRetries` and each
 * attempt gates on retriable status + Retry-After); users retrying their
 * own account against their own provider don't need us capping them.
 * @param {unknown} value
 * @returns {number}
 */
export function clampMaxRetries(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.floor(n);
}

/**
 * @typedef {number | { start: number, end: number }} WhitelistEntry
 * A whitelist entry is either a single HTTP status code (integer) or an
 * inclusive [start, end] range object. Downstream code treats both uniformly
 * via `matchesWhitelist`.
 */

/**
 * Parse a "retry status whitelist" input into a normalized, deduplicated,
 * sorted array of entries. Accepts either an array (of numbers, range
 * objects, or mixed) or a string (comma / whitespace / semicolon separated).
 *
 * Supported string token forms:
 *   - `429`            → single code
 *   - `500-599`        → inclusive range (both ends required, integers)
 *
 * Any token that fails to parse (non-integer, out of [100, 599], reversed
 * range, malformed range) is silently dropped — the input UI is free-text
 * and we don't want a single typo to lose the whole list.
 *
 * Overlapping ranges and codes covered by a range are collapsed:
 *   - `500, 500-599`      → `[500-599]`
 *   - `429, 500-550, 550-599` → `[429, 500-599]`
 *
 * @param {unknown} value
 * @returns {WhitelistEntry[]} sorted ascending by starting code
 */
export function parseRetryStatusWhitelist(value) {
    if (value === null || value === undefined) return [];

    /** @type {Array<{ start: number, end: number }>} */
    const ranges = [];

    /**
     * Feed one raw token (already trimmed) into the accumulator.
     * @param {string} token
     */
    function ingestToken(token) {
        if (!token) return;

        // Range form: "A-B" (single unambiguous hyphen).
        // We reject multi-hyphen input (e.g. "5-500-599") to avoid guessing.
        const hyphenParts = token.split('-');
        if (hyphenParts.length === 2) {
            const lo = Number(hyphenParts[0].trim());
            const hi = Number(hyphenParts[1].trim());
            if (!Number.isInteger(lo) || !Number.isInteger(hi)) return;
            if (lo < 100 || hi > 599) return;
            if (lo > hi) return;
            ranges.push({ start: lo, end: hi });
            return;
        }
        if (hyphenParts.length > 2) return;

        // Single-code form.
        const n = Number(token);
        if (!Number.isFinite(n) || !Number.isInteger(n)) return;
        if (n < 100 || n > 599) return;
        ranges.push({ start: n, end: n });
    }

    if (Array.isArray(value)) {
        for (const raw of value) {
            if (raw && typeof raw === 'object'
                && Number.isInteger(/** @type {any} */(raw).start)
                && Number.isInteger(/** @type {any} */(raw).end)) {
                // Structured range entry — validate the same way as parsed text.
                const lo = /** @type {any} */(raw).start;
                const hi = /** @type {any} */(raw).end;
                if (lo < 100 || hi > 599 || lo > hi) continue;
                ranges.push({ start: lo, end: hi });
                continue;
            }
            ingestToken(String(raw).trim());
        }
    } else {
        for (const raw of String(value).split(/[\s,;]+/)) {
            ingestToken(raw.trim());
        }
    }

    return collapseRanges(ranges);
}

/**
 * Merge overlapping / touching ranges into a canonical sorted list.
 *
 * Rules:
 *   - Two ranges merge when they overlap or touch (integer gap ≤ 1).
 *   - A single code is absorbed into any range that contains or is adjacent
 *     to it (e.g. `499, 500-599` → `499-599`; `503, 500-599` → `500-599`).
 *   - Two isolated single codes stay separate even if numerically adjacent
 *     (e.g. `502, 503` stays `502, 503` — the user wrote two codes, so we
 *     preserve two codes rather than surprising them with a `502-503` range).
 *
 * @param {Array<{ start: number, end: number }>} raw
 * @returns {Array<number | { start: number, end: number }>}
 */
function collapseRanges(raw) {
    if (raw.length === 0) return [];

    // Split into two piles up front: real ranges (start !== end) and single
    // codes. We collapse ranges among themselves normally, then fold each
    // single code into a covering / adjacent range if one exists, otherwise
    // keep it as-is.
    /** @type {Array<{ start: number, end: number }>} */
    const rangePool = [];
    /** @type {number[]} */
    const singlePool = [];
    for (const r of raw) {
        if (r.start === r.end) singlePool.push(r.start);
        else rangePool.push({ start: r.start, end: r.end });
    }

    // Merge the range pool.
    rangePool.sort((a, b) => a.start - b.start || a.end - b.end);
    /** @type {Array<{ start: number, end: number }>} */
    const mergedRanges = [];
    for (const r of rangePool) {
        const last = mergedRanges[mergedRanges.length - 1];
        if (last && r.start <= last.end + 1) {
            if (r.end > last.end) last.end = r.end;
        } else {
            mergedRanges.push({ start: r.start, end: r.end });
        }
    }

    // Dedup single codes.
    const uniqueSingles = Array.from(new Set(singlePool)).sort((a, b) => a - b);

    // Fold each single code into an adjacent / covering range if one exists.
    const survivingSingles = [];
    for (const code of uniqueSingles) {
        let absorbed = false;
        for (const range of mergedRanges) {
            if (code >= range.start - 1 && code <= range.end + 1) {
                if (code < range.start) range.start = code;
                if (code > range.end) range.end = code;
                absorbed = true;
                break;
            }
        }
        if (!absorbed) survivingSingles.push(code);
    }

    // A single code getting absorbed may have grown its range to touch the
    // next one — re-collapse once more to catch that transitive merge.
    mergedRanges.sort((a, b) => a.start - b.start || a.end - b.end);
    /** @type {Array<{ start: number, end: number }>} */
    const finalRanges = [];
    for (const r of mergedRanges) {
        const last = finalRanges[finalRanges.length - 1];
        if (last && r.start <= last.end + 1) {
            if (r.end > last.end) last.end = r.end;
        } else {
            finalRanges.push({ start: r.start, end: r.end });
        }
    }

    // Interleave singles and ranges in sorted order for stable display.
    /** @type {Array<number | { start: number, end: number }>} */
    const combined = [];
    let si = 0, ri = 0;
    while (si < survivingSingles.length && ri < finalRanges.length) {
        if (survivingSingles[si] < finalRanges[ri].start) {
            combined.push(survivingSingles[si++]);
        } else {
            combined.push(finalRanges[ri++]);
        }
    }
    while (si < survivingSingles.length) combined.push(survivingSingles[si++]);
    while (ri < finalRanges.length) combined.push(finalRanges[ri++]);
    return combined;
}

/**
 * Format a normalized whitelist array back to display string. Range entries
 * are rendered as `A-B`, single codes as their number.
 * @param {WhitelistEntry[] | null | undefined} entries
 * @returns {string}
 */
export function formatRetryStatusWhitelist(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return '';
    return entries.map(entry => {
        if (typeof entry === 'number') return String(entry);
        if (entry && Number.isInteger(entry.start) && Number.isInteger(entry.end)) {
            return entry.start === entry.end
                ? String(entry.start)
                : `${entry.start}-${entry.end}`;
        }
        return '';
    }).filter(Boolean).join(', ');
}

/**
 * Test whether an HTTP status code falls in the whitelist.
 * @param {number} status
 * @param {WhitelistEntry[] | null | undefined} entries
 * @returns {boolean}
 */
export function matchesWhitelist(status, entries) {
    if (!Array.isArray(entries) || entries.length === 0) return false;
    for (const entry of entries) {
        if (typeof entry === 'number') {
            if (entry === status) return true;
        } else if (entry && Number.isInteger(entry.start) && Number.isInteger(entry.end)) {
            if (status >= entry.start && status <= entry.end) return true;
        }
    }
    return false;
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
 * Resolve the per-profile retry status whitelist. Same lookup priority as
 * `getMaxRequestRetries`. Returns an empty array when nothing resolves or
 * the field is unset — callers treat that as "use the built-in default
 * retriable set (429 + 5xx)".
 *
 * Legacy field `retry-status-blacklist` (semantics-inverted predecessor) is
 * intentionally NOT auto-translated: silent semantic flip on a user's
 * persisted config would be worse than the field appearing empty. A warning
 * is emitted once per lookup so the user sees why their old list is gone.
 *
 * @param {string} [profileName] Optional profile name to look up first.
 * @returns {WhitelistEntry[]}
 */
export function getRetryStatusWhitelist(profileName = '') {
    const profile = resolveProfile(profileName);
    if (!profile) return [];
    if (profile['retry-status-blacklist'] && !profile['retry-status-whitelist']) {
        console.warn(
            '[connection-manager] Profile has a legacy "retry-status-blacklist" field. '
            + 'The field has been renamed to "retry-status-whitelist" with inverted semantics '
            + '(codes listed will be retried, not skipped). The old value is ignored — '
            + 'please re-enter the codes you want to retry in the Advanced settings.',
        );
    }
    return parseRetryStatusWhitelist(profile['retry-status-whitelist']);
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
