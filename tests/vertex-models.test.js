import { describe, expect, jest, test } from '@jest/globals';
import {
    buildVertexModelsUrl,
    fetchVertexModels,
    getVertexModelsHost,
    VertexModelsHttpError,
    VertexModelsResponseError,
    VERTEX_MODELS_PATH,
} from '../src/endpoints/backends/vertex-models.js';

function createResponse(data, overrides = {}) {
    return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => data,
        ...overrides,
    };
}

describe('Vertex AI model list URL', () => {
    test('lists publisher models through the v1beta1 Model Garden route', () => {
        // `publishers.models.list` does not exist in v1; that surface only has
        // get/computeTokens/generateContent/... so /v1/ 404s at the router.
        expect(VERTEX_MODELS_PATH).toBe('/v1beta1/publishers/google/models');
    });

    test('resolves the host from the region', () => {
        expect(getVertexModelsHost('global')).toBe('https://aiplatform.googleapis.com');
        expect(getVertexModelsHost('')).toBe('https://aiplatform.googleapis.com');
        expect(getVertexModelsHost('us-central1')).toBe('https://us-central1-aiplatform.googleapis.com');
        expect(getVertexModelsHost('europe-west2')).toBe('https://europe-west2-aiplatform.googleapis.com');
    });

    test('never builds a project-scoped URL', () => {
        // The project-scoped `projects/*/locations/*/publishers/*/models`
        // form is not a list route and 404s.
        const url = buildVertexModelsUrl({ region: 'global' });
        expect(url).not.toContain('/projects/');
        expect(url).not.toContain('/locations/');
        expect(url).toBe('https://aiplatform.googleapis.com/v1beta1/publishers/google/models');
    });

    test('honours an explicit origin and drops its trailing slash', () => {
        expect(buildVertexModelsUrl({ region: 'us-central1', origin: 'https://proxy.example.com/' }))
            .toBe('https://proxy.example.com/v1beta1/publishers/google/models');
        expect(buildVertexModelsUrl({ region: 'us-central1', origin: 'https://proxy.example.com' }))
            .toBe('https://proxy.example.com/v1beta1/publishers/google/models');
    });
});

describe('Vertex AI publisher model fetching', () => {
    test('fetches every page and returns model ids', async () => {
        const fetchMock = jest.fn()
            .mockResolvedValueOnce(createResponse({
                publisherModels: [
                    { name: 'publishers/google/models/gemini-2.5-pro' },
                    { name: 'publishers/google/models/gemini-2.5-flash' },
                ],
                nextPageToken: 'second-page',
            }))
            .mockResolvedValueOnce(createResponse({
                publisherModels: [{ name: 'publishers/google/models/gemini-3.7-flash' }],
            }));

        const models = await fetchVertexModels('https://example.com/v1beta1/publishers/google/models', { fetchImpl: fetchMock });

        expect(models).toEqual([
            { id: 'gemini-2.5-flash' },
            { id: 'gemini-2.5-pro' },
            { id: 'gemini-3.7-flash' },
        ]);
        expect(fetchMock).toHaveBeenCalledTimes(2);

        const firstUrl = new URL(fetchMock.mock.calls[0][0]);
        expect(firstUrl.pathname).toBe('/v1beta1/publishers/google/models');
        expect(firstUrl.searchParams.has('pageToken')).toBe(false);

        const secondUrl = new URL(fetchMock.mock.calls[1][0]);
        expect(secondUrl.searchParams.get('pageToken')).toBe('second-page');
    });

    test('keeps models regardless of supportedActions shape', async () => {
        // `supportedActions` is a CallToAction object, not a list of method
        // names. Entries carrying only console/notebook links are still
        // callable models, so they must not be dropped.
        const fetchMock = jest.fn().mockResolvedValue(createResponse({
            publisherModels: [
                { name: 'publishers/google/models/gemini-2.5-pro' },
                { name: 'publishers/google/models/gemini-2.5-flash', supportedActions: { openGenerationAiStudio: { title: 'Open' } } },
                { name: 'publishers/google/models/gemini-2.5-flash-lite', supportedActions: { deploy: { title: 'Deploy' } } },
            ],
        }));

        const models = await fetchVertexModels('https://example.com/v1beta1/publishers/google/models', { fetchImpl: fetchMock });

        expect(models.map(m => m.id)).toEqual([
            'gemini-2.5-flash',
            'gemini-2.5-flash-lite',
            'gemini-2.5-pro',
        ]);
    });

    test('deduplicates repeated model ids across pages', async () => {
        const fetchMock = jest.fn()
            .mockResolvedValueOnce(createResponse({
                publisherModels: [{ name: 'publishers/google/models/gemini-2.5-pro' }],
                nextPageToken: 'next',
            }))
            .mockResolvedValueOnce(createResponse({
                publisherModels: [{ name: 'publishers/google/models/gemini-2.5-pro' }],
            }));

        const models = await fetchVertexModels('https://example.com/v1beta1/publishers/google/models', { fetchImpl: fetchMock });

        expect(models).toEqual([{ id: 'gemini-2.5-pro' }]);
    });

    test('passes the caller headers through to every page', async () => {
        const fetchMock = jest.fn().mockResolvedValue(createResponse({ publisherModels: [] }));

        await fetchVertexModels('https://example.com/v1beta1/publishers/google/models', {
            headers: { Authorization: 'Bearer token' },
            fetchImpl: fetchMock,
        });

        expect(fetchMock.mock.calls[0][1]).toEqual({
            method: 'GET',
            headers: { Authorization: 'Bearer token' },
        });
    });

    test('preserves the express API key across pages', async () => {
        const fetchMock = jest.fn()
            .mockResolvedValueOnce(createResponse({ publisherModels: [], nextPageToken: 'next' }))
            .mockResolvedValueOnce(createResponse({ publisherModels: [] }));

        await fetchVertexModels('https://example.com/v1beta1/publishers/google/models?key=secret', { fetchImpl: fetchMock });

        expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('key')).toBe('secret');
        expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get('key')).toBe('secret');
    });

    test('throws VertexModelsHttpError on an HTTP failure', async () => {
        const fetchMock = jest.fn().mockResolvedValue(createResponse(null, {
            ok: false,
            status: 404,
            statusText: 'Not Found',
        }));

        await expect(fetchVertexModels('https://example.com/v1beta1/publishers/google/models', { fetchImpl: fetchMock }))
            .rejects.toBeInstanceOf(VertexModelsHttpError);
    });

    test('does not return partial results when a later page fails', async () => {
        const fetchMock = jest.fn()
            .mockResolvedValueOnce(createResponse({
                publisherModels: [{ name: 'publishers/google/models/gemini-2.5-pro' }],
                nextPageToken: 'next',
            }))
            .mockResolvedValueOnce(createResponse(null, { ok: false, status: 503, statusText: 'Service Unavailable' }));

        await expect(fetchVertexModels('https://example.com/v1beta1/publishers/google/models', { fetchImpl: fetchMock }))
            .rejects.toBeInstanceOf(VertexModelsHttpError);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test('rejects an invalid publisherModels field', async () => {
        const fetchMock = jest.fn().mockResolvedValue(createResponse({ publisherModels: null }));

        await expect(fetchVertexModels('https://example.com/v1beta1/publishers/google/models', { fetchImpl: fetchMock }))
            .rejects.toThrow('invalid publisherModels field');
    });

    test('rejects a repeated page token', async () => {
        const fetchMock = jest.fn()
            .mockResolvedValueOnce(createResponse({ publisherModels: [], nextPageToken: 'repeated' }))
            .mockResolvedValueOnce(createResponse({ publisherModels: [], nextPageToken: 'repeated' }));

        await expect(fetchVertexModels('https://example.com/v1beta1/publishers/google/models', { fetchImpl: fetchMock }))
            .rejects.toBeInstanceOf(VertexModelsResponseError);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test('rejects a model without a valid name', async () => {
        const fetchMock = jest.fn().mockResolvedValue(createResponse({
            publisherModels: [{ supportedActions: { deploy: { title: 'Deploy' } } }],
        }));

        await expect(fetchVertexModels('https://example.com/v1beta1/publishers/google/models', { fetchImpl: fetchMock }))
            .rejects.toThrow('invalid name');
    });
});
