// public/scripts/extensions/connection-manager/auto-continue-truncated.js
//
// Standalone helper for reading a connection profile's
// "auto-continue when the model finishes with a non-normal reason (typically
// `length` / max_tokens)" setting.
//
// Lives in its own file (rather than index.js) so core LLM entry points in
// public/script.js can import it without inducing a circular dependency with
// connection-manager/index.js (which imports from openai.js).

import { extension_settings } from '../../extensions.js';

// Cap the auto-retry attempts per user request. Above this we start hammering
// the provider without user consent; below `stop` / `length` alternation can
// easily eat quota. 10 covers "normal long-reply completion" without turning
// into an accidental infinite loop.
const MAX_ALLOWED_ATTEMPTS = 10;

/**
 * Clamp arbitrary input to [0, MAX_ALLOWED_ATTEMPTS].
 * Non-numeric / NaN / negative -> 0 (disabled).
 * @param {unknown} value
 * @returns {number}
 */
export function clampAutoContinueMaxAttempts(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.max(0, Math.min(MAX_ALLOWED_ATTEMPTS, Math.floor(n)));
}

export function getAutoContinueMaxAttemptsCeiling() {
    return MAX_ALLOWED_ATTEMPTS;
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
 *     this via CLAUDE_STOP_REASON_TO_OAI / GEMINI_FINISH_REASON_TO_OAI in
 *     src/endpoints/backends/chat-completions.js. When some content already
 *     streamed before the cutoff, continuing sometimes lets the model finish
 *     the sentence; when the whole reply is empty, continuing loops forever
 *     — the caller must gate on "did this round produce actual output"
 *     before invoking the continue.
 *
 * Explicitly excluded:
 *   - stop / end_turn / stop_sequence: model chose to stop
 *   - tool_calls: model wants to call a tool (handled elsewhere)
 *   - abort / error: user or system aborted
 *
 * @param {unknown} finishReason
 * @returns {boolean}
 */
export function isTruncatedFinishReason(finishReason) {
    const v = String(finishReason || '');
    return v === 'length' || v === 'content_filter';
}
