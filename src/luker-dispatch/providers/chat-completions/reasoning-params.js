// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Canonical reasoning vocabulary shared with the frontend capability descriptor.
 * The frontend sends canonical tokens only; every native mapping lives here.
 */
export const REASONING_TOKENS = ['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const RANK = { off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 };

export function normalizeReasoningToken(token) {
    if (token === 'min') return 'minimal';
    return REASONING_TOKENS.includes(token) ? token : 'auto';
}

export function isReasoningOff(token) {
    return normalizeReasoningToken(token) === 'off';
}

export function isReasoningAuto(token) {
    return normalizeReasoningToken(token) === 'auto';
}

export function clampReasoningToken(token, allowed) {
    const normalized = normalizeReasoningToken(token);
    if (normalized === 'auto' || allowed.includes(normalized)) return normalized;
    let best = null;
    for (const candidate of allowed) {
        if (candidate === 'auto') continue;
        if (RANK[candidate] <= RANK[normalized] && (best === null || RANK[candidate] > RANK[best])) best = candidate;
    }
    return best ?? allowed.find(candidate => candidate !== 'auto') ?? 'auto';
}

/**
 * OpenAI-family mapping. Used by OPENAI, AZURE_OPENAI and OPENAI_RESPONSES.
 * @param {string} token canonical token
 * @param {string} model
 * @param {{ responsesApi?: boolean }} [options]
 * @returns {string|undefined}
 */
export function resolveOpenAIEffort(token, model, { responsesApi = false } = {}) {
    const normalized = normalizeReasoningToken(token);
    if (normalized === 'auto') return undefined;
    if (normalized === 'off') return 'none';
    const isBaseGpt5 = /^gpt-5(-|$)/.test(model);
    const supportsXhigh = /gpt-6|gpt-5\.(4|5|6)|gpt-5\.1-codex-max/.test(model);
    const supportsMax = responsesApi && /gpt-6|gpt-5\.6/.test(model);
    switch (normalized) {
        case 'minimal': return isBaseGpt5 ? 'minimal' : 'low';
        case 'low': return 'low';
        case 'medium': return 'medium';
        case 'high': return 'high';
        case 'xhigh': return supportsXhigh ? 'xhigh' : 'high';
        case 'max': return supportsMax ? 'max' : (supportsXhigh ? 'xhigh' : 'high');
        default: return undefined;
    }
}

/**
 * Forward a canonical token as an OpenAI-style string without model clamping.
 * Used by CUSTOM and the aggregators whose model names are not on any allowlist.
 * @param {string} token
 * @returns {string|undefined}
 */
export function passthroughReasoningEffort(token) {
    const normalized = normalizeReasoningToken(token);
    if (normalized === 'auto') return undefined;
    if (normalized === 'off') return 'none';
    return normalized;
}

/**
 * Map include_reasoning to a native output-exclusion flag on an existing
 * `reasoning` object (OpenRouter, NanoGPT, ElectronHub).
 * @param {Record<string, any>} reasoningObject
 * @param {boolean} includeReasoning
 */
export function applyReasoningExclude(reasoningObject, includeReasoning) {
    reasoningObject.exclude = !includeReasoning;
}
