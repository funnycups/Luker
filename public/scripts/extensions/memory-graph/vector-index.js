// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import { getRequestHeaders } from '../../../script.js';
import { extension_settings } from '../../extensions.js';
import { getStringHash } from '../../utils.js';

const VECTOR_COLLECTION_PREFIX = 'mg_';
const VECTOR_REQUEST_TIMEOUT_MS = 120_000;

/**
 * @typedef {{hash: number, text: string, index: number, nodeId?: string}} VectorInsertItem
 * @typedef {{hash: number, score: number, text: string, index: number, nodeId?: string, vector?: number[]}} VectorQueryHit
 * @typedef {Array<VectorQueryHit> & {__queryVector?: number[]}} VectorQueryResults
 */

// ---------------------------------------------------------------------------
// Embedding source constants (mirrors backend SOURCES)
// ---------------------------------------------------------------------------

export const EMBEDDING_SOURCES = [
    'transformers', 'openai', 'openrouter', 'nomicai', 'cohere',
    'jina', 'ollama', 'llamacpp', 'vllm', 'extras', 'makersuite',
    'vertexai', 'mistral', 'chutes', 'nanogpt', 'electronhub',
];

export const EMBEDDING_DEFAULT_MODELS = {
    openai: 'text-embedding-3-small',
    openrouter: 'openai/text-embedding-3-large',
    cohere: 'embed-multilingual-v3.0',
    jina: 'jina-embeddings-v3',
    mistral: 'mistral-embed',
    ollama: 'nomic-embed-text',
    llamacpp: '',
    vllm: 'BAAI/bge-m3',
    chutes: 'chutes-qwen-qwen3-embedding-8b',
    nanogpt: 'text-embedding-3-small',
    electronhub: 'text-embedding-3-small',
    transformers: '',
    nomicai: '',
    extras: '',
    makersuite: 'text-embedding-005',
    vertexai: '',
};

// ---------------------------------------------------------------------------
// Vector config from settings
// ---------------------------------------------------------------------------

/**
 * Source-to-model-key mapping for Vector Storage extension settings.
 * @type {Record<string, string>}
 */
const VECTOR_EXT_MODEL_KEYS = {
    openai: 'openai_model',
    electronhub: 'electronhub_model',
    openrouter: 'openrouter_model',
    togetherai: 'togetherai_model',
    cohere: 'cohere_model',
    jina: 'jina_model',
    ollama: 'ollama_model',
    vllm: 'vllm_model',
    webllm: 'webllm_model',
    palm: 'google_model',
    vertexai: 'google_model',
    chutes: 'chutes_model',
    nanogpt: 'nanogpt_model',
    siliconflow: 'siliconflow_model',
};

/**
 * Build vector config by reading the Vector Storage extension settings.
 * Falls back to memory-graph's own legacy fields if Vector Storage is not configured.
 * @param {object} [_settings] - Unused (kept for call-site compat).
 * @returns {{source: string, model: string, collectionPrefix: string}}
 */
export function getVectorConfigFromSettings(_settings) {
    const vectorExt = extension_settings?.vectors;
    if (vectorExt && vectorExt.source) {
        const source = String(vectorExt.source).trim();
        const modelKey = VECTOR_EXT_MODEL_KEYS[source];
        const model = modelKey ? String(vectorExt[modelKey] || '').trim() : '';
        return {
            source,
            model: model || EMBEDDING_DEFAULT_MODELS[source] || '',
            collectionPrefix: VECTOR_COLLECTION_PREFIX,
        };
    }
    // Fallback: legacy memory-graph settings (embeddingSource / embeddingModel)
    const source = EMBEDDING_SOURCES.includes(_settings?.embeddingSource)
        ? _settings.embeddingSource
        : 'transformers';
    const model = String(_settings?.embeddingModel || EMBEDDING_DEFAULT_MODELS[source] || '').trim();
    return {
        source,
        model,
        collectionPrefix: VECTOR_COLLECTION_PREFIX,
    };
}

/**
 * Validate that vector config has minimum required fields.
 * @param {object} config
 * @returns {{valid: boolean, error: string}}
 */
export function validateVectorConfig(config) {
    if (!config) return { valid: false, error: 'No vector config' };
    if (!config.source) return { valid: false, error: 'No embedding source selected' };
    return { valid: true, error: '' };
}

// ---------------------------------------------------------------------------
// Collection ID
// ---------------------------------------------------------------------------

/**
 * Build a stable collection ID for a chat.
 * @param {string} chatId
 * @param {string} [prefix]
 * @returns {string}
 */
export function buildCollectionId(chatId, prefix = VECTOR_COLLECTION_PREFIX) {
    const sanitized = String(chatId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
    return `${prefix}${sanitized}`;
}

// ---------------------------------------------------------------------------
// Node vector text construction
// ---------------------------------------------------------------------------

// Fallback field priority when schema is not available
const FALLBACK_FIELD_PRIORITY = {
    event: ['summary', 'key_sentences'],
    character_sheet: ['name', 'aliases', 'traits', 'identity', 'state', 'goal', 'core_note'],
    location_state: ['name', 'aliases', 'controller', 'state', 'danger', 'resources'],
    rule_constraint: ['title', 'constraint', 'scope', 'status'],
};

/**
 * Resolve the embedding field priority for a node type.
 * Reads from schema's tableColumns if available, falls back to hardcoded defaults.
 *
 * @param {string} nodeType - The node type ID.
 * @param {Array} [schema] - The nodeTypeSchema array from settings.
 * @returns {string[]} Ordered list of field names to use for embedding.
 */
function resolveEmbeddingFields(nodeType, schema) {
    if (Array.isArray(schema)) {
        const typeSpec = schema.find(s => String(s?.id || '').toLowerCase() === nodeType);
        if (typeSpec) {
            // Prefer embeddingColumns (user-configured subset), fallback to tableColumns
            if (Array.isArray(typeSpec.embeddingColumns) && typeSpec.embeddingColumns.length > 0) {
                return typeSpec.embeddingColumns.map(c => String(c || '').trim()).filter(Boolean);
            }
            if (Array.isArray(typeSpec.tableColumns) && typeSpec.tableColumns.length > 0) {
                return typeSpec.tableColumns.map(c => String(c || '').trim()).filter(Boolean);
            }
        }
    }
    return FALLBACK_FIELD_PRIORITY[nodeType] || [];
}

/**
 * Build the text representation of a node for embedding.
 * Uses schema-defined tableColumns for field priority, with fallback defaults.
 *
 * @param {object} node - A graph node.
 * @param {Array} [schema] - The nodeTypeSchema array from settings (optional).
 * @returns {string}
 */
export function buildNodeVectorText(node, schema) {
    if (!node || typeof node !== 'object') return '';
    const fields = node.fields || {};
    const nodeType = String(node.type || '').trim().toLowerCase();
    const priorityFields = resolveEmbeddingFields(nodeType, schema);
    const parts = [];

    for (const key of priorityFields) {
        const value = fields[key];
        if (value == null || value === '') continue;
        if (Array.isArray(value)) {
            const joined = value.filter(Boolean).join(', ');
            if (joined) parts.push(joined);
        } else if (typeof value === 'object') {
            parts.push(JSON.stringify(value));
        } else {
            parts.push(String(value));
        }
    }

    // Append remaining fields not in priority list
    for (const [key, value] of Object.entries(fields)) {
        if (priorityFields.includes(key)) continue;
        if (value == null || value === '' || key === 'embedding') continue;
        if (Array.isArray(value)) {
            const joined = value.filter(Boolean).join(', ');
            if (joined) parts.push(`${key}: ${joined}`);
        } else if (typeof value === 'object') {
            parts.push(`${key}: ${JSON.stringify(value)}`);
        } else {
            parts.push(`${key}: ${value}`);
        }
    }

    return parts.join(' | ').trim();
}

/**
 * Compute a stable hash for a node's vector content + config.
 * Used to detect when a node needs re-embedding.
 *
 * @param {object} node
 * @param {object} config
 * @returns {number}
 */
export function buildNodeVectorHash(node, config, schema) {
    const text = buildNodeVectorText(node, schema);
    const seqTo = Number(node?.seqTo) || 0;
    const payload = [
        node?.id || '',
        text,
        String(seqTo),
        config?.source || '',
        config?.model || '',
    ].join('::');
    return getStringHash(payload);
}

// ---------------------------------------------------------------------------
// Fetch helper with timeout
// ---------------------------------------------------------------------------

function createAbortWithTimeout(externalSignal, timeoutMs = VECTOR_REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new DOMException('Vector request timeout', 'AbortError')), timeoutMs);

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

    return { signal: controller.signal, clearTimeout: () => clearTimeout(timeout) };
}

async function vectorFetch(url, body, signal) {
    const { signal: fetchSignal, clearTimeout: clearTO } = createAbortWithTimeout(signal);
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
            signal: fetchSignal,
        });
        if (!response.ok) {
            const text = await response.text().catch(() => response.statusText);
            throw new Error(`Vector API ${response.status}: ${text}`);
        }
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('json')) {
            return await response.json();
        }
        return null;
    } finally {
        clearTO();
    }
}

// ---------------------------------------------------------------------------
// Backend API wrappers
// ---------------------------------------------------------------------------

/**
 * Insert items into the vector collection.
 * The backend computes embeddings automatically.
 *
 * @param {string} collectionId
 * @param {object} config - {source, model}
 * @param {VectorInsertItem[]} items
 * @param {AbortSignal} [signal]
 */
export async function insertVectorItems(collectionId, config, items, signal) {
    if (!items?.length) return;
    await vectorFetch('/api/vector/insert', {
        collectionId,
        source: config.source,
        model: config.model,
        items: items.map(item => ({
            hash: item.hash,
            text: item.text,
            index: item.index,
            ...(item.nodeId ? { nodeId: item.nodeId } : {}),
        })),
    }, signal);
}

/**
 * Query the vector collection for similar items.
 *
 * @param {string} collectionId
 * @param {object} config - {source, model}
 * @param {string} searchText
 * @param {number} [topK=10]
 * @param {number} [threshold=0.0]
 * @param {AbortSignal} [signal]
 * @returns {Promise<VectorQueryResults>}
 */
export async function queryVectorCollection(collectionId, config, searchText, topK = 10, threshold = 0.0, signal, includeVectors = false) {
    const response = await vectorFetch('/api/vector/query', {
        collectionId,
        source: config.source,
        model: config.model,
        searchText,
        topK,
        threshold,
        includeVectors,
    }, signal);
    // Backend returns { metadata: [...], hashes: [...], queryVector?: [...] }
    if (response && Array.isArray(response.metadata)) {
        const result = /** @type {VectorQueryResults} */ (response.metadata);
        // Attach queryVector to the result array for cognitive pipeline access
        if (includeVectors && Array.isArray(response.queryVector)) {
            result.__queryVector = response.queryVector;
        }
        return result;
    }
    return Array.isArray(response) ? /** @type {VectorQueryResults} */ (response) : /** @type {VectorQueryResults} */ ([]);
}

/**
 * List saved hashes in a collection.
 *
 * @param {string} collectionId
 * @param {object} config
 * @param {AbortSignal} [signal]
 * @returns {Promise<number[]>}
 */
export async function listSavedHashes(collectionId, config, signal) {
    const results = await vectorFetch('/api/vector/list', {
        collectionId,
        source: config.source,
        model: config.model,
    }, signal);
    return Array.isArray(results) ? results : [];
}

/**
 * Delete items by hash.
 *
 * @param {string} collectionId
 * @param {object} config
 * @param {number[]} hashes
 * @param {AbortSignal} [signal]
 */
export async function deleteVectorItems(collectionId, config, hashes, signal) {
    if (!hashes?.length) return;
    await vectorFetch('/api/vector/delete', {
        collectionId,
        source: config.source,
        model: config.model,
        hashes,
    }, signal);
}

/**
 * Purge entire collection.
 *
 * @param {string} collectionId
 * @param {AbortSignal} [signal]
 */
export async function purgeVectorCollection(collectionId, signal) {
    await vectorFetch('/api/vector/purge', { collectionId }, signal);
}

/**
 * Rerank documents against a query.
 *
 * @param {string} query
 * @param {string[]} documents
 * @param {object} rerankConfig - {source, model, apiUrl?, apiKey?}
 * @param {number} [topK=10]
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array<{index: number, score: number}>>}
 */
/**
 * Query the vector collection using a raw vector instead of text.
 * Skips the embedding computation step on the backend.
 *
 * @param {string} collectionId
 * @param {object} config - {source, model}
 * @param {number[]} vector - The raw embedding vector to search with.
 * @param {number} [topK=10]
 * @param {number} [threshold=0.0]
 * @param {AbortSignal} [signal]
 * @param {boolean} [includeVectors=false]
 * @returns {Promise<VectorQueryHit[]>}
 */
export async function queryVectorCollectionByVector(collectionId, config, vector, topK = 10, threshold = 0.0, signal, includeVectors = false) {
    const response = await vectorFetch('/api/vector/query-by-vector', {
        collectionId,
        source: config.source,
        model: config.model,
        vector,
        topK,
        threshold,
        includeVectors,
    }, signal);
    if (response && Array.isArray(response.metadata)) {
        return response.metadata;
    }
    return Array.isArray(response) ? response : [];
}

export async function rerankDocuments(query, documents, rerankConfig, topK = 10, signal) {
    const results = await vectorFetch('/api/vector/rerank', {
        query,
        documents,
        source: rerankConfig?.source || 'cohere',
        model: rerankConfig?.model || '',
        apiUrl: rerankConfig?.apiUrl || '',
        apiKey: rerankConfig?.apiKey || '',
        topK,
    }, signal);
    return Array.isArray(results) ? results : [];
}

// ---------------------------------------------------------------------------
// Vector index state management
// ---------------------------------------------------------------------------

/**
 * Initialize or retrieve the vector index state on a store.
 * State tracks which nodes have been embedded and with what hash.
 *
 * @param {object} store - The memory graph store.
 * @returns {object} The vectorIndexState object (mutated in place on store).
 */
export function ensureVectorIndexState(store) {
    if (!store.vectorIndexState || typeof store.vectorIndexState !== 'object') {
        store.vectorIndexState = {
            source: '',
            model: '',
            collectionId: '',
            nodeToHash: {},
            hashToNodeId: {},
            dirty: false,
            lastWarning: '',
        };
    }
    return store.vectorIndexState;
}

/**
 * Get eligible nodes for vector indexing (non-archived, with content).
 *
 * @param {object} store
 * @returns {Array<object>}
 */
function getEligibleVectorNodes(store, schema) {
    const nodes = store.nodes || {};
    return Object.values(nodes)
        .filter(node => !node.archived && buildNodeVectorText(node, schema).length > 0);
}

/**
 * Compute what needs to be inserted/deleted to sync the vector index.
 *
 * @param {object} store
 * @param {object} config
 * @returns {{toInsert: Array, toDelete: number[], stats: {total: number, indexed: number, pending: number, stale: number}}}
 */
export function computeVectorSyncPlan(store, config, schema) {
    const state = ensureVectorIndexState(store);
    const eligible = getEligibleVectorNodes(store, schema);
    const desiredByNodeId = new Map();

    for (const node of eligible) {
        const hash = buildNodeVectorHash(node, config, schema);
        const text = buildNodeVectorText(node, schema);
        desiredByNodeId.set(node.id, { nodeId: node.id, hash, text, index: Number(node.seqTo) || 0 });
    }

    const toInsert = [];
    const toDelete = [];
    let indexed = 0;
    let pending = 0;
    let stale = 0;

    for (const [nodeId, entry] of desiredByNodeId) {
        const currentHash = state.nodeToHash[nodeId];
        if (currentHash === entry.hash) {
            indexed++;
        } else {
            if (currentHash !== undefined) {
                toDelete.push(currentHash);
                stale++;
            }
            toInsert.push(entry);
            pending++;
        }
    }

    // Nodes that were indexed but no longer eligible
    for (const [nodeId, hash] of Object.entries(state.nodeToHash)) {
        if (!desiredByNodeId.has(nodeId)) {
            toDelete.push(hash);
            stale++;
        }
    }

    return {
        toInsert,
        toDelete,
        stats: { total: eligible.length, indexed, pending, stale },
    };
}

/**
 * Sync the vector index for a store: insert new/changed nodes, delete stale ones.
 *
 * @param {object} store
 * @param {object} config - {source, model}
 * @param {string} chatId
 * @param {object} [options]
 * @param {boolean} [options.purge=false] - Purge and rebuild from scratch.
 * @param {boolean} [options.force=false] - Force re-embed all nodes.
 * @param {AbortSignal} [options.signal]
 * @param {Array} [options.schema]
 * @returns {Promise<{insertedCount: number, deletedCount: number, stats: object}>}
 */
export async function syncVectorIndex(store, config, chatId, options = {}) {
    const { purge = false, force = false, signal, schema = null } = options;
    const validation = validateVectorConfig(config);
    if (!validation.valid) {
        const state = ensureVectorIndexState(store);
        state.lastWarning = validation.error;
        return { insertedCount: 0, deletedCount: 0, stats: { total: 0, indexed: 0, pending: 0, stale: 0 } };
    }

    const state = ensureVectorIndexState(store);
    const collectionId = buildCollectionId(chatId);
    const configChanged = state.source !== config.source
        || state.model !== config.model
        || state.collectionId !== collectionId;

    if (purge || force || configChanged || state.dirty) {
        await purgeVectorCollection(collectionId, signal);
        state.source = config.source;
        state.model = config.model;
        state.collectionId = collectionId;
        state.nodeToHash = {};
        state.hashToNodeId = {};
        state.dirty = false;
        state.lastWarning = '';
    }

    const plan = computeVectorSyncPlan(store, config, schema);

    if (plan.toDelete.length > 0) {
        await deleteVectorItems(collectionId, config, plan.toDelete, signal);
        for (const hash of plan.toDelete) {
            const nodeId = state.hashToNodeId[hash];
            if (nodeId) {
                delete state.nodeToHash[nodeId];
                delete state.hashToNodeId[hash];
            }
        }
    }

    if (plan.toInsert.length > 0) {
        const BATCH_SIZE = 50;
        for (let i = 0; i < plan.toInsert.length; i += BATCH_SIZE) {
            if (signal?.aborted) break;
            const batch = plan.toInsert.slice(i, i + BATCH_SIZE);
            await insertVectorItems(collectionId, config, batch, signal);
            for (const entry of batch) {
                state.nodeToHash[entry.nodeId] = entry.hash;
                state.hashToNodeId[entry.hash] = entry.nodeId;
            }
        }
    }

    return {
        insertedCount: plan.toInsert.length,
        deletedCount: plan.toDelete.length,
        stats: plan.stats,
    };
}

/**
 * Sync a single node to the vector index (called after extraction).
 *
 * @param {object} store
 * @param {object} node
 * @param {object} config
 * @param {string} chatId
 * @param {AbortSignal} [signal]
 * @param {Array} [schema]
 */
export async function syncSingleNodeToVectorIndex(store, node, config, chatId, signal, schema) {
    const validation = validateVectorConfig(config);
    if (!validation.valid) return;

    const state = ensureVectorIndexState(store);
    const collectionId = state.collectionId || buildCollectionId(chatId);
    const text = buildNodeVectorText(node, schema);
    if (!text) return;

    const hash = buildNodeVectorHash(node, config, schema);
    const currentHash = state.nodeToHash[node.id];
    if (currentHash === hash) return;

    if (currentHash !== undefined) {
        await deleteVectorItems(collectionId, config, [currentHash], signal);
        delete state.hashToNodeId[currentHash];
    }

    await insertVectorItems(collectionId, config, [{ hash, text, index: Number(node.seqTo) || 0 }], signal);
    state.nodeToHash[node.id] = hash;
    state.hashToNodeId[hash] = node.id;
}

/**
 * Remove a node from the vector index (called on node deletion/rollback).
 *
 * @param {object} store
 * @param {string} nodeId
 * @param {object} config
 * @param {string} chatId
 * @param {AbortSignal} [signal]
 */
export async function removeNodeFromVectorIndex(store, nodeId, config, chatId, signal) {
    const state = ensureVectorIndexState(store);
    const hash = state.nodeToHash[nodeId];
    if (hash === undefined) return;

    const collectionId = state.collectionId || buildCollectionId(chatId);
    await deleteVectorItems(collectionId, config, [hash], signal);
    delete state.nodeToHash[nodeId];
    delete state.hashToNodeId[hash];
}

// ---------------------------------------------------------------------------
// High-level search: find similar nodes by text
// ---------------------------------------------------------------------------

/**
 * Find graph nodes similar to the given text using vector search.
 * Returns results mapped back to node IDs.
 * When includeVectors=true, each result also carries the embedding vector
 * and the array-level __queryVector property holds the query embedding.
 *
 * @param {string} queryText
 * @param {object} store
 * @param {object} config
 * @param {string} chatId
 * @param {object} [options]
 * @param {number} [options.topK=20]
 * @param {number} [options.threshold=0.0]
 * @param {boolean} [options.includeVectors=false]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Array<{nodeId: string, score: number, vector?: number[]}>>}
 */
export async function findSimilarNodes(queryText, store, config, chatId, options = {}) {
    const { topK = 20, threshold = 0.0, includeVectors = false, signal } = options;
    const validation = validateVectorConfig(config);
    if (!validation.valid) return [];

    const state = ensureVectorIndexState(store);
    const collectionId = state.collectionId || buildCollectionId(chatId);

    const rawResults = /** @type {VectorQueryResults} */ (
        await queryVectorCollection(collectionId, config, queryText, topK, threshold, signal, includeVectors)
    );

    const results = [];
    for (const hit of rawResults) {
        // Prefer nodeId from metadata (stored during insert), fallback to hashToNodeId mapping
        const nodeId = String(hit.nodeId || '').trim() || state.hashToNodeId?.[hit.hash] || '';
        if (!nodeId) continue;
        const node = store.nodes?.[nodeId];
        if (!node || node.archived) continue;
        const entry = { nodeId, score: Number(hit.score) || 0 };
        if (includeVectors && Array.isArray(hit.vector) && hit.vector.length > 0) {
            entry.vector = hit.vector;
        }
        results.push(entry);
    }

    const sorted = results.sort((a, b) => b.score - a.score);
    // Propagate queryVector from the raw response
    if (includeVectors && Array.isArray(rawResults.__queryVector)) {
        /** @type {Array<{nodeId: string, score: number, vector?: number[]}> & {__queryVector?: number[]}} */ (sorted).__queryVector = rawResults.__queryVector;
    }
    return sorted;
}
