/**
 * Pure-function tests for src/vectors/source-settings.js.
 *
 * Covers:
 *   - getCommonCredentials: triplet extraction from request body, accepting
 *     snake_case + camelCase, trimming, missing/empty fields.
 *   - getSourceSettings: per-source bag construction, with and without the
 *     credential triplet, including the local-backend `apiUrl` semantics
 *     (reverseProxy takes precedence) and the legacy `extras` fallback.
 */

import { describe, test, expect } from '@jest/globals';
import { getCommonCredentials, getSourceSettings } from '../../src/vectors/source-settings.js';

function req(body) {
    return { body };
}

describe('getCommonCredentials', () => {
    test('reads snake_case secret_id', () => {
        expect(getCommonCredentials(req({ secret_id: 'sec-123' }))).toEqual({
            secretId: 'sec-123',
            reverseProxy: '',
            proxyPassword: '',
        });
    });

    test('reads camelCase secretId when snake_case absent', () => {
        expect(getCommonCredentials(req({ secretId: 'sec-cam' }))).toEqual({
            secretId: 'sec-cam',
            reverseProxy: '',
            proxyPassword: '',
        });
    });

    test('snake_case wins over camelCase when both present', () => {
        expect(getCommonCredentials(req({ secret_id: 'snake', secretId: 'camel' }))).toEqual({
            secretId: 'snake',
            reverseProxy: '',
            proxyPassword: '',
        });
    });

    test('trims surrounding whitespace on secret id', () => {
        expect(getCommonCredentials(req({ secret_id: '  sec-trim  ' }))).toMatchObject({ secretId: 'sec-trim' });
        expect(getCommonCredentials(req({ secretId: '\tsec-cam\n' }))).toMatchObject({ secretId: 'sec-cam' });
    });

    test('reads and trims reverse_proxy', () => {
        expect(getCommonCredentials(req({ reverse_proxy: '  https://proxy.local  ' }))).toMatchObject({
            reverseProxy: 'https://proxy.local',
        });
    });

    test('passes proxy_password through verbatim (does not trim)', () => {
        // Passwords legitimately contain leading/trailing whitespace; we never trim them.
        expect(getCommonCredentials(req({ proxy_password: '  secret  ' }))).toMatchObject({
            proxyPassword: '  secret  ',
        });
    });

    test('empty body yields empty triplet', () => {
        expect(getCommonCredentials(req({}))).toEqual({ secretId: '', reverseProxy: '', proxyPassword: '' });
    });

    test('non-string fields are dropped', () => {
        const body = { secret_id: 12345, secretId: ['x'], reverse_proxy: { foo: 'bar' }, proxy_password: 999 };
        expect(getCommonCredentials(req(body))).toEqual({ secretId: '', reverseProxy: '', proxyPassword: '' });
    });

    test('null/undefined request returns empty triplet', () => {
        expect(getCommonCredentials(null)).toEqual({ secretId: '', reverseProxy: '', proxyPassword: '' });
        expect(getCommonCredentials(undefined)).toEqual({ secretId: '', reverseProxy: '', proxyPassword: '' });
        expect(getCommonCredentials({})).toEqual({ secretId: '', reverseProxy: '', proxyPassword: '' });
    });
});

describe('getSourceSettings — credential triplet propagation', () => {
    test.each([
        ['togetherai'],
        ['openai'],
        ['electronhub'],
        ['openrouter'],
        ['cohere'],
        ['mistral'],
        ['nomicai'],
        ['chutes'],
        ['nanogpt'],
        ['siliconflow'],
        ['workers_ai'],
        ['palm'],
        ['vertexai'],
    ])('%s carries triplet through into sourceSettings', (source) => {
        const settings = getSourceSettings(source, req({
            model: 'm-1',
            secret_id: 'sec-x',
            reverse_proxy: 'https://proxy',
            proxy_password: 'pw',
            workers_ai_account_id: 'acct',
        }));
        expect(settings).toMatchObject({
            secretId: 'sec-x',
            reverseProxy: 'https://proxy',
            proxyPassword: 'pw',
        });
    });

    test.each([
        ['transformers'],
        ['webllm'],
        ['koboldcpp'],
    ])('%s does NOT carry triplet (local/builtin source)', (source) => {
        const settings = getSourceSettings(source, req({
            secret_id: 'sec-x',
            reverse_proxy: 'https://proxy',
            proxy_password: 'pw',
        }));
        expect(settings).not.toHaveProperty('secretId');
        expect(settings).not.toHaveProperty('reverseProxy');
        expect(settings).not.toHaveProperty('proxyPassword');
    });
});

describe('getSourceSettings — model defaults & per-source knobs', () => {
    test('togetherai uses raw model string', () => {
        expect(getSourceSettings('togetherai', req({ model: 'foo/bar' }))).toMatchObject({ model: 'foo/bar' });
    });

    test('togetherai missing model becomes empty string (not "undefined")', () => {
        expect(getSourceSettings('togetherai', req({}))).toMatchObject({ model: '' });
    });

    test('openai uses raw model string', () => {
        expect(getSourceSettings('openai', req({ model: 'text-embedding-ada-002' }))).toMatchObject({
            model: 'text-embedding-ada-002',
        });
    });

    test('openai missing model becomes empty string (not "undefined")', () => {
        expect(getSourceSettings('openai', req({}))).toMatchObject({ model: '' });
    });

    test('electronhub falls back to text-embedding-3-small when model missing', () => {
        expect(getSourceSettings('electronhub', req({}))).toMatchObject({ model: 'text-embedding-3-small' });
    });

    test('openrouter falls back to openai/text-embedding-3-large when model missing', () => {
        expect(getSourceSettings('openrouter', req({}))).toMatchObject({
            model: 'openai/text-embedding-3-large',
        });
    });

    test('cohere missing model becomes empty string (not "undefined")', () => {
        expect(getSourceSettings('cohere', req({}))).toMatchObject({ model: '' });
    });

    test('mistral always returns mistral-embed regardless of body', () => {
        expect(getSourceSettings('mistral', req({ model: 'ignored' }))).toMatchObject({ model: 'mistral-embed' });
    });

    test('nomicai always returns nomic-embed-text-v1.5', () => {
        expect(getSourceSettings('nomicai', req({ model: 'ignored' }))).toMatchObject({
            model: 'nomic-embed-text-v1.5',
        });
    });

    test('chutes default model when missing', () => {
        expect(getSourceSettings('chutes', req({}))).toMatchObject({ model: 'chutes-qwen-qwen3-embedding-8b' });
    });

    test('nanogpt default model when missing', () => {
        expect(getSourceSettings('nanogpt', req({}))).toMatchObject({ model: 'text-embedding-3-small' });
    });

    test('jina includes options block with explicit truthy values', () => {
        const settings = getSourceSettings('jina', req({
            model: 'jina-embeddings-v3',
            jina_late_chunking: true,
            jina_dimensions: 1024,
            jina_task: 'retrieval.passage',
        }));
        expect(settings).toMatchObject({
            model: 'jina-embeddings-v3',
            options: {
                late_chunking: true,
                dimensions: 1024,
                task: 'retrieval.passage',
            },
        });
    });

    test('jina options collapse falsy/missing values to defaults', () => {
        const settings = getSourceSettings('jina', req({}));
        expect(settings.options).toEqual({
            late_chunking: false,
            dimensions: undefined,
            task: undefined,
        });
        expect(settings.model).toBe('jina-embeddings-v3');
    });

    test('siliconflow injects cn endpoint when siliconflow_endpoint=cn', () => {
        const settings = getSourceSettings('siliconflow', req({ siliconflow_endpoint: 'cn' }));
        expect(settings.urlOverride).toBe('https://api.siliconflow.cn/v1');
        expect(settings.model).toBe('Qwen/Qwen3-Embedding-0.6B');
    });

    test('siliconflow leaves urlOverride null otherwise', () => {
        expect(getSourceSettings('siliconflow', req({})).urlOverride).toBeNull();
        expect(getSourceSettings('siliconflow', req({ siliconflow_endpoint: '' })).urlOverride).toBeNull();
        expect(getSourceSettings('siliconflow', req({ siliconflow_endpoint: 'us' })).urlOverride).toBeNull();
    });

    test('workers_ai builds urlOverride from account id', () => {
        const settings = getSourceSettings('workers_ai', req({
            model: '@cf/baai/bge-m3',
            workers_ai_account_id: 'acct/123',
        }));
        expect(settings.urlOverride).toBe('https://api.cloudflare.com/client/v4/accounts/acct%2F123/ai/v1');
        expect(settings.model).toBe('@cf/baai/bge-m3');
    });

    test('workers_ai falls back to @cf/baai/bge-m3 model + null urlOverride when accountId missing', () => {
        const settings = getSourceSettings('workers_ai', req({}));
        expect(settings.model).toBe('@cf/baai/bge-m3');
        expect(settings.urlOverride).toBeNull();
    });

    test.each([['palm'], ['vertexai']])('%s preserves request reference for downstream Google plumbing', (source) => {
        const incoming = req({ model: 'text-embedding-005' });
        const settings = getSourceSettings(source, incoming);
        expect(settings.model).toBe('text-embedding-005');
        expect(settings.request).toBe(incoming);
    });

    test('palm/vertexai default model when body.model missing', () => {
        expect(getSourceSettings('palm', req({})).model).toBe('text-embedding-005');
        expect(getSourceSettings('vertexai', req({})).model).toBe('text-embedding-005');
    });
});

describe('getSourceSettings — local backend apiUrl semantics', () => {
    test('llamacpp picks reverseProxy over body.apiUrl', () => {
        const settings = getSourceSettings('llamacpp', req({
            apiUrl: 'http://legacy:8080',
            reverse_proxy: 'http://override:9090',
            proxy_password: 'pw',
        }));
        expect(settings.apiUrl).toBe('http://override:9090');
        expect(settings.reverseProxy).toBe('http://override:9090');
        expect(settings.proxyPassword).toBe('pw');
    });

    test('llamacpp falls back to body.apiUrl when reverse_proxy missing', () => {
        expect(getSourceSettings('llamacpp', req({ apiUrl: 'http://local:8080' })).apiUrl).toBe('http://local:8080');
    });

    test('llamacpp gives empty apiUrl when nothing supplied', () => {
        expect(getSourceSettings('llamacpp', req({})).apiUrl).toBe('');
    });

    test('vllm carries model + reverseProxy precedence', () => {
        const settings = getSourceSettings('vllm', req({
            apiUrl: 'http://legacy',
            model: 'BAAI/bge-m3',
            reverse_proxy: 'http://override',
        }));
        expect(settings).toMatchObject({
            apiUrl: 'http://override',
            model: 'BAAI/bge-m3',
            reverseProxy: 'http://override',
        });
    });

    test('ollama carries model + keep + reverseProxy precedence', () => {
        const settings = getSourceSettings('ollama', req({
            apiUrl: 'http://legacy',
            model: 'mxbai',
            keep: true,
            reverse_proxy: 'http://override',
            secret_id: 'sec-9',
        }));
        expect(settings).toMatchObject({
            apiUrl: 'http://override',
            model: 'mxbai',
            keep: true,
            secretId: 'sec-9',
        });
    });

    test('ollama coerces keep to boolean', () => {
        expect(getSourceSettings('ollama', req({ keep: 0 })).keep).toBe(false);
        expect(getSourceSettings('ollama', req({ keep: 1 })).keep).toBe(true);
        expect(getSourceSettings('ollama', req({ keep: 'yes' })).keep).toBe(true);
        expect(getSourceSettings('ollama', req({})).keep).toBe(false);
    });
});

describe('getSourceSettings — extras source legacy fallback', () => {
    test('triplet form (reverseProxy + proxyPassword) wins over legacy extrasUrl/extrasKey', () => {
        const settings = getSourceSettings('extras', req({
            extrasUrl: 'http://old',
            extrasKey: 'old-key',
            reverse_proxy: 'http://new',
            proxy_password: 'new-pw',
        }));
        expect(settings.extrasUrl).toBe('http://new');
        expect(settings.extrasKey).toBe('new-pw');
    });

    test('falls back to legacy extrasUrl/extrasKey when no reverseProxy', () => {
        const settings = getSourceSettings('extras', req({
            extrasUrl: 'http://old',
            extrasKey: 'old-key',
        }));
        expect(settings.extrasUrl).toBe('http://old');
        expect(settings.extrasKey).toBe('old-key');
    });

    test('triplet without password leaves extrasKey empty (no legacy fallback once proxy is set)', () => {
        const settings = getSourceSettings('extras', req({
            extrasKey: 'legacy-key',
            reverse_proxy: 'http://new',
        }));
        expect(settings.extrasUrl).toBe('http://new');
        expect(settings.extrasKey).toBe('');
    });

    test('extras with empty body returns empty url+key', () => {
        const settings = getSourceSettings('extras', req({}));
        expect(settings.extrasUrl).toBe('');
        expect(settings.extrasKey).toBe('');
    });
});

describe('getSourceSettings — webllm/koboldcpp pre-computed embeddings', () => {
    test('webllm preserves the embeddings map as-is', () => {
        const embeddings = { hello: [0.1, 0.2] };
        const settings = getSourceSettings('webllm', req({ model: 'm', embeddings }));
        expect(settings.model).toBe('m');
        expect(settings.embeddings).toBe(embeddings);
    });

    test('webllm defaults embeddings to {}', () => {
        expect(getSourceSettings('webllm', req({})).embeddings).toEqual({});
    });

    test('koboldcpp preserves the embeddings map and model', () => {
        const embeddings = { foo: [0.3] };
        expect(getSourceSettings('koboldcpp', req({ model: 'kobold', embeddings }))).toMatchObject({
            model: 'kobold',
            embeddings,
        });
    });
});

describe('getSourceSettings — unknown source', () => {
    test('returns empty object for unknown source', () => {
        expect(getSourceSettings('unknown_source_xyz', req({ model: 'm', secret_id: 'sec' }))).toEqual({});
    });
});
