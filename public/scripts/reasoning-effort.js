// SPDX-License-Identifier: AGPL-3.0-or-later
export const REASONING_TOKENS = ['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Canonical token to i18n key. The dropdown is rebuilt on every source
 * switch, so labels must come from this static map rather than from the
 * currently rendered `<option>` text.
 * @type {Record<string, string>}
 */
export const REASONING_EFFORT_LABEL_KEYS = {
    auto: 'openai_reasoning_effort_auto',
    off: 'openai_reasoning_effort_off',
    minimal: 'openai_reasoning_effort_minimum',
    low: 'openai_reasoning_effort_low',
    medium: 'openai_reasoning_effort_medium',
    high: 'openai_reasoning_effort_high',
    xhigh: 'openai_reasoning_effort_xhigh',
    max: 'openai_reasoning_effort_maximum',
};

/**
 * Canonical token to English display label. Passed as the fallback text to
 * `translate(label, key)` so the default English UI never renders a raw i18n
 * key when no translation is available.
 * @type {Record<string, string>}
 */
export const REASONING_EFFORT_LABELS = {
    auto: 'Auto',
    off: 'Off',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra high',
    max: 'Max',
};

/**
 * Per-source reasoning capability. `options` drives the dropdown; `supportsOutput`
 * drives the display toggle; `hint` selects one of three shared hint strings.
 * @type {Record<string, { options: string[], supportsOutput: boolean, hint: 'varies'|'uniform'|'always_on'|null }>}
 */
export const REASONING_EFFORT_BY_SOURCE = {
    openai: { options: ['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh'], supportsOutput: true, hint: 'varies' },
    azure_openai: { options: ['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh'], supportsOutput: true, hint: 'varies' },
    openai_responses: { options: ['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], supportsOutput: true, hint: 'varies' },
    claude: { options: ['auto', 'off', 'low', 'medium', 'high', 'xhigh', 'max'], supportsOutput: true, hint: 'varies' },
    makersuite: { options: ['auto', 'off', 'minimal', 'low', 'medium', 'high'], supportsOutput: true, hint: 'varies' },
    vertexai: { options: ['auto', 'off', 'minimal', 'low', 'medium', 'high'], supportsOutput: true, hint: 'varies' },
    deepseek: { options: ['auto', 'off', 'low', 'high', 'max'], supportsOutput: true, hint: 'uniform' },
    xai: { options: ['auto', 'low', 'medium', 'high', 'xhigh'], supportsOutput: true, hint: 'always_on' },
    moonshot: { options: ['auto', 'off', 'low', 'high', 'max'], supportsOutput: true, hint: 'varies' },
    zai: { options: ['auto', 'off', 'low', 'medium', 'high', 'xhigh', 'max'], supportsOutput: true, hint: 'varies' },
    mistralai: { options: ['auto', 'off', 'low', 'high', 'max'], supportsOutput: true, hint: 'varies' },
    cohere: { options: ['auto', 'off'], supportsOutput: true, hint: 'uniform' },
    groq: { options: ['auto', 'off', 'low', 'medium', 'high'], supportsOutput: true, hint: 'varies' },
    perplexity: { options: ['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], supportsOutput: true, hint: 'uniform' },
    openrouter: { options: ['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], supportsOutput: true, hint: 'varies' },
    fireworks: { options: ['auto', 'off', 'low', 'medium', 'high', 'xhigh', 'max'], supportsOutput: true, hint: 'uniform' },
    nanogpt: { options: ['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], supportsOutput: true, hint: 'uniform' },
    electronhub: { options: ['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh'], supportsOutput: true, hint: 'uniform' },
    siliconflow: { options: ['auto', 'off', 'high', 'max'], supportsOutput: true, hint: 'varies' },
    workers_ai: { options: ['auto', 'off', 'low', 'medium', 'high', 'xhigh'], supportsOutput: true, hint: 'varies' },
    chutes: { options: ['auto', 'off'], supportsOutput: true, hint: 'uniform' },
    pollinations: { options: ['auto', 'minimal', 'low', 'medium', 'high'], supportsOutput: true, hint: 'uniform' },
    aimlapi: { options: ['auto', 'low', 'medium', 'high'], supportsOutput: true, hint: 'uniform' },
    custom: { options: ['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], supportsOutput: true, hint: 'uniform' },
    minimax: { options: ['auto', 'off', 'low', 'medium', 'high', 'xhigh', 'max'], supportsOutput: true, hint: 'varies' },
    cometapi: { options: [], supportsOutput: false, hint: null },
    ai21: { options: [], supportsOutput: false, hint: null },
};

export function normalizeReasoningToken(token) {
    if (token === 'min') return 'minimal';
    return REASONING_TOKENS.includes(token) ? token : 'auto';
}

export function getReasoningOptions(source) {
    return REASONING_EFFORT_BY_SOURCE[source]?.options ?? [];
}

export function getReasoningHint(source) {
    return REASONING_EFFORT_BY_SOURCE[source]?.hint ?? null;
}

export function supportsReasoningOutput(source) {
    return REASONING_EFFORT_BY_SOURCE[source]?.supportsOutput ?? false;
}

/**
 * Build the initial per-source map from the legacy global value.
 * @param {string} legacyToken
 * @returns {Record<string, string>}
 */
export function buildReasoningEffortBySource(legacyToken) {
    const legacy = normalizeReasoningToken(legacyToken);
    const map = {};
    for (const [source, descriptor] of Object.entries(REASONING_EFFORT_BY_SOURCE)) {
        if (!descriptor.options.length) continue;
        map[source] = descriptor.options.includes(legacy) ? legacy : 'auto';
    }
    return map;
}
