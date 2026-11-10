// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest } from '@jest/globals';
import { selectChatCompletionDispatch } from '../../../src/endpoints/backends/chat-completions.js';

/**
 * Every chat completion source that reaches a dispatch function. CometAPI is
 * omitted because its dispatch throws unconditionally while the provider is
 * disabled. Vertex AI runs through the reverse-proxy auth branch so the test
 * does not need a service-account fixture.
 */
const SOURCES = [
    'ai21',
    'aimlapi',
    'azure_openai',
    'chutes',
    'claude',
    'cohere',
    'deepseek',
    'electronhub',
    'makersuite',
    'minimax',
    'mistralai',
    'openai',
    'openrouter',
    'custom',
    'openai_responses',
    'perplexity',
    'groq',
    'fireworks',
    'nanogpt',
    'pollinations',
    'moonshot',
    'vertexai',
    'zai',
    'siliconflow',
    'workers_ai',
    'xai',
];

function buildBody(source) {
    /** @type {any} */
    const body = {
        chat_completion_source: source,
        model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        max_tokens: 128,
        temperature: 0.7,
        top_p: 1,
        custom_include_body: 'custom_probe: applied\n',
        custom_exclude_body: '',
        custom_include_headers: 'X-Additional-Parameter: applied\n',
    };

    if (source === 'custom') {
        body.custom_url = 'http://localhost:5001/v1';
    }
    if (source === 'azure_openai') {
        body.azure_base_url = 'https://azure.example.com';
        body.azure_deployment_name = 'deployment';
        body.azure_api_version = '2024-10-21';
    }
    if (source === 'vertexai') {
        body.reverse_proxy = 'https://vertex-proxy.example.com';
        body.proxy_password = 'proxy-key';
    }
    if (source === 'workers_ai') {
        body.workers_ai_account_id = 'account-id';
    }

    return body;
}

function fakeCtx(source) {
    const submitted = [];
    const ac = new AbortController();
    const body = buildBody(source);

    // Superset of the response shapes the dispatchers normalize. Only the
    // outbound request matters for these assertions; the shapes keep the
    // response tail from throwing before the fetch call is recorded.
    const responsePayload = {
        id: 'test-1',
        object: 'chat.completion',
        model: 'test-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        message: { content: [{ type: 'text', text: 'ok' }] },
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
        generations: [{ text: 'ok', finish_reason: 'COMPLETE' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    };

    return {
        body,
        user: { handle: 'alice', directories: {}, profile: { handle: 'alice' } },
        signal: ac.signal,
        fetch: jest.fn(async (url, init) => {
            submitted.push({ url: String(url), init });
            return new Response(JSON.stringify(responsePayload), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }),
        secrets: { read: jest.fn(() => 'test-key') },
        generation: {
            startJob: jest.fn(() => null),
            appendEvent: jest.fn(),
            hasActiveKeepAliveJob: jest.fn(() => false),
        },
        inspection: {
            start: jest.fn(),
            attach: jest.fn(),
            complete: jest.fn(),
            fail: jest.fn(),
        },
        emit: {
            head: jest.fn(),
            chunk: jest.fn(),
            end: jest.fn(),
            error: jest.fn(),
        },
        _submitted: submitted,
    };
}

describe.each(SOURCES)('additional parameters: %s', (source) => {
    test('merges include body and headers into the outbound request', async () => {
        const ctx = fakeCtx(source);
        await selectChatCompletionDispatch(ctx.body)(ctx);

        expect(ctx._submitted.length).toBeGreaterThan(0);
        const { init } = ctx._submitted[0];
        expect(init.headers['X-Additional-Parameter']).toBe('applied');
        const requestBody = JSON.parse(init.body);
        expect(requestBody.custom_probe).toBe('applied');
    });

    test('custom_exclude_body removes the selected top-level key', async () => {
        const ctx = fakeCtx(source);
        // Gemini's wire body has no top-level stream flag; exclude the safety
        // list instead so the assertion exercises a key that really exists.
        const excludedKey = source === 'makersuite' || source === 'vertexai' ? 'safetySettings' : 'stream';
        ctx.body.custom_exclude_body = `${excludedKey}\n`;

        await selectChatCompletionDispatch(ctx.body)(ctx);

        const { init } = ctx._submitted[0];
        const requestBody = JSON.parse(init.body);
        expect(Object.hasOwn(requestBody, excludedKey)).toBe(false);
    });
});
