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

// Cap the auto-retry attempts per user request. Above this we start hammering
// the provider without user consent. 10 is enough headroom for a long reply
// composed across several 4k / 8k output-token windows without turning into
// an accidental infinite loop.
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
 *     this in normalizeStreamingFinishReason() below.
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

// Mirrors src/endpoints/backends/chat-completions.js:78-85 verbatim. Kept in
// sync manually because that file runs server-side and can't be imported from
// browser code. Any change to that mapping MUST be reflected here or the
// streaming code path will diverge from the non-streaming path's finishReason.
const CLAUDE_STOP_REASON_TO_OAI = {
    end_turn: 'stop',
    max_tokens: 'length',
    stop_sequence: 'stop',
    tool_use: 'tool_calls',
    pause_turn: 'stop',
    refusal: 'content_filter',
};

// Mirrors src/endpoints/backends/chat-completions.js:244-254 verbatim.
const GEMINI_FINISH_REASON_TO_OAI = {
    STOP: 'stop',
    MAX_TOKENS: 'length',
    SAFETY: 'content_filter',
    RECITATION: 'content_filter',
    PROHIBITED_CONTENT: 'content_filter',
    BLOCKLIST: 'content_filter',
    SPII: 'content_filter',
    MALFORMED_FUNCTION_CALL: 'stop',
    OTHER: 'stop',
};

// Mirrors src/endpoints/backends/chat-completions.js Cohere mapping.
const COHERE_FINISH_REASON_TO_OAI = {
    complete: 'stop',
    max_tokens: 'length',
    tool_call: 'tool_calls',
    stop_sequence: 'stop',
    error: 'stop',
};

/**
 * Normalize a raw provider-specific finish/stop reason to the OAI vocabulary
 * used by isTruncatedFinishReason(). Used by the streaming code path in
 * openai.js where SSE chunks pass through unchanged from the upstream
 * provider (server-side normalization only happens on non-streaming JSON).
 *
 * @param {string} source One of chat_completion_sources values ('claude',
 *   'makersuite'/'google_ai_studio' for Gemini, 'cohere', ...) — anything
 *   else is treated as OAI-native (no remapping).
 * @param {unknown} rawReason The raw stop_reason / finish_reason value read
 *   from the SSE chunk.
 * @returns {string|null} Normalized OAI finish_reason, or null if input empty.
 */
export function normalizeStreamingFinishReason(source, rawReason) {
    if (rawReason === null || rawReason === undefined || rawReason === '') return null;
    const v = String(rawReason);
    const s = String(source || '').toLowerCase();
    if (s === 'claude') return CLAUDE_STOP_REASON_TO_OAI[v] ?? v;
    if (s === 'makersuite' || s === 'google_ai_studio' || s === 'vertexai') {
        return GEMINI_FINISH_REASON_TO_OAI[v] ?? v;
    }
    if (s === 'cohere') return COHERE_FINISH_REASON_TO_OAI[v.toLowerCase()] ?? v;
    return v;
}
