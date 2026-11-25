// public/scripts/extensions/connection-manager/auto-continue-truncated.js
//
// Per-connection-profile setting: when the main-chat model finishes with a
// truncated finish_reason (`length` = hit output-token cap, or
// `content_filter` = safety cutoff mid-reply), automatically dispatch a
// continue. The continue is emitted INSIDE Generate()'s own loop with a
// `continuationChain` flag so downstream extension events fire exactly once
// for the whole chain — the plugin only sees one MESSAGE_RECEIVED /
// CHARACTER_MESSAGE_RENDERED / GENERATION_ENDED for the merged reply.

import { extension_settings } from '../../extensions.js';

/**
 * Coerce arbitrary input into a non-negative integer attempts count.
 * Non-numeric / NaN / negative -> 0 (disabled). No upper bound: this is a
 * user-facing UX knob, not a downstream constraint. The continue loop
 * short-circuits as soon as the model finishes non-truncated, so a high
 * ceiling only matters for pathological repeat-truncation cases the user
 * has opted into.
 * @param {unknown} value
 * @returns {number}
 */
export function clampAutoContinueMaxAttempts(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.floor(n);
}

/**
 * Resolve the "auto-continue on truncated" behavior for a connection profile.
 *
 * Lookup priority mirrors max-retries.js:
 *   1. `profileName` if provided (exact match on `name`).
 *   2. The active profile (`selectedProfile`).
 *
 * Returns { enabled, maxAttempts } — enabled is only true when the flag is
 * set AND the attempts cap is > 0. Missing / unset fields → disabled.
 * @param {string} [profileName]
 * @returns {{ enabled: boolean, maxAttempts: number }}
 */
export function getAutoContinueOnTruncated(profileName = '') {
    const cmSettings = extension_settings?.connectionManager;
    const profiles = cmSettings?.profiles;
    if (!Array.isArray(profiles) || profiles.length === 0) {
        return { enabled: false, maxAttempts: 0 };
    }

    let profile = null;
    const trimmedName = String(profileName || '').trim();
    if (trimmedName) {
        profile = profiles.find(p => p?.name === trimmedName) || null;
    }
    if (!profile) {
        const activeProfileId = cmSettings?.selectedProfile;
        if (activeProfileId) {
            profile = profiles.find(p => p?.id === activeProfileId) || null;
        }
    }
    if (!profile) return { enabled: false, maxAttempts: 0 };

    const flag = profile['auto-continue-on-truncated'];
    const enabledFlag = flag === true || flag === 'true';
    const maxAttempts = clampAutoContinueMaxAttempts(profile['auto-continue-on-truncated-max-attempts']);
    return { enabled: enabledFlag && maxAttempts > 0, maxAttempts };
}

/**
 * Finish-reason values that indicate the response was cut off and a continue
 * could sensibly resume:
 *
 *   - length: hit the output-token cap (canonical case)
 *   - content_filter: safety cutoff. Claude `refusal` and Gemini
 *     SAFETY/RECITATION/PROHIBITED_CONTENT/BLOCKLIST/SPII all normalize to
 *     this in protocol-parser's `normalizeFinishReason()`.
 *
 * Explicitly excluded:
 *   - stop / end_turn / stop_sequence: model chose to stop
 *   - tool_calls: model wants to call a tool (handled elsewhere in Generate())
 *   - abort / error: user or system aborted
 *
 * @param {unknown} finishReason
 * @returns {boolean}
 */
export function isTruncatedFinishReason(finishReason) {
    const v = String(finishReason || '');
    return v === 'length' || v === 'content_filter';
}
