// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Vector backend — model list adapters.
//
// Every embedding / rerank source publishes its catalog through a different
// endpoint and response shape. This module keeps those differences in one
// place so `/api/vector/models` stays a thin dispatcher.

import fetch from 'node-fetch';

import { SECRET_KEYS, readProviderSecret, readSecret } from '../endpoints/secrets.js';
import { getCommonCredentials } from './source-settings.js';
import { getConfigValue, trimV1 } from '../util.js';
import { normalizeProviderBaseUrl } from '../util/base-url.js';
import { setAdditionalHeadersByType } from '../additional-headers.js';
import { OPENROUTER_HEADERS, TEXTGEN_TYPES } from '../constants.js';
import { fetchGoogleModels } from '../endpoints/backends/google-models.js';
import { buildVertexModelsUrl, fetchVertexModels } from '../endpoints/backends/vertex-models.js';
import { getVertexAIAuth } from '../endpoints/google.js';

const DEFAULT_URLS = {
    openai: 'https://api.openai.com/v1',
    cohere: 'https://api.cohere.com/v1',
    jina: 'https://api.jina.ai/v1',
    togetherai: 'https://api.together.xyz/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    electronhub: 'https://api.electronhub.ai/v1',
    nanogpt: 'https://nano-gpt.com/api/v1',
    siliconflow: 'https://api.siliconflow.com/v1',
    siliconflowCn: 'https://api.siliconflow.cn/v1',
    makersuite: 'https://generativelanguage.googleapis.com',
};

/**
 * @param {object} request Express request
 * @param {string} secretKey Secret store key
 * @param {{reverseProxy: string, proxyPassword: string, secretId: string}} credentials
 * @returns {string} API key
 */
function resolveKey(request, secretKey, credentials) {
    if (credentials.reverseProxy) {
        return credentials.proxyPassword;
    }
    return readSecret(request.user.directories, secretKey, credentials.secretId || null) || '';
}

/**
 * @param {string} url
 * @param {{headers?: Record<string, string>, fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<any>}
 */
async function fetchJson(url, { headers = {}, fetchImpl = fetch } = {}) {
    const response = await fetchImpl(url, { method: 'GET', headers });
    if (!response.ok) {
        let detail = '';
        try {
            detail = (await response.text()).slice(0, 300);
        } catch {
            // Response body is optional in error reporting.
        }
        throw new Error(`Model list request failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ''}`);
    }
    return response.json();
}

/**
 * @param {any} data
 * @param {{filter?: (model: any) => boolean, map?: (model: any) => {id: string, name?: string}}} [options]
 * @returns {{id: string, name?: string}[]}
 */
function mapOpenAIStyle(data, { filter, map } = {}) {
    const items = Array.isArray(data?.data) ? data.data : [];
    const filtered = typeof filter === 'function' ? items.filter(filter) : items;
    return filtered
        .map(item => (typeof map === 'function' ? map(item) : { id: String(item?.id || '') }))
        .filter(model => model.id);
}

async function listOpenAI(request, credentials, fetchImpl) {
    const base = normalizeProviderBaseUrl('openai', credentials.reverseProxy || DEFAULT_URLS.openai);
    const key = resolveKey(request, SECRET_KEYS.OPENAI, credentials);
    const data = await fetchJson(`${base}/models`, {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
        fetchImpl,
    });
    // The official catalog mixes chat and embedding models with no modality
    // field, so the name is the only discriminator. A custom endpoint may use
    // arbitrary names, so every model it returns is offered.
    return mapOpenAIStyle(data, {
        filter: credentials.reverseProxy
            ? undefined
            : model => String(model?.id || '').includes('embedding'),
    });
}

async function listCohere(request, credentials, mode, fetchImpl) {
    const base = normalizeProviderBaseUrl('cohere', credentials.reverseProxy || DEFAULT_URLS.cohere);
    const key = resolveKey(request, SECRET_KEYS.COHERE, credentials);
    if (!key) {
        throw new Error('No Cohere API key found.');
    }
    const endpoint = mode === 'rerank' ? 'rerank' : 'embed';
    const data = await fetchJson(`${base}/models?endpoint=${endpoint}`, {
        headers: { Authorization: `Bearer ${key}` },
        fetchImpl,
    });
    const items = Array.isArray(data?.models) ? data.models : [];
    return items
        .map(model => ({ id: String(model?.name || ''), name: String(model?.name || '') }))
        .filter(model => model.id);
}

async function listJina(request, credentials, mode, fetchImpl) {
    const base = normalizeProviderBaseUrl('jina', credentials.reverseProxy || DEFAULT_URLS.jina);
    const key = resolveKey(request, SECRET_KEYS.JINA, credentials);
    const data = await fetchJson(`${base}/models`, {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
        fetchImpl,
    });
    const items = Array.isArray(data?.data) ? data.data : [];
    const filtered = mode === 'rerank'
        ? items.filter(model => /reranker|colbert/i.test(String(model?.id || '')))
        : items.filter(model => Array.isArray(model?.output_modalities) && model.output_modalities.includes('embeddings'));
    return filtered
        .map(model => {
            const id = String(model?.id || '').replace(/^jina-ai\//, '');
            return { id, name: String(model?.name || id) };
        })
        .filter(model => model.id);
}

async function listTogether(request, credentials, fetchImpl) {
    const base = normalizeProviderBaseUrl('togetherai', credentials.reverseProxy || DEFAULT_URLS.togetherai);
    const key = resolveKey(request, SECRET_KEYS.TOGETHERAI, credentials);
    const data = await fetchJson(`${base}/models`, {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
        fetchImpl,
    });
    return mapOpenAIStyle(data, {
        filter: model => String(model?.type || '') === 'embedding',
        map: model => ({ id: String(model?.id || ''), name: String(model?.display_name || model?.id || '') }),
    });
}

async function listOpenRouter(request, credentials, fetchImpl) {
    const base = normalizeProviderBaseUrl('openrouter', credentials.reverseProxy || DEFAULT_URLS.openrouter);
    const key = resolveKey(request, SECRET_KEYS.OPENROUTER, credentials);
    const data = await fetchJson(`${base}/models?output_modalities=embeddings`, {
        headers: {
            ...OPENROUTER_HEADERS,
            ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        fetchImpl,
    });
    return mapOpenAIStyle(data, {
        map: model => ({ id: String(model?.id || ''), name: String(model?.name || model?.id || '') }),
    });
}

async function listElectronHub(request, credentials, fetchImpl) {
    const base = normalizeProviderBaseUrl('electronhub', credentials.reverseProxy || DEFAULT_URLS.electronhub);
    const key = resolveKey(request, SECRET_KEYS.ELECTRONHUB, credentials);
    const data = await fetchJson(`${base}/models`, {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
        fetchImpl,
    });
    return mapOpenAIStyle(data, {
        filter: model => Array.isArray(model?.endpoints) && model.endpoints.includes('/v1/embeddings'),
        map: model => ({ id: String(model?.id || ''), name: String(model?.name || model?.id || '') }),
    });
}

async function listChutes(request, credentials, fetchImpl) {
    const key = resolveKey(request, SECRET_KEYS.CHUTES, credentials);
    if (!key) {
        throw new Error('No Chutes API key found.');
    }
    const data = await fetchJson('https://api.chutes.ai/chutes/?template=embedding&include_public=true&limit=999', {
        headers: { Authorization: `Bearer ${key}` },
        fetchImpl,
    });
    const items = Array.isArray(data?.items) ? data.items : [];
    return items
        .map(model => ({ id: String(model?.slug || model?.name || ''), name: String(model?.name || model?.slug || '') }))
        .filter(model => model.id);
}

async function listNanoGpt(request, credentials, fetchImpl) {
    const key = resolveKey(request, SECRET_KEYS.NANOGPT, credentials);
    if (!key) {
        throw new Error('No NanoGPT API key found.');
    }
    const data = await fetchJson('https://nano-gpt.com/api/v1/embedding-models', {
        headers: { Authorization: `Bearer ${key}`, 'Accept-Encoding': 'identity' },
        fetchImpl,
    });
    return mapOpenAIStyle(data, {
        map: model => ({ id: String(model?.id || ''), name: String(model?.name || model?.id || '') }),
    });
}

async function listSiliconFlow(request, credentials, fetchImpl) {
    const key = resolveKey(request, SECRET_KEYS.SILICONFLOW, credentials);
    if (!key) {
        throw new Error('No SiliconFlow API key found.');
    }
    const base = normalizeProviderBaseUrl('siliconflow', credentials.reverseProxy
        ? credentials.reverseProxy
        : (request.body.siliconflow_endpoint === 'cn' ? DEFAULT_URLS.siliconflowCn : DEFAULT_URLS.siliconflow));
    const data = await fetchJson(`${base}/models?type=text&sub_type=embedding`, {
        headers: { Authorization: `Bearer ${key}` },
        fetchImpl,
    });
    return mapOpenAIStyle(data);
}

async function listWorkersAi(request, credentials, fetchImpl) {
    const key = resolveKey(request, SECRET_KEYS.WORKERS_AI, credentials);
    if (!key) {
        throw new Error('No Cloudflare Workers AI API key found.');
    }
    const accountId = String(request.body.workers_ai_account_id || '').trim();
    if (!accountId) {
        throw new Error('Cloudflare Account ID is required.');
    }
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/models/search?task=Text+Embeddings&per_page=100`;
    const data = await fetchJson(url, {
        headers: { Authorization: `Bearer ${key}` },
        fetchImpl,
    });
    const items = Array.isArray(data?.result) ? data.result : [];
    return items
        .map(model => ({ id: String(model?.name || ''), name: String(model?.name || '') }))
        .filter(model => model.id);
}

async function listMakerSuite(request, fetchImpl) {
    const apiKey = request.body.proxy_password || readProviderSecret(request, SECRET_KEYS.MAKERSUITE) || '';
    const apiUrl = normalizeProviderBaseUrl('makersuite', request.body.reverse_proxy || request.body.base_url || DEFAULT_URLS.makersuite);
    const apiVersion = getConfigValue('gemini.apiVersion', 'v1beta');
    if (!apiKey && !request.body.base_url && !request.body.reverse_proxy) {
        throw new Error('Google AI Studio API key is missing.');
    }
    const modelsUrl = !apiKey && (request.body.base_url || request.body.reverse_proxy)
        ? `${apiUrl}/${apiVersion}/models`
        : `${apiUrl}/${apiVersion}/models?key=${apiKey}`;
    const models = await fetchGoogleModels(modelsUrl, fetchImpl, {
        supportedMethods: ['embedContent', 'batchEmbedContents'],
    });
    return models.map(model => ({ id: String(model.id), name: String(model.displayName || model.id) }));
}

async function listVertexAi(request, fetchImpl) {
    const region = String(request.body.vertexai_region || 'us-central1');
    const auth = await getVertexAIAuth(request);
    /** @type {Record<string, string>} */
    const headers = {};
    let modelsUrl;

    if (auth.authType === 'express') {
        const keyParam = auth.authHeader.replace('Bearer ', '');
        modelsUrl = `${buildVertexModelsUrl({ region })}?key=${keyParam}`;
    } else if (auth.authType === 'full') {
        modelsUrl = buildVertexModelsUrl({ region });
        headers['Authorization'] = auth.authHeader;
    } else {
        const proxyUrl = normalizeProviderBaseUrl('vertexai', request.body.reverse_proxy || request.body.base_url || '');
        modelsUrl = buildVertexModelsUrl({ region, origin: proxyUrl });
        headers['Authorization'] = auth.authHeader;
    }

    const models = await fetchVertexModels(modelsUrl, { headers, fetchImpl });
    return models.filter(model => String(model.id).includes('embedding'));
}

async function listOllama(request, credentials, fetchImpl) {
    const base = normalizeProviderBaseUrl('ollama', credentials.reverseProxy || String(request.body.apiUrl || ''));
    if (!base) {
        throw new Error('Ollama server URL is required.');
    }
    const url = new URL(base);
    url.pathname = '/api/tags';
    /** @type {Record<string, string>} */
    const headers = {};
    if (credentials.reverseProxy && credentials.proxyPassword) {
        headers['Authorization'] = `Bearer ${credentials.proxyPassword}`;
    } else {
        setAdditionalHeadersByType(headers, TEXTGEN_TYPES.OLLAMA, base, request.user.directories, credentials.secretId || null);
    }
    const data = await fetchJson(url.toString(), { headers, fetchImpl });
    const items = Array.isArray(data?.models) ? data.models : [];
    return items
        .map(model => ({ id: String(model?.name || model?.model || '') }))
        .filter(model => model.id);
}

async function listOpenAICompatibleServer(request, credentials, type, fetchImpl) {
    const base = normalizeProviderBaseUrl(type, credentials.reverseProxy || String(request.body.apiUrl || ''));
    if (!base) {
        throw new Error('Server URL is required.');
    }
    /** @type {Record<string, string>} */
    const headers = {};
    if (credentials.reverseProxy && credentials.proxyPassword) {
        headers['Authorization'] = `Bearer ${credentials.proxyPassword}`;
    } else {
        setAdditionalHeadersByType(headers, type, base, request.user.directories, credentials.secretId || null);
    }
    const data = await fetchJson(`${trimV1(base)}/v1/models`, { headers, fetchImpl });
    return mapOpenAIStyle(data);
}

async function listCustomRerank(request, credentials, fetchImpl) {
    const base = credentials.reverseProxy || String(request.body.apiUrl || '');
    if (!base) {
        throw new Error('Rerank server URL is required.');
    }
    const url = new URL(base);
    url.pathname = url.pathname.replace(/\/rerank\/?$/, '').replace(/\/$/, '') + '/models';
    const headers = {};
    if (credentials.proxyPassword) {
        headers['Authorization'] = `Bearer ${credentials.proxyPassword}`;
    }
    const data = await fetchJson(url.toString(), { headers, fetchImpl });
    return mapOpenAIStyle(data);
}

/**
 * Lists models for an embedding or rerank profile.
 *
 * @param {object} options
 * @param {string} options.source Source id from the profile
 * @param {'embed'|'rerank'} [options.mode] Profile mode
 * @param {object} options.request Express request carrying the profile body
 * @param {typeof fetch} [options.fetchImpl] Fetch implementation
 * @returns {Promise<{id: string, name?: string}[]>}
 */
export async function listModels({ source, mode = 'embed', request, fetchImpl = fetch }) {
    const credentials = getCommonCredentials(request);

    switch (source) {
        case 'openai':
            return listOpenAI(request, credentials, fetchImpl);
        case 'cohere':
            return listCohere(request, credentials, mode, fetchImpl);
        case 'jina':
            return listJina(request, credentials, mode, fetchImpl);
        case 'togetherai':
            return listTogether(request, credentials, fetchImpl);
        case 'openrouter':
            return listOpenRouter(request, credentials, fetchImpl);
        case 'electronhub':
            return listElectronHub(request, credentials, fetchImpl);
        case 'chutes':
            return listChutes(request, credentials, fetchImpl);
        case 'nanogpt':
            return listNanoGpt(request, credentials, fetchImpl);
        case 'siliconflow':
            return listSiliconFlow(request, credentials, fetchImpl);
        case 'workers_ai':
            return listWorkersAi(request, credentials, fetchImpl);
        case 'palm':
            return listMakerSuite(request, fetchImpl);
        case 'vertexai':
            return listVertexAi(request, fetchImpl);
        case 'ollama':
            return listOllama(request, credentials, fetchImpl);
        case 'vllm':
            return listOpenAICompatibleServer(request, credentials, TEXTGEN_TYPES.VLLM, fetchImpl);
        case 'llamacpp':
            return listOpenAICompatibleServer(request, credentials, TEXTGEN_TYPES.LLAMACPP, fetchImpl);
        case 'custom':
            return listCustomRerank(request, credentials, fetchImpl);
        default:
            throw new Error(`Model list is not available for source "${source}".`);
    }
}
