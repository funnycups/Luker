/**
 * Pure-function tests for public/scripts/embedding-service-core.js.
 *
 * Covers the body-builder layer that translates Connection-Manager profiles
 * into the request body the /api/vector/* backend understands. Verifies the
 * triplet propagation, per-provider knobs, local-backend fallback, and the
 * extras / rerank-custom legacy compat shapes.
 */

import { describe, test, expect } from '@jest/globals';
import {
    buildRequestBodyFromEmbedProfile,
    buildRequestBodyFromRerankProfile,
} from '../../public/scripts/embedding-service-core.js';

describe('buildRequestBodyFromEmbedProfile — null/empty handling', () => {
    test('null returns empty body', () => {
        expect(buildRequestBodyFromEmbedProfile(null)).toEqual({});
    });

    test('undefined returns empty body', () => {
        expect(buildRequestBodyFromEmbedProfile(undefined)).toEqual({});
    });

    test('non-object returns empty body', () => {
        expect(buildRequestBodyFromEmbedProfile('foo')).toEqual({});
        expect(buildRequestBodyFromEmbedProfile(42)).toEqual({});
    });

    test('empty source returns empty body', () => {
        expect(buildRequestBodyFromEmbedProfile({ source: '' })).toEqual({});
        expect(buildRequestBodyFromEmbedProfile({ source: '   ' })).toEqual({});
        expect(buildRequestBodyFromEmbedProfile({})).toEqual({});
    });
});

describe('buildRequestBodyFromEmbedProfile — minimal profiles', () => {
    test('source-only profile returns just the source', () => {
        expect(buildRequestBodyFromEmbedProfile({ source: 'transformers' })).toEqual({
            source: 'transformers',
        });
    });

    test('source + model', () => {
        expect(buildRequestBodyFromEmbedProfile({ source: 'openai', model: 'text-embedding-3-small' })).toEqual({
            source: 'openai',
            model: 'text-embedding-3-small',
        });
    });

    test('blank model is dropped', () => {
        expect(buildRequestBodyFromEmbedProfile({ source: 'openai', model: '' })).toEqual({ source: 'openai' });
        expect(buildRequestBodyFromEmbedProfile({ source: 'openai', model: '   ' })).toEqual({ source: 'openai' });
    });
});

describe('buildRequestBodyFromEmbedProfile — credential triplet', () => {
    test('api-url alone becomes reverse_proxy (no proxy_password without password)', () => {
        const body = buildRequestBodyFromEmbedProfile({
            source: 'openai',
            'api-url': 'https://proxy.local',
        });
        expect(body.reverse_proxy).toBe('https://proxy.local');
        expect(body).not.toHaveProperty('proxy_password');
    });

    test('api-url + proxy-password populates reverse_proxy + proxy_password', () => {
        const body = buildRequestBodyFromEmbedProfile({
            source: 'openai',
            'api-url': 'https://proxy.local',
            'proxy-password': 'pw',
        });
        expect(body.reverse_proxy).toBe('https://proxy.local');
        expect(body.proxy_password).toBe('pw');
    });

    test('proxy-password without api-url is dropped (chat-completion contract)', () => {
        const body = buildRequestBodyFromEmbedProfile({
            source: 'openai',
            'proxy-password': 'pw',
        });
        expect(body).not.toHaveProperty('reverse_proxy');
        expect(body).not.toHaveProperty('proxy_password');
    });

    test('secret-id propagates regardless of api-url', () => {
        expect(buildRequestBodyFromEmbedProfile({ source: 'openai', 'secret-id': 'sec-1' }).secret_id).toBe('sec-1');
        expect(buildRequestBodyFromEmbedProfile({
            source: 'openai',
            'api-url': 'https://proxy',
            'secret-id': 'sec-2',
        }).secret_id).toBe('sec-2');
    });

    test('whitespace-only triplet fields are dropped', () => {
        const body = buildRequestBodyFromEmbedProfile({
            source: 'openai',
            'api-url': '   ',
            'secret-id': '  ',
            'proxy-password': '',
        });
        expect(body).not.toHaveProperty('reverse_proxy');
        expect(body).not.toHaveProperty('secret_id');
        expect(body).not.toHaveProperty('proxy_password');
    });

    test('empty-string proxy-password is treated as missing (no auth via proxy)', () => {
        const body = buildRequestBodyFromEmbedProfile({
            source: 'openai',
            'api-url': 'https://proxy',
            'proxy-password': '',
        });
        expect(body.reverse_proxy).toBe('https://proxy');
        expect(body).not.toHaveProperty('proxy_password');
    });
});

describe('buildRequestBodyFromEmbedProfile — local backend apiUrl fallback', () => {
    test.each([['ollama'], ['llamacpp'], ['vllm'], ['koboldcpp']])(
        '%s also propagates api-url through the legacy apiUrl body field',
        (source) => {
            const body = buildRequestBodyFromEmbedProfile({ source, 'api-url': 'http://local:8080' });
            expect(body.reverse_proxy).toBe('http://local:8080');
            expect(body.apiUrl).toBe('http://local:8080');
        },
    );

    test('cloud sources do NOT get the legacy apiUrl mirror', () => {
        const body = buildRequestBodyFromEmbedProfile({ source: 'openai', 'api-url': 'https://proxy' });
        expect(body).not.toHaveProperty('apiUrl');
    });
});

describe('buildRequestBodyFromEmbedProfile — extras source', () => {
    test('extras maps api-url + proxy-password into extrasUrl + extrasKey', () => {
        const body = buildRequestBodyFromEmbedProfile({
            source: 'extras',
            'api-url': 'http://extras.local',
            'proxy-password': 'extras-key',
        });
        expect(body.extrasUrl).toBe('http://extras.local');
        expect(body.extrasKey).toBe('extras-key');
    });

    test('extras still sets extrasUrl=empty when api-url missing', () => {
        const body = buildRequestBodyFromEmbedProfile({ source: 'extras' });
        expect(body.extrasUrl).toBe('');
        expect(body.extrasKey).toBe('');
    });
});

describe('buildRequestBodyFromEmbedProfile — jina knobs', () => {
    test('late-chunking string "true" maps to body.jina_late_chunking', () => {
        expect(buildRequestBodyFromEmbedProfile({
            source: 'jina', 'jina-late-chunking': 'true',
        }).jina_late_chunking).toBe(true);
    });

    test('late-chunking boolean true also accepted', () => {
        expect(buildRequestBodyFromEmbedProfile({
            source: 'jina', 'jina-late-chunking': true,
        }).jina_late_chunking).toBe(true);
    });

    test('late-chunking "false" / missing is omitted', () => {
        expect(buildRequestBodyFromEmbedProfile({ source: 'jina', 'jina-late-chunking': 'false' }))
            .not.toHaveProperty('jina_late_chunking');
        expect(buildRequestBodyFromEmbedProfile({ source: 'jina' }))
            .not.toHaveProperty('jina_late_chunking');
    });

    test('positive jina-dimensions becomes numeric body.jina_dimensions', () => {
        expect(buildRequestBodyFromEmbedProfile({
            source: 'jina', 'jina-dimensions': '1024',
        }).jina_dimensions).toBe(1024);
    });

    test('non-positive / non-numeric jina-dimensions dropped', () => {
        expect(buildRequestBodyFromEmbedProfile({ source: 'jina', 'jina-dimensions': '0' }))
            .not.toHaveProperty('jina_dimensions');
        expect(buildRequestBodyFromEmbedProfile({ source: 'jina', 'jina-dimensions': '-3' }))
            .not.toHaveProperty('jina_dimensions');
        expect(buildRequestBodyFromEmbedProfile({ source: 'jina', 'jina-dimensions': 'abc' }))
            .not.toHaveProperty('jina_dimensions');
    });

    test('jina-task propagates to body.jina_task', () => {
        expect(buildRequestBodyFromEmbedProfile({
            source: 'jina', 'jina-task': 'retrieval.passage',
        }).jina_task).toBe('retrieval.passage');
    });

    test('jina knobs are NOT applied when source != jina', () => {
        const body = buildRequestBodyFromEmbedProfile({
            source: 'openai',
            'jina-late-chunking': 'true',
            'jina-dimensions': '1024',
            'jina-task': 'retrieval.query',
        });
        expect(body).not.toHaveProperty('jina_late_chunking');
        expect(body).not.toHaveProperty('jina_dimensions');
        expect(body).not.toHaveProperty('jina_task');
    });
});

describe('buildRequestBodyFromEmbedProfile — ollama knobs', () => {
    test('ollama-keep "true" maps to body.keep=true', () => {
        expect(buildRequestBodyFromEmbedProfile({
            source: 'ollama', 'ollama-keep': 'true',
        }).keep).toBe(true);
    });

    test('ollama-keep boolean true also accepted', () => {
        expect(buildRequestBodyFromEmbedProfile({
            source: 'ollama', 'ollama-keep': true,
        }).keep).toBe(true);
    });

    test('ollama-keep falsy dropped', () => {
        expect(buildRequestBodyFromEmbedProfile({ source: 'ollama', 'ollama-keep': 'false' }))
            .not.toHaveProperty('keep');
        expect(buildRequestBodyFromEmbedProfile({ source: 'ollama' }))
            .not.toHaveProperty('keep');
    });
});

describe('buildRequestBodyFromEmbedProfile — siliconflow / workers_ai', () => {
    test('siliconflow endpoint propagates', () => {
        expect(buildRequestBodyFromEmbedProfile({
            source: 'siliconflow', 'siliconflow-endpoint': 'cn',
        }).siliconflow_endpoint).toBe('cn');
    });

    test('siliconflow without endpoint omits field', () => {
        expect(buildRequestBodyFromEmbedProfile({ source: 'siliconflow' }))
            .not.toHaveProperty('siliconflow_endpoint');
    });

    test('workers_ai account id propagates', () => {
        expect(buildRequestBodyFromEmbedProfile({
            source: 'workers_ai', 'workers-ai-account-id': 'acct-1',
        }).workers_ai_account_id).toBe('acct-1');
    });

    test('workers_ai without account id omits field', () => {
        expect(buildRequestBodyFromEmbedProfile({ source: 'workers_ai' }))
            .not.toHaveProperty('workers_ai_account_id');
    });
});

describe('buildRequestBodyFromEmbedProfile — google sources', () => {
    test('palm sets api=makersuite + propagates region/auth/express', () => {
        const body = buildRequestBodyFromEmbedProfile({
            source: 'palm',
            'vertexai-region': 'us-central1',
            'vertexai-auth-mode': 'service-account',
            'vertexai-express-project-id': 'proj-1',
        });
        expect(body.api).toBe('makersuite');
        expect(body.vertexai_region).toBe('us-central1');
        expect(body.vertexai_auth_mode).toBe('service-account');
        expect(body.vertexai_express_project_id).toBe('proj-1');
    });

    test('vertexai sets api=vertexai', () => {
        expect(buildRequestBodyFromEmbedProfile({ source: 'vertexai' }).api).toBe('vertexai');
    });

    test('vertexai with empty knobs omits them', () => {
        const body = buildRequestBodyFromEmbedProfile({
            source: 'vertexai',
            'vertexai-region': '',
            'vertexai-auth-mode': '',
            'vertexai-express-project-id': '',
        });
        expect(body).not.toHaveProperty('vertexai_region');
        expect(body).not.toHaveProperty('vertexai_auth_mode');
        expect(body).not.toHaveProperty('vertexai_express_project_id');
    });

    test('non-google sources do not get the api field', () => {
        expect(buildRequestBodyFromEmbedProfile({ source: 'openai' })).not.toHaveProperty('api');
    });
});

describe('buildRequestBodyFromEmbedProfile — full integration', () => {
    test('openai with full triplet + secret', () => {
        expect(buildRequestBodyFromEmbedProfile({
            source: 'openai',
            model: 'text-embedding-3-large',
            'api-url': 'https://proxy.local/v1',
            'proxy-password': 'pw-1',
            'secret-id': 'sec-9',
        })).toEqual({
            source: 'openai',
            model: 'text-embedding-3-large',
            reverse_proxy: 'https://proxy.local/v1',
            proxy_password: 'pw-1',
            secret_id: 'sec-9',
        });
    });

    test('jina with all per-provider knobs + triplet', () => {
        expect(buildRequestBodyFromEmbedProfile({
            source: 'jina',
            model: 'jina-embeddings-v3',
            'api-url': 'https://jina.alt',
            'proxy-password': 'jp',
            'jina-late-chunking': 'true',
            'jina-dimensions': '768',
            'jina-task': 'retrieval.passage',
        })).toEqual({
            source: 'jina',
            model: 'jina-embeddings-v3',
            reverse_proxy: 'https://jina.alt',
            proxy_password: 'jp',
            jina_late_chunking: true,
            jina_dimensions: 768,
            jina_task: 'retrieval.passage',
        });
    });

    test('ollama with apiUrl + keep + triplet absent', () => {
        expect(buildRequestBodyFromEmbedProfile({
            source: 'ollama',
            model: 'mxbai-embed-large',
            'api-url': 'http://localhost:11434',
            'ollama-keep': 'true',
        })).toEqual({
            source: 'ollama',
            model: 'mxbai-embed-large',
            reverse_proxy: 'http://localhost:11434',
            apiUrl: 'http://localhost:11434',
            keep: true,
        });
    });
});

describe('buildRequestBodyFromRerankProfile', () => {
    test('null/undefined → empty body', () => {
        expect(buildRequestBodyFromRerankProfile(null)).toEqual({});
        expect(buildRequestBodyFromRerankProfile(undefined)).toEqual({});
    });

    test('empty source → empty body', () => {
        expect(buildRequestBodyFromRerankProfile({ source: '' })).toEqual({});
        expect(buildRequestBodyFromRerankProfile({})).toEqual({});
    });

    test('cohere minimal profile', () => {
        expect(buildRequestBodyFromRerankProfile({ source: 'cohere', model: 'rerank-v3.5' })).toEqual({
            source: 'cohere',
            model: 'rerank-v3.5',
        });
    });

    test('jina with secret-id', () => {
        expect(buildRequestBodyFromRerankProfile({
            source: 'jina',
            model: 'jina-reranker-v2-base-multilingual',
            'secret-id': 'sec-rer',
        })).toEqual({
            source: 'jina',
            model: 'jina-reranker-v2-base-multilingual',
            secret_id: 'sec-rer',
        });
    });

    test('cohere with reverse-proxy + password', () => {
        expect(buildRequestBodyFromRerankProfile({
            source: 'cohere',
            model: 'rerank-v3.5',
            'api-url': 'https://cohere.proxy',
            'proxy-password': 'pw',
        })).toEqual({
            source: 'cohere',
            model: 'rerank-v3.5',
            reverse_proxy: 'https://cohere.proxy',
            proxy_password: 'pw',
        });
    });

    test('custom source mirrors triplet into legacy apiUrl/apiKey body fields', () => {
        const body = buildRequestBodyFromRerankProfile({
            source: 'custom',
            model: 'rerank-custom',
            'api-url': 'http://my-rerank.local/v1',
            'proxy-password': 'custom-key',
        });
        expect(body).toEqual({
            source: 'custom',
            model: 'rerank-custom',
            reverse_proxy: 'http://my-rerank.local/v1',
            proxy_password: 'custom-key',
            apiUrl: 'http://my-rerank.local/v1',
            apiKey: 'custom-key',
        });
    });

    test('custom source with only api-url (no key) still sets legacy apiUrl', () => {
        const body = buildRequestBodyFromRerankProfile({
            source: 'custom',
            'api-url': 'http://my-rerank.local',
        });
        expect(body.apiUrl).toBe('http://my-rerank.local');
        expect(body).not.toHaveProperty('apiKey');
    });

    test('non-custom source does NOT get legacy apiUrl/apiKey fields', () => {
        const body = buildRequestBodyFromRerankProfile({
            source: 'jina',
            'api-url': 'https://jina.proxy',
            'proxy-password': 'pw',
        });
        expect(body).not.toHaveProperty('apiUrl');
        expect(body).not.toHaveProperty('apiKey');
    });

    test('blank model is dropped', () => {
        expect(buildRequestBodyFromRerankProfile({ source: 'cohere', model: '' })).toEqual({ source: 'cohere' });
    });
});
