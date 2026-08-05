// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// RAG recall pipeline for memory-graph.
// Orchestrates: [optional LLM-rewritten query] → vector pre-filter → per-type
// bucketing → [optional per-bucket rerank] → merge → trim.
//
// The LLM query rewrite is performed by the caller (injectMemoryPrompts in main.js)
// and supplied via options.rewrittenQuery — keeping this module pure and unit-testable
// without an LLM client. See main.js → runQueryRewrite.
//
// Per-type bucketing exists because vector pre-filter over a shared pool
// systematically starves under-represented types. In real corpora `event` nodes
// vastly outnumber character_sheet / location_state / thread; without bucketing,
// a shared topK fills entirely with events and the other types never surface,
// even though they carry latest-truth state recall depends on.

import {
    findSimilarNodes,
    buildNodeVectorText,
    rerankDocuments,
    getVectorConfigFromSettings,
    validateVectorConfig,
} from './vector-index.js';

const MODULE_NAME = 'memory_graph';

// Sentinel bucket key for candidates whose node.type is missing / doesn't
// resolve to a schema type. Kept as one bucket so no candidate is silently
// dropped just because its type is unknown.
const UNKNOWN_TYPE = '__unknown__';

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
        perBucket: {},
    };
}

function createBucketMeta() {
    return {
        vectorHits: 0,
        finalCount: 0,
        rerankApplied: false,
        skipReasons: [],
    };
}

// Resolve the K quota for a given type. `perTypeK` map takes precedence;
// missing entries fall back to `defaultPerTypeK`; missing default falls back
// to `fallback` (typically = maxResults, giving the pre-existing single-pool
// behavior when the caller supplies no per-type config at all).
function resolveTypeQuota(type, perTypeK, defaultPerTypeK, fallback) {
    if (perTypeK && Object.prototype.hasOwnProperty.call(perTypeK, type)) {
        const explicit = Number(perTypeK[type]);
        if (Number.isFinite(explicit) && explicit >= 0) return Math.floor(explicit);
    }
    if (Number.isFinite(Number(defaultPerTypeK)) && Number(defaultPerTypeK) >= 0) {
        return Math.floor(Number(defaultPerTypeK));
    }
    return fallback;
}

// Compute the vector-side topK we actually need to request. When bucketing is
// configured, the caller-supplied vectorTopK can be too small to feed every
// bucket to its quota; auto-lift so buckets can fill.
function computeEffectiveVectorTopK(callerTopK, perTypeK, defaultPerTypeK, maxResults) {
    const base = Math.max(0, Math.floor(Number(callerTopK) || 0));
    const quotas = perTypeK && typeof perTypeK === 'object' ? Object.values(perTypeK) : [];
    let quotaSum = 0;
    for (const raw of quotas) {
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) quotaSum += Math.floor(n);
    }
    const defaultK = Number.isFinite(Number(defaultPerTypeK)) && Number(defaultPerTypeK) > 0
        ? Math.floor(Number(defaultPerTypeK))
        : 0;
    // Reserve headroom for unlisted types via defaultK; use maxResults as an
    // upper-bound proxy for how many distinct unlisted types could realistically
    // matter in one recall.
    const unlistedHeadroom = defaultK * Math.max(1, Math.floor(Number(maxResults) || 0));
    const required = quotaSum + unlistedHeadroom;
    return Math.max(base, required, Math.floor(Number(maxResults) || 0));
}

// Group already-scored vector candidates by node.type. Preserves input order
// within each bucket (which the caller keeps sorted by vector score desc).
function bucketByType(candidates, store) {
    const buckets = new Map();
    for (const c of candidates) {
        const node = store?.nodes?.[c.nodeId];
        const type = String(node?.type || '').trim() || UNKNOWN_TYPE;
        c.nodeType = type;
        if (!buckets.has(type)) buckets.set(type, []);
        buckets.get(type).push(c);
    }
    return buckets;
}

// Rerank one bucket in place. Failures fall back to the bucket's incoming
// vector order and record a skipReason on the bucket meta; they do not
// propagate to sibling buckets or the whole pipeline.
async function rerankBucket(query, bucket, rerankProfile, settings, store, signal, bucketMeta) {
    if (bucket.length === 0) return bucket;
    try {
        const documents = bucket.map((c) => {
            const node = store.nodes?.[c.nodeId];
            return buildNodeVectorText(node, settings?.nodeTypeSchema || null) || c.nodeId;
        });
        const rerankResults = await rerankDocuments(
            query,
            documents,
            rerankProfile,
            bucket.length,
            signal,
        );
        if (rerankResults.length === 0) return bucket;
        const rerankScoreMap = new Map();
        for (const r of rerankResults) {
            if (Number.isFinite(r.index) && r.index >= 0 && r.index < bucket.length) {
                rerankScoreMap.set(bucket[r.index].nodeId, Number(r.score) || 0);
            }
        }
        for (const c of bucket) {
            const s = rerankScoreMap.get(c.nodeId);
            if (s !== undefined) {
                c.rerankScore = s;
                c.finalScore = s;
            }
        }
        bucket.sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0));
        bucketMeta.rerankApplied = true;
        return bucket;
    } catch (err) {
        if (isAbortError(err)) throw err;
        console.warn(`[${MODULE_NAME}] Rerank failed for bucket, falling back to vector order`, err);
        bucketMeta.skipReasons.push('Rerank failed, fell back to vector order');
        return bucket;
    }
}

/**
 * RAG recall: vector retrieval with optional LLM query rewrite, per-type
 * bucketing, and optional per-bucket cross-encoder rerank.
 *
 * @param {object} store - Memory graph store (with .nodes).
 * @param {string} queryText - Raw query text (last user message + context).
 * @param {string} chatId - Chat key for vector collection scoping.
 * @param {object} settings - Effective memory-graph settings.
 * @param {object} [options]
 * @param {number} [options.maxResults=15] - Final cap on returned candidates.
 * @param {number} [options.vectorTopK=20] - Vector pre-filter Top-K (auto-lifted
 *   when perTypeK / defaultPerTypeK demand more).
 * @param {boolean} [options.useRerank=false] - Rerank per bucket.
 * @param {object} [options.rerankProfile] - Rerank connection profile (required iff useRerank).
 * @param {string|null} [options.rewrittenQuery] - LLM-rewritten query to use in place of queryText.
 * @param {object} [options.perTypeK] - Map of typeId → per-type quota.
 * @param {number} [options.defaultPerTypeK] - Fallback quota for types not in perTypeK.
 *   Omit both perTypeK and defaultPerTypeK to get legacy single-pool behavior
 *   (everything in one bucket, capped by maxResults).
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
        perTypeK = null,
        defaultPerTypeK = null,
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

    // Vector pre-filter — auto-lift topK so per-type quotas can fill.
    const effectiveTopK = computeEffectiveVectorTopK(vectorTopK, perTypeK, defaultPerTypeK, maxResults);
    throwIfAborted(signal);
    const tVec = performance.now();
    let vectorHits = [];
    try {
        vectorHits = await findSimilarNodes(effectiveQuery, store, embeddingProfile, chatId, {
            topK: effectiveTopK,
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

    // Filter out hits pointing at nodes not in the store (stale index rows).
    const scored = [];
    for (const hit of vectorHits) {
        const nodeId = String(hit.nodeId || '').trim();
        if (!nodeId || !store?.nodes?.[nodeId]) continue;
        scored.push({
            nodeId,
            nodeType: '', // filled in by bucketByType
            vectorScore: Number(hit.score) || 0,
            rerankScore: null,
            finalScore: Number(hit.score) || 0,
        });
    }

    // If neither perTypeK nor defaultPerTypeK is provided, run the legacy
    // single-pool path: no bucketing, one rerank call (if enabled), trim to
    // maxResults. This preserves the pre-existing contract for callers that
    // haven't opted in to per-type bucketing.
    const bucketingConfigured =
        (perTypeK && typeof perTypeK === 'object' && Object.keys(perTypeK).length > 0)
        || (Number.isFinite(Number(defaultPerTypeK)) && Number(defaultPerTypeK) > 0);

    if (!bucketingConfigured) {
        let candidates = scored;
        if (useRerank && rerankProfile && candidates.length > 0) {
            throwIfAborted(signal);
            const tRerank = performance.now();
            const legacyBucketMeta = createBucketMeta();
            candidates = await rerankBucket(effectiveQuery, candidates, rerankProfile, settings, store, signal, legacyBucketMeta);
            if (legacyBucketMeta.rerankApplied) meta.rerankApplied = true;
            for (const r of legacyBucketMeta.skipReasons) meta.skipReasons.push(r);
            timings.rerankMs = Math.round((performance.now() - tRerank) * 10) / 10;
        }
        candidates = candidates.slice(0, maxResults);
        timings.totalMs = Math.round((performance.now() - t0) * 10) / 10;
        meta.timings = timings;
        meta.finalCount = candidates.length;
        // Populate nodeType on each candidate for callers that inspect it.
        for (const c of candidates) {
            const node = store?.nodes?.[c.nodeId];
            c.nodeType = String(node?.type || '').trim();
        }
        return { candidates, meta };
    }

    // Bucketing path.
    const buckets = bucketByType(scored, store);

    // Per-bucket vector-order cap, then optional per-bucket rerank.
    let tRerankTotal = 0;
    const perBucketOrdered = [];
    for (const [type, bucket] of buckets) {
        const bucketMeta = createBucketMeta();
        bucketMeta.vectorHits = bucket.length;

        const quota = resolveTypeQuota(type, perTypeK, defaultPerTypeK, maxResults);
        // Take top-quota by vector score first (bucket already sorted).
        let capped = bucket.slice(0, quota);

        if (useRerank && rerankProfile && capped.length > 0) {
            throwIfAborted(signal);
            const tRerank = performance.now();
            capped = await rerankBucket(effectiveQuery, capped, rerankProfile, settings, store, signal, bucketMeta);
            tRerankTotal += performance.now() - tRerank;
        }

        bucketMeta.finalCount = capped.length;
        meta.perBucket[type] = bucketMeta;
        if (bucketMeta.rerankApplied) meta.rerankApplied = true;
        perBucketOrdered.push({ type, items: capped });
    }

    if (useRerank) {
        timings.rerankMs = Math.round(tRerankTotal * 10) / 10;
    }

    // Merge across buckets. Iteration order is insertion order of the Map,
    // which follows the order candidates appeared in vector hits — i.e.
    // whichever type had the top-scoring hit comes first. This preserves
    // "most relevant type first" without introducing an arbitrary type
    // priority list here (main.js re-sorts by timeline afterwards anyway).
    const merged = [];
    for (const { items } of perBucketOrdered) {
        for (const c of items) merged.push(c);
    }

    const finalCandidates = merged.slice(0, maxResults);
    timings.totalMs = Math.round((performance.now() - t0) * 10) / 10;
    meta.timings = timings;
    meta.finalCount = finalCandidates.length;

    return { candidates: finalCandidates, meta };
}
