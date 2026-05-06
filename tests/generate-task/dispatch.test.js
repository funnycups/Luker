import { describe, expect, test } from '@jest/globals';
import { dispatchToSender, normalizeResponse } from '../../public/scripts/generate-task.js';

describe('dispatchToSender — openai', () => {
    test('calls sendOpenAIRequest with type=quiet, requestScope=extension_internal, and forwarded options', async () => {
        let captured = null;
        const senders = {
            sendOpenAIRequest: async (type, messages, signal, opts) => {
                captured = { type, messages, signal, opts };
                return { id: 'fake-openai' };
            },
        };
        const out = await dispatchToSender({
            requestApi: 'openai',
            payload: [{ role: 'user', content: 'hi' }],
            tools: [{ type: 'function', function: { name: 'f' } }],
            toolChoice: 'auto',
            jsonSchema: null,
            llmPresetName: 'MyPreset',
            apiSettingsOverride: { reverse_proxy: 'http://x' },
            functionCallMode: 'native',
            abortSignal: undefined,
        }, { senders });

        expect(captured.type).toBe('quiet');
        expect(captured.messages).toEqual([{ role: 'user', content: 'hi' }]);
        expect(captured.opts.requestScope).toBe('extension_internal');
        expect(captured.opts.tools).toEqual([{ type: 'function', function: { name: 'f' } }]);
        expect(captured.opts.toolChoice).toBe('auto');
        expect(captured.opts.replaceTools).toBe(true);
        expect(captured.opts.llmPresetName).toBe('MyPreset');
        expect(captured.opts.apiSettingsOverride).toEqual({ reverse_proxy: 'http://x' });
        expect(captured.opts.functionCallMode).toBe('native');
        expect(out).toEqual({ id: 'fake-openai' });
    });

    test('replaceTools=false when tools is null/empty', async () => {
        let captured = null;
        const senders = {
            sendOpenAIRequest: async (type, messages, signal, opts) => { captured = opts; return {}; },
        };
        await dispatchToSender({ requestApi: 'openai', payload: [] }, { senders });
        expect(captured.replaceTools).toBe(false);
        expect(captured.tools).toBeNull();
    });
});

describe('dispatchToSender — koboldhorde', () => {
    test('calls generateHorde with text payload', async () => {
        let captured = null;
        const senders = {
            generateHorde: async (prompt, params, signal) => {
                captured = { prompt, params, signal };
                return { results: [{ text: 'horde reply' }] };
            },
            getKoboldGenerationData: () => ({ stub: true }),
            getKoboldRuntime: () => ({
                kai_settings: { preset_settings: 'Default' },
                koboldai_settings: { 'Default': { temp: 1 } },
                koboldai_setting_names: { 'Default': 'Default' },
                amount_gen: 200,
                max_context: 4096,
            }),
        };
        const out = await dispatchToSender({
            requestApi: 'koboldhorde',
            payload: 'folded text prompt',
            abortSignal: undefined,
        }, { senders });
        expect(captured.prompt).toBe('folded text prompt');
        expect(out.results[0].text).toBe('horde reply');
    });
});

describe('dispatchToSender — kobold (non-horde)', () => {
    test('POSTs to getGenerateUrl(api) with kobold body', async () => {
        let captured = null;
        const senders = {
            getKoboldGenerationData: (prompt, settings, max, ctx, isHorde, type) => ({ prompt, isHorde, type }),
            getGenerateUrl: (api) => `http://test/${api}`,
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            fetchImpl: async (url, init) => {
                captured = { url, init };
                return { ok: true, json: async () => ({ choices: [{ text: 'kobold reply' }] }) };
            },
            getKoboldRuntime: () => ({
                kai_settings: { preset_settings: 'Default' },
                koboldai_settings: { 'Default': { temp: 1 } },
                koboldai_setting_names: { 'Default': 'Default' },
                amount_gen: 200,
                max_context: 4096,
            }),
        };
        const out = await dispatchToSender({
            requestApi: 'kobold',
            payload: 'folded text',
        }, { senders });
        expect(captured.url).toBe('http://test/kobold');
        expect(captured.init.method).toBe('POST');
        expect(captured.init.headers).toEqual({ 'Content-Type': 'application/json' });
        expect(out.choices[0].text).toBe('kobold reply');
    });

    test('non-ok HTTP response throws GenerateTaskError network', async () => {
        const senders = {
            getKoboldGenerationData: () => ({}),
            getGenerateUrl: () => 'http://test',
            getRequestHeaders: () => ({}),
            fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }),
            getKoboldRuntime: () => ({ kai_settings: { preset_settings: 'Default' }, koboldai_settings: { Default: {} }, koboldai_setting_names: { Default: 'Default' }, amount_gen: 100, max_context: 2000 }),
        };
        await expect(dispatchToSender({ requestApi: 'kobold', payload: 'x' }, { senders }))
            .rejects.toMatchObject({ name: 'GenerateTaskError', code: 'network' });
    });
});

describe('dispatchToSender — invalid', () => {
    test('unsupported_api when requestApi unknown', async () => {
        await expect(dispatchToSender({ requestApi: 'weird', payload: '' }, { senders: {} }))
            .rejects.toMatchObject({ name: 'GenerateTaskError', code: 'unsupported_api' });
    });

    test('throws unknown when senders option missing required openai sender', async () => {
        await expect(dispatchToSender({ requestApi: 'openai', payload: [] }, { senders: {} }))
            .rejects.toMatchObject({ name: 'GenerateTaskError' });
    });
});

describe('normalizeResponse — openai', () => {
    test('text mode extracts assistantText + finishReason + usage', () => {
        const raw = {
            choices: [{
                message: { role: 'assistant', content: 'Hello!' },
                finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        };
        const r = normalizeResponse({ requestApi: 'openai', mode: 'text', raw });
        expect(r.assistantText).toBe('Hello!');
        expect(r.finishReason).toBe('stop');
        expect(r.usage).toEqual({ promptTokens: 10, completionTokens: 3, totalTokens: 13 });
        expect(r.toolCalls).toEqual([]);
        expect(r.jsonData).toBeNull();
        expect(r.raw).toBe(raw);
    });

    test('tool mode parses tool_calls.arguments JSON into args object', () => {
        const raw = {
            choices: [{
                message: {
                    role: 'assistant',
                    content: '',
                    tool_calls: [
                        { id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":"hello"}' } },
                    ],
                },
                finish_reason: 'tool_calls',
            }],
        };
        const r = normalizeResponse({ requestApi: 'openai', mode: 'tool', raw });
        expect(r.toolCalls).toHaveLength(1);
        expect(r.toolCalls[0].name).toBe('lookup');
        expect(r.toolCalls[0].args).toEqual({ q: 'hello' });
        expect(r.toolCalls[0].raw.id).toBe('c1');
        expect(r.finishReason).toBe('tool_calls');
    });

    test('tool mode with malformed arguments throws tool_call_parse', () => {
        const raw = {
            choices: [{
                message: {
                    role: 'assistant',
                    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: 'not-json' } }],
                },
            }],
        };
        expect(() => normalizeResponse({ requestApi: 'openai', mode: 'tool', raw }))
            .toThrow(expect.objectContaining({ name: 'GenerateTaskError', code: 'tool_call_parse' }));
    });

    test('json mode parses jsonData', () => {
        const raw = '{"answer":42}';
        const r = normalizeResponse({ requestApi: 'openai', mode: 'json', raw });
        expect(r.jsonData).toEqual({ answer: 42 });
    });

    test('json mode accepts openai chat-completion shape (real sender output)', () => {
        const raw = {
            choices: [{ message: { content: '{"answer":42,"reason":"because"}' } }],
        };
        const r = normalizeResponse({ requestApi: 'openai', mode: 'json', raw });
        expect(r.jsonData).toEqual({ answer: 42, reason: 'because' });
    });

    test('json mode with chat-completion shape but non-string content throws', () => {
        const raw = { choices: [{ message: { content: 42 } }] };
        expect(() => normalizeResponse({ requestApi: 'openai', mode: 'json', raw }))
            .toThrow(expect.objectContaining({ name: 'GenerateTaskError', code: 'json_schema_violation' }));
    });

    test('json mode with empty choices throws', () => {
        const raw = { choices: [] };
        expect(() => normalizeResponse({ requestApi: 'openai', mode: 'json', raw }))
            .toThrow(expect.objectContaining({ name: 'GenerateTaskError', code: 'json_schema_violation' }));
    });

    test('json mode with invalid JSON throws json_schema_violation', () => {
        expect(() => normalizeResponse({ requestApi: 'openai', mode: 'json', raw: '{not-json' }))
            .toThrow(expect.objectContaining({ name: 'GenerateTaskError', code: 'json_schema_violation' }));
    });

    test('json mode extracts usage and finishReason from chat-completion shape', () => {
        const raw = {
            choices: [{
                message: { content: '{"x":1}' },
                finish_reason: 'length',
            }],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        };
        const r = normalizeResponse({ requestApi: 'openai', mode: 'json', raw });
        expect(r.jsonData).toEqual({ x: 1 });
        expect(r.finishReason).toBe('length');
        expect(r.usage).toEqual({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
    });

    test('reasoning_content extracted from openai message', () => {
        const raw = {
            choices: [{
                message: { role: 'assistant', content: 'final answer', reasoning_content: 'step-by-step thinking' },
                finish_reason: 'stop',
            }],
        };
        const r = normalizeResponse({ requestApi: 'openai', mode: 'text', raw });
        expect(r.reasoning).toBe('step-by-step thinking');
    });
});

describe('normalizeResponse — non-openai', () => {
    test('kobold-style { results: [{ text }] } extracts assistantText, usage=null, finishReason=stop', () => {
        const r = normalizeResponse({
            requestApi: 'kobold',
            mode: 'text',
            raw: { results: [{ text: 'kobold output' }] },
        });
        expect(r.assistantText).toBe('kobold output');
        expect(r.usage).toBeNull();
        expect(r.finishReason).toBe('stop');
    });

    test('text-completion-style { choices: [{ text }] } extracts assistantText', () => {
        const r = normalizeResponse({
            requestApi: 'textgenerationwebui',
            mode: 'text',
            raw: { choices: [{ text: 'tg output' }] },
        });
        expect(r.assistantText).toBe('tg output');
    });

    test('empty openai choices → no_response', () => {
        expect(() => normalizeResponse({ requestApi: 'openai', mode: 'text', raw: { choices: [] } }))
            .toThrow(expect.objectContaining({ name: 'GenerateTaskError', code: 'no_response' }));
    });

    test('non-openai with no extractable text → no_response', () => {
        expect(() => normalizeResponse({ requestApi: 'kobold', mode: 'text', raw: {} }))
            .toThrow(expect.objectContaining({ name: 'GenerateTaskError', code: 'no_response' }));
    });
});
