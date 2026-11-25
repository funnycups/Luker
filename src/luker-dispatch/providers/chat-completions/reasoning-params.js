// SPDX-License-Identifier: AGPL-3.0-or-later
import { resolveOpenAIModelCapabilities } from '../../../../public/scripts/lib/provider-capabilities.js';

/**
 * Canonical reasoning vocabulary shared with the frontend capability descriptor.
 * The frontend sends canonical tokens only; every native mapping lives here.
 */
export const REASONING_TOKENS = ['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function normalizeReasoningToken(token) {
    if (token === 'min') return 'minimal';
    return REASONING_TOKENS.includes(token) ? token : 'auto';
}

/**
 * OpenAI-family mapping. Used by OPENAI, AZURE_OPENAI and OPENAI_RESPONSES.
 * Product mapping from canonical UI effort tokens to OpenAI wire effort values
 * respecting verified model constraints (see provider-capabilities.js).
 * @param {string} token canonical token
 * @param {string} model
 * @param {{ responsesApi?: boolean }} [options]
 * @returns {string|undefined}
 */
export function resolveOpenAIEffort(token, model, { responsesApi = false } = {}) {
    const normalized = normalizeReasoningToken(token);
    if (normalized === 'auto') return undefined;
    const caps = resolveOpenAIModelCapabilities(model);
    // GPT-6 Astra and GPT-6.1 Sol reject `none` with HTTP 400; the documented
    // lowest substitute is `low`.
    if (normalized === 'off') return caps.rejectsReasoningNone ? 'low' : 'none';
    const supportsMax = responsesApi && caps.supportsResponsesMax;
    switch (normalized) {
        case 'minimal': return caps.isBaseGpt5 ? 'minimal' : 'low';
        case 'low': return 'low';
        case 'medium': return 'medium';
        case 'high': return 'high';
        case 'xhigh': return caps.supportsXhigh ? 'xhigh' : 'high';
        case 'max': return supportsMax ? 'max' : (caps.supportsXhigh ? 'xhigh' : 'high');
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
