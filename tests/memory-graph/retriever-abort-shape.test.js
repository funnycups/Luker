// tests/memory-graph/retriever-abort-shape.test.js
import { jest, describe, test, expect, beforeEach, afterAll } from '@jest/globals';
import { installBrowserModuleContext } from '../util/browser-module-context.js';

const queryStub = jest.fn();
const rerankStub = jest.fn();

const browserCtx = installBrowserModuleContext({
    connectionProfiles: {
        list: () => [],
        embedding: {
            list: () => [{ id: 'embed-id', source: 'openai', model: 'text-embedding-3-small' }],
            getById: (id) => (id === 'embed-id' ? { id: 'embed-id', source: 'openai', model: 'text-embedding-3-small' } : null),
            upsert: () => null,
        },
        rerank: {
            list: () => [],
            getById: () => null,
            upsert: () => null,
        },
    },
    embeddingService: {
        query: queryStub,
        rerank: rerankStub,
    },
});

const { runRagRecall } = await import('../../public/scripts/extensions/memory-graph/retriever.js');

const STORE = { nodes: { n_a: { id: 'n_a', type: 'event', title: 'Reef survey', fields: { summary: 'Ash charts the western reef.' } } } };
const SETTINGS = { embeddingProfileId: 'embed-id' };

beforeEach(() => {
    queryStub.mockReset();
    rerankStub.mockReset();
});

afterAll(() => {
    browserCtx.restore();
});

describe('runRagRecall abort handling', () => {
    test('an aborted signal rejects with a DOMException AbortError', async () => {
        const ctrl = new AbortController();
        ctrl.abort();
        queryStub.mockResolvedValue({ metadata: [] });
        const error = await runRagRecall(STORE, 'reef', 'chat-1', SETTINGS, { signal: ctrl.signal }).catch((e) => e);
        expect(error).toBeInstanceOf(DOMException);
        expect(error.name).toBe('AbortError');
        expect(error.message).toBe('RAG recall aborted');
    });

    test('a vector-search error that only mentions abort is propagated as a failure', async () => {
        queryStub.mockRejectedValue(new Error('upstream aborted the connection'));
        await expect(runRagRecall(STORE, 'reef', 'chat-1', SETTINGS, {})).rejects.toThrow('upstream aborted the connection');
    });
});
