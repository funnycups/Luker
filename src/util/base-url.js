// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Provider base-URL normalization for Connection Manager profiles.
//
// Every base path below is taken from the provider's official API
// documentation. The documentation URL is recorded next to the rule so a
// future change can be checked against the same page. Sources without a
// documented base path are intentionally absent: their input is returned
// unchanged rather than guessed at.

const ENDPOINT_SUFFIXES = [
    '/chat/completions',
    '/completions',
    '/messages',
    '/responses',
    '/chat',
    '/api/embeddings/compute',
    '/embedding/text',
    '/embeddings',
    '/api/embed',
    '/embed',
    '/rerank',
    '/models',
];

// Google model endpoints: /models/{model}:{method} and the Vertex publisher
// form /projects/{project}/locations/{location}/publishers/{publisher}/models/{model}:{method}.
const MODEL_ENDPOINT_RE = /\/(?:projects\/[^/]+\/locations\/[^/]+\/publishers\/[^/]+\/)?models\/[^/]+:(?:generateContent|streamGenerateContent|embedContent|batchEmbedContents|predict)$/;
const VERSION_RE = /\/v\d+(?:beta\d*)?$/;

/**
 * @typedef {object} SourceRule
 * @property {string} [basePath] Documented base path appended when the user
 *   supplied only a host. Empty means the provider's base is the host itself.
 * @property {string[]} [shortBasePaths] Documented shorter bases that should
 *   be completed to `basePath` (for example NanoGPT's `https://api.nano-gpt.com/api`).
 * @property {boolean} [legacyOpenAI] Keep the historical behavior: append
 *   `/v1` to any path that has no version segment.
 * @property {boolean} [stripVersion] Strip a trailing `/v1`, `/v2`, `/v1beta`
 *   before applying `basePath`.
 * @property {boolean} [stripModelEndpoint] Strip a full Google model endpoint
 *   (`/models/{model}:{method}` or the Vertex publisher form).
 */

/** @type {Record<string, SourceRule>} */
const SOURCE_RULES = {
    // Chat completions.
    // https://github.com/openai/openai-openapi
    openai: { basePath: '/v1', legacyOpenAI: true },
    custom: { basePath: '/v1', legacyOpenAI: true },
    openai_responses: { basePath: '/v1', legacyOpenAI: true },
    // https://platform.claude.com/docs/en/api/overview
    claude: { basePath: '/v1' },
    // https://docs.mistral.ai/api/
    mistral: { basePath: '/v1' },
    // https://api-docs.deepseek.com/ (base_url is the host; /v1 is an alias)
    deepseek: { basePath: '' },
    // https://docs.x.ai/overview
    xai: { basePath: '/v1' },
    // https://platform.kimi.ai/docs/api/chat
    moonshot: { basePath: '/v1' },
    // https://docs.z.ai/api-reference/introduction
    zai: { basePath: '/api/paas/v4' },
    // https://ai.google.dev/api/generate-content
    makersuite: { basePath: '', stripVersion: true, stripModelEndpoint: true },
    palm: { basePath: '', stripVersion: true, stripModelEndpoint: true },
    // https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/inference
    vertexai: { basePath: '', stripVersion: true, stripModelEndpoint: true },
    // https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/azureopenai/chat
    azure: { basePath: '' },

    // Embeddings.
    // https://github.com/openai/openai-openapi
    togetherai: { basePath: '/v1' },
    // https://docs.electronhub.ai/getting-started/quickstart
    electronhub: { basePath: '/v1' },
    // https://openrouter.ai/docs/api/api-reference/embeddings/submit-an-embedding-request
    openrouter: { basePath: '/api/v1' },
    // https://chutes.ai/docs/models/chutes-qwen-qwen3-embedding-8b-tee
    chutes: { basePath: '/v1' },
    // https://docs.nano-gpt.com/ documents both https://api.nano-gpt.com/api
    // and https://nano-gpt.com/api; the code appends /embeddings, so the
    // version segment belongs to the base.
    nanogpt: { basePath: '/api/v1', shortBasePaths: ['/api'] },
    // https://docs.siliconflow.com/en/api-reference/embeddings/create-embeddings
    siliconflow: { basePath: '/v1' },
    // https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/
    workers_ai: { basePath: '' },
    // https://docs.cohere.com/reference/embed
    cohere: { basePath: '/v2' },
    // https://jina.ai/embeddings/
    jina: { basePath: '/v1' },
    // https://docs.ollama.com/api/embed
    ollama: { basePath: '' },
    // https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
    llamacpp: { basePath: '', stripVersion: true },
    // https://docs.vllm.ai/en/latest/serving/online_serving/
    vllm: { basePath: '', stripVersion: true },
    // https://github.com/SillyTavern/SillyTavern-extras
    extras: { basePath: '' },
    // User-defined rerank endpoint; only the documented /rerank suffix is
    // removed, the rest of the path is left untouched.
    custom_rerank: { basePath: '' },
};

/**
 * Normalize a user-supplied base URL for a source.
 *
 * The function only removes a documented endpoint suffix and completes a
 * documented base path. A non-empty path that is not a documented base is
 * treated as a user-supplied proxy path and left unchanged.
 *
 * @param {string} source Source id from Connection Manager.
 * @param {string} input User-supplied URL.
 * @returns {string} Normalized URL, or the trimmed input when the source has
 *   no documented rule or the input is not a valid http(s) URL.
 */
export function normalizeProviderBaseUrl(source, input) {
    const raw = String(input ?? '').trim();
    if (!raw) return raw;

    const rule = SOURCE_RULES[String(source || '')];
    if (!rule) return raw;

    let url;
    try {
        url = new URL(raw);
    } catch {
        return raw;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return raw;

    let path = url.pathname.replace(/\/+$/, '');
    path = stripEndpointSuffix(path);
    if (rule.stripModelEndpoint) path = path.replace(MODEL_ENDPOINT_RE, '');
    if (rule.stripVersion) path = path.replace(VERSION_RE, '');
    path = path.replace(/\/+$/, '');

    if (rule.legacyOpenAI) {
        if (!/\/v\d+(?:\/|$)/.test(path)) path += '/v1';
    } else if (!path) {
        path = rule.basePath || '';
    } else if (rule.shortBasePaths?.includes(path)) {
        path = rule.basePath || '';
    }

    url.pathname = path || '/';
    let out = url.toString();
    out = out.replace(/\/\?/, '?');
    if (out.endsWith('/')) out = out.slice(0, -1);
    return out;
}

/**
 * @param {string} path
 * @returns {string}
 */
function stripEndpointSuffix(path) {
    for (const suffix of ENDPOINT_SUFFIXES) {
        if (path.endsWith(suffix)) {
            return path.slice(0, -suffix.length).replace(/\/+$/, '');
        }
    }
    return path;
}
