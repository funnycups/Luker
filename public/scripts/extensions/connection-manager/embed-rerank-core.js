// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Embed/Rerank profile — pure core layer.
//
// Source-def tables, lookup helpers, profile compaction (cross-source field
// stripping + empty-field removal) and field-validation live here so they can
// be unit-tested without `script.js` / popup / DOM imports. The IO shell that
// owns the popup form, secret-store integration and CRUD lives in
// `embed-rerank.js` and consumes these helpers.

export const EMBED_MODE = 'embed';
export const RERANK_MODE = 'rerank';

export const EMBEDDING_SOURCE_DEFS = [
    { id: 'transformers', label: 'Local (Transformers.js)', needsModel: false, needsUrl: false, needsKey: false, secretKey: null, urlOptional: false, defaultModel: '' },
    { id: 'webllm', label: 'WebLLM (in-browser)', needsModel: true, needsUrl: false, needsKey: false, secretKey: null, urlOptional: false, defaultModel: '' },
    { id: 'extras', label: 'SillyTavern Extras', needsModel: false, needsUrl: true, needsKey: false, secretKey: null, urlOptional: false, defaultModel: '' },
    { id: 'openai', label: 'OpenAI', needsModel: true, needsUrl: false, needsKey: true, secretKey: 'api_key_openai', urlOptional: true, defaultModel: 'text-embedding-3-small' },
    { id: 'cohere', label: 'Cohere', needsModel: true, needsUrl: false, needsKey: true, secretKey: 'api_key_cohere', urlOptional: true, defaultModel: 'embed-multilingual-v3.0' },
    { id: 'jina', label: 'Jina AI', needsModel: true, needsUrl: false, needsKey: true, secretKey: 'api_key_jina', urlOptional: true, defaultModel: 'jina-embeddings-v3' },
    { id: 'mistral', label: 'Mistral', needsModel: false, needsUrl: false, needsKey: true, secretKey: 'api_key_mistralai', urlOptional: true, defaultModel: 'mistral-embed' },
    { id: 'nomicai', label: 'NomicAI', needsModel: false, needsUrl: false, needsKey: true, secretKey: 'api_key_nomicai', urlOptional: true, defaultModel: 'nomic-embed-text-v1.5' },
    { id: 'togetherai', label: 'Together AI', needsModel: true, needsUrl: false, needsKey: true, secretKey: 'api_key_togetherai', urlOptional: true, defaultModel: 'togethercomputer/m2-bert-80M-32k-retrieval' },
    { id: 'openrouter', label: 'OpenRouter', needsModel: true, needsUrl: false, needsKey: true, secretKey: 'api_key_openrouter', urlOptional: true, defaultModel: 'openai/text-embedding-3-large' },
    { id: 'electronhub', label: 'ElectronHub', needsModel: true, needsUrl: false, needsKey: true, secretKey: 'api_key_electronhub', urlOptional: true, defaultModel: 'text-embedding-3-small' },
    { id: 'chutes', label: 'Chutes', needsModel: true, needsUrl: false, needsKey: true, secretKey: 'api_key_chutes', urlOptional: true, defaultModel: 'chutes-qwen-qwen3-embedding-8b' },
    { id: 'nanogpt', label: 'NanoGPT', needsModel: true, needsUrl: false, needsKey: true, secretKey: 'api_key_nanogpt', urlOptional: true, defaultModel: 'text-embedding-3-small' },
    { id: 'siliconflow', label: 'SiliconFlow', needsModel: true, needsUrl: false, needsKey: true, secretKey: 'api_key_siliconflow', urlOptional: true, defaultModel: 'Qwen/Qwen3-Embedding-0.6B' },
    { id: 'workers_ai', label: 'Cloudflare Workers AI', needsModel: true, needsUrl: false, needsKey: true, secretKey: 'api_key_workers_ai', urlOptional: false, defaultModel: '@cf/baai/bge-m3' },
    { id: 'palm', label: 'Google AI Studio (PaLM)', needsModel: true, needsUrl: false, needsKey: true, secretKey: 'api_key_makersuite', urlOptional: true, defaultModel: 'text-embedding-005' },
    { id: 'vertexai', label: 'Google Vertex AI', needsModel: true, needsUrl: false, needsKey: true, secretKey: 'api_key_vertexai', urlOptional: true, defaultModel: 'text-embedding-005' },
    { id: 'ollama', label: 'Ollama', needsModel: true, needsUrl: true, needsKey: false, secretKey: null, urlOptional: false, defaultModel: 'mxbai-embed-large' },
    { id: 'llamacpp', label: 'llama.cpp', needsModel: false, needsUrl: true, needsKey: false, secretKey: null, urlOptional: false, defaultModel: '' },
    { id: 'vllm', label: 'vLLM', needsModel: true, needsUrl: true, needsKey: false, secretKey: null, urlOptional: false, defaultModel: '' },
    { id: 'koboldcpp', label: 'KoboldCpp', needsModel: false, needsUrl: true, needsKey: false, secretKey: null, urlOptional: false, defaultModel: '' },
];

export const RERANK_SOURCE_DEFS = [
    { id: 'cohere', label: 'Cohere', needsModel: true, needsUrl: false, needsKey: true, secretKey: 'api_key_cohere', urlOptional: true, defaultModel: 'rerank-v3.5' },
    { id: 'jina', label: 'Jina AI', needsModel: true, needsUrl: false, needsKey: true, secretKey: 'api_key_jina', urlOptional: true, defaultModel: 'jina-reranker-v2-base-multilingual' },
    { id: 'custom', label: 'Custom (OpenAI-compatible)', needsModel: true, needsUrl: true, needsKey: false, secretKey: null, urlOptional: false, defaultModel: '' },
];

/**
 * @param {string} sourceId
 * @returns {object|null}
 */
export function getEmbeddingSourceDef(sourceId) {
    return EMBEDDING_SOURCE_DEFS.find(s => s.id === sourceId) || null;
}

/**
 * @param {string} sourceId
 * @returns {object|null}
 */
export function getRerankSourceDef(sourceId) {
    return RERANK_SOURCE_DEFS.find(s => s.id === sourceId) || null;
}

export function listEmbeddingSourceDefs() {
    return EMBEDDING_SOURCE_DEFS.slice();
}

export function listRerankSourceDefs() {
    return RERANK_SOURCE_DEFS.slice();
}

/**
 * Strip empty optional fields from the profile and remove provider-specific
 * fields that don't belong to the chosen source. Mutates and returns the input.
 * @param {object} profile
 * @param {'embed'|'rerank'} mode
 * @returns {object}
 */
export function compactProfile(profile, mode) {
    const def = mode === EMBED_MODE ? getEmbeddingSourceDef(profile.source) : getRerankSourceDef(profile.source);

    const keepIfTruthy = ['model', 'api-url', 'proxy-password', 'secret-id', 'jina-task', 'jina-dimensions', 'workers-ai-account-id', 'siliconflow-endpoint', 'vertexai-region', 'vertexai-auth-mode', 'vertexai-express-project-id'];
    for (const k of keepIfTruthy) {
        if (Object.hasOwn(profile, k) && (profile[k] === '' || profile[k] == null)) {
            delete profile[k];
        }
    }
    // Booleans: only keep when 'true'
    for (const k of ['jina-late-chunking', 'ollama-keep']) {
        if (profile[k] !== 'true') delete profile[k];
    }
    // Strip provider-specific fields that don't belong to the chosen source
    if (def) {
        if (profile.source !== 'jina') {
            delete profile['jina-late-chunking'];
            delete profile['jina-dimensions'];
            delete profile['jina-task'];
        }
        if (profile.source !== 'ollama') {
            delete profile['ollama-keep'];
        }
        if (profile.source !== 'siliconflow') {
            delete profile['siliconflow-endpoint'];
        }
        if (profile.source !== 'workers_ai') {
            delete profile['workers-ai-account-id'];
        }
        if (profile.source !== 'vertexai' && profile.source !== 'palm') {
            delete profile['vertexai-region'];
            delete profile['vertexai-auth-mode'];
            delete profile['vertexai-express-project-id'];
        }
    }
    return profile;
}

/**
 * Validates an embed/rerank profile-form values bag and returns a compacted
 * profile (without `id` — the IO layer assigns one). Pure: no UI/storage side
 * effects, errors are returned as strings rather than thrown/toastr'd.
 *
 * @param {'embed'|'rerank'} mode
 * @param {object} values - raw form values keyed by field name
 * @param {string[]} [takenNames] - names already used by other profiles
 * @returns {{ok: true, profile: object} | {ok: false, error: string}}
 */
export function validateProfileFields(mode, values, takenNames = []) {
    const name = String(values?.name || '').trim();
    if (!name) {
        return { ok: false, error: 'Profile name is required.' };
    }
    if (Array.isArray(takenNames) && takenNames.includes(name)) {
        return { ok: false, error: 'A profile with this name already exists.' };
    }
    const source = String(values?.source || '').trim();
    const def = mode === EMBED_MODE ? getEmbeddingSourceDef(source) : getRerankSourceDef(source);
    if (!def) {
        return { ok: false, error: `Invalid source: ${source}` };
    }
    if (def.needsUrl && !def.urlOptional) {
        if (!String(values['api-url'] || '').trim()) {
            return { ok: false, error: `URL is required for ${def.label}.` };
        }
    }
    if (def.needsModel && !String(values.model || '').trim() && !def.defaultModel) {
        return { ok: false, error: `Model is required for ${def.label}.` };
    }
    if (source === 'workers_ai' && !String(values['workers-ai-account-id'] || '').trim()) {
        return { ok: false, error: 'Cloudflare Account ID is required.' };
    }

    const profile = /** @type {any} */ ({
        mode,
        name,
        source,
    });

    const fields = ['model', 'api-url', 'proxy-password', 'secret-id'];
    if (mode === EMBED_MODE) {
        fields.push('jina-late-chunking', 'jina-dimensions', 'jina-task',
            'ollama-keep', 'siliconflow-endpoint', 'workers-ai-account-id',
            'vertexai-region', 'vertexai-auth-mode', 'vertexai-express-project-id');
    }
    for (const f of fields) {
        if (Object.hasOwn(values, f)) profile[f] = values[f];
    }

    return { ok: true, profile: compactProfile(profile, mode) };
}
