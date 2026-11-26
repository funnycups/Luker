/**
 * Pure helpers for OpenRouter-style `reasoning_details` arrays.
 *
 * The provider streams a logical reasoning block as many small deltas that
 * all carry the same `index`, so reassembly is driven by the `type`
 * transition, not by `index`: consecutive `reasoning.text` / `reasoning.summary`
 * entries concatenate into one entry, while `reasoning.encrypted` blobs are
 * opaque and stay discrete. Re-submitting a fragmented array breaks multi-turn
 * round-tripping upstream, so the client stream accumulator and the server
 * request inspector share these helpers. Kept free of DOM and app imports so
 * it can be unit-tested under the node test environment.
 */

const TEXT = 'reasoning.text';
const SUMMARY = 'reasoning.summary';

/**
 * Merge one incoming batch of reasoning_details into `accumulated` in place.
 * @param {object[]} accumulated
 * @param {object[]|null|undefined} incoming
 */
export function mergeReasoningDetails(accumulated, incoming) {
    if (!Array.isArray(accumulated) || !Array.isArray(incoming)) return;
    for (const detail of incoming) {
        if (!detail || typeof detail !== 'object') continue;
        const last = accumulated[accumulated.length - 1];

        if (detail.type === TEXT && last?.type === TEXT) {
            last.text = (last.text || '') + (detail.text || '');
            last.signature = last.signature || detail.signature;
            last.format = last.format || detail.format;
        } else if (detail.type === SUMMARY && last?.type === SUMMARY) {
            last.summary = (last.summary || '') + (detail.summary || '');
            last.format = last.format || detail.format;
        } else {
            accumulated.push({ ...detail });
        }
    }
}

/**
 * Client-side stream accumulator for a chat-completion `state`: appends one
 * delta's reasoning_details to `state.reasoningDetails` with the same merging
 * semantics, backfills a positional `index` for entries the provider left
 * without one, and routes tool-attached encrypted payloads into
 * `state.toolSignatures`.
 * @param {{ reasoningDetails?: object[], toolSignatures?: Record<string, string> }} state
 * @param {object[]|null|undefined} incoming
 */
export function pushReasoningDetails(state, incoming) {
    if (!state || !Array.isArray(incoming) || incoming.length === 0) return;
    if (!Array.isArray(state.reasoningDetails)) {
        state.reasoningDetails = [];
    }
    for (const detail of incoming) {
        if (!detail || typeof detail !== 'object') continue;

        const isEncrypted = detail.type === 'reasoning.encrypted' && typeof detail.data === 'string' && detail.data.length > 0;
        const isToolLikeId = typeof detail.id === 'string' && /^(tool_|call_)/.test(detail.id);
        if (isEncrypted && isToolLikeId) {
            if (!state.toolSignatures || typeof state.toolSignatures !== 'object') {
                state.toolSignatures = {};
            }
            state.toolSignatures[detail.id] = detail.data;
        }

        const last = state.reasoningDetails[state.reasoningDetails.length - 1];
        const mergesWithLast = (detail.type === TEXT && last?.type === TEXT)
            || (detail.type === SUMMARY && last?.type === SUMMARY);
        if (mergesWithLast) {
            mergeReasoningDetails(state.reasoningDetails, [detail]);
            continue;
        }

        const preserved = { ...detail };
        if (!Number.isInteger(preserved.index)) {
            preserved.index = state.reasoningDetails.length;
        }
        state.reasoningDetails.push(preserved);
    }
}

/**
 * Concatenate the human-readable text carried by a reasoning_details array
 * (`reasoning.text` fragments plus `reasoning.summary` fragments, in order).
 * Encrypted blobs contribute nothing. Detects the dual-channel case where the
 * same thinking arrives both as a plain string and as structured entries.
 * @param {object[]|null|undefined} details
 * @returns {string}
 */
export function joinReasoningDetailsText(details) {
    if (!Array.isArray(details)) return '';
    let out = '';
    for (const detail of details) {
        if (!detail || typeof detail !== 'object') continue;
        if (detail.type === TEXT && typeof detail.text === 'string') {
            out += detail.text;
        } else if (detail.type === SUMMARY && typeof detail.summary === 'string') {
            out += detail.summary;
        }
    }
    return out;
}
