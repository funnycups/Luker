// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest } from '@jest/globals';
import { buildResponsesRequestBody, dispatchOpenAIResponses } from '../../../src/luker-dispatch/providers/chat-completions/openai-responses.js';
import { CHAT_COMPLETION_SOURCES } from '../../../src/constants.js';

function fakeCtx({ body = {}, onFetch, secretMap = {} } = {}) {
    const emitted = [];
    const attachCalls = [];
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
        inspection: {
            start: jest.fn(),
            attach: jest.fn((...args) => attachCalls.push(args)),
            fail: jest.fn(),
        },
        emit: {
            head: (h) => emitted.push({ kind: 'head', data: h }),
            chunk: (b) => emitted.push({ kind: 'chunk', data: b }),
            end: () => emitted.push({ kind: 'end' }),
            error: (e) => emitted.push({ kind: 'error', error: e }),
        },
        _emitted: emitted,
        _attachCalls: attachCalls,
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

    test('reasoning effort maps minimal on base gpt-5; include_reasoning requests summary auto; max_tokens -> max_output_tokens', () => {
        const requestBody = buildResponsesRequestBody({
            model: 'gpt-5',
            reasoning_effort: 'minimal',
            include_reasoning: true,
            max_tokens: 300,
        });
        expect(requestBody.reasoning).toEqual({ effort: 'minimal', summary: 'auto' });
        expect(requestBody.max_output_tokens).toBe(300);
        expect(requestBody.max_tokens).toBeUndefined();
    });

    test('canonical max maps to max on the responses API and off maps to none', () => {
        const max = buildResponsesRequestBody({ model: 'gpt-5.6', reasoning_effort: 'max' });
        expect(max.reasoning).toEqual({ effort: 'max' });

        const off = buildResponsesRequestBody({ model: 'gpt-5.6', reasoning_effort: 'off' });
        expect(off.reasoning).toEqual({ effort: 'none' });
    });

    test('off with include_reasoning does not request a summary', () => {
        const requestBody = buildResponsesRequestBody({
            model: 'gpt-5.6',
            reasoning_effort: 'off',
            include_reasoning: true,
        });
        expect(requestBody.reasoning).toEqual({ effort: 'none' });
    });

    test('tool_choice function object unwraps to flat shape', () => {
        const requestBody = buildResponsesRequestBody({
            model: 'gpt-5.5',
            tools: [{ type: 'function', function: { name: 'f' } }],
            tool_choice: { type: 'function', function: { name: 'f' } },
        });
        expect(requestBody.tool_choice).toEqual({ type: 'function', name: 'f' });
    });

    test('forwards json_schema into text.format and preserves tool.function.strict', () => {
        const requestBody = buildResponsesRequestBody({
            model: 'gpt-5.5',
            json_schema: {
                name: 'result_obj',
                description: 'Structured result',
                strict: true,
                value: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
            },
            tools: [
                { type: 'function', function: { name: 'loose_fn', strict: false, parameters: { type: 'object' } } },
                { type: 'function', function: { name: 'strict_fn', strict: true, parameters: { type: 'object' } } },
            ],
        });
        expect(requestBody.text).toEqual({
            format: {
                type: 'json_schema',
                name: 'result_obj',
                description: 'Structured result',
                strict: true,
                schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
            },
        });
        expect(requestBody.tools[0].strict).toBe(false);
        expect(requestBody.tools[1].strict).toBe(true);
    });

    test('suppresses temperature and top_p on Responses reasoning models unless effort is none on gpt-5.1-5.4', () => {
        const reasoningReq = buildResponsesRequestBody({
            model: 'o4-mini',
            temperature: 0.7,
            top_p: 0.9,
            messages: [{ role: 'user', content: 'hi' }],
        });
        expect(reasoningReq.temperature).toBeUndefined();
        expect(reasoningReq.top_p).toBeUndefined();

        const gpt54Off = buildResponsesRequestBody({
            model: 'gpt-5.4',
            reasoning_effort: 'off',
            temperature: 0.7,
            top_p: 0.9,
            messages: [{ role: 'user', content: 'hi' }],
        });
        expect(gpt54Off.temperature).toBe(0.7);
        expect(gpt54Off.top_p).toBe(0.9);
    });

    test('replays responses_output_items verbatim in original order including encrypted reasoning items', () => {
        const outputItems = [
            { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc_payload', summary: [{ type: 'summary_text', text: 'plan' }] },
            { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'Running lookup' }] },
            { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' },
        ];
        const requestBody = buildResponsesRequestBody({
            model: 'gpt-5.5',
            messages: [
                { role: 'user', content: 'hi' },
                {
                    role: 'assistant',
                    content: 'Running lookup',
                    responses_output_items: outputItems,
                    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
                },
                { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
            ],
        });
        expect(requestBody.input).toEqual([
            { role: 'user', content: 'hi' },
            ...outputItems,
            { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' },
        ]);
    });

    test('gates reasoning against known non-reasoning models while allowing unknown custom models', () => {
        for (const model of ['gpt-4o', 'gpt-4.1', 'gpt-5-chat-latest']) {
            const req = buildResponsesRequestBody({
                model,
                reasoning_effort: 'high',
                include_reasoning: true,
            });
            expect(req.reasoning).toBeUndefined();
            expect(req.include).toBeUndefined();
        }

        const customReq = buildResponsesRequestBody({
            model: 'my-custom-reasoning-model',
            reasoning_effort: 'high',
            include_reasoning: true,
        });
        expect(customReq.reasoning).toEqual({ effort: 'high', summary: 'auto' });
        expect(customReq.include).toEqual(['reasoning.encrypted_content']);
    });

    test('attaches include reasoning.encrypted_content when reasoning is active with store:false, and omits when effort is off', () => {
        const activeReq = buildResponsesRequestBody({
            model: 'gpt-5.5',
            reasoning_effort: 'medium',
        });
        expect(activeReq.store).toBe(false);
        expect(activeReq.include).toEqual(['reasoning.encrypted_content']);

        const offReq = buildResponsesRequestBody({
            model: 'gpt-5.6',
            reasoning_effort: 'off',
            include_reasoning: true,
        });
        expect(offReq.reasoning).toEqual({ effort: 'none' });
        expect(offReq.include).toBeUndefined();
    });

    test('attaches include reasoning.encrypted_content on known reasoning models with default auto effort and include_reasoning:false', () => {
        for (const model of ['gpt-5.5', 'o4-mini', 'gpt-6-astra']) {
            const req = buildResponsesRequestBody({
                model,
                reasoning_effort: 'auto',
                include_reasoning: false,
            });
            expect(req.store).toBe(false);
            expect(req.reasoning).toBeUndefined();
            expect(req.include).toEqual(['reasoning.encrypted_content']);
        }

        // Unknown custom models without explicit reasoning settings do not guess include.
        const customAuto = buildResponsesRequestBody({
            model: 'my-custom-model',
            reasoning_effort: 'auto',
            include_reasoning: false,
        });
        expect(customAuto.include).toBeUndefined();
    });

    test('forwards verbosity to text.verbosity on supported models without clobbering json_schema', () => {
        const req = buildResponsesRequestBody({
            model: 'gpt-5.5',
            verbosity: 'low',
            json_schema: { name: 'r', value: { type: 'object' } },
        });
        expect(req.text.verbosity).toBe('low');
        expect(req.text.format.type).toBe('json_schema');

        const unsupported = buildResponsesRequestBody({
            model: 'gpt-4o',
            verbosity: 'low',
        });
        expect(unsupported.text).toBeUndefined();
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

    test('inspector fingerprint reflects Authorization overridden by custom_include_headers', async () => {
        const ctx = fakeCtx({
            body: {
                responses_url: 'http://127.0.0.1:9/v1',
                custom_include_headers: 'Authorization: Bearer plugin-proxy-key\n',
            },
            secretMap: { api_key_openai_responses: 'rk' },
        });
        await dispatchOpenAIResponses(ctx);

        const [, init] = ctx.fetch.mock.calls[0];
        expect(init.headers['Authorization']).toBe('Bearer plugin-proxy-key');

        expect(ctx._attachCalls).toHaveLength(1);
        const [, attachedKey] = ctx._attachCalls[0];
        expect(attachedKey).toBe('plugin-proxy-key');
    });

    test('suppresses reasoning.encrypted_content when custom_include_body sets store:true or reasoning.effort:none, and honors custom_exclude_body', async () => {
        const storeTrueCtx = fakeCtx({
            body: {
                model: 'gpt-5.5',
                responses_url: 'http://127.0.0.1:9/v1',
                reasoning_effort: 'medium',
                custom_include_body: 'store: true\n',
            },
            secretMap: { api_key_openai_responses: 'rk' },
        });
        await dispatchOpenAIResponses(storeTrueCtx);
        const storeTrueSent = JSON.parse(storeTrueCtx.fetch.mock.calls[0][1].body);
        expect(storeTrueSent.store).toBe(true);
        expect(storeTrueSent.include).toBeUndefined();

        const effortNoneCtx = fakeCtx({
            body: {
                model: 'gpt-5.5',
                responses_url: 'http://127.0.0.1:9/v1',
                custom_include_body: 'reasoning:\n  effort: none\n',
            },
            secretMap: { api_key_openai_responses: 'rk' },
        });
        await dispatchOpenAIResponses(effortNoneCtx);
        const effortNoneSent = JSON.parse(effortNoneCtx.fetch.mock.calls[0][1].body);
        expect(effortNoneSent.include).toBeUndefined();

        const excludeIncludeCtx = fakeCtx({
            body: {
                model: 'gpt-5.5',
                responses_url: 'http://127.0.0.1:9/v1',
                custom_exclude_body: 'include',
            },
            secretMap: { api_key_openai_responses: 'rk' },
        });
        await dispatchOpenAIResponses(excludeIncludeCtx);
        const excludeIncludeSent = JSON.parse(excludeIncludeCtx.fetch.mock.calls[0][1].body);
        expect(excludeIncludeSent.include).toBeUndefined();

        const mergeIncludeCtx = fakeCtx({
            body: {
                model: 'gpt-5.5',
                responses_url: 'http://127.0.0.1:9/v1',
                custom_include_body: 'include:\n  - web_search_call.action.sources\n',
            },
            secretMap: { api_key_openai_responses: 'rk' },
        });
        await dispatchOpenAIResponses(mergeIncludeCtx);
        const mergeIncludeSent = JSON.parse(mergeIncludeCtx.fetch.mock.calls[0][1].body);
        expect(mergeIncludeSent.include).toEqual([
            'web_search_call.action.sources',
            'reasoning.encrypted_content',
        ]);
    });
});
