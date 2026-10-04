// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

export const SAFE_SEARCH_OPTIONS = [
    ['off', 'Off'],
    ['moderate', 'Moderate'],
    ['strict', 'Strict'],
];

const SAFE_SEARCH_FIELD = {
    key: 'safeSearch',
    type: 'select',
    label: 'Default safe search',
    options: SAFE_SEARCH_OPTIONS,
    default: 'moderate',
};

export const SEARCH_PROVIDERS = [
    {
        id: 'ddg',
        label: 'DuckDuckGo (no login)',
        secretKey: null,
        fields: [SAFE_SEARCH_FIELD],
    },
    {
        id: 'searxng',
        label: 'SearXNG (custom instance)',
        secretKey: null,
        fields: [
            { key: 'baseUrl', type: 'text', label: 'SearXNG instance URL', placeholder: 'https://your-searxng.example', default: '' },
            SAFE_SEARCH_FIELD,
        ],
    },
    {
        id: 'brave',
        label: 'Brave Search (API key)',
        secretKey: 'api_key_brave_search',
        fields: [SAFE_SEARCH_FIELD],
    },
    {
        id: 'tavily',
        label: 'Tavily (API key)',
        secretKey: 'api_key_tavily',
        fields: [
            {
                key: 'searchDepth',
                type: 'select',
                label: 'Search depth',
                options: [['basic', 'Basic'], ['advanced', 'Advanced'], ['fast', 'Fast'], ['ultra-fast', 'Ultra fast']],
                default: 'basic',
            },
            {
                key: 'topic',
                type: 'select',
                label: 'Topic',
                options: [['general', 'General'], ['news', 'News'], ['finance', 'Finance']],
                default: 'general',
            },
            {
                key: 'includeAnswer',
                type: 'select',
                label: 'Include answer',
                options: [['off', 'Off'], ['basic', 'Basic'], ['advanced', 'Advanced']],
                default: 'off',
            },
            SAFE_SEARCH_FIELD,
        ],
    },
    {
        id: 'exa',
        label: 'Exa (API key)',
        secretKey: 'api_key_exa',
        fields: [
            {
                key: 'searchType',
                type: 'select',
                label: 'Search type',
                options: [
                    ['auto', 'Auto'], ['fast', 'Fast'], ['instant', 'Instant'],
                    ['deep-lite', 'Deep lite'], ['deep', 'Deep'], ['deep-reasoning', 'Deep reasoning'],
                ],
                default: 'auto',
            },
            {
                key: 'category',
                type: 'select',
                label: 'Category',
                options: [
                    ['', 'Any'], ['company', 'Company'], ['publication', 'Publication'], ['news', 'News'],
                    ['personal site', 'Personal site'], ['financial report', 'Financial report'], ['people', 'People'],
                ],
                default: '',
            },
            {
                key: 'contents',
                type: 'select',
                label: 'Result contents',
                options: [['highlights', 'Highlights'], ['text', 'Full text'], ['none', 'None']],
                default: 'highlights',
            },
            SAFE_SEARCH_FIELD,
        ],
    },
    {
        id: 'serper',
        label: 'Serper (API key)',
        secretKey: 'api_key_serper',
        fields: [
            {
                key: 'resultType',
                type: 'select',
                label: 'Result type',
                options: [['web', 'Web'], ['news', 'News']],
                default: 'web',
            },
            { key: 'region', type: 'text', label: 'Region', placeholder: 'us', default: '' },
            { key: 'language', type: 'text', label: 'Language', placeholder: 'en', default: '' },
        ],
    },
    {
        id: 'serpapi',
        label: 'SerpApi (API key)',
        secretKey: 'api_key_serpapi',
        fields: [
            {
                key: 'resultType',
                type: 'select',
                label: 'Result type',
                options: [['web', 'Web'], ['news', 'News']],
                default: 'web',
            },
            { key: 'region', type: 'text', label: 'Region', placeholder: 'us', default: '' },
            { key: 'language', type: 'text', label: 'Language', placeholder: 'en', default: '' },
            SAFE_SEARCH_FIELD,
        ],
    },
    {
        id: 'zai',
        label: 'Z.AI (API key)',
        secretKey: 'api_key_zai',
        fields: [
            {
                key: 'recency',
                type: 'select',
                label: 'Recency',
                options: [
                    ['noLimit', 'No limit'], ['oneDay', 'Past day'], ['oneWeek', 'Past week'],
                    ['oneMonth', 'Past month'], ['oneYear', 'Past year'],
                ],
                default: 'noLimit',
            },
        ],
    },
];

const SAFE_SEARCH_VALUES = SAFE_SEARCH_OPTIONS.map(([value]) => value);
const LEGACY_SAFE_SEARCH_PROVIDER_IDS = new Set(['ddg', 'searxng', 'brave']);

function clampInteger(value, min, max, fallback) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, parsed));
}

function normalizeWhitespace(text) {
    return String(text || '')
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export function normalizeSafeSearch(value, fallback = 'moderate') {
    const normalized = String(value || '').trim().toLowerCase();
    return SAFE_SEARCH_VALUES.includes(normalized) ? normalized : fallback;
}

export function getSearchProviderDefinition(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return SEARCH_PROVIDERS.find(provider => provider.id === normalized) || SEARCH_PROVIDERS[0];
}

export function normalizeFieldValue(field, raw) {
    if (field.type === 'select') {
        return field.options.some(([value]) => value === raw) ? raw : field.default;
    }
    if (field.type === 'number') {
        return clampInteger(raw, field.min ?? 0, field.max ?? Number.MAX_SAFE_INTEGER, field.default);
    }
    if (field.type === 'checkbox') {
        return Boolean(raw);
    }
    return normalizeWhitespace(raw ?? field.default ?? '');
}

export function normalizeProviderConfig(providerId, raw = {}, legacySafeSearch) {
    const definition = getSearchProviderDefinition(providerId);
    const source = raw && typeof raw === 'object' ? raw : {};
    const normalized = {};
    for (const field of definition.fields) {
        let value = source[field.key];
        if (field.key === 'safeSearch'
            && value == null
            && LEGACY_SAFE_SEARCH_PROVIDER_IDS.has(definition.id)) {
            value = normalizeSafeSearch(legacySafeSearch, field.default);
        }
        normalized[field.key] = normalizeFieldValue(field, value);
    }
    return normalized;
}

export function normalizeProviderSettings(raw = {}, legacy = {}) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const normalized = {};
    for (const definition of SEARCH_PROVIDERS) {
        normalized[definition.id] = normalizeProviderConfig(definition.id, source[definition.id], legacy.safeSearch);
    }
    return normalized;
}
