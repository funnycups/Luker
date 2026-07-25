import fetch from 'node-fetch';
import { SECRET_KEYS, readSecret } from '../endpoints/secrets.js';
import { attachInspectionEndpoint } from '../request-inspector.js';

const DEFAULT_COHERE_URL = 'https://api.cohere.ai/v2';
const DEFAULT_JINA_URL = 'https://api.jina.ai/v1';

/**
 * @typedef {object} RerankSettings
 * @property {string} model
 * @property {string} [apiUrl] Legacy custom-source URL (kept for backward compat)
 * @property {string} [apiKey] Legacy custom-source API key (kept for backward compat)
 * @property {string} [reverseProxy] Triplet: optional URL override for cohere/jina/custom
 * @property {string} [proxyPassword] Triplet: API key when reverseProxy is set
 * @property {string} [secretId] Triplet: secret store id for cohere/jina default-URL flow
 */

/**
 * Reranks documents using the specified source.
 * @param {string} source - The rerank source (cohere, jina, custom)
 * @param {RerankSettings} settings - Rerank settings
 * @param {string} query - The query text
 * @param {Array<{text: string, index: number, hash: number, score?: number}>} documents - Documents to rerank
 * @param {number} topK - Number of top results to return
 * @param {import('../users.js').UserDirectoryList} directories - User directories
 * @param {import('express').Request} [request] - Inspector-carrying request
 * @returns {Promise<Array<{text: string, index: number, hash: number, score: number, relevance_score: number}>>} Reranked documents
 */
export async function rerank(source, settings, query, documents, topK, directories, request = null) {
    switch (source) {
        case 'cohere':
            return rerankCohere(settings, query, documents, topK, directories, request);
        case 'jina':
            return rerankJina(settings, query, documents, topK, directories, request);
        case 'custom':
            return rerankCustom(settings, query, documents, topK, directories, request);
        default:
            throw new Error(`Unknown rerank source: ${source}`);
    }
}

function resolveTriplet(settings) {
    const reverseProxy = typeof settings?.reverseProxy === 'string' ? settings.reverseProxy.trim() : '';
    const proxyPassword = typeof settings?.proxyPassword === 'string' ? settings.proxyPassword : '';
    const secretId = typeof settings?.secretId === 'string' && settings.secretId.trim()
        ? settings.secretId.trim()
        : null;
    return { reverseProxy, proxyPassword, secretId };
}

/**
 * Reranks using Cohere Rerank API v2.
 * @param {RerankSettings} settings
 */
async function rerankCohere(settings, query, documents, topK, directories, request = null) {
    const { reverseProxy, proxyPassword, secretId } = resolveTriplet(settings);
    const key = reverseProxy
        ? proxyPassword
        : readSecret(directories, SECRET_KEYS.COHERE, secretId);
    if (!key) {
        throw new Error('No Cohere API key found for reranking');
    }

    const baseUrl = (reverseProxy || DEFAULT_COHERE_URL).replace(/\/+$/, '');
    const rerankUrl = `${baseUrl}/rerank`;
    const body = {
        model: settings.model || 'rerank-v3.5',
        query: query,
        documents: documents.map(d => d.text),
        top_n: topK,
    };

    if (request) attachInspectionEndpoint(request, rerankUrl, key, body);

    const response = await fetch(rerankUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`,
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const text = await response.text();
        console.error('Cohere rerank failed:', response.status, text);
        throw new Error(`Cohere rerank failed: ${response.statusText}`);
    }

    const data = await response.json();
    return data.results.map(r => ({
        ...documents[r.index],
        relevance_score: r.relevance_score,
    }));
}

/**
 * Reranks using Jina Rerank API.
 * @param {RerankSettings} settings
 */
async function rerankJina(settings, query, documents, topK, directories, request = null) {
    const { reverseProxy, proxyPassword, secretId } = resolveTriplet(settings);
    const key = reverseProxy
        ? proxyPassword
        : readSecret(directories, SECRET_KEYS.JINA, secretId);
    if (!key) {
        throw new Error('No Jina API key found for reranking');
    }

    const baseUrl = (reverseProxy || DEFAULT_JINA_URL).replace(/\/+$/, '');
    const rerankUrl = `${baseUrl}/rerank`;
    const body = {
        model: settings.model || 'jina-reranker-v2-base-multilingual',
        query: query,
        documents: documents.map(d => d.text),
        top_n: topK,
    };

    if (request) attachInspectionEndpoint(request, rerankUrl, key, body);

    const response = await fetch(rerankUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`,
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const text = await response.text();
        console.error('Jina rerank failed:', response.status, text);
        throw new Error(`Jina rerank failed: ${response.statusText}`);
    }

    const data = await response.json();
    return data.results.map(r => ({
        ...documents[r.index],
        relevance_score: r.relevance_score,
    }));
}

/**
 * Reranks using a custom OpenAI-compatible rerank endpoint.
 * Triplet form: `reverseProxy` is the URL, `proxyPassword` is the API key.
 * Legacy fallback: `apiUrl`/`apiKey` body fields.
 * Expects Cohere-compatible request/response format.
 * @param {RerankSettings} settings
 */
async function rerankCustom(settings, query, documents, topK, directories, request = null) {
    const { reverseProxy, proxyPassword } = resolveTriplet(settings);
    const apiUrl = reverseProxy || settings.apiUrl || '';
    const apiKey = reverseProxy ? proxyPassword : (settings.apiKey || '');

    if (!apiUrl) {
        throw new Error('No API URL provided for custom reranking');
    }

    const headers = {
        'Content-Type': 'application/json',
    };

    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const url = new URL(apiUrl);
    // Append /rerank if the URL doesn't already end with it
    if (!url.pathname.endsWith('/rerank')) {
        url.pathname = url.pathname.replace(/\/$/, '') + '/rerank';
    }

    const body = {
        model: settings.model || '',
        query: query,
        documents: documents.map(d => d.text),
        top_n: topK,
    };

    if (request) attachInspectionEndpoint(request, url.toString(), apiKey || '', body);

    const response = await fetch(url.toString(), {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const text = await response.text();
        console.error('Custom rerank failed:', response.status, text);
        throw new Error(`Custom rerank failed: ${response.statusText}`);
    }

    const data = await response.json();
    return data.results.map(r => ({
        ...documents[r.index],
        relevance_score: r.relevance_score,
    }));
}
