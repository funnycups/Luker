// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import { getStringHash } from '../../utils.js';
import { getEmbeddingProfileById, getRerankProfileById } from '../connection-manager/embed-rerank.js';
import { EmbeddingService } from '../../embedding-service.js';

const VECTOR_COLLECTION_PREFIX = 'mg_';

/**
 * @typedef {{hash: number, text: string, index: number, nodeId?: string}} VectorInsertItem
 * @typedef {{hash: number, score: number, text: string, index: number, nodeId?: string, vector?: number[]}} VectorQueryHit
 * @typedef {Array<VectorQueryHit> & {__queryVector?: number[]}} VectorQueryResults
 */

// ---------------------------------------------------------------------------
// Profile resolution from memory-graph settings
// ---------------------------------------------------------------------------

/**
 * Resolves the embedding profile that memory-graph is configured to use, based
 * on its own `embeddingProfileId` setting. Returns null if no profile id is set
 * or the referenced profile does not exist.
 *
 * @param {object} settings - Memory-graph settings object.
 * @returns {object|null} EmbedProfile object or null.
 */
export function getVectorConfigFromSettings(settings) {
    const id = String(settings?.embeddingProfileId || '').trim();
    if (!id) return null;
    return getEmbeddingProfileById(id) || null;
}

/**
 * Resolves the rerank profile that memory-graph is configured to use, based on
 * its own `rerankProfileId` setting.
 * @param {object} settings
 * @returns {object|null}
 */
export function getRerankProfileFromSettings(settings) {
    const id = String(settings?.rerankProfileId || '').trim();
    if (!id) return null;
    return getRerankProfileById(id) || null;
}

/**
 * Validate that an embedding profile is usable for vector operations.
 * @param {object|null} profile - Profile object returned by getVectorConfigFromSettings.
 * @returns {{valid: boolean, error: string}}
 */
export function validateVectorConfig(profile) {
    if (!profile) return { valid: false, error: 'No embedding profile selected' };
    if (!profile.source) return { valid: false, error: 'Embedding profile has no source' };
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

const FALLBACK_FIELD_PRIORITY = {
    event: ['summary', 'key_sentences'],
    character_sheet: ['title', 'aliases', 'traits', 'identity', 'state', 'goal', 'core_note'],
    location_state: ['title', 'aliases', 'controller', 'state', 'danger', 'resources'],
    rule_constraint: ['title', 'constraint', 'scope', 'status'],
};

function resolveEmbeddingFields(nodeType, schema) {
    if (Array.isArray(schema)) {
        const typeSpec = schema.find(s => String(s?.id || '').toLowerCase() === nodeType);
        if (typeSpec) {
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
 * @param {object} node
 * @param {Array} [schema]
 * @returns {string}
 */
export function buildNodeVectorText(node, schema) {
    if (!node || typeof node !== 'object') return '';
    const fields = node.fields || {};
    const nodeType = String(node.type || '').trim().toLowerCase();
    const priorityFields = resolveEmbeddingFields(nodeType, schema);
    const parts = [];

    const readFieldValue = (key) => {
        if (key === 'title') {
            return node.title || fields.title || fields.name || '';
        }
        return fields[key];
    };

    for (const key of priorityFields) {
        const value = readFieldValue(key);
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
 * Compute a stable hash for a node's vector content + profile.
 * Used to detect when a node needs re-embedding.
 *
 * @param {object} node
 * @param {object} profile
 * @returns {number}
 */
export function buildNodeVectorHash(node, profile, schema) {
    const text = buildNodeVectorText(node, schema);
    const seqTo = Number(node?.seqTo) || 0;
    const payload = [
        node?.id || '',
        text,
        String(seqTo),
        profile?.source || '',
        profile?.model || '',
    ].join('::');
    return getStringHash(payload);
}

// ---------------------------------------------------------------------------
// Backend API wrappers — delegate to EmbeddingService
// ---------------------------------------------------------------------------

/**
 * Insert items into the vector collection.
 * @param {string} collectionId
 * @param {object} profile - Embedding profile
 * @param {VectorInsertItem[]} items
 * @param {AbortSignal} [signal]
 */
export async function insertVectorItems(collectionId, profile, items, signal) {
    if (!items?.length) return;
    if (!profile) return;
    await EmbeddingService.insert({
        profile,
        collectionId,
        items: items.map(item => ({
            hash: item.hash,
            text: item.text,
            index: item.index,
            metadata: { ...(item.metadata || {}), ...(item.nodeId ? { nodeId: item.nodeId } : {}) },
        })),
        signal,
    });
}

/**
 * Query the vector collection for similar items.
 *
 * @param {string} collectionId
 * @param {object} profile - Embedding profile
 * @param {string} searchText
 * @param {number} [topK=10]
 * @param {number} [threshold=0.0]
 * @param {AbortSignal} [signal]
 * @param {boolean} [includeVectors=false]
 * @returns {Promise<VectorQueryResults>}
 */
export async function queryVectorCollection(collectionId, profile, searchText, topK = 10, threshold = 0.0, signal, includeVectors = false) {
    if (!profile) return /** @type {VectorQueryResults} */ ([]);
    const response = await EmbeddingService.query({
        profile,
        collectionId,
        searchText,
        topK,
        threshold,
        includeVectors,
        signal,
    });
    if (response && Array.isArray(response.metadata)) {
        const result = /** @type {VectorQueryResults} */ (response.metadata);
        if (includeVectors && Array.isArray(response.queryVector)) {
            result.__queryVector = response.queryVector;
        }
        return result;
    }
    return /** @type {VectorQueryResults} */ ([]);
}

/**
 * Query the vector collection using a raw vector instead of text. Skips
 * embedding computation on the backend.
 *
 * @param {string} collectionId
 * @param {object} profile - Embedding profile (kept for collection scoping)
 * @param {number[]} vector
 * @param {number} [topK=10]
 * @param {number} [threshold=0.0]
 * @param {AbortSignal} [signal]
 * @param {boolean} [includeVectors=false]
 * @returns {Promise<VectorQueryHit[]>}
 */
export async function queryVectorCollectionByVector(collectionId, profile, vector, topK = 10, threshold = 0.0, signal, includeVectors = false) {
    if (!profile) return [];
    const response = await EmbeddingService.queryByVector({
        profile,
        collectionId,
        vector,
        topK,
        threshold,
        includeVectors,
        signal,
    });
    if (response && Array.isArray(response.metadata)) {
        return response.metadata;
    }
    return [];
}

/**
 * Delete items from the collection by hash.
 *
 * @param {string} collectionId
 * @param {object} profile
 * @param {number[]} hashes
 * @param {AbortSignal} [signal]
 */
export async function deleteVectorItems(collectionId, profile, hashes, signal) {
    if (!hashes?.length) return;
    if (!profile) return;
    await EmbeddingService.deleteByHashes({
        profile,
        collectionId,
        hashes,
        signal,
    });
}

/**
 * Purge a collection across all sources. Profile-agnostic.
 * @param {string} collectionId
 * @param {AbortSignal} [signal]
 */
export async function purgeVectorCollection(collectionId, signal) {
    await EmbeddingService.purgeCollection({ collectionId, signal });
}

/**
 * Rerank documents against a query.
 *
 * @param {string} query
 * @param {string[]} documents
 * @param {object} rerankProfile - Rerank profile from connection-manager
 * @param {number} [topK=10]
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array<{index: number, score: number}>>}
 */
export async function rerankDocuments(query, documents, rerankProfile, topK = 10, signal) {
    if (!rerankProfile) return [];
    const docObjects = (documents || []).map((text, index) => ({ text: String(text || ''), index }));
    const results = await EmbeddingService.rerank({
        profile: rerankProfile,
        query,
        documents: docObjects,
        topK,
        signal,
    });
    return Array.isArray(results)
        ? results.map(r => ({
            index: typeof r?.index === 'number' ? r.index : -1,
            score: Number(r?.relevance_score ?? r?.score) || 0,
        })).filter(r => r.index >= 0)
        : [];
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

function getEligibleVectorNodes(store, schema) {
    const nodes = store.nodes || {};
    return Object.values(nodes)
        .filter(node => !node.archived && buildNodeVectorText(node, schema).length > 0);
}

/**
 * Compute what needs to be inserted/deleted to sync the vector index.
 *
 * @param {object} store
 * @param {object} profile
 * @returns {{toInsert: Array, toDelete: number[], stats: {total: number, indexed: number, pending: number, stale: number}}}
 */
export function computeVectorSyncPlan(store, profile, schema) {
    const state = ensureVectorIndexState(store);
    const eligible = getEligibleVectorNodes(store, schema);
    const desiredByNodeId = new Map();

    for (const node of eligible) {
        const hash = buildNodeVectorHash(node, profile, schema);
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
 * Sync the vector index for a store.
 *
 * @param {object} store
 * @param {object} profile - Embedding profile
 * @param {string} chatId
 * @param {object} [options]
 * @param {boolean} [options.purge=false]
 * @param {boolean} [options.force=false]
 * @param {AbortSignal} [options.signal]
 * @param {Array} [options.schema]
 * @returns {Promise<{insertedCount: number, deletedCount: number, stats: object}>}
 */
export async function syncVectorIndex(store, profile, chatId, options = {}) {
    const { purge = false, force = false, signal, schema = null } = options;
    const validation = validateVectorConfig(profile);
    if (!validation.valid) {
        const state = ensureVectorIndexState(store);
        state.lastWarning = validation.error;
        return { insertedCount: 0, deletedCount: 0, stats: { total: 0, indexed: 0, pending: 0, stale: 0 } };
    }

    const state = ensureVectorIndexState(store);
    const collectionId = buildCollectionId(chatId);
    const configChanged = state.source !== profile.source
        || state.model !== (profile.model || '')
        || state.collectionId !== collectionId;

    if (purge || force || configChanged || state.dirty) {
        await purgeVectorCollection(collectionId, signal);
        state.source = profile.source;
        state.model = profile.model || '';
        state.collectionId = collectionId;
        state.nodeToHash = {};
        state.hashToNodeId = {};
        state.dirty = false;
        state.lastWarning = '';
    }

    const plan = computeVectorSyncPlan(store, profile, schema);

    if (plan.toDelete.length > 0) {
        await deleteVectorItems(collectionId, profile, plan.toDelete, signal);
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
            await insertVectorItems(collectionId, profile, batch, signal);
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

// ---------------------------------------------------------------------------
// High-level search: find similar nodes by text
// ---------------------------------------------------------------------------

/**
 * Find graph nodes similar to the given text using vector search.
 *
 * @param {string} queryText
 * @param {object} store
 * @param {object} profile - Embedding profile
 * @param {string} chatId
 * @param {object} [options]
 * @param {number} [options.topK=20]
 * @param {number} [options.threshold=0.0]
 * @param {boolean} [options.includeVectors=false]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Array<{nodeId: string, score: number, vector?: number[]}>>}
 */
export async function findSimilarNodes(queryText, store, profile, chatId, options = {}) {
    const { topK = 20, threshold = 0.0, includeVectors = false, signal } = options;
    const validation = validateVectorConfig(profile);
    if (!validation.valid) return [];

    const state = ensureVectorIndexState(store);
    const collectionId = state.collectionId || buildCollectionId(chatId);

    const rawResults = /** @type {VectorQueryResults} */ (
        await queryVectorCollection(collectionId, profile, queryText, topK, threshold, signal, includeVectors)
    );

    const results = [];
    for (const hit of rawResults) {
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
    if (includeVectors && Array.isArray(rawResults.__queryVector)) {
        /** @type {Array<{nodeId: string, score: number, vector?: number[]}> & {__queryVector?: number[]}} */ (sorted).__queryVector = rawResults.__queryVector;
    }
    return sorted;
}
