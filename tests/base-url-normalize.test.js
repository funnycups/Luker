import { normalizeProviderBaseUrl } from '../src/util/base-url.js';

describe('normalizeProviderBaseUrl', () => {
    test.each([
        // OpenAI-compatible chat. The legacy rule appends /v1 to a bare host
        // and to a proxy path without a version segment.
        ['openai', 'https://api.openai.com', 'https://api.openai.com/v1'],
        ['openai', 'https://api.openai.com/', 'https://api.openai.com/v1'],
        ['openai', 'https://api.openai.com/v1', 'https://api.openai.com/v1'],
        ['openai', 'https://api.openai.com/v1/chat/completions', 'https://api.openai.com/v1'],
        ['openai', 'https://api.openai.com/v1/responses', 'https://api.openai.com/v1'],
        ['openai', 'https://proxy.example.com/openai', 'https://proxy.example.com/openai/v1'],
        ['custom', 'https://proxy.example.com/v1/chat/completions', 'https://proxy.example.com/v1'],
        ['openai_responses', 'https://api.openai.com/v1/responses', 'https://api.openai.com/v1'],

        // Anthropic.
        ['claude', 'https://api.anthropic.com', 'https://api.anthropic.com/v1'],
        ['claude', 'https://api.anthropic.com/v1/messages', 'https://api.anthropic.com/v1'],

        // Mistral.
        ['mistral', 'https://api.mistral.ai', 'https://api.mistral.ai/v1'],
        ['mistral', 'https://api.mistral.ai/v1/chat/completions', 'https://api.mistral.ai/v1'],

        // DeepSeek documents the host as the base; /v1 is left as an alias.
        ['deepseek', 'https://api.deepseek.com', 'https://api.deepseek.com'],
        ['deepseek', 'https://api.deepseek.com/chat/completions', 'https://api.deepseek.com'],
        ['deepseek', 'https://api.deepseek.com/v1', 'https://api.deepseek.com/v1'],

        // xAI and Moonshot.
        ['xai', 'https://api.x.ai', 'https://api.x.ai/v1'],
        ['moonshot', 'https://api.moonshot.ai', 'https://api.moonshot.ai/v1'],

        // Z.AI.
        ['zai', 'https://api.z.ai', 'https://api.z.ai/api/paas/v4'],
        ['zai', 'https://api.z.ai/api/paas/v4/chat/completions', 'https://api.z.ai/api/paas/v4'],
        ['zai', 'https://api.z.ai/api/coding/paas/v4', 'https://api.z.ai/api/coding/paas/v4'],

        // Gemini API.
        ['makersuite', 'https://generativelanguage.googleapis.com', 'https://generativelanguage.googleapis.com'],
        ['makersuite', 'https://generativelanguage.googleapis.com/v1beta', 'https://generativelanguage.googleapis.com'],
        ['makersuite', 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent', 'https://generativelanguage.googleapis.com'],
        ['palm', 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents', 'https://generativelanguage.googleapis.com'],

        // Vertex AI.
        ['vertexai', 'https://us-central1-aiplatform.googleapis.com', 'https://us-central1-aiplatform.googleapis.com'],
        ['vertexai', 'https://us-central1-aiplatform.googleapis.com/v1', 'https://us-central1-aiplatform.googleapis.com'],
        ['vertexai', 'https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google/models/gemini-embedding-001:predict', 'https://us-central1-aiplatform.googleapis.com'],

        // Azure keeps the deployment path and the api-version query.
        ['azure', 'https://resource.openai.azure.com', 'https://resource.openai.azure.com'],
        ['azure', 'https://resource.openai.azure.com/openai/deployments/d/chat/completions?api-version=2024-06-01', 'https://resource.openai.azure.com/openai/deployments/d?api-version=2024-06-01'],

        // Cohere.
        ['cohere', 'https://api.cohere.com', 'https://api.cohere.com/v2'],
        ['cohere', 'https://api.cohere.com/v2/embed', 'https://api.cohere.com/v2'],
        ['cohere', 'https://api.cohere.com/v2/rerank', 'https://api.cohere.com/v2'],
        ['cohere', 'https://api.cohere.com/v2/chat', 'https://api.cohere.com/v2'],

        // Jina.
        ['jina', 'https://api.jina.ai', 'https://api.jina.ai/v1'],
        ['jina', 'https://api.jina.ai/v1/embeddings', 'https://api.jina.ai/v1'],
        ['jina', 'https://api.jina.ai/v1/rerank', 'https://api.jina.ai/v1'],

        // OpenRouter.
        ['openrouter', 'https://openrouter.ai', 'https://openrouter.ai/api/v1'],
        ['openrouter', 'https://openrouter.ai/api/v1/embeddings', 'https://openrouter.ai/api/v1'],

        // SiliconFlow.
        ['siliconflow', 'https://api.siliconflow.com', 'https://api.siliconflow.com/v1'],
        ['siliconflow', 'https://api.siliconflow.cn/v1/embeddings', 'https://api.siliconflow.cn/v1'],

        // Together, ElectronHub, Chutes.
        ['togetherai', 'https://api.together.ai', 'https://api.together.ai/v1'],
        ['electronhub', 'https://api.electronhub.ai', 'https://api.electronhub.ai/v1'],
        ['chutes', 'https://llm.chutes.ai', 'https://llm.chutes.ai/v1'],

        // NanoGPT documents both /api and /api/v1 as bases.
        ['nanogpt', 'https://api.nano-gpt.com/api', 'https://api.nano-gpt.com/api/v1'],
        ['nanogpt', 'https://nano-gpt.com/api/v1', 'https://nano-gpt.com/api/v1'],

        // Cloudflare Workers AI keeps the account path.
        ['workers_ai', 'https://api.cloudflare.com/client/v4/accounts/abc/ai/v1/embeddings', 'https://api.cloudflare.com/client/v4/accounts/abc/ai/v1'],

        // Local servers.
        ['ollama', 'http://localhost:11434', 'http://localhost:11434'],
        ['ollama', 'http://localhost:11434/api/embed', 'http://localhost:11434'],
        ['llamacpp', 'http://localhost:8080', 'http://localhost:8080'],
        ['llamacpp', 'http://localhost:8080/v1', 'http://localhost:8080'],
        ['llamacpp', 'http://localhost:8080/v1/embeddings', 'http://localhost:8080'],
        ['vllm', 'http://localhost:8000/v1/embeddings', 'http://localhost:8000'],
        ['extras', 'http://localhost:5100', 'http://localhost:5100'],
        ['extras', 'http://localhost:5100/api/embeddings/compute', 'http://localhost:5100'],

        // Custom rerank strips the documented /rerank suffix and keeps the
        // user-supplied path.
        ['custom_rerank', 'https://proxy.example.com', 'https://proxy.example.com'],
        ['custom_rerank', 'https://proxy.example.com/v1/rerank', 'https://proxy.example.com/v1'],

        // Sources without a documented rule are returned unchanged.
        ['nomicai', 'https://api-atlas.nomic.ai/v1/embedding/text', 'https://api-atlas.nomic.ai/v1/embedding/text'],

        // Invalid input is returned unchanged so the request surfaces the error.
        ['openai', 'not a url', 'not a url'],
        ['openai', '', ''],
    ])('%s: %s -> %s', (source, input, expected) => {
        expect(normalizeProviderBaseUrl(source, input)).toBe(expected);
    });
});
