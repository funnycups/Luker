// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// EmbeddingService — pure body-builder layer.
//
// These helpers translate Connection-Manager profiles into the request body
// fields the `/api/vector/*` backend understands. They are pulled out of
// `embedding-service.js` so they can be unit-tested without the DOM/jQuery/
// `script.js` import chain that the IO wrapper drags in.

/**
 * Translate an embed profile into the body fields understood by the vector
 * backend endpoints.
 * @param {object} profile
 * @returns {object} Partial request body
 */
export function buildRequestBodyFromEmbedProfile(profile) {
    if (!profile || typeof profile !== 'object') return {};

    const source = String(profile.source || '').trim();
    if (!source) return {};

    const body = { source };
    const model = String(profile.model || '').trim();
    if (model) body.model = model;

    const apiUrl = String(profile['api-url'] || '').trim();
    const proxyPassword = profile['proxy-password'] != null
        ? String(profile['proxy-password'])
        : '';
    const secretId = String(profile['secret-id'] || '').trim();

    // Triplet — aligned with chat-completion endpoints.
    if (apiUrl) body.reverse_proxy = apiUrl;
    if (apiUrl && proxyPassword) body.proxy_password = proxyPassword;
    if (secretId) body.secret_id = secretId;

    // Local-backend fallback: the legacy `apiUrl` body field is still consulted by
    // the backend when `reverse_proxy` is absent, so propagate it explicitly to
    // keep a single source of truth.
    if (apiUrl && (source === 'ollama' || source === 'llamacpp' || source === 'vllm' || source === 'koboldcpp')) {
        body.apiUrl = apiUrl;
    }
    if (source === 'extras') {
        body.extrasUrl = apiUrl;
        body.extrasKey = proxyPassword;
    }

    // Per-provider knobs.
    if (source === 'jina') {
        if (profile['jina-late-chunking'] === 'true' || profile['jina-late-chunking'] === true) {
            body.jina_late_chunking = true;
        }
        const dims = Number(profile['jina-dimensions']);
        if (Number.isFinite(dims) && dims > 0) body.jina_dimensions = dims;
        const task = String(profile['jina-task'] || '').trim();
        if (task) body.jina_task = task;
    }
    if (source === 'ollama') {
        if (profile['ollama-keep'] === 'true' || profile['ollama-keep'] === true) {
            body.keep = true;
        }
    }
    if (source === 'siliconflow') {
        const ep = String(profile['siliconflow-endpoint'] || '').trim();
        if (ep) body.siliconflow_endpoint = ep;
    }
    if (source === 'workers_ai') {
        const accountId = String(profile['workers-ai-account-id'] || '').trim();
        if (accountId) body.workers_ai_account_id = accountId;
    }
    if (source === 'palm' || source === 'vertexai') {
        body.api = source === 'palm' ? 'makersuite' : 'vertexai';
        const region = String(profile['vertexai-region'] || '').trim();
        if (region) body.vertexai_region = region;
        const authMode = String(profile['vertexai-auth-mode'] || '').trim();
        if (authMode) body.vertexai_auth_mode = authMode;
        const expressId = String(profile['vertexai-express-project-id'] || '').trim();
        if (expressId) body.vertexai_express_project_id = expressId;
    }

    return body;
}

/**
 * Translate a rerank profile into the body fields understood by the rerank
 * backend endpoint.
 * @param {object} profile
 * @returns {object} Partial request body
 */
export function buildRequestBodyFromRerankProfile(profile) {
    if (!profile || typeof profile !== 'object') return {};

    const source = String(profile.source || '').trim();
    if (!source) return {};

    const body = { source };
    const model = String(profile.model || '').trim();
    if (model) body.model = model;

    const apiUrl = String(profile['api-url'] || '').trim();
    const proxyPassword = profile['proxy-password'] != null
        ? String(profile['proxy-password'])
        : '';
    const secretId = String(profile['secret-id'] || '').trim();

    if (apiUrl) body.reverse_proxy = apiUrl;
    if (apiUrl && proxyPassword) body.proxy_password = proxyPassword;
    if (secretId) body.secret_id = secretId;

    // Backward compat with the legacy custom-rerank body fields. The backend
    // prefers the triplet but accepts these as a fallback.
    if (source === 'custom') {
        if (apiUrl) body.apiUrl = apiUrl;
        if (proxyPassword) body.apiKey = proxyPassword;
    }

    return body;
}
