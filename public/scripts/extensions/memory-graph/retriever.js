// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// RAG recall pipeline for memory-graph.
// Orchestrates: [optional LLM-rewritten query] → vector pre-filter → [optional rerank] → trim.
//
// The LLM query rewrite is performed by the caller (injectMemoryPrompts in main.js)
// and supplied via options.rewrittenQuery — keeping this module pure and unit-testable
// without an LLM client. See main.js → runQueryRewrite.

import {
    findSimilarNodes,
    buildNodeVectorText,
    rerankDocuments,
    getVectorConfigFromSettings,
    validateVectorConfig,
} from './vector-index.js';

const MODULE_NAME = 'memory_graph';

function isAbortError(error) {
    return error?.name === 'AbortError';
}

function throwIfAborted(signal) {
    if (signal?.aborted) {
        const err = new Error('RAG recall aborted');
        err.name = 'AbortError';
        throw err;
    }
}

export function normalizeQueryText(value) {
    return String(value ?? '').replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
}

function createEmptyMeta() {
    return {
        vectorHits: 0,
        finalCount: 0,
        rerankApplied: false,
        rewriteApplied: false,
        skipReasons: [],
        timings: {},
    };
}

/**
 * RAG recall: vector retrieval with optional LLM query rewrite and optional cross-encoder rerank.
 *
 * @param {object} store - Memory graph store (with .nodes).
 * @param {string} queryText - Raw query text (last user message + context).
 * @param {string} chatId - Chat key for vector collection scoping.
 * @param {object} settings - Effective memory-graph settings.
 * @param {object} [options]
 * @param {number} [options.maxResults=15] - Final cap on returned candidates.
 * @param {number} [options.vectorTopK=20] - Vector pre-filter Top-K.
 * @param {boolean} [options.useRerank=false] - Rerank vector hits with rerankProfile.
 * @param {object} [options.rerankProfile] - Rerank connection profile (required iff useRerank).
 * @param {string|null} [options.rewrittenQuery] - LLM-rewritten query to use in place of queryText.
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{candidates: Array, meta: object}>}
 */
export async function runRagRecall(store, queryText, chatId, settings, options = {}) {
    const {
        maxResults = 15,
        vectorTopK = 20,
        useRerank = false,
        rerankProfile = null,
        rewrittenQuery = null,
        signal = null,
    } = options;

    const meta = createEmptyMeta();
    const timings = {};
    const t0 = performance.now();

    const rewrittenTrimmed = typeof rewrittenQuery === 'string' ? rewrittenQuery.trim() : '';
    const effectiveQuery = normalizeQueryText(rewrittenTrimmed || queryText);
    if (rewrittenTrimmed) {
        meta.rewriteApplied = true;
        meta.rewrittenQuery = rewrittenTrimmed;
    }
    if (!effectiveQuery) {
        meta.skipReasons.push('Empty query');
        timings.totalMs = Math.round((performance.now() - t0) * 10) / 10;
        meta.timings = timings;
        return { candidates: [], meta };
    }

    const embeddingProfile = getVectorConfigFromSettings(settings);
    if (!validateVectorConfig(embeddingProfile).valid) {
        meta.skipReasons.push('No embedding profile selected, RAG recall skipped');
        timings.totalMs = Math.round((performance.now() - t0) * 10) / 10;
        meta.timings = timings;
        return { candidates: [], meta };
    }

    // Vector pre-filter
    throwIfAborted(signal);
    const tVec = performance.now();
    let vectorHits = [];
    try {
        vectorHits = await findSimilarNodes(effectiveQuery, store, embeddingProfile, chatId, {
            topK: vectorTopK,
            includeVectors: false,
            signal,
        });
    } catch (err) {
        if (isAbortError(err)) throw err;
        console.warn(`[${MODULE_NAME}] Vector search failed`, err);
        meta.skipReasons.push('Vector search failed');
        timings.totalMs = Math.round((performance.now() - t0) * 10) / 10;
        meta.timings = timings;
        return { candidates: [], meta };
    }
    timings.vectorMs = Math.round((performance.now() - tVec) * 10) / 10;
    meta.vectorHits = vectorHits.length;

    let candidates = vectorHits.map(hit => ({
        nodeId: hit.nodeId,
        vectorScore: Number(hit.score) || 0,
        rerankScore: null,
        finalScore: Number(hit.score) || 0,
    }));

    // Optional rerank
    if (useRerank && rerankProfile && candidates.length > 0) {
        throwIfAborted(signal);
        const tRerank = performance.now();
        try {
            const nodes = store.nodes || {};
            const documents = candidates.map(c => {
                const node = nodes[c.nodeId];
                return buildNodeVectorText(node, settings?.nodeTypeSchema || null) || c.nodeId;
            });
            const rerankResults = await rerankDocuments(
                effectiveQuery,
                documents,
                rerankProfile,
                candidates.length,
                signal,
            );
            if (rerankResults.length > 0) {
                const rerankScoreMap = new Map();
                for (const r of rerankResults) {
                    if (Number.isFinite(r.index) && r.index >= 0 && r.index < candidates.length) {
                        rerankScoreMap.set(candidates[r.index].nodeId, Number(r.score) || 0);
                    }
                }
                for (const c of candidates) {
                    const rerankScore = rerankScoreMap.get(c.nodeId);
                    if (rerankScore !== undefined) {
                        c.rerankScore = rerankScore;
                        c.finalScore = rerankScore;
                    }
                }
                candidates.sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0));
                meta.rerankApplied = true;
            }
        } catch (err) {
            if (isAbortError(err)) throw err;
            console.warn(`[${MODULE_NAME}] Rerank failed, falling back to vector order`, err);
            meta.skipReasons.push('Rerank failed, fell back to vector order');
        }
        timings.rerankMs = Math.round((performance.now() - tRerank) * 10) / 10;
    }

    candidates = candidates.slice(0, maxResults);

    timings.totalMs = Math.round((performance.now() - t0) * 10) / 10;
    meta.timings = timings;
    meta.finalCount = candidates.length;

    return { candidates, meta };
}
