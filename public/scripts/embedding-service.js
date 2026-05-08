// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// EmbeddingService — high-level client for the `/api/vector/*` backend.
//
// Consumer plugins (vectors, memory-graph, etc.) should call this service rather
// than hand-rolling fetch requests. It accepts an "embedding profile" or "rerank
// profile" (managed by the Connection Manager extension) and assembles the
// chat-completion-aligned request body (`reverse_proxy` / `proxy_password` /
// `secret_id` triplet plus per-provider knobs) before posting to the backend.

import { getRequestHeaders } from '../script.js';
import { extension_settings } from './extensions.js';

const VECTOR_REQUEST_TIMEOUT_MS = 120_000;

/**
 * @typedef {object} VectorInsertItem
 * @property {number} hash
 * @property {string} text
 * @property {number} index
 * @property {object} [metadata]
 */

/**
 * @typedef {object} VectorQueryHit
 * @property {number} hash
 * @property {number} score
 * @property {string} [text]
 * @property {number} [index]
 * @property {number[]} [vector]
 */

/**
 * @typedef {object} VectorQueryResponse
 * @property {VectorQueryHit[]} metadata
 * @property {number[]} hashes
 * @property {number[]} [queryVector]
 */

function resolveProfile(profileOrId, mode) {
    if (!profileOrId) return null;
    if (typeof profileOrId === 'object') return profileOrId;
    if (typeof profileOrId !== 'string') return null;
    const list = extension_settings?.connectionManager?.profiles;
    if (!Array.isArray(list)) return null;
    return list.find(p => p && p.id === profileOrId && String(p.mode || '') === mode) || null;
}

/**
 * Translate an embed profile into the body fields understood by the vector
 * backend endpoints.
 * @param {object} profile
 * @returns {object} Partial request body
 */
export function buildRequestBodyFromEmbedProfile(profile) {
    if (!profile || typeof profile !== 'object') return {};

    const source = String(profile.source || '').trim();
    if (!source) return {};

    const body = { source };
    const model = String(profile.model || '').trim();
    if (model) body.model = model;

    const apiUrl = String(profile['api-url'] || '').trim();
    const proxyPassword = profile['proxy-password'] != null
        ? String(profile['proxy-password'])
        : '';
    const secretId = String(profile['secret-id'] || '').trim();

    // Triplet — aligned with chat-completion endpoints.
    if (apiUrl) body.reverse_proxy = apiUrl;
    if (apiUrl && proxyPassword) body.proxy_password = proxyPassword;
    if (secretId) body.secret_id = secretId;

    // Local-backend fallback: the legacy `apiUrl` body field is still consulted by
    // the backend when `reverse_proxy` is absent, so propagate it explicitly to
    // keep a single source of truth.
    if (apiUrl && (source === 'ollama' || source === 'llamacpp' || source === 'vllm' || source === 'koboldcpp')) {
        body.apiUrl = apiUrl;
    }
    if (source === 'extras') {
        body.extrasUrl = apiUrl;
        body.extrasKey = proxyPassword;
    }

    // Per-provider knobs.
    if (source === 'jina') {
        if (profile['jina-late-chunking'] === 'true' || profile['jina-late-chunking'] === true) {
            body.jina_late_chunking = true;
        }
        const dims = Number(profile['jina-dimensions']);
        if (Number.isFinite(dims) && dims > 0) body.jina_dimensions = dims;
        const task = String(profile['jina-task'] || '').trim();
        if (task) body.jina_task = task;
    }
    if (source === 'ollama') {
        if (profile['ollama-keep'] === 'true' || profile['ollama-keep'] === true) {
            body.keep = true;
        }
    }
    if (source === 'siliconflow') {
        const ep = String(profile['siliconflow-endpoint'] || '').trim();
        if (ep) body.siliconflow_endpoint = ep;
    }
    if (source === 'workers_ai') {
        const accountId = String(profile['workers-ai-account-id'] || '').trim();
        if (accountId) body.workers_ai_account_id = accountId;
    }
    if (source === 'palm' || source === 'vertexai') {
        body.api = source === 'palm' ? 'makersuite' : 'vertexai';
        const region = String(profile['vertexai-region'] || '').trim();
        if (region) body.vertexai_region = region;
        const authMode = String(profile['vertexai-auth-mode'] || '').trim();
        if (authMode) body.vertexai_auth_mode = authMode;
        const expressId = String(profile['vertexai-express-project-id'] || '').trim();
        if (expressId) body.vertexai_express_project_id = expressId;
    }

    return body;
}

/**
 * Translate a rerank profile into the body fields understood by the rerank
 * backend endpoint.
 * @param {object} profile
 * @returns {object} Partial request body
 */
export function buildRequestBodyFromRerankProfile(profile) {
    if (!profile || typeof profile !== 'object') return {};

    const source = String(profile.source || '').trim();
    if (!source) return {};

    const body = { source };
    const model = String(profile.model || '').trim();
    if (model) body.model = model;

    const apiUrl = String(profile['api-url'] || '').trim();
    const proxyPassword = profile['proxy-password'] != null
        ? String(profile['proxy-password'])
        : '';
    const secretId = String(profile['secret-id'] || '').trim();

    if (apiUrl) body.reverse_proxy = apiUrl;
    if (apiUrl && proxyPassword) body.proxy_password = proxyPassword;
    if (secretId) body.secret_id = secretId;

    // Backward compat with the legacy custom-rerank body fields. The backend
    // prefers the triplet but accepts these as a fallback.
    if (source === 'custom') {
        if (apiUrl) body.apiUrl = apiUrl;
        if (proxyPassword) body.apiKey = proxyPassword;
    }

    return body;
}

function abortWithTimeout(externalSignal, timeoutMs = VECTOR_REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeout = setTimeout(
        () => controller.abort(new DOMException('Vector request timeout', 'AbortError')),
        timeoutMs,
    );

    if (externalSignal?.aborted) {
        clearTimeout(timeout);
        controller.abort(externalSignal.reason);
    } else if (externalSignal) {
        const onAbort = () => {
            clearTimeout(timeout);
            controller.abort(externalSignal.reason);
        };
        externalSignal.addEventListener('abort', onAbort, { once: true });
    }

    return { signal: controller.signal, dispose: () => clearTimeout(timeout) };
}

async function vectorFetch(url, body, signal) {
    const { signal: fetchSignal, dispose } = abortWithTimeout(signal);
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
            signal: fetchSignal,
        });
        if (!response.ok) {
            const text = await response.text().catch(() => response.statusText);
            const err = new Error(`Vector API ${response.status}: ${text}`);
            // @ts-ignore — annotate for callers that want to react to 4xx vs 5xx.
            err.status = response.status;
            throw err;
        }
        const contentType = response.headers.get('content-type') || '';
        if (response.status === 204) {
            return null;
        }
        if (contentType.includes('json')) {
            return await response.json();
        }
        return null;
    } finally {
        dispose();
    }
}

/**
 * High-level API that consumer plugins should use instead of touching
 * `/api/vector/*` directly. All methods accept either a profile id (string)
 * managed by Connection Manager, or a profile-shaped object.
 */
export const EmbeddingService = {
    /**
     * Resolve an embedding profile from id or object. Returns null if not found.
     * @param {string|object|null} profileOrId
     * @returns {object|null}
     */
    resolveEmbeddingProfile(profileOrId) {
        return resolveProfile(profileOrId, 'embed');
    },

    /**
     * Resolve a rerank profile from id or object. Returns null if not found.
     * @param {string|object|null} profileOrId
     * @returns {object|null}
     */
    resolveRerankProfile(profileOrId) {
        return resolveProfile(profileOrId, 'rerank');
    },

    /**
     * Insert items into a vector collection.
     * @param {object} args
     * @param {string|object} args.profile Embedding profile id or object
     * @param {string} args.collectionId
     * @param {VectorInsertItem[]} args.items
     * @param {AbortSignal} [args.signal]
     * @param {object} [args.extraBody] Additional body fields merged after the
     *   profile-derived fields. Used by callers that pre-compute embeddings
     *   client-side (e.g. WebLLM, KoboldCpp) and need to ship them in the body.
     * @returns {Promise<void>}
     */
    async insert({ profile, collectionId, items, signal, extraBody }) {
        if (!Array.isArray(items) || items.length === 0) return;
        const resolved = resolveProfile(profile, 'embed');
        if (!resolved) {
            throw new Error('Embedding profile not found');
        }
        await vectorFetch('/api/vector/insert', {
            ...buildRequestBodyFromEmbedProfile(resolved),
            ...(extraBody || {}),
            collectionId: String(collectionId),
            items: items.map(item => ({
                hash: item.hash,
                text: item.text,
                index: item.index,
                ...(item.metadata && typeof item.metadata === 'object'
                    ? { metadata: item.metadata }
                    : {}),
            })),
        }, signal);
    },

    /**
     * Query a vector collection by text.
     * @param {object} args
     * @param {string|object} args.profile Embedding profile
     * @param {string} args.collectionId
     * @param {string} args.searchText
     * @param {number} [args.topK=10]
     * @param {number} [args.threshold=0]
     * @param {boolean} [args.includeVectors=false]
     * @param {AbortSignal} [args.signal]
     * @param {object} [args.extraBody]
     * @returns {Promise<VectorQueryResponse>}
     */
    async query({ profile, collectionId, searchText, topK = 10, threshold = 0, includeVectors = false, signal, extraBody }) {
        const resolved = resolveProfile(profile, 'embed');
        if (!resolved) {
            throw new Error('Embedding profile not found');
        }
        const response = await vectorFetch('/api/vector/query', {
            ...buildRequestBodyFromEmbedProfile(resolved),
            ...(extraBody || {}),
            collectionId: String(collectionId),
            searchText: String(searchText || ''),
            topK,
            threshold,
            includeVectors,
        }, signal);
        return response || { metadata: [], hashes: [] };
    },

    /**
     * Query multiple collections at once. Returns a map keyed by collection id.
     * @param {object} args
     * @param {string|object} args.profile
     * @param {string[]} args.collectionIds
     * @param {string} args.searchText
     * @param {number} [args.topK=10]
     * @param {number} [args.threshold=0]
     * @param {AbortSignal} [args.signal]
     * @param {object} [args.extraBody]
     * @returns {Promise<Record<string, VectorQueryResponse>>}
     */
    async queryMulti({ profile, collectionIds, searchText, topK = 10, threshold = 0, signal, extraBody }) {
        const resolved = resolveProfile(profile, 'embed');
        if (!resolved) {
            throw new Error('Embedding profile not found');
        }
        const response = await vectorFetch('/api/vector/query-multi', {
            ...buildRequestBodyFromEmbedProfile(resolved),
            ...(extraBody || {}),
            collectionIds: collectionIds.map(String),
            searchText: String(searchText || ''),
            topK,
            threshold,
        }, signal);
        return response || {};
    },

    /**
     * Query a vector collection using a precomputed embedding vector. Skips the
     * embedding step.
     * @param {object} args
     * @param {string|object} args.profile
     * @param {string} args.collectionId
     * @param {number[]} args.vector
     * @param {number} [args.topK=10]
     * @param {number} [args.threshold=0]
     * @param {boolean} [args.includeVectors=false]
     * @param {AbortSignal} [args.signal]
     * @returns {Promise<VectorQueryResponse>}
     */
    async queryByVector({ profile, collectionId, vector, topK = 10, threshold = 0, includeVectors = false, signal }) {
        const resolved = resolveProfile(profile, 'embed');
        if (!resolved) {
            throw new Error('Embedding profile not found');
        }
        const response = await vectorFetch('/api/vector/query-by-vector', {
            ...buildRequestBodyFromEmbedProfile(resolved),
            collectionId: String(collectionId),
            vector,
            topK,
            threshold,
            includeVectors,
        }, signal);
        return response || { metadata: [], hashes: [] };
    },

    /**
     * List the hashes currently stored in a collection.
     * @param {object} args
     * @param {string|object} args.profile
     * @param {string} args.collectionId
     * @param {AbortSignal} [args.signal]
     * @returns {Promise<number[]>}
     */
    async listHashes({ profile, collectionId, signal }) {
        const resolved = resolveProfile(profile, 'embed');
        if (!resolved) {
            throw new Error('Embedding profile not found');
        }
        const response = await vectorFetch('/api/vector/list', {
            ...buildRequestBodyFromEmbedProfile(resolved),
            collectionId: String(collectionId),
        }, signal);
        return Array.isArray(response) ? response.map(Number) : [];
    },

    /**
     * Delete items from a collection by hash.
     * @param {object} args
     * @param {string|object} args.profile
     * @param {string} args.collectionId
     * @param {number[]} args.hashes
     * @param {AbortSignal} [args.signal]
     * @returns {Promise<void>}
     */
    async deleteByHashes({ profile, collectionId, hashes, signal }) {
        if (!Array.isArray(hashes) || hashes.length === 0) return;
        const resolved = resolveProfile(profile, 'embed');
        if (!resolved) {
            throw new Error('Embedding profile not found');
        }
        await vectorFetch('/api/vector/delete', {
            ...buildRequestBodyFromEmbedProfile(resolved),
            collectionId: String(collectionId),
            hashes: hashes.map(Number),
        }, signal);
    },

    /**
     * Purge a single collection across every source. The body need not include
     * source/profile because the backend purges every per-source folder.
     * @param {object} args
     * @param {string} args.collectionId
     * @param {AbortSignal} [args.signal]
     */
    async purgeCollection({ collectionId, signal }) {
        await vectorFetch('/api/vector/purge', {
            collectionId: String(collectionId),
        }, signal);
    },

    /**
     * Rerank an array of documents using a rerank profile.
     * @param {object} args
     * @param {string|object} args.profile Rerank profile
     * @param {string} args.query
     * @param {Array<{text: string, [key: string]: any}>} args.documents
     * @param {number} [args.topK=10]
     * @param {AbortSignal} [args.signal]
     * @returns {Promise<Array<{relevance_score: number, [key: string]: any}>>}
     */
    async rerank({ profile, query, documents, topK = 10, signal }) {
        const resolved = resolveProfile(profile, 'rerank');
        if (!resolved) {
            throw new Error('Rerank profile not found');
        }
        const response = await vectorFetch('/api/vector/rerank', {
            ...buildRequestBodyFromRerankProfile(resolved),
            query: String(query || ''),
            documents,
            topK,
        }, signal);
        return Array.isArray(response) ? response : [];
    },
};

export default EmbeddingService;
