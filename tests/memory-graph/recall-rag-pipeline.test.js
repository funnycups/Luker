/**
 * Pure tests for the RAG retriever. Targets `runRagRecall` in
 * public/scripts/extensions/memory-graph/retriever.js, which is intentionally
 * LLM-free: the caller computes any optional query rewrite and passes the
 * string in via options.rewrittenQuery. We mock only the vector-index
 * boundary (findSimilarNodes, rerankDocuments) so the test stays at the
 * retriever's contract surface — no real embedding HTTP calls.
 */

import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const findSimilarNodesMock = jest.fn();
const rerankDocumentsMock = jest.fn();
const buildNodeVectorTextMock = jest.fn();
const getVectorConfigFromSettingsMock = jest.fn();
const validateVectorConfigMock = jest.fn();

jest.unstable_mockModule('../../public/scripts/extensions/memory-graph/vector-index.js', () => ({
    findSimilarNodes: findSimilarNodesMock,
    rerankDocuments: rerankDocumentsMock,
    buildNodeVectorText: buildNodeVectorTextMock,
    getVectorConfigFromSettings: getVectorConfigFromSettingsMock,
    validateVectorConfig: validateVectorConfigMock,
}));

const retrieverModulePromise = import('../../public/scripts/extensions/memory-graph/retriever.js');

function makeStore() {
    return {
        nodes: {
            n_a: { id: 'n_a', type: 'event', title: 'A', fields: { summary: 'alpha event' } },
            n_b: { id: 'n_b', type: 'event', title: 'B', fields: { summary: 'beta event' } },
            n_c: { id: 'n_c', type: 'event', title: 'C', fields: { summary: 'gamma event' } },
            n_d: { id: 'n_d', type: 'event', title: 'D', fields: { summary: 'delta event' } },
        },
    };
}

const STUB_EMBED_PROFILE = { id: 'embed-id', source: 'openai', model: 'fake' };

beforeEach(() => {
    findSimilarNodesMock.mockReset();
    rerankDocumentsMock.mockReset();
    buildNodeVectorTextMock.mockReset();
    getVectorConfigFromSettingsMock.mockReset();
    validateVectorConfigMock.mockReset();

    getVectorConfigFromSettingsMock.mockReturnValue(STUB_EMBED_PROFILE);
    validateVectorConfigMock.mockReturnValue({ valid: true });
    buildNodeVectorTextMock.mockImplementation((node) => `doc:${node?.id || ''}`);
});

describe('runRagRecall — vector only', () => {
    test('returns nodes in vector score order with no rerank or rewrite', async () => {
        const { runRagRecall } = await retrieverModulePromise;
        findSimilarNodesMock.mockResolvedValue([
            { nodeId: 'n_c', score: 0.9 },
            { nodeId: 'n_a', score: 0.7 },
            { nodeId: 'n_b', score: 0.5 },
        ]);
        const { candidates, meta } = await runRagRecall(makeStore(), 'find alpha', 'chat-1', {}, {
            vectorTopK: 10,
            maxResults: 10,
        });
        expect(findSimilarNodesMock).toHaveBeenCalledTimes(1);
        expect(findSimilarNodesMock.mock.calls[0][0]).toBe('find alpha');
        expect(candidates.map(c => c.nodeId)).toEqual(['n_c', 'n_a', 'n_b']);
        expect(candidates.every(c => c.rerankScore === null)).toBe(true);
        expect(meta.vectorHits).toBe(3);
        expect(meta.rerankApplied).toBe(false);
        expect(meta.rewriteApplied).toBe(false);
        expect(meta.finalCount).toBe(3);
    });

    test('honours maxResults trim', async () => {
        const { runRagRecall } = await retrieverModulePromise;
        findSimilarNodesMock.mockResolvedValue([
            { nodeId: 'n_a', score: 0.9 },
            { nodeId: 'n_b', score: 0.7 },
            { nodeId: 'n_c', score: 0.5 },
            { nodeId: 'n_d', score: 0.3 },
        ]);
        const { candidates } = await runRagRecall(makeStore(), 'q', 'chat-1', {}, { maxResults: 2 });
        expect(candidates.map(c => c.nodeId)).toEqual(['n_a', 'n_b']);
    });
});

describe('runRagRecall — query rewrite', () => {
    test('uses rewrittenQuery for vector search, marks meta', async () => {
        const { runRagRecall } = await retrieverModulePromise;
        findSimilarNodesMock.mockResolvedValue([{ nodeId: 'n_a', score: 0.8 }]);
        const { candidates, meta } = await runRagRecall(makeStore(), 'raw long sloppy query', 'chat-1', {}, {
            rewrittenQuery: 'alpha event found',
        });
        expect(findSimilarNodesMock.mock.calls[0][0]).toBe('alpha event found');
        expect(meta.rewriteApplied).toBe(true);
        expect(meta.rewrittenQuery).toBe('alpha event found');
        expect(candidates).toHaveLength(1);
    });

    test('empty rewrittenQuery falls through to raw query', async () => {
        const { runRagRecall } = await retrieverModulePromise;
        findSimilarNodesMock.mockResolvedValue([{ nodeId: 'n_a', score: 0.8 }]);
        const { meta } = await runRagRecall(makeStore(), 'raw query', 'chat-1', {}, {
            rewrittenQuery: '   ',
        });
        expect(findSimilarNodesMock.mock.calls[0][0]).toBe('raw query');
        expect(meta.rewriteApplied).toBe(false);
    });
});

describe('runRagRecall — rerank', () => {
    test('rerank reorders by rerank score, vector score retained per row', async () => {
        const { runRagRecall } = await retrieverModulePromise;
        findSimilarNodesMock.mockResolvedValue([
            { nodeId: 'n_a', score: 0.9 },
            { nodeId: 'n_b', score: 0.7 },
            { nodeId: 'n_c', score: 0.5 },
        ]);
        // Rerank inverts the order
        rerankDocumentsMock.mockResolvedValue([
            { index: 2, score: 0.95 },
            { index: 1, score: 0.5 },
            { index: 0, score: 0.05 },
        ]);
        const { candidates, meta } = await runRagRecall(makeStore(), 'q', 'chat-1', {}, {
            useRerank: true,
            rerankProfile: { id: 'rk' },
        });
        expect(rerankDocumentsMock).toHaveBeenCalledTimes(1);
        expect(candidates.map(c => c.nodeId)).toEqual(['n_c', 'n_b', 'n_a']);
        expect(candidates.map(c => c.rerankScore)).toEqual([0.95, 0.5, 0.05]);
        expect(candidates.map(c => c.vectorScore)).toEqual([0.5, 0.7, 0.9]);
        expect(meta.rerankApplied).toBe(true);
    });

    test('rerank failure falls back to vector order with skipReason recorded', async () => {
        const { runRagRecall } = await retrieverModulePromise;
        findSimilarNodesMock.mockResolvedValue([
            { nodeId: 'n_a', score: 0.9 },
            { nodeId: 'n_b', score: 0.7 },
        ]);
        rerankDocumentsMock.mockRejectedValue(new Error('rerank backend down'));
        const { candidates, meta } = await runRagRecall(makeStore(), 'q', 'chat-1', {}, {
            useRerank: true,
            rerankProfile: { id: 'rk' },
        });
        expect(candidates.map(c => c.nodeId)).toEqual(['n_a', 'n_b']);
        expect(meta.rerankApplied).toBe(false);
        expect(meta.skipReasons.some(r => r.includes('Rerank failed'))).toBe(true);
    });

    test('useRerank=true without rerankProfile is a no-op (no call, no mark)', async () => {
        const { runRagRecall } = await retrieverModulePromise;
        findSimilarNodesMock.mockResolvedValue([{ nodeId: 'n_a', score: 0.9 }]);
        const { meta } = await runRagRecall(makeStore(), 'q', 'chat-1', {}, {
            useRerank: true,
            rerankProfile: null,
        });
        expect(rerankDocumentsMock).not.toHaveBeenCalled();
        expect(meta.rerankApplied).toBe(false);
    });
});

describe('runRagRecall — rewrite + rerank compose', () => {
    test('both apply in the same call', async () => {
        const { runRagRecall } = await retrieverModulePromise;
        findSimilarNodesMock.mockResolvedValue([
            { nodeId: 'n_a', score: 0.9 },
            { nodeId: 'n_b', score: 0.7 },
        ]);
        rerankDocumentsMock.mockResolvedValue([
            { index: 1, score: 0.8 },
            { index: 0, score: 0.2 },
        ]);
        const { candidates, meta } = await runRagRecall(makeStore(), 'raw', 'chat-1', {}, {
            rewrittenQuery: 'cleaned up',
            useRerank: true,
            rerankProfile: { id: 'rk' },
        });
        expect(findSimilarNodesMock.mock.calls[0][0]).toBe('cleaned up');
        expect(rerankDocumentsMock.mock.calls[0][0]).toBe('cleaned up');
        expect(candidates.map(c => c.nodeId)).toEqual(['n_b', 'n_a']);
        expect(meta.rewriteApplied).toBe(true);
        expect(meta.rerankApplied).toBe(true);
    });
});

describe('runRagRecall — early exits', () => {
    test('empty embedding profile → skip + empty candidates', async () => {
        const { runRagRecall } = await retrieverModulePromise;
        validateVectorConfigMock.mockReturnValue({ valid: false });
        const { candidates, meta } = await runRagRecall(makeStore(), 'q', 'chat-1', {}, {});
        expect(findSimilarNodesMock).not.toHaveBeenCalled();
        expect(candidates).toEqual([]);
        expect(meta.skipReasons.some(r => r.includes('No embedding profile'))).toBe(true);
    });

    test('vector search throws → empty candidates with skip reason, no crash', async () => {
        const { runRagRecall } = await retrieverModulePromise;
        findSimilarNodesMock.mockRejectedValue(new Error('embed 500'));
        const { candidates, meta } = await runRagRecall(makeStore(), 'q', 'chat-1', {}, {});
        expect(candidates).toEqual([]);
        expect(meta.skipReasons.some(r => r.includes('Vector search failed'))).toBe(true);
    });

    test('empty query (after normalize) returns immediately', async () => {
        const { runRagRecall } = await retrieverModulePromise;
        const { candidates, meta } = await runRagRecall(makeStore(), '   ', 'chat-1', {}, {});
        expect(findSimilarNodesMock).not.toHaveBeenCalled();
        expect(candidates).toEqual([]);
        expect(meta.skipReasons.some(r => r.includes('Empty query'))).toBe(true);
    });

    test('abort signal mid-call propagates AbortError', async () => {
        const { runRagRecall } = await retrieverModulePromise;
        const ctrl = new AbortController();
        ctrl.abort();
        findSimilarNodesMock.mockResolvedValue([]);
        await expect(runRagRecall(makeStore(), 'q', 'chat-1', {}, { signal: ctrl.signal }))
            .rejects.toMatchObject({ name: 'AbortError' });
    });
});

describe('normalizeQueryText', () => {
    test('collapses whitespace and trims', async () => {
        const { normalizeQueryText } = await retrieverModulePromise;
        expect(normalizeQueryText('  a   b\n\nc  ')).toBe('a b c');
    });

    test('does not truncate long input', async () => {
        const { normalizeQueryText } = await retrieverModulePromise;
        expect(normalizeQueryText('x'.repeat(10000))).toHaveLength(10000);
    });

    test('handles null/undefined input safely', async () => {
        const { normalizeQueryText } = await retrieverModulePromise;
        expect(normalizeQueryText(null)).toBe('');
        expect(normalizeQueryText(undefined)).toBe('');
    });
});

// Per-type quota tests. The retriever must bucket vector hits by
// store.nodes[nodeId].type, take the top K per bucket, and never let one
// dominant type starve the others out of the final selection. This exists
// because in real corpora `event` nodes vastly outnumber character_sheet /
// location_state / thread; a shared topK pool always fills with events and
// the other types never surface — even though they carry latest-truth state
// that recall depends on.

function makeMixedStore() {
    return {
        nodes: {
            // 6 events with high vector scores
            e1: { id: 'e1', type: 'event', title: 'E1', fields: { summary: 's1' } },
            e2: { id: 'e2', type: 'event', title: 'E2', fields: { summary: 's2' } },
            e3: { id: 'e3', type: 'event', title: 'E3', fields: { summary: 's3' } },
            e4: { id: 'e4', type: 'event', title: 'E4', fields: { summary: 's4' } },
            e5: { id: 'e5', type: 'event', title: 'E5', fields: { summary: 's5' } },
            e6: { id: 'e6', type: 'event', title: 'E6', fields: { summary: 's6' } },
            // 3 character_sheet with mid scores
            c1: { id: 'c1', type: 'character_sheet', title: 'C1', fields: {} },
            c2: { id: 'c2', type: 'character_sheet', title: 'C2', fields: {} },
            c3: { id: 'c3', type: 'character_sheet', title: 'C3', fields: {} },
            // 2 location_state with low scores
            l1: { id: 'l1', type: 'location_state', title: 'L1', fields: {} },
            l2: { id: 'l2', type: 'location_state', title: 'L2', fields: {} },
        },
    };
}

describe('runRagRecall — per-type bucketing', () => {
    test('per-type quota takes top K within each type bucket, not from shared pool', async () => {
        const { runRagRecall } = await retrieverModulePromise;
        // Vector returns 11 hits with events scoring highest overall.
        findSimilarNodesMock.mockResolvedValue([
            { nodeId: 'e1', score: 0.99 },
            { nodeId: 'e2', score: 0.98 },
            { nodeId: 'e3', score: 0.97 },
            { nodeId: 'e4', score: 0.96 },
            { nodeId: 'e5', score: 0.95 },
            { nodeId: 'e6', score: 0.94 },
            { nodeId: 'c1', score: 0.70 },
            { nodeId: 'c2', score: 0.60 },
            { nodeId: 'c3', score: 0.55 },
            { nodeId: 'l1', score: 0.40 },
            { nodeId: 'l2', score: 0.30 },
        ]);
        const { candidates, meta } = await runRagRecall(makeMixedStore(), 'q', 'chat', {}, {
            perTypeK: { event: 3, character_sheet: 2, location_state: 2 },
            maxResults: 20,
        });
        const byType = candidates.reduce((acc, c) => {
            const t = c.nodeType || '';
            acc[t] = (acc[t] || 0) + 1;
            return acc;
        }, {});
        expect(byType.event).toBe(3);
        expect(byType.character_sheet).toBe(2);
        expect(byType.location_state).toBe(2);
        expect(candidates).toHaveLength(7);
        // Per-bucket meta present
        expect(meta.perBucket).toBeTruthy();
        expect(meta.perBucket.event.finalCount).toBe(3);
        expect(meta.perBucket.character_sheet.finalCount).toBe(2);
        expect(meta.perBucket.location_state.finalCount).toBe(2);
    });

    test('vectorTopK auto-lifts to at least sum(perTypeK) so all buckets can fill', async () => {
        const { runRagRecall } = await retrieverModulePromise;
        findSimilarNodesMock.mockResolvedValue([]);
        await runRagRecall(makeMixedStore(), 'q', 'chat', {}, {
            perTypeK: { event: 10, character_sheet: 5, location_state: 5 },
            vectorTopK: 8, // Deliberately too small — must be auto-lifted.
            maxResults: 20,
        });
        expect(findSimilarNodesMock).toHaveBeenCalledTimes(1);
        // 4th arg to findSimilarNodes is chatId, options is 5th; look at options.topK
        const passedOptions = findSimilarNodesMock.mock.calls[0][4];
        expect(passedOptions.topK).toBeGreaterThanOrEqual(20);
    });

    test('defaultPerTypeK covers types not listed in perTypeK', async () => {
        const { runRagRecall } = await retrieverModulePromise;
        findSimilarNodesMock.mockResolvedValue([
            { nodeId: 'e1', score: 0.99 },
            { nodeId: 'e2', score: 0.98 },
            { nodeId: 'e3', score: 0.97 },
            { nodeId: 'c1', score: 0.70 },
            { nodeId: 'c2', score: 0.60 },
        ]);
        const { candidates } = await runRagRecall(makeMixedStore(), 'q', 'chat', {}, {
            perTypeK: { character_sheet: 2 },
            defaultPerTypeK: 2, // event has no explicit quota → falls back to 2
            maxResults: 20,
        });
        const events = candidates.filter(c => c.nodeType === 'event');
        const chars = candidates.filter(c => c.nodeType === 'character_sheet');
        expect(events).toHaveLength(2);
        expect(chars).toHaveLength(2);
    });

    test('no per-type config → single bucket, honours maxResults (legacy-equivalent)', async () => {
        const { runRagRecall } = await retrieverModulePromise;
        findSimilarNodesMock.mockResolvedValue([
            { nodeId: 'e1', score: 0.99 },
            { nodeId: 'e2', score: 0.98 },
            { nodeId: 'c1', score: 0.70 },
        ]);
        const { candidates } = await runRagRecall(makeMixedStore(), 'q', 'chat', {}, {
            maxResults: 2,
        });
        expect(candidates.map(c => c.nodeId)).toEqual(['e1', 'e2']);
    });

    test('maxResults still caps final total across buckets', async () => {
        const { runRagRecall } = await retrieverModulePromise;
        findSimilarNodesMock.mockResolvedValue([
            { nodeId: 'e1', score: 0.99 },
            { nodeId: 'e2', score: 0.98 },
            { nodeId: 'e3', score: 0.97 },
            { nodeId: 'c1', score: 0.70 },
            { nodeId: 'c2', score: 0.60 },
        ]);
        const { candidates } = await runRagRecall(makeMixedStore(), 'q', 'chat', {}, {
            perTypeK: { event: 3, character_sheet: 2 },
            maxResults: 3,
        });
        expect(candidates).toHaveLength(3);
    });

    test('unknown node ids in vector hits are dropped', async () => {
        const { runRagRecall } = await retrieverModulePromise;
        findSimilarNodesMock.mockResolvedValue([
            { nodeId: 'e1', score: 0.99 },
            { nodeId: 'ghost', score: 0.98 },
            { nodeId: 'c1', score: 0.70 },
        ]);
        const { candidates } = await runRagRecall(makeMixedStore(), 'q', 'chat', {}, {
            perTypeK: { event: 5, character_sheet: 5 },
        });
        expect(candidates.map(c => c.nodeId).sort()).toEqual(['c1', 'e1']);
    });

    // Caller side (main.js: buildRagPerTypeQuotas) MUST strip 0-valued
    // entries from perTypeK before invoking the retriever — the UI policy
    // "0 = follow the global default" is enforced there, not here. This
    // test pins the retriever's own behavior: an explicit 0 in perTypeK
    // means "take 0 hits from this bucket". If a caller ever leaks
    // 0-valued entries through, that whole node type disappears from
    // recall — a regression a caller-side test cannot catch.
    test('perTypeK map with explicit 0 for a type respects the 0 (caller must filter zeros)', async () => {
        const { runRagRecall } = await retrieverModulePromise;
        findSimilarNodesMock.mockResolvedValue([
            { nodeId: 'e1', score: 0.99 },
            { nodeId: 'c1', score: 0.70 },
        ]);
        const { candidates } = await runRagRecall(makeMixedStore(), 'q', 'chat', {}, {
            perTypeK: { event: 0, character_sheet: 5 },
        });
        expect(candidates.map(c => c.nodeId)).toEqual(['c1']);
    });
});

describe('runRagRecall — per-type rerank', () => {
    test('rerank is called once per non-empty bucket, results merged', async () => {
        const { runRagRecall } = await retrieverModulePromise;
        findSimilarNodesMock.mockResolvedValue([
            { nodeId: 'e1', score: 0.99 },
            { nodeId: 'e2', score: 0.98 },
            { nodeId: 'e3', score: 0.97 },
            { nodeId: 'c1', score: 0.70 },
            { nodeId: 'c2', score: 0.60 },
        ]);
        // Distinct rerank results per bucket call: event bucket inverts (e3 wins),
        // character bucket keeps order (c1 wins).
        rerankDocumentsMock
            .mockResolvedValueOnce([
                { index: 2, score: 0.9 },
                { index: 1, score: 0.5 },
                { index: 0, score: 0.1 },
            ])
            .mockResolvedValueOnce([
                { index: 0, score: 0.8 },
                { index: 1, score: 0.4 },
            ]);
        const { candidates, meta } = await runRagRecall(makeMixedStore(), 'q', 'chat', {}, {
            perTypeK: { event: 3, character_sheet: 2 },
            useRerank: true,
            rerankProfile: { id: 'rk' },
        });
        expect(rerankDocumentsMock).toHaveBeenCalledTimes(2);
        const events = candidates.filter(c => c.nodeType === 'event');
        const chars = candidates.filter(c => c.nodeType === 'character_sheet');
        expect(events.map(c => c.nodeId)).toEqual(['e3', 'e2', 'e1']);
        expect(chars.map(c => c.nodeId)).toEqual(['c1', 'c2']);
        expect(meta.perBucket.event.rerankApplied).toBe(true);
        expect(meta.perBucket.character_sheet.rerankApplied).toBe(true);
    });

    test('one bucket rerank failure does not affect other buckets', async () => {
        const { runRagRecall } = await retrieverModulePromise;
        findSimilarNodesMock.mockResolvedValue([
            { nodeId: 'e1', score: 0.99 },
            { nodeId: 'e2', score: 0.98 },
            { nodeId: 'c1', score: 0.70 },
            { nodeId: 'c2', score: 0.60 },
        ]);
        // Event bucket fails, character bucket succeeds.
        rerankDocumentsMock
            .mockRejectedValueOnce(new Error('rerank event boom'))
            .mockResolvedValueOnce([
                { index: 1, score: 0.9 }, // c2 wins
                { index: 0, score: 0.3 },
            ]);
        const { candidates, meta } = await runRagRecall(makeMixedStore(), 'q', 'chat', {}, {
            perTypeK: { event: 2, character_sheet: 2 },
            useRerank: true,
            rerankProfile: { id: 'rk' },
        });
        const events = candidates.filter(c => c.nodeType === 'event');
        const chars = candidates.filter(c => c.nodeType === 'character_sheet');
        // Event bucket falls back to vector order
        expect(events.map(c => c.nodeId)).toEqual(['e1', 'e2']);
        // Character bucket applied rerank
        expect(chars.map(c => c.nodeId)).toEqual(['c2', 'c1']);
        expect(meta.perBucket.event.rerankApplied).toBe(false);
        expect(meta.perBucket.event.skipReasons.some(r => /Rerank failed/.test(r))).toBe(true);
        expect(meta.perBucket.character_sheet.rerankApplied).toBe(true);
    });

    test('useRerank=true without rerankProfile → no bucket rerank calls', async () => {
        const { runRagRecall } = await retrieverModulePromise;
        findSimilarNodesMock.mockResolvedValue([
            { nodeId: 'e1', score: 0.99 },
            { nodeId: 'c1', score: 0.70 },
        ]);
        await runRagRecall(makeMixedStore(), 'q', 'chat', {}, {
            perTypeK: { event: 5, character_sheet: 5 },
            useRerank: true,
            rerankProfile: null,
        });
        expect(rerankDocumentsMock).not.toHaveBeenCalled();
    });
});
