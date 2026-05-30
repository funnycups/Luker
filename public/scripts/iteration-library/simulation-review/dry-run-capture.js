// Shared helper for simulation-review code paths that need to see the
// real prompt the model would receive, including all extension hooks
// that mutate it. Drives a dryRun Generate so the prompt-build pipeline
// runs end-to-end without invoking the model or persisting to chat,
// and captures the named event's payload via a one-shot listener
// registered last so it fires after any extension mutations.

import { Generate, eventSource, event_types } from '../../../script.js';

/**
 * Runs a dryRun Generate to drive the prompt-build pipeline (including
 * extension hooks that mutate the prompt) without invoking the model
 * or persisting to chat. Captures the named event's payload via a
 * one-shot listener registered last so it fires after extension
 * mutations. Returns the captured payload (or null on failure).
 *
 * @param {object} context - getContext() result; falls back to global eventSource/Generate
 * @param {string} eventName - one of event_types.CHAT_COMPLETION_PROMPT_READY or event_types.GENERATION_WORLD_INFO_FINALIZED
 * @param {{quietPrompt?: string, skipWIAN?: boolean}} [opts]
 * @returns {Promise<any|null>}
 */
export async function captureDryRunPayload(context, eventName, opts = {}) {
    const { quietPrompt = '', skipWIAN = false } = opts;
    const src = context?.eventSource ?? eventSource ?? null;
    if (!src) return null;
    const generateFn = context?.Generate ?? Generate;
    if (typeof generateFn !== 'function') return null;

    let captured = null;
    const listener = (payload) => {
        try { captured = structuredClone(payload); }
        catch { captured = payload; }
    };
    const registerLast = typeof src.makeLast === 'function'
        ? src.makeLast.bind(src)
        : src.on.bind(src);
    registerLast(eventName, listener);

    try {
        await generateFn('quiet', { quiet_prompt: quietPrompt, skipWIAN, quietToLoud: false }, true);
    } catch (err) {
        console.warn('[simulation-review/dry-run-capture] dryRun failed', err);
    } finally {
        try { src.removeListener(eventName, listener); } catch (_) { /* best-effort */ }
    }
    return captured;
}

/**
 * For CHAT_COMPLETION_PROMPT_READY payloads: extract the chat array.
 * The event payload is `{chat, dryRun}`; callers receive the full
 * payload from captureDryRunPayload, this helper unwraps the array.
 */
export function unwrapCapturedChat(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.chat)) return payload.chat;
    return null;
}

/**
 * Concatenate every system message's content from a captured prompt
 * array, in order, separated by blank lines. Mirrors the popup's
 * pre-existing `assembledPrompt.systemPrompt` shape so the renderer is
 * unchanged.
 */
export function extractSystemFromCapturedPrompt(promptArray) {
    if (!Array.isArray(promptArray)) return '';
    return promptArray
        .filter(m => (m?.role || '').toLowerCase() === 'system')
        .map(m => String(m?.content || ''))
        .join('\n\n');
}

/**
 * Return non-system messages from a captured prompt array as plain
 * `{role, content}` records, preserving order.
 */
export function extractNonSystemFromCapturedPrompt(promptArray) {
    if (!Array.isArray(promptArray)) return [];
    return promptArray
        .filter(m => (m?.role || '').toLowerCase() !== 'system')
        .map(m => ({ role: String(m?.role || ''), content: String(m?.content || '') }));
}
