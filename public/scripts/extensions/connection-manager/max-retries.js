// public/scripts/extensions/connection-manager/max-retries.js
//
// Standalone helper for reading the active connection profile's
// max-request-retries setting. Lives in its own file (rather than index.js)
// so consumers like core LLM entry points can import it without inducing a
// circular dependency with connection-manager/index.js (which imports from
// openai.js).

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
 * Resolve the network-layer retry count from the active connection profile.
 * Returns 0 when no profile is selected, the field is unset, or out of range.
 * @returns {number}
 */
export function getMaxRequestRetries() {
    const cmSettings = extension_settings?.connectionManager;
    const activeProfileId = cmSettings?.selectedProfile;
    if (!activeProfileId) return 0;
    const activeProfile = cmSettings.profiles?.find(p => p.id === activeProfileId);
    return clampMaxRetries(activeProfile?.['max-request-retries']);
}
