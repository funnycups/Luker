// public/scripts/extensions/connection-manager/profile-retry.js
//
// Profile-aware wrapper around `withRetry`. Reads the per-profile retry
// policy (max-request-retries + retry-status-whitelist) and applies it via
// the generic HTTP retry loop.
//
// All main-chat + image-generation HTTP transports funnel through this so
// retry policy lives in exactly one place per transport. Adding a new
// transport that forgets to call this helper is now visible in review
// (single import to notice), and the profile-field name coupling
// (`max-request-retries` / `retry-status-whitelist` string keys) exists in
// one file (`max-retries.js`) instead of six.

import { withRetry } from '../../request-retry.js';
import { getMaxRequestRetries, getRetryStatusWhitelist } from './max-retries.js';

/**
 * Wrap a fetcher with the retry policy of a connection profile.
 *
 * Lookup priority for `profileName` follows `getMaxRequestRetries` /
 * `getRetryStatusWhitelist`: exact name match first, then fall back to the
 * currently selected profile. Empty / missing → active profile.
 *
 * `onAttempt` receives a 4th positional arg `maxRetries` so callers can
 * render "attempt N/M" toasts without pre-reading the profile setting
 * themselves. Existing 3-arg `onAttempt` callbacks continue to work — the
 * extra arg is optional and ignored by any callback that doesn't declare it.
 *
 * @template T
 * @param {() => Promise<T>} fetcher
 * @param {object} [options]
 * @param {string} [options.profileName] Profile lookup name (empty = active profile).
 * @param {AbortSignal} [options.signal]
 * @param {(attempt: number, error: Error, delay: number, maxRetries: number) => void} [options.onAttempt]
 * @param {string} [options.label]
 * @returns {Promise<T>}
 */
export async function withProfileRetry(fetcher, { profileName = '', signal, onAttempt, label } = {}) {
    const maxRetries = getMaxRequestRetries(profileName);
    const retryWhitelist = getRetryStatusWhitelist(profileName);
    const wrappedOnAttempt = typeof onAttempt === 'function'
        ? (attempt, error, delay) => onAttempt(attempt, error, delay, maxRetries)
        : undefined;
    return withRetry(fetcher, {
        maxRetries,
        retryWhitelist,
        signal,
        label,
        onAttempt: wrappedOnAttempt,
    });
}
