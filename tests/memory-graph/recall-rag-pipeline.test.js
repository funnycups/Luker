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

    test('caps at maxLength', async () => {
        const { normalizeQueryText } = await retrieverModulePromise;
        expect(normalizeQueryText('x'.repeat(900))).toHaveLength(800);
    });

    test('handles null/undefined input safely', async () => {
        const { normalizeQueryText } = await retrieverModulePromise;
        expect(normalizeQueryText(null)).toBe('');
        expect(normalizeQueryText(undefined)).toBe('');
    });
});
