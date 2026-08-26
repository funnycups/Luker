// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest } from '@jest/globals';
import { buildResponsesRequestBody, dispatchOpenAIResponses } from '../../../src/luker-dispatch/providers/chat-completions/openai-responses.js';
import { CHAT_COMPLETION_SOURCES } from '../../../src/constants.js';

function fakeCtx({ body = {}, onFetch, secretMap = {} } = {}) {
    const emitted = [];
    return {
        body: {
            model: 'gpt-5.5',
            messages: [{ role: 'user', content: 'hi' }],
            stream: false,
            max_tokens: 128,
            temperature: 0.7,
            chat_completion_source: CHAT_COMPLETION_SOURCES.OPENAI_RESPONSES,
            ...body,
        },
        signal: new AbortController().signal,
        fetch: onFetch || jest.fn(async () => new Response(JSON.stringify({
            id: 'resp_1',
            object: 'response',
            status: 'completed',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello back' }] }],
            usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
        }), { status: 200, headers: { 'content-type': 'application/json' } })),
        secrets: { read: jest.fn((key) => secretMap[key] ?? '') },
        inspection: { start: jest.fn(), attach: jest.fn(), fail: jest.fn() },
        emit: {
            head: (h) => emitted.push({ kind: 'head', data: h }),
            chunk: (b) => emitted.push({ kind: 'chunk', data: b }),
            end: () => emitted.push({ kind: 'end' }),
            error: (e) => emitted.push({ kind: 'error', error: e }),
        },
        _emitted: emitted,
    };
}

describe('buildResponsesRequestBody', () => {
    test('system messages fold into instructions, user message becomes input item', () => {
        const requestBody = buildResponsesRequestBody({
            model: 'gpt-5.5',
            messages: [
                { role: 'system', content: 'be nice' },
                { role: 'user', content: 'hi' },
            ],
        });
        expect(requestBody.instructions).toBe('be nice');
        expect(requestBody.input).toEqual([{ role: 'user', content: 'hi' }]);
        expect(requestBody.model).toBe('gpt-5.5');
        expect(requestBody.store).toBe(false);
    });

    test('image_url content parts map to input_image', () => {
        const requestBody = buildResponsesRequestBody({
            model: 'gpt-5.5',
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: 'look' },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
                ],
            }],
        });
        expect(requestBody.input[0].content).toEqual([
            { type: 'input_text', text: 'look' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
        ]);
    });

    test('assistant tool_calls become function_call items and tool results become function_call_output items', () => {
        const requestBody = buildResponsesRequestBody({
            model: 'gpt-5.5',
            messages: [
                { role: 'user', content: 'weather?' },
                { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
                { role: 'tool', tool_call_id: 'call_1', content: '{"temp":20}' },
            ],
        });
        expect(requestBody.input[1]).toEqual({ type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' });
        expect(requestBody.input[2]).toEqual({ type: 'function_call_output', call_id: 'call_1', output: '{"temp":20}' });
    });

    test('OpenAI-shaped tools flatten; web search appends builtin tool', () => {
        const requestBody = buildResponsesRequestBody({
            model: 'gpt-5.5',
            enable_web_search: true,
            tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } }],
        });
        expect(requestBody.tools).toEqual([
            { type: 'function', name: 'f', description: 'd', parameters: { type: 'object' } },
            { type: 'web_search' },
        ]);
    });

    test('reasoning effort maps min->minimal; include_reasoning requests summary auto; max_tokens -> max_output_tokens', () => {
        const requestBody = buildResponsesRequestBody({
            model: 'gpt-5.5',
            reasoning_effort: 'min',
            include_reasoning: true,
            max_tokens: 300,
        });
        expect(requestBody.reasoning).toEqual({ effort: 'minimal', summary: 'auto' });
        expect(requestBody.max_output_tokens).toBe(300);
        expect(requestBody.max_tokens).toBeUndefined();
    });

    test('tool_choice function object unwraps to flat shape', () => {
        const requestBody = buildResponsesRequestBody({
            model: 'gpt-5.5',
            tools: [{ type: 'function', function: { name: 'f' } }],
            tool_choice: { type: 'function', function: { name: 'f' } },
        });
        expect(requestBody.tool_choice).toEqual({ type: 'function', name: 'f' });
    });
});

describe('dispatchOpenAIResponses', () => {
    test('POSTs to <base>/responses with Bearer auth and passes body through', async () => {
        const ctx = fakeCtx({ body: { responses_url: 'http://127.0.0.1:9/v1' }, secretMap: { api_key_openai_responses: 'rk' } });
        await dispatchOpenAIResponses(ctx);

        expect(ctx.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = ctx.fetch.mock.calls[0];
        expect(String(url)).toBe('http://127.0.0.1:9/v1/responses');
        expect(init.headers['Authorization']).toBe('Bearer rk');
        const sent = JSON.parse(init.body);
        expect(sent.input).toEqual([{ role: 'user', content: 'hi' }]);
        expect(ctx._emitted.some((e) => e.kind === 'head')).toBe(true);
        expect(ctx._emitted.some((e) => e.kind === 'end')).toBe(true);
    });

    test('default base URL is api.openai.com/v1 when responses_url is empty', async () => {
        const ctx = fakeCtx({ secretMap: { api_key_openai_responses: 'rk' } });
        await dispatchOpenAIResponses(ctx);
        const [url] = ctx.fetch.mock.calls[0];
        expect(String(url)).toBe('https://api.openai.com/v1/responses');
    });

    test('missing API key emits error event', async () => {
        const ctx = fakeCtx({});
        await dispatchOpenAIResponses(ctx);
        const errs = ctx._emitted.filter((e) => e.kind === 'error');
        expect(errs.length).toBeGreaterThan(0);
        expect(errs[0].error.message).toContain('API key');
    });

    test('custom_include_body YAML merges into request body; custom_exclude_body removes keys', async () => {
        const ctx = fakeCtx({
            body: {
                responses_url: 'http://127.0.0.1:9/v1',
                custom_include_body: 'reasoning:\n  effort: high\n',
                custom_exclude_body: 'store',
            },
            secretMap: { api_key_openai_responses: 'rk' },
        });
        await dispatchOpenAIResponses(ctx);
        const sent = JSON.parse(ctx.fetch.mock.calls[0][1].body);
        expect(sent.reasoning).toEqual({ effort: 'high' });
        expect('store' in sent).toBe(false);
    });
});
