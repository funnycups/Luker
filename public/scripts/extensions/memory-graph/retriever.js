// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Hybrid recall pipeline for memory-graph.
// Orchestrates: vector pre-filter → entity anchors → PEDSA graph diffusion
//             → hybrid scoring → [rerank] → [cognitive pipeline] → output
//
// Algorithm design informed by PeroCore/TriviumDB (Apache-2.0) by YoKONCy.

import {
    buildAdjacencyMap,
    diffuseAndRank,
    extractEntityAnchors,
    computeCooccurrenceBoost,
    isEntityType,
    DIFFUSION_DEFAULTS,
    TYPE_HALF_LIFE,
} from './diffusion.js';
import {
    findSimilarNodes,
    buildNodeVectorText,
    rerankDocuments,
    getVectorConfigFromSettings,
    validateVectorConfig,
    queryVectorCollection,
    queryVectorCollectionByVector,
    buildCollectionId,
    ensureVectorIndexState,
} from './vector-index.js';
import {
    applyNMFRebalance,
    computeFISTAResidual,
    applyDPPSampling,
} from './cognitive.js';

const MODULE_NAME = 'memory_graph';

// ---------------------------------------------------------------------------
// Type-specific scoring weights
// ---------------------------------------------------------------------------

const TYPE_WEIGHT_CONFIG = {
    event: {
        vectorWeight: 0.35,
        diffusionWeight: 0.30,
        lexicalWeight: 0.15,
        anchorWeight: 0.05,
        recencyWeight: 0.15,
    },
    character_sheet: {
        vectorWeight: 0.25,
        diffusionWeight: 0.20,
        lexicalWeight: 0.35,
        anchorWeight: 0.10,
        recencyWeight: 0.10,
    },
    location_state: {
        vectorWeight: 0.30,
        diffusionWeight: 0.25,
        lexicalWeight: 0.30,
        anchorWeight: 0.05,
        recencyWeight: 0.10,
    },
    rule_constraint: {
        vectorWeight: 0.25,
        diffusionWeight: 0.10,
        lexicalWeight: 0.35,
        anchorWeight: 0.05,
        recencyWeight: 0.00,
    },
};

const DEFAULT_TYPE_WEIGHTS = {
    vectorWeight: 0.30,
    diffusionWeight: 0.25,
    lexicalWeight: 0.25,
    anchorWeight: 0.05,
    recencyWeight: 0.15,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAbortError(error) {
    return error?.name === 'AbortError';
}

function throwIfAborted(signal) {
    if (signal?.aborted) {
        const err = new Error('Hybrid recall aborted');
        err.name = 'AbortError';
        throw err;
    }
}

function normalizeQueryText(value, maxLength = 800) {
    return String(value ?? '').replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

// ---------------------------------------------------------------------------
// Lazy co-occurrence rebuild (time-weighted, no persistence needed)
// ---------------------------------------------------------------------------

function rebuildCooccurrenceCounts(store, currentSeq, schema) {
    const counts = {};
    const nodes = store.nodes || {};
    const edges = Array.isArray(store.edges) ? store.edges : [];

    for (const node of Object.values(nodes)) {
        if (node.archived) continue;
        // Skip entity nodes — we want event/non-entity nodes that link entities together
        if (isEntityType(node.type, schema)) continue;

        const linkedEntities = [];
        for (const edge of edges) {
            const from = String(edge.from || '').trim();
            const to = String(edge.to || '').trim();
            let linkedId = null;
            if (from === node.id) linkedId = to;
            else if (to === node.id) linkedId = from;
            if (!linkedId) continue;
            const linkedNode = nodes[linkedId];
            if (linkedNode && !linkedNode.archived && isEntityType(linkedNode.type, schema)) {
                linkedEntities.push(linkedId);
            }
        }

        if (linkedEntities.length < 2) continue;

        // Time-weighted contribution: recent events contribute more
        const nodeSeq = Math.max(0, Number(node.seqTo) || 0);
        const distance = Math.max(0, currentSeq - nodeSeq);
        const weight = Math.exp(-0.693 * distance / 100); // half-life = 100 turns

        const sorted = [...new Set(linkedEntities)].sort();
        for (let i = 0; i < sorted.length; i++) {
            for (let j = i + 1; j < sorted.length; j++) {
                const key = `${sorted[i]}|${sorted[j]}`;
                counts[key] = (counts[key] || 0) + weight;
            }
        }
    }

    return counts;
}

// ---------------------------------------------------------------------------
// Lexical scoring (lightweight token overlap)
// ---------------------------------------------------------------------------

function buildLexicalUnits(text) {
    const normalized = String(text || '').toLowerCase();
    const rawTokens = normalized.match(/[a-z0-9]+|[\u4e00-\u9fff]+/g) || [];
    const units = new Set();
    for (const token of rawTokens) {
        if (token.length >= 2) units.add(token);
        if (/[\u4e00-\u9fff]/.test(token) && token.length > 2) {
            for (let i = 0; i < token.length - 1; i++) {
                units.add(token.slice(i, i + 2));
            }
        }
    }
    return units;
}

function computeLexicalScore(node, queryText) {
    if (!node || !queryText) return 0;
    const queryUnits = buildLexicalUnits(queryText);
    if (queryUnits.size === 0) return 0;

    const fields = node.fields || {};
    const primaryTexts = [fields.name, fields.title].filter(Boolean);
    const secondaryTexts = [fields.summary, fields.state, fields.traits, fields.constraint].filter(Boolean);
    const allText = [...primaryTexts, ...secondaryTexts].join(' ');
    const nodeUnits = buildLexicalUnits(allText);
    if (nodeUnits.size === 0) return 0;

    let overlap = 0;
    for (const unit of queryUnits) {
        if (nodeUnits.has(unit)) overlap++;
    }

    return Math.min(1, overlap / Math.max(1, queryUnits.size));
}

// ---------------------------------------------------------------------------
// Lexical embedding (sparse vector for DPP fallback)
// ---------------------------------------------------------------------------

function buildLexicalEmbedding(text) {
    const units = buildLexicalUnits(text);
    if (units.size === 0) return new Float64Array(0);
    // Convert lexical units to a sparse hash-based vector
    // Use a fixed-size vector with hash bucketing
    const DIM = 256;
    const vec = new Float64Array(DIM);
    for (const unit of units) {
        let hash = 0;
        for (let i = 0; i < unit.length; i++) {
            hash = ((hash << 5) - hash + unit.charCodeAt(i)) | 0;
        }
        const bucket = ((hash % DIM) + DIM) % DIM;
        vec[bucket] += 1;
    }
    // L2 normalize
    let norm = 0;
    for (let i = 0; i < DIM; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm > 1e-12) {
        for (let i = 0; i < DIM; i++) vec[i] /= norm;
    }
    return vec;
}

// ---------------------------------------------------------------------------
// Recency boost
// ---------------------------------------------------------------------------

function computeRecencyBoost(node, currentSeq) {
    if (!Number.isFinite(currentSeq) || currentSeq <= 0) return 0.5;
    const nodeSeq = Math.max(0, Number(node?.seqTo) || 0);
    if (nodeSeq <= 0) return 0;

    const halfLife = TYPE_HALF_LIFE[node.type] ?? 50;
    if (!Number.isFinite(halfLife)) return 1.0;

    const distance = Math.max(0, currentSeq - nodeSeq);
    return Math.exp(-0.693 * distance / halfLife);
}

// ---------------------------------------------------------------------------
// Hybrid scoring
// ---------------------------------------------------------------------------

function buildScoredCandidates(store, sources) {
    const { vectorHits, entityAnchors, diffusionResults, queryText, currentSeq, schema } = sources;
    const scoreMap = new Map();
    const nodes = store.nodes || {};
    const cooccurrenceCounts = rebuildCooccurrenceCounts(store, currentSeq, schema);
    const queryEntityIds = new Set((entityAnchors || []).map(a => a.id).filter(Boolean));

    function getOrCreate(nodeId) {
        let entry = scoreMap.get(nodeId);
        if (!entry) {
            entry = { nodeId, vectorScore: 0, anchorScore: 0, diffusionEnergy: 0, lexicalScore: 0, recencyBoost: 0, finalScore: 0 };
            scoreMap.set(nodeId, entry);
        }
        return entry;
    }

    for (const hit of vectorHits || []) {
        getOrCreate(hit.nodeId).vectorScore = Math.max(0, Math.min(1, hit.score || 0));
    }

    for (const anchor of entityAnchors || []) {
        getOrCreate(anchor.id).anchorScore = 1.0;
    }

    for (const item of diffusionResults || []) {
        const normalized = Math.min(1, Math.max(0, (item.energy || 0) / DIFFUSION_DEFAULTS.maxEnergy));
        getOrCreate(item.nodeId).diffusionEnergy = normalized;
    }

    for (const [nodeId, entry] of scoreMap) {
        const node = nodes[nodeId];
        if (!node || node.archived) {
            scoreMap.delete(nodeId);
            continue;
        }
        entry.lexicalScore = computeLexicalScore(node, queryText);
        entry.recencyBoost = computeRecencyBoost(node, currentSeq);
        entry.cooccurrenceBoost = computeCooccurrenceBoost(node, queryEntityIds, cooccurrenceCounts, store, schema);

        const typeConfig = TYPE_WEIGHT_CONFIG[node.type] || DEFAULT_TYPE_WEIGHTS;
        entry.finalScore =
            typeConfig.vectorWeight * entry.vectorScore
            + typeConfig.diffusionWeight * entry.diffusionEnergy
            + typeConfig.lexicalWeight * entry.lexicalScore
            + typeConfig.anchorWeight * entry.anchorScore
            + typeConfig.recencyWeight * entry.recencyBoost
            + entry.cooccurrenceBoost;
    }

    return [...scoreMap.values()]
        .sort((a, b) => b.finalScore - a.finalScore);
}

// ---------------------------------------------------------------------------
// Main hybrid recall pipeline
// ---------------------------------------------------------------------------

/**
 * Run the hybrid recall pipeline.
 *
 * @param {object} store - The memory graph store.
 * @param {string} queryText - Recent dialogue text for recall.
 * @param {string} chatId - Current chat ID.
 * @param {object} settings - Memory-graph extension settings.
 * @param {object} [options]
 * @param {number} [options.currentSeq] - Current assistant floor seq.
 * @param {number} [options.maxResults=15] - Max nodes to return.
 * @param {number} [options.vectorTopK=20] - Vector pre-filter top-K.
 * @param {boolean} [options.enableRerank=false] - Use rerank model for final scoring.
 * @param {object} [options.rerankConfig] - Rerank model config.
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{candidates: Array, meta: object}>}
 */
export async function runHybridRecall(store, queryText, chatId, settings, options = {}) {
    const {
        currentSeq = 0,
        maxResults = 15,
        vectorTopK = 20,
        enableRerank = false,
        rerankConfig = null,
        signal = null,
    } = options;

    const normalizedQuery = normalizeQueryText(queryText);
    if (!normalizedQuery) {
        return { candidates: [], meta: createEmptyMeta() };
    }

    const meta = createEmptyMeta();
    const timings = {};
    const t0 = performance.now();

    // ① Vector pre-filter
    let vectorHits = [];
    const vectorConfig = getVectorConfigFromSettings(settings);
    const vectorValid = validateVectorConfig(vectorConfig).valid;

    let queryVector = null;
    if (vectorValid) {
        throwIfAborted(signal);
        const tVec = performance.now();
        try {
            vectorHits = await findSimilarNodes(normalizedQuery, store, vectorConfig, chatId, {
                topK: vectorTopK,
                includeVectors: true,
                signal,
            });
            // Extract queryVector propagated from backend
            if (Array.isArray(vectorHits.__queryVector) && vectorHits.__queryVector.length > 0) {
                queryVector = vectorHits.__queryVector;
            }
        } catch (err) {
            if (isAbortError(err)) throw err;
            console.warn(`[${MODULE_NAME}] Vector search failed, continuing without it`, err);
            if (typeof toastr !== 'undefined') {
                const msg = typeof translate === 'function'
                    ? await translate('Vector search failed. Hybrid recall may return suboptimal results. Check your embedding API configuration.')
                    : 'Vector search failed. Hybrid recall may return suboptimal results. Check your embedding API configuration.';
                toastr.warning(msg);
            }
        }
        timings.vectorMs = Math.round((performance.now() - tVec) * 10) / 10;
        meta.vectorHits = vectorHits.length;
    } else {
        meta.skipReasons.push('Vector config invalid, skipping vector pre-filter');
    }

    // ② Entity anchors
    throwIfAborted(signal);
    const tAnchor = performance.now();
    const schema = settings.nodeTypeSchema || null;
    const entityAnchors = extractEntityAnchors(normalizedQuery, store, 2.0, schema);
    timings.anchorMs = Math.round((performance.now() - tAnchor) * 10) / 10;
    meta.anchorHits = entityAnchors.length;

    // ③ Build seeds
    const seeds = [];
    for (const hit of vectorHits) {
        seeds.push({ id: hit.nodeId, energy: hit.score });
    }
    for (const anchor of entityAnchors) {
        seeds.push({ id: anchor.id, energy: anchor.energy });
    }
    meta.seedCount = seeds.length;

    if (seeds.length === 0) {
        meta.skipReasons.push('No seeds from vector search or entity anchors');
        timings.totalMs = Math.round((performance.now() - t0) * 10) / 10;
        meta.timings = timings;
        return { candidates: [], meta };
    }

    // ④ Build adjacency map
    throwIfAborted(signal);
    const tAdj = performance.now();
    const adjacencyMap = buildAdjacencyMap(store, {
        maxSteps: Number(settings.diffusionSteps) || DIFFUSION_DEFAULTS.maxSteps,
        decayFactor: Number(settings.diffusionDecay) || DIFFUSION_DEFAULTS.decayFactor,
        topK: Number(settings.diffusionTopK) || DIFFUSION_DEFAULTS.topK,
        teleportAlpha: Number(settings.diffusionTeleportAlpha) || DIFFUSION_DEFAULTS.teleportAlpha,
    });
    timings.adjacencyMs = Math.round((performance.now() - tAdj) * 10) / 10;

    // ⑤ PEDSA graph diffusion
    throwIfAborted(signal);
    const tDiff = performance.now();
    const diffusionResults = diffuseAndRank(adjacencyMap, seeds, store, currentSeq, {
        maxSteps: Number(settings.diffusionSteps) || DIFFUSION_DEFAULTS.maxSteps,
        decayFactor: Number(settings.diffusionDecay) || DIFFUSION_DEFAULTS.decayFactor,
        topK: Number(settings.diffusionTopK) || DIFFUSION_DEFAULTS.topK,
        teleportAlpha: Number(settings.diffusionTeleportAlpha) || DIFFUSION_DEFAULTS.teleportAlpha,
        schema,
    });
    timings.diffusionMs = Math.round((performance.now() - tDiff) * 10) / 10;
    meta.diffusionHits = diffusionResults.length;

    // ⑥ Hybrid scoring
    throwIfAborted(signal);
    const tScore = performance.now();
    let candidates = buildScoredCandidates(store, {
        vectorHits,
        entityAnchors,
        diffusionResults,
        queryText: normalizedQuery,
        currentSeq,
        schema: settings.nodeTypeSchema || null,
    });
    timings.scoringMs = Math.round((performance.now() - tScore) * 10) / 10;
    meta.scoredCandidates = candidates.length;

    // ⑦ Cognitive pipeline (NMF → FISTA → DPP) — always enabled when using hybrid recall
    if (candidates.length > 3 && vectorValid) {
        throwIfAborted(signal);
        const tCog = performance.now();

        // Map embeddings from vector pre-filter results (step ①) to scored candidates
        // No extra API call needed — embeddings were fetched in step ① with includeVectors=true
        const vectorHitMap = new Map();
        for (const hit of vectorHits) {
            if (Array.isArray(hit.vector) && hit.vector.length > 0) {
                vectorHitMap.set(hit.nodeId, hit.vector);
            }
        }
        for (const c of candidates) {
            if (!c.vector && vectorHitMap.has(c.nodeId)) {
                c.vector = vectorHitMap.get(c.nodeId);
            }
        }

        const candidatesWithVectors = candidates.filter(c => Array.isArray(c.vector) && c.vector.length > 0);

        // NMF: topic rebalancing (always enabled in hybrid mode)
        if (queryVector && candidatesWithVectors.length >= 5) {
            try {
                applyNMFRebalance(candidates, queryVector, {
                    numTopics: 4,
                    iterations: 50,
                    boostFactor: 0.3,
                });
                meta.nmfApplied = true;
            } catch (nmfErr) {
                console.warn(`[${MODULE_NAME}] NMF rebalancing failed, skipping`, nmfErr);
                meta.skipReasons.push('NMF failed');
            }
        }

        // FISTA: residual discovery → supplementary search (always enabled in hybrid mode)
        if (queryVector && candidatesWithVectors.length >= 3) {
            try {
                const fistaResult = computeFISTAResidual(queryVector, candidates, {
                    lambda: 0.1,
                    iterations: 30,
                    residualThreshold: 0.3,
                });
                meta.fistaResidualNorm = Math.round(fistaResult.residualNorm * 1000) / 1000;
                meta.fistaTriggered = fistaResult.shouldSupplementSearch;

                if (fistaResult.shouldSupplementSearch && fistaResult.residualVector.length > 0) {
                    // Supplementary search: use residual vector to find nodes that fill the semantic gap
                    try {
                        const state = ensureVectorIndexState(store);
                        const collectionId = state.collectionId || buildCollectionId(chatId);
                        const suppResults = await queryVectorCollectionByVector(
                            collectionId, vectorConfig, fistaResult.residualVector,
                            10, 0.1, signal, false,
                        );
                        throwIfAborted(signal);

                        const existingNodeIds = new Set(candidates.map(c => c.nodeId));
                        let supplementCount = 0;
                        for (const hit of suppResults) {
                            const nodeId = state.hashToNodeId?.[hit.hash];
                            if (!nodeId || existingNodeIds.has(nodeId)) continue;
                            const node = store.nodes?.[nodeId];
                            if (!node || node.archived) continue;

                            candidates.push({
                                nodeId,
                                vectorScore: 0,
                                anchorScore: 0,
                                diffusionEnergy: 0,
                                lexicalScore: computeLexicalScore(node, normalizedQuery),
                                recencyBoost: computeRecencyBoost(node, currentSeq),
                                finalScore: Math.max(0, (Number(hit.score) || 0) * 0.5),
                                fistaSupplemental: true,
                            });
                            supplementCount++;
                        }
                        if (supplementCount > 0) {
                            candidates.sort((a, b) => b.finalScore - a.finalScore);
                            meta.fistaSupplementCount = supplementCount;
                        }
                    } catch (suppErr) {
                        if (isAbortError(suppErr)) throw suppErr;
                        console.warn(`[${MODULE_NAME}] FISTA supplementary search failed`, suppErr);
                        meta.skipReasons.push('FISTA supplementary search failed');
                    }
                }
            } catch (fistaErr) {
                console.warn(`[${MODULE_NAME}] FISTA residual computation failed, skipping`, fistaErr);
                meta.skipReasons.push('FISTA failed');
            }
        }

        // DPP: diversity sampling (always enabled in hybrid mode)
        if (candidatesWithVectors.length > maxResults) {
            try {
                const dppResult = applyDPPSampling(candidates, maxResults, {
                    qualityExponent: 1.0,
                    similarityFloor: 0.0,
                });
                if (dppResult.length > 0) {
                    candidates = dppResult;
                    meta.dppApplied = true;
                }
            } catch (dppErr) {
                console.warn(`[${MODULE_NAME}] DPP sampling failed, skipping`, dppErr);
                meta.skipReasons.push('DPP sampling failed');
            }
        }

        timings.cognitiveMs = Math.round((performance.now() - tCog) * 10) / 10;
    }

    // ⑧ Optional rerank
    if (enableRerank && rerankConfig && candidates.length > 0) {
        throwIfAborted(signal);
        const tRerank = performance.now();
        try {
            const nodes = store.nodes || {};
            const documents = candidates.map(c => {
                const node = nodes[c.nodeId];
                return buildNodeVectorText(node) || c.nodeId;
            });
            const rerankResults = await rerankDocuments(
                normalizedQuery,
                documents,
                rerankConfig,
                Math.min(maxResults * 2, candidates.length),
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
                        c.finalScore = 0.4 * c.finalScore + 0.6 * rerankScore;
                    }
                }
                candidates.sort((a, b) => b.finalScore - a.finalScore);
                meta.rerankApplied = true;
            }
        } catch (err) {
            if (isAbortError(err)) throw err;
            console.warn(`[${MODULE_NAME}] Rerank failed, using algorithm scores`, err);
            meta.skipReasons.push('Rerank failed, fell back to algorithm scores');
        }
        timings.rerankMs = Math.round((performance.now() - tRerank) * 10) / 10;
    }

    // ⑧ Trim to maxResults
    candidates = candidates.slice(0, maxResults);

    timings.totalMs = Math.round((performance.now() - t0) * 10) / 10;
    meta.timings = timings;
    meta.finalCount = candidates.length;

    return { candidates, meta };
}

// ---------------------------------------------------------------------------
// Meta helper
// ---------------------------------------------------------------------------

function createEmptyMeta() {
    return {
        vectorHits: 0,
        anchorHits: 0,
        seedCount: 0,
        diffusionHits: 0,
        scoredCandidates: 0,
        finalCount: 0,
        rerankApplied: false,
        skipReasons: [],
        timings: {},
    };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { TYPE_WEIGHT_CONFIG, DEFAULT_TYPE_WEIGHTS };
