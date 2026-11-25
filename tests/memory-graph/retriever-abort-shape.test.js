// tests/memory-graph/retriever-abort-shape.test.js
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const findSimilarNodesMock = jest.fn();

jest.unstable_mockModule('../../public/scripts/extensions/memory-graph/vector-index.js', () => ({
    findSimilarNodes: findSimilarNodesMock,
    rerankDocuments: jest.fn(),
    buildNodeVectorText: (node) => `doc:${node?.id || ''}`,
    getVectorConfigFromSettings: () => ({ id: 'embed-id', source: 'openai', model: 'fake' }),
    validateVectorConfig: () => ({ valid: true }),
}));

const { runRagRecall } = await import('../../public/scripts/extensions/memory-graph/retriever.js');

const STORE = { nodes: { n_a: { id: 'n_a', type: 'event', title: 'Reef survey', fields: { summary: 'Ash charts the western reef.' } } } };

beforeEach(() => {
    findSimilarNodesMock.mockReset();
});

describe('runRagRecall abort handling', () => {
    test('an aborted signal rejects with a DOMException AbortError', async () => {
        const ctrl = new AbortController();
        ctrl.abort();
        findSimilarNodesMock.mockResolvedValue([]);
        const error = await runRagRecall(STORE, 'reef', 'chat-1', {}, { signal: ctrl.signal }).catch((e) => e);
        expect(error).toBeInstanceOf(DOMException);
        expect(error.name).toBe('AbortError');
        expect(error.message).toBe('RAG recall aborted');
    });

    test('a vector-search error that only mentions abort is propagated as a failure', async () => {
        findSimilarNodesMock.mockRejectedValue(new Error('upstream aborted the connection'));
        await expect(runRagRecall(STORE, 'reef', 'chat-1', {}, {})).rejects.toThrow('upstream aborted the connection');
    });
});
