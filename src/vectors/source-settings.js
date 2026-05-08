// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Vector backend — pure source-settings layer.
//
// `getCommonCredentials` extracts the chat-completion-aligned credential
// triplet (`secret_id` / `reverse_proxy` / `proxy_password`) from an Express
// request body, accepting both snake_case and camelCase secret-id keys.
//
// `getSourceSettings` folds those credentials into per-source knobs and
// returns the bag passed downstream to provider modules. Both functions are
// side-effect-free apart from `getSourceSettings(transformers, …)` which
// reads the server-side config (single key, no IO at call time).

import { getConfigValue } from '../util.js';

/**
 * Reads the chat-completion-style credential triplet from the request body.
 * @param {object} request - The HTTP request object.
 * @returns {{secretId: string, reverseProxy: string, proxyPassword: string}}
 */
export function getCommonCredentials(request) {
    const secretId = typeof request?.body?.secret_id === 'string'
        ? request.body.secret_id.trim()
        : (typeof request?.body?.secretId === 'string' ? request.body.secretId.trim() : '');
    const reverseProxy = typeof request?.body?.reverse_proxy === 'string'
        ? request.body.reverse_proxy.trim()
        : '';
    const proxyPassword = typeof request?.body?.proxy_password === 'string'
        ? request.body.proxy_password
        : '';
    return { secretId, reverseProxy, proxyPassword };
}

/**
 * Extracts settings for the vectorization sources from the HTTP request body.
 * @param {string} source - Which source to extract settings for.
 * @param {object} request - The HTTP request object.
 * @returns {object} - An object that can be used as `sourceSettings` in functions that take that parameter.
 */
export function getSourceSettings(source, request) {
    const credentials = getCommonCredentials(request);
    switch (source) {
        case 'togetherai':
            return {
                model: String(request.body.model),
                ...credentials,
            };
        case 'openai':
            return {
                model: String(request.body.model),
                ...credentials,
            };
        case 'electronhub':
            return {
                model: String(request.body.model || 'text-embedding-3-small'),
                ...credentials,
            };
        case 'openrouter':
            return {
                model: String(request.body.model) || 'openai/text-embedding-3-large',
                ...credentials,
            };
        case 'cohere':
            return {
                model: String(request.body.model),
                ...credentials,
            };
        case 'jina':
            return {
                model: String(request.body.model || 'jina-embeddings-v3'),
                options: {
                    late_chunking: request.body.jina_late_chunking || false,
                    dimensions: request.body.jina_dimensions || undefined,
                    task: request.body.jina_task || undefined,
                },
                ...credentials,
            };
        case 'llamacpp': {
            const apiUrl = credentials.reverseProxy || String(request.body.apiUrl || '');
            return {
                apiUrl,
                ...credentials,
            };
        }
        case 'vllm': {
            const apiUrl = credentials.reverseProxy || String(request.body.apiUrl || '');
            return {
                apiUrl,
                model: String(request.body.model),
                ...credentials,
            };
        }
        case 'ollama': {
            const apiUrl = credentials.reverseProxy || String(request.body.apiUrl || '');
            return {
                apiUrl,
                model: String(request.body.model),
                keep: Boolean(request.body.keep),
                ...credentials,
            };
        }
        case 'extras': {
            // Triplet form takes precedence; fall back to legacy `extrasUrl`/`extrasKey` body fields.
            const apiUrl = credentials.reverseProxy || String(request.body.extrasUrl || '');
            const apiKey = credentials.reverseProxy
                ? credentials.proxyPassword
                : String(request.body.extrasKey || '');
            return {
                extrasUrl: apiUrl,
                extrasKey: apiKey,
                ...credentials,
            };
        }
        case 'transformers':
            return {
                model: getConfigValue('extensions.models.embedding', ''),
            };
        case 'palm':
        case 'vertexai':
            return {
                model: String(request.body.model || 'text-embedding-005'),
                request: request, // Pass the request object to get API key and URL
                ...credentials,
            };
        case 'mistral':
            return {
                model: 'mistral-embed',
                ...credentials,
            };
        case 'nomicai':
            return {
                model: 'nomic-embed-text-v1.5',
                ...credentials,
            };
        case 'webllm':
            return {
                model: String(request.body.model),
                embeddings: request.body.embeddings ?? {},
            };
        case 'koboldcpp':
            return {
                model: String(request.body.model),
                embeddings: request.body.embeddings ?? {},
            };
        case 'chutes':
            return {
                model: String(request.body.model || 'chutes-qwen-qwen3-embedding-8b'),
                ...credentials,
            };
        case 'nanogpt':
            return {
                model: String(request.body.model || 'text-embedding-3-small'),
                ...credentials,
            };
        case 'siliconflow':
            return {
                model: String(request.body.model || 'Qwen/Qwen3-Embedding-0.6B'),
                urlOverride: request.body.siliconflow_endpoint === 'cn'
                    ? 'https://api.siliconflow.cn/v1' : null,
                ...credentials,
            };
        case 'workers_ai': {
            const accountId = String(request.body.workers_ai_account_id || '').trim();
            return {
                model: String(request.body.model || '@cf/baai/bge-m3'),
                urlOverride: accountId
                    ? `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1`
                    : null,
                ...credentials,
            };
        }
        default:
            return {};
    }
}
