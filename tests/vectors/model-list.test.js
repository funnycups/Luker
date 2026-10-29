/**
 * Tests for src/vectors/model-list.js.
 *
 * The module is a dispatcher over per-provider catalog endpoints. These tests
 * pin the request URL, auth header and response mapping for every supported
 * source, plus the reverse-proxy credential precedence.
 */

import { describe, test, expect, jest, beforeAll, beforeEach } from '@jest/globals';

globalThis.__testSecrets = new Map();

jest.unstable_mockModule('../../src/endpoints/secrets.js', () => ({
    SECRET_KEYS: {
        OPENAI: 'api_key_openai',
        COHERE: 'api_key_cohere',
        JINA: 'api_key_jina',
        TOGETHERAI: 'api_key_togetherai',
        OPENROUTER: 'api_key_openrouter',
        ELECTRONHUB: 'api_key_electronhub',
        CHUTES: 'api_key_chutes',
        NANOGPT: 'api_key_nanogpt',
        SILICONFLOW: 'api_key_siliconflow',
        WORKERS_AI: 'api_key_workers_ai',
        MAKERSUITE: 'api_key_makersuite',
    },
    readSecret: (_directories, key, id) => globalThis.__testSecrets.get(id || key) || '',
    readProviderSecret: (_request, key) => globalThis.__testSecrets.get(key) || '',
}));

jest.unstable_mockModule('../../src/endpoints/google.js', () => ({
    getVertexAIAuth: async (request) => {
        if (request.body.reverse_proxy) {
            return { authHeader: `Bearer ${request.body.proxy_password}`, authType: 'proxy' };
        }
        if (request.body.vertexai_auth_mode === 'full') {
            return { authHeader: 'Bearer full-token', authType: 'full' };
        }
        return { authHeader: 'Bearer express-key', authType: 'express' };
    },
}));

jest.unstable_mockModule('../../src/util.js', () => ({
    getConfigValue: (_key, defaultValue) => defaultValue,
    trimV1: (value) => String(value ?? '').replace(/\/$/, '').replace(/\/v1$/, ''),
}));

/** @type {typeof import('../../src/vectors/model-list.js')} */
let mod;

beforeAll(async () => {
    mod = await import('../../src/vectors/model-list.js');
});

beforeEach(() => {
    globalThis.__testSecrets.clear();
});

function jsonResponse(body, { ok = true, status = 200, statusText = 'OK' } = {}) {
    return {
        ok,
        status,
        statusText,
        text: async () => JSON.stringify(body),
        json: async () => body,
    };
}

function makeFetch(handler) {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url: String(url), options });
        return handler(String(url), options);
    };
    return { fetchImpl, calls };
}

function makeRequest(body) {
    return { body, user: { directories: {} } };
}

describe('listModels — OpenAI', () => {
    test('filters embedding models and sends the bearer key', async () => {
        globalThis.__testSecrets.set('api_key_openai', 'sk-test');
        const { fetchImpl, calls } = makeFetch(() => jsonResponse({
            data: [{ id: 'gpt-4o' }, { id: 'text-embedding-3-small' }, { id: 'text-embedding-3-large' }],
        }));

        const models = await mod.listModels({
            source: 'openai',
            request: makeRequest({}),
            fetchImpl,
        });

        expect(calls[0].url).toBe('https://api.openai.com/v1/models');
        expect(calls[0].options.headers.Authorization).toBe('Bearer sk-test');
        expect(models).toEqual([
            { id: 'text-embedding-3-small' },
            { id: 'text-embedding-3-large' },
        ]);
    });

    test('reverse proxy URL and password take precedence over the saved secret', async () => {
        globalThis.__testSecrets.set('api_key_openai', 'sk-saved');
        const { fetchImpl, calls } = makeFetch(() => jsonResponse({ data: [{ id: 'text-embedding-3-small' }] }));

        await mod.listModels({
            source: 'openai',
            request: makeRequest({ reverse_proxy: 'https://proxy.local/v1/', proxy_password: 'proxy-key' }),
            fetchImpl,
        });

        expect(calls[0].url).toBe('https://proxy.local/v1/models');
        expect(calls[0].options.headers.Authorization).toBe('Bearer proxy-key');
    });

    test('custom OpenAI-compatible endpoints are not filtered by model name', async () => {
        const { fetchImpl } = makeFetch(() => jsonResponse({
            data: [{ id: 'BAAI/bge-m3' }, { id: 'some-chat-model' }],
        }));

        const models = await mod.listModels({
            source: 'openai',
            request: makeRequest({ reverse_proxy: 'https://proxy.local/v1', proxy_password: 'proxy-key' }),
            fetchImpl,
        });

        expect(models.map(model => model.id)).toEqual(['BAAI/bge-m3', 'some-chat-model']);
    });
});

describe('listModels — Cohere', () => {
    test('uses endpoint=embed for embedding profiles', async () => {
        globalThis.__testSecrets.set('api_key_cohere', 'co-test');
        const { fetchImpl, calls } = makeFetch(() => jsonResponse({
            models: [{ name: 'embed-english-v3.0' }, { name: 'embed-multilingual-v3.0' }],
        }));

        const models = await mod.listModels({
            source: 'cohere',
            mode: 'embed',
            request: makeRequest({}),
            fetchImpl,
        });

        expect(calls[0].url).toBe('https://api.cohere.com/v1/models?endpoint=embed');
        expect(models).toEqual([
            { id: 'embed-english-v3.0', name: 'embed-english-v3.0' },
            { id: 'embed-multilingual-v3.0', name: 'embed-multilingual-v3.0' },
        ]);
    });

    test('uses endpoint=rerank for rerank profiles', async () => {
        globalThis.__testSecrets.set('api_key_cohere', 'co-test');
        const { fetchImpl, calls } = makeFetch(() => jsonResponse({ models: [{ name: 'rerank-v3.5' }] }));

        await mod.listModels({
            source: 'cohere',
            mode: 'rerank',
            request: makeRequest({}),
            fetchImpl,
        });

        expect(calls[0].url).toBe('https://api.cohere.com/v1/models?endpoint=rerank');
    });
});

describe('listModels — Jina', () => {
    test('strips the catalog prefix and keeps embedding models', async () => {
        const { fetchImpl } = makeFetch(() => jsonResponse({
            data: [
                { id: 'jina-ai/jina-embeddings-v3', name: 'Jina Embeddings v3', output_modalities: ['embeddings'] },
                { id: 'jina-ai/jina-reranker-v3', name: 'Jina Reranker v3', output_modalities: ['text'] },
            ],
        }));

        const models = await mod.listModels({
            source: 'jina',
            mode: 'embed',
            request: makeRequest({}),
            fetchImpl,
        });

        expect(models).toEqual([{ id: 'jina-embeddings-v3', name: 'Jina Embeddings v3' }]);
    });

    test('keeps reranker and colbert models for rerank profiles', async () => {
        const { fetchImpl } = makeFetch(() => jsonResponse({
            data: [
                { id: 'jina-ai/jina-embeddings-v3', output_modalities: ['embeddings'] },
                { id: 'jina-ai/jina-reranker-v2-base-multilingual', output_modalities: ['text'] },
                { id: 'jina-ai/jina-colbert-v2', output_modalities: ['embeddings'] },
            ],
        }));

        const models = await mod.listModels({
            source: 'jina',
            mode: 'rerank',
            request: makeRequest({}),
            fetchImpl,
        });

        expect(models.map(model => model.id)).toEqual([
            'jina-reranker-v2-base-multilingual',
            'jina-colbert-v2',
        ]);
    });
});

describe('listModels — Together AI', () => {
    test('keeps type=embedding and prefers display_name', async () => {
        const { fetchImpl } = makeFetch(() => jsonResponse({
            data: [
                { id: 'chat-model', type: 'chat', display_name: 'Chat' },
                { id: 'BAAI/bge-large-en-v1.5', type: 'embedding', display_name: 'BGE Large' },
            ],
        }));

        const models = await mod.listModels({
            source: 'togetherai',
            request: makeRequest({}),
            fetchImpl,
        });

        expect(models).toEqual([{ id: 'BAAI/bge-large-en-v1.5', name: 'BGE Large' }]);
    });
});

describe('listModels — OpenRouter', () => {
    test('asks for embeddings output modality and maps names', async () => {
        const { fetchImpl, calls } = makeFetch(() => jsonResponse({
            data: [{ id: 'openai/text-embedding-3-large', name: 'OpenAI: Text Embedding 3 Large' }],
        }));

        const models = await mod.listModels({
            source: 'openrouter',
            request: makeRequest({}),
            fetchImpl,
        });

        expect(calls[0].url).toBe('https://openrouter.ai/api/v1/models?output_modalities=embeddings');
        expect(models).toEqual([{ id: 'openai/text-embedding-3-large', name: 'OpenAI: Text Embedding 3 Large' }]);
    });
});

describe('listModels — ElectronHub', () => {
    test('keeps models exposing /v1/embeddings', async () => {
        const { fetchImpl } = makeFetch(() => jsonResponse({
            data: [
                { id: 'gpt-4o', endpoints: ['/v1/chat/completions'] },
                { id: 'text-embedding-3-small', endpoints: ['/v1/embeddings'] },
            ],
        }));

        const models = await mod.listModels({
            source: 'electronhub',
            request: makeRequest({}),
            fetchImpl,
        });

        expect(models.map(model => model.id)).toEqual(['text-embedding-3-small']);
    });
});

describe('listModels — Chutes', () => {
    test('maps slug to id and name to label', async () => {
        globalThis.__testSecrets.set('api_key_chutes', 'ch-test');
        const { fetchImpl, calls } = makeFetch(() => jsonResponse({
            items: [{ slug: 'chutes-qwen-qwen3-embedding-8b', name: 'Qwen3 Embedding 8B' }],
        }));

        const models = await mod.listModels({
            source: 'chutes',
            request: makeRequest({}),
            fetchImpl,
        });

        expect(calls[0].url).toBe('https://api.chutes.ai/chutes/?template=embedding&include_public=true&limit=999');
        expect(models).toEqual([{ id: 'chutes-qwen-qwen3-embedding-8b', name: 'Qwen3 Embedding 8B' }]);
    });
});

describe('listModels — NanoGPT', () => {
    test('maps id and name from the embedding catalog', async () => {
        globalThis.__testSecrets.set('api_key_nanogpt', 'ng-test');
        const { fetchImpl, calls } = makeFetch(() => jsonResponse({
            data: [{ id: 'nvidia/Nemotron-3.5-Embed-1B-BF16', name: 'Nemotron 3.5 Embed 1B' }],
        }));

        const models = await mod.listModels({
            source: 'nanogpt',
            request: makeRequest({}),
            fetchImpl,
        });

        expect(calls[0].url).toBe('https://nano-gpt.com/api/v1/embedding-models');
        expect(models).toEqual([{ id: 'nvidia/Nemotron-3.5-Embed-1B-BF16', name: 'Nemotron 3.5 Embed 1B' }]);
    });
});

describe('listModels — SiliconFlow', () => {
    test('uses the international endpoint by default', async () => {
        globalThis.__testSecrets.set('api_key_siliconflow', 'sf-test');
        const { fetchImpl, calls } = makeFetch(() => jsonResponse({ data: [{ id: 'Qwen/Qwen3-Embedding-0.6B' }] }));

        await mod.listModels({
            source: 'siliconflow',
            request: makeRequest({}),
            fetchImpl,
        });

        expect(calls[0].url).toBe('https://api.siliconflow.com/v1/models?type=text&sub_type=embedding');
    });

    test('uses the China endpoint when siliconflow_endpoint=cn', async () => {
        globalThis.__testSecrets.set('api_key_siliconflow', 'sf-test');
        const { fetchImpl, calls } = makeFetch(() => jsonResponse({ data: [] }));

        await mod.listModels({
            source: 'siliconflow',
            request: makeRequest({ siliconflow_endpoint: 'cn' }),
            fetchImpl,
        });

        expect(calls[0].url).toBe('https://api.siliconflow.cn/v1/models?type=text&sub_type=embedding');
    });
});

describe('listModels — Workers AI', () => {
    test('requires an account id', async () => {
        globalThis.__testSecrets.set('api_key_workers_ai', 'cf-test');

        await expect(mod.listModels({
            source: 'workers_ai',
            request: makeRequest({}),
            fetchImpl: async () => jsonResponse({ result: [] }),
        })).rejects.toThrow('Cloudflare Account ID is required.');
    });

    test('maps result names to ids', async () => {
        globalThis.__testSecrets.set('api_key_workers_ai', 'cf-test');
        const { fetchImpl, calls } = makeFetch(() => jsonResponse({
            result: [{ name: '@cf/baai/bge-m3' }, { name: '@cf/baai/bge-large-en-v1.5' }],
        }));

        const models = await mod.listModels({
            source: 'workers_ai',
            request: makeRequest({ workers_ai_account_id: 'acct-1' }),
            fetchImpl,
        });

        expect(calls[0].url).toBe('https://api.cloudflare.com/client/v4/accounts/acct-1/ai/models/search?task=Text+Embeddings&per_page=100');
        expect(models).toEqual([
            { id: '@cf/baai/bge-m3', name: '@cf/baai/bge-m3' },
            { id: '@cf/baai/bge-large-en-v1.5', name: '@cf/baai/bge-large-en-v1.5' },
        ]);
    });
});

describe('listModels — Google AI Studio', () => {
    test('keeps models that support embedContent', async () => {
        const { fetchImpl, calls } = makeFetch(() => jsonResponse({
            models: [
                { name: 'models/text-embedding-005', supportedGenerationMethods: ['embedContent', 'batchEmbedContents'] },
                { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
            ],
        }));

        const models = await mod.listModels({
            source: 'palm',
            request: makeRequest({ proxy_password: 'google-key' }),
            fetchImpl,
        });

        expect(calls[0].url).toContain('https://generativelanguage.googleapis.com/v1beta/models');
        expect(calls[0].url).toContain('key=google-key');
        expect(models).toEqual([{ id: 'text-embedding-005', name: 'text-embedding-005' }]);
    });
});

describe('listModels — Vertex AI', () => {
    test('keeps publisher models whose id contains embedding', async () => {
        const { fetchImpl, calls } = makeFetch(() => jsonResponse({
            publisherModels: [
                { name: 'publishers/google/models/text-embedding-005' },
                { name: 'publishers/google/models/gemini-2.5-pro' },
            ],
        }));

        const models = await mod.listModels({
            source: 'vertexai',
            request: makeRequest({ vertexai_auth_mode: 'full', vertexai_region: 'us-central1' }),
            fetchImpl,
        });

        expect(calls[0].url).toBe('https://us-central1-aiplatform.googleapis.com/v1beta1/publishers/google/models');
        expect(calls[0].options.headers.Authorization).toBe('Bearer full-token');
        expect(models).toEqual([{ id: 'text-embedding-005' }]);
    });
});

describe('listModels — Ollama', () => {
    test('reads /api/tags from the configured server', async () => {
        const { fetchImpl, calls } = makeFetch(() => jsonResponse({
            models: [{ name: 'mxbai-embed-large:latest' }, { name: 'nomic-embed-text:latest' }],
        }));

        const models = await mod.listModels({
            source: 'ollama',
            request: makeRequest({ apiUrl: 'http://localhost:11434' }),
            fetchImpl,
        });

        expect(calls[0].url).toBe('http://localhost:11434/api/tags');
        expect(models).toEqual([
            { id: 'mxbai-embed-large:latest' },
            { id: 'nomic-embed-text:latest' },
        ]);
    });
});

describe('listModels — OpenAI-compatible local servers', () => {
    test('vLLM trims a trailing /v1 before appending /v1/models', async () => {
        const { fetchImpl, calls } = makeFetch(() => jsonResponse({ data: [{ id: 'BAAI/bge-m3' }] }));

        const models = await mod.listModels({
            source: 'vllm',
            request: makeRequest({ apiUrl: 'http://localhost:8000/v1' }),
            fetchImpl,
        });

        expect(calls[0].url).toBe('http://localhost:8000/v1/models');
        expect(models).toEqual([{ id: 'BAAI/bge-m3' }]);
    });

    test('llama.cpp reads /v1/models', async () => {
        const { fetchImpl, calls } = makeFetch(() => jsonResponse({ data: [{ id: 'embedding-model.gguf' }] }));

        const models = await mod.listModels({
            source: 'llamacpp',
            request: makeRequest({ apiUrl: 'http://localhost:8080' }),
            fetchImpl,
        });

        expect(calls[0].url).toBe('http://localhost:8080/v1/models');
        expect(models).toEqual([{ id: 'embedding-model.gguf' }]);
    });
});

describe('listModels — custom rerank', () => {
    test('derives /models from a /rerank URL', async () => {
        const { fetchImpl, calls } = makeFetch(() => jsonResponse({ data: [{ id: 'BAAI/bge-reranker-v2-m3' }] }));

        const models = await mod.listModels({
            source: 'custom',
            mode: 'rerank',
            request: makeRequest({ reverse_proxy: 'http://localhost:8000/v1/rerank', proxy_password: 'key-1' }),
            fetchImpl,
        });

        expect(calls[0].url).toBe('http://localhost:8000/v1/models');
        expect(calls[0].options.headers.Authorization).toBe('Bearer key-1');
        expect(models).toEqual([{ id: 'BAAI/bge-reranker-v2-m3' }]);
    });
});

describe('listModels — unsupported sources', () => {
    test('throws for local sources without a catalog', async () => {
        await expect(mod.listModels({
            source: 'transformers',
            request: makeRequest({}),
            fetchImpl: async () => jsonResponse({}),
        })).rejects.toThrow('Model list is not available for source "transformers".');
    });
});

describe('listModels — error handling', () => {
    test('surfaces the upstream status and body', async () => {
        const { fetchImpl } = makeFetch(() => ({
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            text: async () => 'invalid api key',
            json: async () => ({}),
        }));

        await expect(mod.listModels({
            source: 'openai',
            request: makeRequest({}),
            fetchImpl,
        })).rejects.toThrow('Model list request failed (401 Unauthorized): invalid api key');
    });
});
