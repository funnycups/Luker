/**
 * Pure-function tests for
 * public/scripts/extensions/connection-manager/embed-rerank-core.js.
 *
 * Covers:
 *   - source-def lookup tables (embedding + rerank)
 *   - compactProfile: empty-field stripping, boolean coercion, cross-source
 *     field stripping (jina-only, ollama-only, etc.)
 *   - validateProfileFields: required name, taken-name detection, source
 *     validity, URL-required-when-not-optional, model-required-when-no-default,
 *     workers_ai account id, and end-to-end profile assembly with field
 *     compaction.
 */

import { describe, test, expect } from '@jest/globals';
import {
    EMBED_MODE,
    RERANK_MODE,
    EMBEDDING_SOURCE_DEFS,
    RERANK_SOURCE_DEFS,
    getEmbeddingSourceDef,
    getRerankSourceDef,
    listEmbeddingSourceDefs,
    listRerankSourceDefs,
    compactProfile,
    validateProfileFields,
} from '../../public/scripts/extensions/connection-manager/embed-rerank-core.js';

describe('mode constants', () => {
    test('EMBED_MODE / RERANK_MODE are the expected literals', () => {
        expect(EMBED_MODE).toBe('embed');
        expect(RERANK_MODE).toBe('rerank');
    });
});

describe('getEmbeddingSourceDef', () => {
    test('returns the def for a known source', () => {
        const def = getEmbeddingSourceDef('openai');
        expect(def).toMatchObject({
            id: 'openai',
            label: 'OpenAI',
            secretKey: 'api_key_openai',
            defaultModel: 'text-embedding-3-small',
            needsModel: true,
            urlOptional: true,
        });
    });

    test('returns null for unknown source', () => {
        expect(getEmbeddingSourceDef('not-a-source')).toBeNull();
        expect(getEmbeddingSourceDef('')).toBeNull();
        expect(getEmbeddingSourceDef(null)).toBeNull();
        expect(getEmbeddingSourceDef(undefined)).toBeNull();
    });

    test('local sources have no secretKey', () => {
        expect(getEmbeddingSourceDef('transformers').secretKey).toBeNull();
        expect(getEmbeddingSourceDef('webllm').secretKey).toBeNull();
        expect(getEmbeddingSourceDef('ollama').secretKey).toBeNull();
        expect(getEmbeddingSourceDef('llamacpp').secretKey).toBeNull();
        expect(getEmbeddingSourceDef('vllm').secretKey).toBeNull();
    });

    test('workers_ai is the only required-URL cloud source', () => {
        const def = getEmbeddingSourceDef('workers_ai');
        // workers_ai's URL is constructed from the account-id, so urlOptional is false.
        expect(def.urlOptional).toBe(false);
    });
});

describe('getRerankSourceDef', () => {
    test('returns the def for a known rerank source', () => {
        expect(getRerankSourceDef('cohere')).toMatchObject({
            id: 'cohere',
            secretKey: 'api_key_cohere',
            defaultModel: 'rerank-v3.5',
        });
        expect(getRerankSourceDef('jina')).toMatchObject({ id: 'jina' });
        expect(getRerankSourceDef('custom')).toMatchObject({
            id: 'custom',
            needsUrl: true,
            urlOptional: false,
            secretKey: null,
        });
    });

    test('returns null for unknown rerank source', () => {
        expect(getRerankSourceDef('cohere2')).toBeNull();
        expect(getRerankSourceDef('')).toBeNull();
    });
});

describe('listEmbeddingSourceDefs / listRerankSourceDefs', () => {
    test('embedding list includes the canonical sources', () => {
        const ids = listEmbeddingSourceDefs().map(s => s.id);
        for (const required of ['transformers', 'openai', 'cohere', 'jina', 'ollama', 'webllm', 'workers_ai']) {
            expect(ids).toContain(required);
        }
    });

    test('rerank list contains exactly cohere/jina/custom', () => {
        expect(listRerankSourceDefs().map(s => s.id).sort()).toEqual(['cohere', 'custom', 'jina']);
    });

    test('listed defs are detached from internal table (mutating is safe)', () => {
        const list = listEmbeddingSourceDefs();
        const before = list.length;
        list.push({ id: 'mutant' });
        expect(listEmbeddingSourceDefs().length).toBe(before);
        expect(EMBEDDING_SOURCE_DEFS.find(s => s.id === 'mutant')).toBeUndefined();
    });

    test('rerank list also detached', () => {
        const list = listRerankSourceDefs();
        list.length = 0;
        expect(listRerankSourceDefs().length).toBe(RERANK_SOURCE_DEFS.length);
    });
});

describe('compactProfile — empty-field stripping', () => {
    test('drops empty string optional fields', () => {
        const profile = {
            mode: 'embed', source: 'openai', model: 'm', 'api-url': '',
            'proxy-password': '', 'secret-id': '',
        };
        compactProfile(profile, EMBED_MODE);
        expect(profile).not.toHaveProperty('api-url');
        expect(profile).not.toHaveProperty('proxy-password');
        expect(profile).not.toHaveProperty('secret-id');
        expect(profile).toMatchObject({ source: 'openai', model: 'm' });
    });

    test('drops null/undefined optional fields', () => {
        const profile = {
            mode: 'embed', source: 'openai', model: 'm',
            'api-url': null, 'proxy-password': undefined,
        };
        compactProfile(profile, EMBED_MODE);
        expect(profile).not.toHaveProperty('api-url');
        expect(profile).not.toHaveProperty('proxy-password');
    });

    test('keeps truthy optional fields', () => {
        const profile = {
            mode: 'embed', source: 'openai', model: 'm',
            'api-url': 'https://x', 'proxy-password': 'pw', 'secret-id': 'sec',
        };
        compactProfile(profile, EMBED_MODE);
        expect(profile).toMatchObject({
            'api-url': 'https://x',
            'proxy-password': 'pw',
            'secret-id': 'sec',
        });
    });
});

describe('compactProfile — boolean fields', () => {
    test('jina-late-chunking only kept when string "true"', () => {
        const a = { mode: 'embed', source: 'jina', 'jina-late-chunking': 'true' };
        const b = { mode: 'embed', source: 'jina', 'jina-late-chunking': 'false' };
        const c = { mode: 'embed', source: 'jina', 'jina-late-chunking': '' };
        const d = { mode: 'embed', source: 'jina', 'jina-late-chunking': true };
        compactProfile(a, EMBED_MODE);
        compactProfile(b, EMBED_MODE);
        compactProfile(c, EMBED_MODE);
        compactProfile(d, EMBED_MODE);
        expect(a['jina-late-chunking']).toBe('true');
        expect(b).not.toHaveProperty('jina-late-chunking');
        expect(c).not.toHaveProperty('jina-late-chunking');
        // Boolean true is NOT preserved by compactProfile — only string 'true' is kept.
        expect(d).not.toHaveProperty('jina-late-chunking');
    });

    test('ollama-keep only kept when string "true"', () => {
        const a = { mode: 'embed', source: 'ollama', 'ollama-keep': 'true' };
        const b = { mode: 'embed', source: 'ollama', 'ollama-keep': 'false' };
        compactProfile(a, EMBED_MODE);
        compactProfile(b, EMBED_MODE);
        expect(a['ollama-keep']).toBe('true');
        expect(b).not.toHaveProperty('ollama-keep');
    });
});

describe('compactProfile — cross-source field stripping', () => {
    test('jina knobs deleted when source != jina', () => {
        const profile = {
            mode: 'embed', source: 'openai', model: 'm',
            'jina-late-chunking': 'true',
            'jina-dimensions': '1024',
            'jina-task': 'retrieval.passage',
        };
        compactProfile(profile, EMBED_MODE);
        expect(profile).not.toHaveProperty('jina-late-chunking');
        expect(profile).not.toHaveProperty('jina-dimensions');
        expect(profile).not.toHaveProperty('jina-task');
    });

    test('jina knobs preserved when source = jina', () => {
        const profile = {
            mode: 'embed', source: 'jina', model: 'jina-embeddings-v3',
            'jina-late-chunking': 'true',
            'jina-dimensions': '1024',
            'jina-task': 'retrieval.passage',
        };
        compactProfile(profile, EMBED_MODE);
        expect(profile).toMatchObject({
            'jina-late-chunking': 'true',
            'jina-dimensions': '1024',
            'jina-task': 'retrieval.passage',
        });
    });

    test('ollama-keep deleted when source != ollama', () => {
        const profile = { mode: 'embed', source: 'openai', 'ollama-keep': 'true' };
        compactProfile(profile, EMBED_MODE);
        expect(profile).not.toHaveProperty('ollama-keep');
    });

    test('siliconflow-endpoint deleted when source != siliconflow', () => {
        const profile = { mode: 'embed', source: 'openai', 'siliconflow-endpoint': 'cn' };
        compactProfile(profile, EMBED_MODE);
        expect(profile).not.toHaveProperty('siliconflow-endpoint');
    });

    test('workers-ai-account-id deleted when source != workers_ai', () => {
        const profile = { mode: 'embed', source: 'openai', 'workers-ai-account-id': 'acct' };
        compactProfile(profile, EMBED_MODE);
        expect(profile).not.toHaveProperty('workers-ai-account-id');
    });

    test('vertexai-* deleted when source not in (vertexai, palm)', () => {
        const profile = {
            mode: 'embed', source: 'openai',
            'vertexai-region': 'us-central1',
            'vertexai-auth-mode': 'service-account',
            'vertexai-express-project-id': 'p',
        };
        compactProfile(profile, EMBED_MODE);
        expect(profile).not.toHaveProperty('vertexai-region');
        expect(profile).not.toHaveProperty('vertexai-auth-mode');
        expect(profile).not.toHaveProperty('vertexai-express-project-id');
    });

    test('vertexai-* preserved when source = palm', () => {
        const profile = {
            mode: 'embed', source: 'palm',
            'vertexai-region': 'us-east4',
            'vertexai-auth-mode': 'express',
            'vertexai-express-project-id': 'proj-1',
        };
        compactProfile(profile, EMBED_MODE);
        expect(profile['vertexai-region']).toBe('us-east4');
        expect(profile['vertexai-auth-mode']).toBe('express');
        expect(profile['vertexai-express-project-id']).toBe('proj-1');
    });

    test('vertexai-* preserved when source = vertexai', () => {
        const profile = {
            mode: 'embed', source: 'vertexai',
            'vertexai-region': 'us-east4',
        };
        compactProfile(profile, EMBED_MODE);
        expect(profile['vertexai-region']).toBe('us-east4');
    });
});

describe('compactProfile — unknown source', () => {
    test('unknown source skips cross-source stripping but still drops empties', () => {
        const profile = {
            mode: 'embed', source: 'unknown-xyz', model: '',
            'jina-late-chunking': 'true',
        };
        compactProfile(profile, EMBED_MODE);
        // model dropped (empty), jina-late-chunking preserved (we don't know the source kind)
        expect(profile).not.toHaveProperty('model');
        expect(profile['jina-late-chunking']).toBe('true');
    });
});

describe('compactProfile — rerank mode', () => {
    test('rerank profile keeps cohere fields', () => {
        const profile = {
            mode: 'rerank', source: 'cohere', model: 'rerank-v3.5',
            'api-url': 'https://cohere.proxy', 'proxy-password': 'pw',
        };
        compactProfile(profile, RERANK_MODE);
        expect(profile).toMatchObject({
            source: 'cohere',
            model: 'rerank-v3.5',
            'api-url': 'https://cohere.proxy',
            'proxy-password': 'pw',
        });
    });

    test('rerank profile drops empty fields', () => {
        const profile = {
            mode: 'rerank', source: 'cohere', model: '',
            'api-url': '', 'proxy-password': '', 'secret-id': '',
        };
        compactProfile(profile, RERANK_MODE);
        expect(profile).not.toHaveProperty('model');
        expect(profile).not.toHaveProperty('api-url');
        expect(profile).not.toHaveProperty('proxy-password');
        expect(profile).not.toHaveProperty('secret-id');
    });
});

describe('validateProfileFields — name validation', () => {
    test('rejects missing name', () => {
        const result = validateProfileFields(EMBED_MODE, { source: 'openai' });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/name/i);
    });

    test('rejects whitespace-only name', () => {
        const result = validateProfileFields(EMBED_MODE, { name: '   ', source: 'openai' });
        expect(result.ok).toBe(false);
    });

    test('rejects name already in takenNames', () => {
        const result = validateProfileFields(EMBED_MODE, {
            name: 'My Profile', source: 'openai', model: 'm',
        }, ['Other', 'My Profile']);
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/already exists/i);
    });

    test('trims whitespace before checking takenNames', () => {
        const result = validateProfileFields(EMBED_MODE, {
            name: '  Existing  ', source: 'openai', model: 'm',
        }, ['Existing']);
        expect(result.ok).toBe(false);
    });

    test('null/undefined values bag is rejected gracefully (missing name)', () => {
        expect(validateProfileFields(EMBED_MODE, null).ok).toBe(false);
        expect(validateProfileFields(EMBED_MODE, undefined).ok).toBe(false);
    });
});

describe('validateProfileFields — source validation', () => {
    test('rejects unknown embedding source', () => {
        const result = validateProfileFields(EMBED_MODE, { name: 'P', source: 'nonexistent' });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/Invalid source/);
    });

    test('rejects unknown rerank source', () => {
        const result = validateProfileFields(RERANK_MODE, { name: 'R', source: 'nonexistent' });
        expect(result.ok).toBe(false);
    });

    test('accepts source not present in opposing mode (embed-only source rejected for rerank)', () => {
        const result = validateProfileFields(RERANK_MODE, { name: 'R', source: 'openai' });
        expect(result.ok).toBe(false);
    });
});

describe('validateProfileFields — URL/model/account requirements', () => {
    test('rejects ollama profile without api-url (URL required, not optional)', () => {
        const result = validateProfileFields(EMBED_MODE, {
            name: 'Ollama', source: 'ollama', model: 'm',
        });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/URL is required/);
    });

    test('accepts ollama profile with api-url', () => {
        const result = validateProfileFields(EMBED_MODE, {
            name: 'Ollama', source: 'ollama', model: 'm', 'api-url': 'http://localhost:11434',
        });
        expect(result.ok).toBe(true);
    });

    test('rejects custom rerank without api-url', () => {
        const result = validateProfileFields(RERANK_MODE, {
            name: 'Cust', source: 'custom', model: 'm',
        });
        expect(result.ok).toBe(false);
    });

    test('cloud sources with urlOptional true do NOT require api-url', () => {
        const result = validateProfileFields(EMBED_MODE, {
            name: 'OAI', source: 'openai', model: 'text-embedding-3-small',
        });
        expect(result.ok).toBe(true);
    });

    test('rejects vllm profile without model (needsModel + no defaultModel)', () => {
        const result = validateProfileFields(EMBED_MODE, {
            name: 'VLLM', source: 'vllm', 'api-url': 'http://localhost:8000',
        });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/Model is required/);
    });

    test('accepts profile that relies on defaultModel even when model field empty', () => {
        // OpenAI def has needsModel=true and defaultModel='text-embedding-3-small'.
        const result = validateProfileFields(EMBED_MODE, { name: 'OAI', source: 'openai' });
        expect(result.ok).toBe(true);
    });

    test('rejects workers_ai without account-id', () => {
        const result = validateProfileFields(EMBED_MODE, {
            name: 'WAI', source: 'workers_ai', model: '@cf/baai/bge-m3',
        });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/Cloudflare Account ID/);
    });

    test('accepts workers_ai with account-id', () => {
        const result = validateProfileFields(EMBED_MODE, {
            name: 'WAI', source: 'workers_ai', model: '@cf/baai/bge-m3',
            'workers-ai-account-id': 'acct-1',
        });
        expect(result.ok).toBe(true);
    });
});

describe('validateProfileFields — assembly + compaction', () => {
    test('returns compacted profile (no id) on success', () => {
        const result = validateProfileFields(EMBED_MODE, {
            name: 'My OpenAI',
            source: 'openai',
            model: 'text-embedding-3-large',
            'api-url': 'https://proxy.local',
            'proxy-password': 'pw',
            'secret-id': '',
        });
        expect(result.ok).toBe(true);
        expect(result.profile).not.toHaveProperty('id');
        expect(result.profile).toMatchObject({
            mode: EMBED_MODE,
            name: 'My OpenAI',
            source: 'openai',
            model: 'text-embedding-3-large',
            'api-url': 'https://proxy.local',
            'proxy-password': 'pw',
        });
        // empty 'secret-id' should be stripped
        expect(result.profile).not.toHaveProperty('secret-id');
    });

    test('embed-only fields are NOT copied for rerank mode', () => {
        const result = validateProfileFields(RERANK_MODE, {
            name: 'CR',
            source: 'cohere',
            model: 'rerank-v3.5',
            'api-url': 'https://x',
            'jina-late-chunking': 'true', // should be ignored
            'workers-ai-account-id': 'acct', // should be ignored
        });
        expect(result.ok).toBe(true);
        expect(result.profile).not.toHaveProperty('jina-late-chunking');
        expect(result.profile).not.toHaveProperty('workers-ai-account-id');
    });

    test('jina profile with all knobs survives compaction', () => {
        const result = validateProfileFields(EMBED_MODE, {
            name: 'J',
            source: 'jina',
            model: 'jina-embeddings-v3',
            'jina-late-chunking': 'true',
            'jina-dimensions': '1024',
            'jina-task': 'retrieval.passage',
        });
        expect(result.ok).toBe(true);
        expect(result.profile).toMatchObject({
            'jina-late-chunking': 'true',
            'jina-dimensions': '1024',
            'jina-task': 'retrieval.passage',
        });
    });

    test('cross-source fields are stripped on assembly (e.g. ollama-keep on openai profile)', () => {
        const result = validateProfileFields(EMBED_MODE, {
            name: 'OAI',
            source: 'openai',
            model: 'm',
            'ollama-keep': 'true',
            'siliconflow-endpoint': 'cn',
        });
        expect(result.ok).toBe(true);
        expect(result.profile).not.toHaveProperty('ollama-keep');
        expect(result.profile).not.toHaveProperty('siliconflow-endpoint');
    });

    test('does not mutate input values bag', () => {
        const values = {
            name: 'P',
            source: 'openai',
            model: 'm',
            'api-url': 'https://x',
            'jina-late-chunking': 'true',
            'workers-ai-account-id': 'acct',
        };
        const snapshot = JSON.parse(JSON.stringify(values));
        validateProfileFields(EMBED_MODE, values);
        expect(values).toEqual(snapshot);
    });

    test('takenNames omitted defaults to empty (no false positives)', () => {
        const result = validateProfileFields(EMBED_MODE, { name: 'New', source: 'openai' });
        expect(result.ok).toBe(true);
    });
});
