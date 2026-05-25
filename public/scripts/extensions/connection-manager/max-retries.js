// public/scripts/extensions/connection-manager/max-retries.js
//
// Standalone helper for reading a connection profile's max-request-retries
// setting. Lives in its own file (rather than index.js) so consumers like
// core LLM entry points can import it without inducing a circular
// dependency with connection-manager/index.js (which imports from openai.js).

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
    const cmSettings = extension_settings?.connectionManager;
    const profiles = cmSettings?.profiles;
    if (!Array.isArray(profiles) || profiles.length === 0) return 0;

    const trimmedName = String(profileName || '').trim();
    if (trimmedName) {
        const named = profiles.find(p => p?.name === trimmedName);
        if (named) return clampMaxRetries(named['max-request-retries']);
    }

    const activeProfileId = cmSettings?.selectedProfile;
    if (!activeProfileId) return 0;
    const activeProfile = profiles.find(p => p.id === activeProfileId);
    return clampMaxRetries(activeProfile?.['max-request-retries']);
}

