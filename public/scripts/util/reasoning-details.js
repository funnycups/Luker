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
