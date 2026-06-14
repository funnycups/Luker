// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Memory-graph vector index — IO shell.
//
// All side-effect-free helpers (text/hash builders, validation, sync-plan
// computation) live in `vector-index-core.js`. This file owns the parts that
// reach across module boundaries: profile resolution from connection-manager,
// `/api/vector/*` calls via EmbeddingService, and the high-level
// `findSimilarNodes` / `syncVectorIndex` orchestration.

import { getEmbeddingProfileById, getRerankProfileById } from '../connection-manager/embed-rerank.js';
const EmbeddingService = Luker.getContext().embeddingService;
import {
    validateVectorConfig,
    buildCollectionId,
    buildNodeVectorText,
    buildNodeVectorHash,
    ensureVectorIndexState,
    computeVectorSyncPlan,
} from './vector-index-core.js';

export {
    validateVectorConfig,
    buildCollectionId,
    buildNodeVectorText,
    buildNodeVectorHash,
    ensureVectorIndexState,
    computeVectorSyncPlan,
};

// ---------------------------------------------------------------------------
// Profile resolution from memory-graph settings
// ---------------------------------------------------------------------------

/**
 * Resolves the embedding profile that memory-graph is configured to use,
 * based on its own `embeddingProfileId` setting.
 * @param {object} settings
 * @returns {object|null}
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

// ---------------------------------------------------------------------------
// Backend API wrappers — delegate to EmbeddingService
// ---------------------------------------------------------------------------

/**
 * Insert items into the vector collection.
 * @param {string} collectionId
 * @param {object} profile
 * @param {Array<object>} items
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
 * @param {string} collectionId
 * @param {object} profile
 * @param {string} searchText
 * @param {number} [topK=10]
 * @param {number} [threshold=0.0]
 * @param {AbortSignal} [signal]
 * @param {boolean} [includeVectors=false]
 */
export async function queryVectorCollection(collectionId, profile, searchText, topK = 10, threshold = 0.0, signal, includeVectors = false) {
    if (!profile) return [];
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
        const result = response.metadata;
        if (includeVectors && Array.isArray(response.queryVector)) {
            result.__queryVector = response.queryVector;
        }
        return result;
    }
    return [];
}

/**
 * Query the vector collection using a raw vector instead of text. Skips
 * embedding computation on the backend.
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
 */
export async function purgeVectorCollection(collectionId, signal) {
    await EmbeddingService.purgeCollection({ collectionId, signal });
}

/**
 * Rerank documents against a query.
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
// High-level operations: sync index, find similar nodes
// ---------------------------------------------------------------------------

/**
 * Sync the vector index for a store.
 *
 * @param {object} store
 * @param {object} profile
 * @param {string} chatId
 * @param {object} [options]
 * @param {boolean} [options.purge=false]
 * @param {boolean} [options.force=false]
 * @param {AbortSignal} [options.signal]
 * @param {Array} [options.schema]
 * @param {(progress: {current: number, total: number}) => void} [options.onProgress]
 * @param {boolean} [options.tolerateErrors=false] When true, batch failures are logged and their
 *   nodeIds returned in `failedNodeIds` instead of aborting the whole sync.
 */
export async function syncVectorIndex(store, profile, chatId, options = {}) {
    const { purge = false, force = false, signal, schema = null, onProgress = null, tolerateErrors = false } = options;
    const validation = validateVectorConfig(profile);
    if (!validation.valid) {
        const state = ensureVectorIndexState(store);
        state.lastWarning = validation.error;
        return { insertedCount: 0, deletedCount: 0, stats: { total: 0, indexed: 0, pending: 0, stale: 0 }, failedNodeIds: [] };
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
    const failedNodeIds = [];

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
        const total = plan.toInsert.length;
        let processed = 0;
        for (let i = 0; i < total; i += BATCH_SIZE) {
            if (signal?.aborted) break;
            const batch = plan.toInsert.slice(i, i + BATCH_SIZE);
            try {
                await insertVectorItems(collectionId, profile, batch, signal);
                for (const entry of batch) {
                    state.nodeToHash[entry.nodeId] = entry.hash;
                    state.hashToNodeId[entry.hash] = entry.nodeId;
                }
            } catch (error) {
                if (!tolerateErrors) throw error;
                console.error('[memory-graph/vector-index] batch insert failed, skipping batch:', error, batch.map(b => b.nodeId));
                for (const entry of batch) {
                    failedNodeIds.push(entry.nodeId);
                }
            }
            processed += batch.length;
            if (typeof onProgress === 'function') {
                try { onProgress({ current: processed, total }); } catch (_) { /* noop */ }
            }
        }
    }

    return {
        insertedCount: plan.toInsert.length - failedNodeIds.length,
        deletedCount: plan.toDelete.length,
        stats: plan.stats,
        failedNodeIds,
    };
}

/**
 * Find graph nodes similar to the given text using vector search.
 *
 * @param {string} queryText
 * @param {object} store
 * @param {object} profile
 * @param {string} chatId
 * @param {object} [options]
 * @returns {Promise<Array<{nodeId: string, score: number, vector?: number[]}>>}
 */
export async function findSimilarNodes(queryText, store, profile, chatId, options = {}) {
    const { topK = 20, threshold = 0.0, includeVectors = false, signal } = options;
    const validation = validateVectorConfig(profile);
    if (!validation.valid) return [];

    const state = ensureVectorIndexState(store);
    const collectionId = state.collectionId || buildCollectionId(chatId);

    const rawResults = await queryVectorCollection(collectionId, profile, queryText, topK, threshold, signal, includeVectors);

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
        sorted.__queryVector = rawResults.__queryVector;
    }
    return sorted;
}
