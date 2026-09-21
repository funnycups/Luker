import fetch from 'node-fetch';

/**
 * Vertex AI exposes publisher models through Model Garden's
 * `publishers.models.list`. Two properties of that route matter here:
 *
 * - It only exists in the `v1beta1` surface. `v1` exposes
 *   `publishers.models.get` but no `list`, so a `v1` URL 404s at the router
 *   before authentication is even considered.
 * - The publisher is part of the path (`publishers/{publisher}/models`).
 *   The project-scoped
 *   `projects/{project}/locations/{region}/publishers/{publisher}/models`
 *   form is not a list route either, and 404s the same way.
 *
 * Model Garden requires OAuth2 on this route; API keys are rejected. Express
 * mode therefore cannot enumerate models and keeps whatever static list the
 * UI ships, while full (service account) and proxy modes can.
 */
export const VERTEX_MODELS_PATH = '/v1beta1/publishers/google/models';

const VERTEX_GLOBAL_HOST = 'https://aiplatform.googleapis.com';

export class VertexModelsHttpError extends Error {
    /**
     * @param {number} status HTTP status code
     * @param {string} statusText HTTP status text
     */
    constructor(status, statusText) {
        super(`Vertex AI models endpoint returned ${status} ${statusText}`.trim());
        this.name = 'VertexModelsHttpError';
        this.status = status;
        this.statusText = statusText;
    }
}

export class VertexModelsResponseError extends Error {
    /**
     * @param {string} message Error message
     * @param {ErrorOptions} [options] Error options
     */
    constructor(message, options) {
        super(message, options);
        this.name = 'VertexModelsResponseError';
    }
}

/**
 * Resolves the Model Garden host for a Vertex AI region. `global` is served
 * by the un-prefixed host, every other region by a region-prefixed one.
 * @param {string} region Vertex AI region
 * @returns {string} Host without a trailing slash
 */
export function getVertexModelsHost(region) {
    const trimmed = String(region || '').trim();
    return !trimmed || trimmed === 'global'
        ? VERTEX_GLOBAL_HOST
        : `https://${trimmed}-aiplatform.googleapis.com`;
}

/**
 * Builds the Model Garden publisher model list URL.
 * @param {object} [options] Options
 * @param {string} [options.region] Vertex AI region
 * @param {string} [options.origin] Explicit origin (reverse proxy / base URL)
 * @returns {string} Models list URL
 */
export function buildVertexModelsUrl({ region = '', origin = '' } = {}) {
    const base = origin ? String(origin) : getVertexModelsHost(region);
    return `${base.replace(/\/+$/, '')}${VERTEX_MODELS_PATH}`;
}

/**
 * Extracts the model id from a publisher model resource name.
 * @param {any} model Publisher model entry
 * @returns {string} Model id, or an empty string when the name is unusable
 */
function extractModelId(model) {
    const name = typeof model?.name === 'string' ? model.name.trim() : '';
    return name
        .replace(/^projects\/[^/]+\/locations\/[^/]+\/publishers\/[^/]+\/models\//, '')
        .replace(/^publishers\/[^/]+\/models\//, '')
        .replace(/^models\//, '');
}

/**
 * Fetches every page of Model Garden publisher models for a publisher.
 *
 * The list response carries no generation-capability flag: `supportedActions`
 * is a `CallToAction` object describing console/notebook/deploy links, and the
 * `supportedGenerationMethods` field the AI Studio API uses does not exist on
 * this schema at all. Consumers that need a narrower set (Google's own Gen AI
 * SDK, Model Garden gateways) therefore filter client-side, so this returns
 * every entry and leaves selection to the caller.
 *
 * @param {string | URL} modelsUrl Model Garden publisher models endpoint
 * @param {object} [options] Options
 * @param {Record<string, string>} [options.headers] Extra request headers
 * @param {typeof fetch} [options.fetchImpl] Fetch implementation
 * @returns {Promise<object[]>} Models in `{ id }` shape
 */
export async function fetchVertexModels(modelsUrl, { headers = {}, fetchImpl = fetch } = {}) {
    const requestUrl = new URL(modelsUrl);
    requestUrl.searchParams.delete('pageToken');

    const models = [];
    const pageTokens = new Set();
    let pageNumber = 1;

    while (true) {
        let response;

        try {
            response = await fetchImpl(requestUrl.toString(), { method: 'GET', headers });
        } catch (cause) {
            throw new VertexModelsResponseError(`Failed to fetch Vertex AI models page ${pageNumber}.`, { cause });
        }

        if (!response.ok) {
            throw new VertexModelsHttpError(response.status, response.statusText);
        }

        let data;
        try {
            data = await response.json();
        } catch (cause) {
            throw new VertexModelsResponseError(`Failed to parse Vertex AI models page ${pageNumber}.`, { cause });
        }

        if (!data || !Array.isArray(data.publisherModels)) {
            throw new VertexModelsResponseError(`Vertex AI models page ${pageNumber} has an invalid publisherModels field.`);
        }

        for (const [index, model] of data.publisherModels.entries()) {
            const id = extractModelId(model);
            if (!id) {
                throw new VertexModelsResponseError(`Vertex AI model at page ${pageNumber} index ${index} has an invalid name.`);
            }

            models.push({ id });
        }

        const nextPageToken = data.nextPageToken;
        if (nextPageToken === undefined || nextPageToken === '') {
            break;
        }
        if (typeof nextPageToken !== 'string') {
            throw new VertexModelsResponseError(`Vertex AI models page ${pageNumber} has an invalid nextPageToken.`);
        }
        if (pageTokens.has(nextPageToken)) {
            throw new VertexModelsResponseError(`Vertex AI models pagination repeated token on page ${pageNumber}.`);
        }

        pageTokens.add(nextPageToken);
        requestUrl.searchParams.set('pageToken', nextPageToken);
        pageNumber++;
    }

    const uniqueModelMap = new Map();
    for (const model of models) {
        uniqueModelMap.set(model.id, model);
    }

    return [...uniqueModelMap.values()].sort((a, b) => a.id.localeCompare(b.id));
}
