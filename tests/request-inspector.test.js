// SPDX-License-Identifier: AGPL-3.0-or-later
import express from 'express';
import supertest from 'supertest';
import {
    router as inspectorRouter,
    startInspection,
    completeInspection,
    completeInspectionFromStream,
    cleanupExpiredEntries,
    getBufferForHandle,
    resolveEffectiveApiKey,
    startEmbeddingInspection,
    startImageInspection,
    completeEmbeddingInspection,
    failEmbeddingInspection,
    failInspection,
    abortInspectionByJobId,
    abortInspectionEntry,
    getInspectionAbortSignal,
    getAbortKind,
} from '../src/request-inspector.js';

// Each test gets a unique handle so the module-level ring buffer stays
// isolated between cases; findEntry() keys on handle + __inspectorId.
let counter = 0;
function newRequest(source = 'openai') {
    counter++;
    return {
        user: { profile: { handle: `ri-test-${counter}` } },
        body: {
            chat_completion_source: source,
            model: 'test-model',
            messages: [{ role: 'user', content: 'hi' }],
        },
    };
}

function getEntry(request) {
    const handle = request.user.profile.handle;
    const buf = getBufferForHandle(handle);
    return buf.find(e => e.id === request.__inspectorId) ?? null;
}

describe('request-inspector: 200-but-error detection', () => {
    describe('completeInspection (non-streaming)', () => {
        test('payload.error with .message → status=error, entry.error populated, httpStatus stays 200', () => {
            const req = newRequest();
            startInspection(req);
            completeInspection(req, { error: { message: 'rate limit exceeded' } });

            const e = getEntry(req);
            expect(e.status).toBe('error');
            expect(e.error).toBe('rate limit exceeded');
            // Truthful HTTP status preserved — the fetch itself returned 200.
            // UI shows status=error + httpStatus=200 so the user can see the
            // "HTTP succeeded but body was an error" case at a glance.
            expect(e.httpStatus).toBe(200);
        });

        test('payload.error with .code (no .message) → uses code as error message', () => {
            const req = newRequest();
            startInspection(req);
            completeInspection(req, { error: { code: 'insufficient_quota' } });

            const e = getEntry(req);
            expect(e.status).toBe('error');
            expect(e.error).toBe('insufficient_quota');
        });

        test('payload.error with .type (Anthropic-style) → uses type as error message', () => {
            const req = newRequest('claude');
            startInspection(req);
            completeInspection(req, { error: { type: 'overloaded_error' } });

            const e = getEntry(req);
            expect(e.status).toBe('error');
            expect(e.error).toBe('overloaded_error');
        });

        test('payload.error as plain string → stringifies to that string', () => {
            const req = newRequest();
            startInspection(req);
            completeInspection(req, { error: 'plain string error' });

            const e = getEntry(req);
            expect(e.status).toBe('error');
            expect(e.error).toBe('plain string error');
        });

        test('payload.error object with no .message/.code/.type → JSON.stringify fallback', () => {
            const req = newRequest();
            startInspection(req);
            completeInspection(req, { error: { details: 'weird shape', http: 429 } });

            const e = getEntry(req);
            expect(e.status).toBe('error');
            expect(e.error).toBe(JSON.stringify({ details: 'weird shape', http: 429 }));
        });

        test('normal success payload (no error field) still marks status=success', () => {
            const req = newRequest();
            startInspection(req);
            completeInspection(req, {
                choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
            });

            const e = getEntry(req);
            expect(e.status).toBe('success');
            expect(e.error).toBe('');
            expect(e.responseText).toBe('hello');
            expect(e.usage.prompt_tokens).toBe(5);
        });

        test('Makersuite-style blocked payload (dispatch-constructed {error:{message}}) → status=error', () => {
            // Mirrors makersuite dispatch's blocked-prompt branch which posts
            // `{error:{message:'...blocked...'}}` through inspection.complete
            // so the inspector sees the payload and classifies it.
            const req = newRequest('makersuite');
            startInspection(req);
            completeInspection(
                req,
                { error: { message: 'no candidate returned (blocked by SAFETY)' } },
                { promptFeedback: { blockReason: 'SAFETY' }, candidates: [] },
            );

            const e = getEntry(req);
            expect(e.status).toBe('error');
            expect(e.error).toContain('blocked by SAFETY');
            expect(e.httpStatus).toBe(200);
        });
    });

    describe('completeInspectionFromStream (SSE)', () => {
        test('single error frame → status=error, entry.error populated, httpStatus=200', () => {
            const req = newRequest();
            startInspection(req);
            completeInspectionFromStream(
                req,
                [JSON.stringify({ error: { message: 'context_length_exceeded' } })],
                '',
            );

            const e = getEntry(req);
            expect(e.status).toBe('error');
            expect(e.error).toBe('context_length_exceeded');
            expect(e.httpStatus).toBe(200);
        });

        test('partial success: content deltas then error frame → status=error but accumulated text preserved', () => {
            const req = newRequest();
            startInspection(req);
            const events = [
                JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }),
                JSON.stringify({ choices: [{ delta: { content: ' world' } }] }),
                JSON.stringify({ error: { message: 'stream cut short' } }),
            ];
            completeInspectionFromStream(req, events, 'Hello world');

            const e = getEntry(req);
            expect(e.status).toBe('error');
            expect(e.error).toBe('stream cut short');
            // Partial content the model already produced is preserved so the
            // user can see how far the stream got before it broke.
            expect(e.responseText).toBe('Hello world');
            expect(e.responseParts).toEqual([{ type: 'text', text: 'Hello world' }]);
        });

        test('normal stream (no error frame) still marks status=success', () => {
            const req = newRequest();
            startInspection(req);
            completeInspectionFromStream(
                req,
                [JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })],
                'ok',
            );

            const e = getEntry(req);
            expect(e.status).toBe('success');
            expect(e.error).toBe('');
            expect(e.responseText).toBe('ok');
        });

        test('error frame in { data } event object shape (luker-generation envelope)', () => {
            // runner.js pushes plain-string SSE data lines, but the reader path
            // (normalizeEvent) also accepts {seq, data, ts} envelopes so error
            // detection must handle both shapes.
            const req = newRequest();
            startInspection(req);
            completeInspectionFromStream(
                req,
                [{ seq: 1, data: JSON.stringify({ error: { message: 'upstream timeout' } }), ts: Date.now() }],
                '',
            );

            const e = getEntry(req);
            expect(e.status).toBe('error');
            expect(e.error).toBe('upstream timeout');
        });

        test('non-JSON frames and [DONE] sentinel do not trip false positives', () => {
            const req = newRequest();
            startInspection(req);
            completeInspectionFromStream(
                req,
                [
                    JSON.stringify({ choices: [{ delta: { content: 'a' } }] }),
                    '[DONE]',
                    'garbage-not-json',
                ],
                'a',
            );

            const e = getEntry(req);
            expect(e.status).toBe('success');
            expect(e.error).toBe('');
        });
    });
});

describe('request-inspector: TTL cleanup', () => {
    test('保留有效记录，超过 TTL 后删除完整记录', () => {
        const req = newRequest();
        startInspection(req);
        completeInspection(req, {
            choices: [{ message: { content: 'full response' }, finish_reason: 'stop' }],
        });

        const entry = getEntry(req);
        const fullMessages = [{ role: 'user', content: 'complete request body' }];
        entry.fullMessages = fullMessages;
        entry.wireRequest = { messages: fullMessages };
        entry.timestamp = Date.now() - (2 * 60 * 60 * 1000) + 1000;

        expect(cleanupExpiredEntries(Date.now())).toBe(0);
        expect(getEntry(req)).toBe(entry);

        entry.timestamp = Date.now() - (2 * 60 * 60 * 1000) - 1000;
        expect(cleanupExpiredEntries(Date.now())).toBe(1);
        expect(getBufferForHandle(req.user.profile.handle)).toEqual([]);
    });

    test('运行中的请求在扩展保留期内不会被删除', () => {
        const req = newRequest();
        startInspection(req);
        const entry = getEntry(req);
        entry.timestamp = Date.now() - (2 * 60 * 60 * 1000) - 1000;

        expect(cleanupExpiredEntries(Date.now())).toBe(0);
        expect(getEntry(req)).toBe(entry);

        entry.timestamp = Date.now() - (6 * 60 * 60 * 1000) - 1000;
        expect(cleanupExpiredEntries(Date.now())).toBe(1);
        expect(getEntry(req)).toBeNull();
    });

    test('全部记录过期后清理空缓冲区条目', () => {
        const req = newRequest();
        startInspection(req);
        completeInspection(req, {
            choices: [{ message: { content: 'to expire' }, finish_reason: 'stop' }],
        });

        const entry = getEntry(req);
        entry.timestamp = Date.now() - (2 * 60 * 60 * 1000) - 1000;
        expect(cleanupExpiredEntries(Date.now())).toBe(1);
        expect(getBufferForHandle(req.user.profile.handle)).toEqual([]);

        // 模拟 /list 路由为无记录用户重建的空缓冲区——下一轮清理应删除该键,
        // 不让空数组长期占用 Map。
        const beforeKeys = cleanupExpiredEntries(Date.now());
        expect(beforeKeys).toBe(0);
        // getBufferForHandle on a deleted key returns [] without recreating,
        // so a second sweep observing zero removals confirms the empty
        // buffer didn't linger as a live Map entry with stale data.
        expect(getBufferForHandle(req.user.profile.handle)).toEqual([]);
    });
});

describe('request-inspector: openai_responses support', () => {
    test('non-streaming payload extracts tokens, responseText, responseParts, and finishReason', () => {
        const req = newRequest('openai_responses');
        startInspection(req);

        const payload = {
            id: 'resp_123',
            object: 'response',
            status: 'completed',
            output: [
                {
                    type: 'reasoning',
                    summary: [{ type: 'summary_text', text: 'Thinking about greetings' }],
                },
                {
                    type: 'message',
                    role: 'assistant',
                    content: [
                        { type: 'output_text', text: 'Hello, how can I assist you today?' },
                    ],
                },
            ],
            usage: {
                input_tokens: 15169,
                output_tokens: 1436,
                total_tokens: 16605,
                input_token_details: { cached_tokens: 7600 },
            },
        };

        completeInspection(req, payload, payload);

        const entry = getEntry(req);
        expect(entry.status).toBe('success');
        expect(entry.usage.prompt_tokens).toBe(15169);
        expect(entry.usage.completion_tokens).toBe(1436);
        expect(entry.usage.total_tokens).toBe(16605);
        expect(entry.usage.cache_read).toBe(7600);
        expect(entry.responseText).toBe('Hello, how can I assist you today?');
        expect(entry.responseParts).toEqual([
            { type: 'reasoning', kind: 'thinking', text: 'Thinking about greetings' },
            { type: 'text', text: 'Hello, how can I assist you today?' },
        ]);
        expect(entry.finishReason).toBe('stop');
        expect(entry.nativeFinishReason).toBe('completed');
    });

    test('non-streaming payload with function_call extracts tool call and sets finishReason to tool_calls', () => {
        const req = newRequest('openai_responses');
        startInspection(req);

        const payload = {
            id: 'resp_tool',
            object: 'response',
            status: 'completed',
            output: [
                {
                    type: 'function_call',
                    call_id: 'call_999',
                    name: 'get_current_weather',
                    arguments: '{"location":"Taipei"}',
                },
            ],
            usage: {
                input_tokens: 100,
                output_tokens: 50,
            },
        };

        completeInspection(req, payload, payload);

        const entry = getEntry(req);
        expect(entry.status).toBe('success');
        expect(entry.usage.prompt_tokens).toBe(100);
        expect(entry.usage.completion_tokens).toBe(50);
        expect(entry.usage.total_tokens).toBe(150);
        expect(entry.responseParts).toEqual([
            {
                type: 'tool_call',
                id: 'call_999',
                name: 'get_current_weather',
                args: { location: 'Taipei' },
            },
        ]);
        expect(entry.finishReason).toBe('tool_calls');
        expect(entry.nativeFinishReason).toBe('completed');
    });

    test('streaming events extract tokens, responseText, responseParts, and finishReason', () => {
        const req = newRequest('openai_responses');
        startInspection(req);

        const events = [
            'data: {"type":"response.reasoning_text.delta","delta":"Hmm..."}',
            'data: {"type":"response.output_text.delta","delta":"Hello"}',
            'data: {"type":"response.output_text.delta","delta":" world!"}',
            'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":500,"output_tokens":20,"total_tokens":520,"input_tokens_details":{"cached_tokens":120,"cache_creation_tokens":45}}}}',
        ];

        completeInspectionFromStream(req, events);

        const entry = getEntry(req);
        expect(entry.status).toBe('success');
        expect(entry.usage.prompt_tokens).toBe(500);
        expect(entry.usage.completion_tokens).toBe(20);
        expect(entry.usage.total_tokens).toBe(520);
        expect(entry.usage.cache_read).toBe(120);
        expect(entry.usage.cache_write).toBe(45);
        expect(entry.responseText).toBe('Hello world!');
        expect(entry.responseParts).toEqual([
            { type: 'reasoning', kind: 'text', text: 'Hmm...' },
            { type: 'text', text: 'Hello world!' },
        ]);
        expect(entry.finishReason).toBe('stop');
        expect(entry.nativeFinishReason).toBe('completed');
    });

    test('non-streaming payload with input_tokens_details extracts cache_read: 0 and cache_write', () => {
        const req = newRequest('openai_responses');
        startInspection(req);

        const payload = {
            id: 'resp_cache_0',
            object: 'response',
            status: 'completed',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }],
            usage: {
                input_tokens: 2,
                input_tokens_details: { cached_tokens: 0, cache_creation_tokens: 10 },
                output_tokens: 145,
                total_tokens: 147,
            },
        };

        completeInspection(req, payload, payload);

        const entry = getEntry(req);
        expect(entry.status).toBe('success');
        expect(entry.usage.cache_read).toBe(0);
        expect(entry.usage.cache_write).toBe(10);
    });

    test('streaming: function_call output_item is detected as tool_calls finish reason', () => {
        const req = newRequest('openai_responses');
        startInspection(req);

        const events = [
            'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call_1","name":"f","arguments":""}}',
            'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{}"}',
            'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":10,"output_tokens":4}}}',
        ];

        completeInspectionFromStream(req, events);

        const entry = getEntry(req);
        expect(entry.finishReason).toBe('tool_calls');
        expect(entry.nativeFinishReason).toBe('completed');
    });

    test('streaming: body text mentioning function_call does not fake tool_calls', () => {
        const req = newRequest('openai_responses');
        startInspection(req);

        const events = [
            'data: {"type":"response.output_text.delta","delta":"Call the function_call helper next."}',
            'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":10,"output_tokens":4}}}',
        ];

        completeInspectionFromStream(req, events);

        const entry = getEntry(req);
        expect(entry.finishReason).toBe('stop');
    });

    test('non-streaming incomplete with content_filter reason maps to content_filter', () => {
        const req = newRequest('openai_responses');
        startInspection(req);

        const payload = {
            id: 'resp_filter',
            object: 'response',
            status: 'incomplete',
            incomplete_details: { reason: 'content_filter' },
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'partial' }] }],
        };

        completeInspection(req, payload, payload);

        const entry = getEntry(req);
        expect(entry.finishReason).toBe('content_filter');
        expect(entry.nativeFinishReason).toBe('incomplete');
    });

    test('streaming incomplete with content_filter reason maps to content_filter', () => {
        const req = newRequest('openai_responses');
        startInspection(req);

        const events = [
            'data: {"type":"response.output_text.delta","delta":"partial"}',
            'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"content_filter"}}}',
        ];

        completeInspectionFromStream(req, events);

        const entry = getEntry(req);
        expect(entry.finishReason).toBe('content_filter');
        expect(entry.nativeFinishReason).toBe('incomplete');
    });

    test('streaming incomplete without content_filter reason still maps to length', () => {
        const req = newRequest('openai_responses');
        startInspection(req);

        const events = [
            'data: {"type":"response.output_text.delta","delta":"partial"}',
            'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}',
        ];

        completeInspectionFromStream(req, events);

        const entry = getEntry(req);
        expect(entry.finishReason).toBe('length');
        expect(entry.nativeFinishReason).toBe('incomplete');
    });
});

describe('request-inspector: resolveEffectiveApiKey', () => {
    test('no headers → falls back to resolved key', () => {
        expect(resolveEffectiveApiKey({}, 'stored-key')).toBe('stored-key');
        expect(resolveEffectiveApiKey(undefined, 'stored-key')).toBe('stored-key');
    });

    test('Authorization Bearer overrides fallback and strips the prefix', () => {
        expect(resolveEffectiveApiKey({ 'Authorization': 'Bearer proxy-key' }, 'stored-key')).toBe('proxy-key');
    });

    test('header lookup is case-insensitive', () => {
        expect(resolveEffectiveApiKey({ 'authorization': 'Bearer proxy-key' }, 'stored-key')).toBe('proxy-key');
        expect(resolveEffectiveApiKey({ 'X-API-KEY': 'proxy-key' }, 'stored-key', ['x-api-key'])).toBe('proxy-key');
    });

    test('preferred header order decides between competing credential headers', () => {
        const headers = { 'Authorization': 'Bearer auth-key', 'x-api-key': 'x-key' };
        expect(resolveEffectiveApiKey(headers, 'stored-key', ['x-api-key'])).toBe('x-key');
        expect(resolveEffectiveApiKey(headers, 'stored-key', ['authorization'])).toBe('auth-key');
    });

    test('non-Bearer credential values are returned verbatim', () => {
        expect(resolveEffectiveApiKey({ 'Authorization': 'Basic dXNlcjpwYXNz' }, 'stored-key')).toBe('Basic dXNlcjpwYXNz');
    });

    test('present-but-empty header wins over fallback (nothing goes on the wire)', () => {
        expect(resolveEffectiveApiKey({ 'Authorization': '' }, 'stored-key')).toBe('');
    });

    test('null header value is treated as absent', () => {
        expect(resolveEffectiveApiKey({ 'Authorization': null }, 'stored-key')).toBe('stored-key');
    });

    test('preferred headers absent → falls back to resolved key', () => {
        expect(resolveEffectiveApiKey({ 'X-Custom': 'yes' }, 'stored-key')).toBe('stored-key');
    });
});

describe('request-inspector: reasoning_details accumulation and dedup', () => {
    test('streaming merges consecutive reasoning.text fragments and drops the duplicated reasoning string', () => {
        const req = newRequest('custom');
        startInspection(req);

        const events = [
            'data: {"choices":[{"delta":{"reasoning":"Let","reasoning_details":[{"type":"reasoning.text","text":"Let","format":"anthropic-claude-v1","index":0}]}}]}',
            'data: {"choices":[{"delta":{"reasoning":" me","reasoning_details":[{"type":"reasoning.text","text":" me","format":"anthropic-claude-v1","index":0}]}}]}',
            'data: {"choices":[{"delta":{"reasoning":" think.","reasoning_details":[{"type":"reasoning.text","text":" think.","signature":"sig-abc","format":"anthropic-claude-v1","index":0}]}}]}',
        ];

        completeInspectionFromStream(req, events);

        const entry = getEntry(req);
        expect(entry.responseParts).toEqual([
            {
                type: 'reasoning',
                kind: 'details',
                details: [{
                    type: 'reasoning.text',
                    text: 'Let me think.',
                    signature: 'sig-abc',
                    format: 'anthropic-claude-v1',
                    index: 0,
                }],
            },
        ]);
    });

    test('streaming keeps the reasoning string when it differs from the details text', () => {
        const req = newRequest('custom');
        startInspection(req);

        const events = [
            'data: {"choices":[{"delta":{"reasoning":"abc","reasoning_details":[{"type":"reasoning.text","text":"ab","format":"anthropic-claude-v1","index":0}]}}]}',
            'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","text":"X","index":0}]}}]}',
        ];

        completeInspectionFromStream(req, events);

        const entry = getEntry(req);
        expect(entry.responseParts).toEqual([
            { type: 'reasoning', kind: 'text', text: 'abc' },
            {
                type: 'reasoning',
                kind: 'details',
                details: [{
                    type: 'reasoning.text',
                    text: 'abX',
                    format: 'anthropic-claude-v1',
                    index: 0,
                }],
            },
        ]);
    });

    test('streaming keeps same-type runs separate across other types; encrypted entries stay discrete', () => {
        const req = newRequest('custom');
        startInspection(req);

        const events = [
            'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","text":"a","format":"anthropic-claude-v1","index":0},{"type":"reasoning.text","text":"b","index":0},{"type":"reasoning.encrypted","id":"rs_1","data":"blob-1","format":"openai-responses-v1","index":0},{"type":"reasoning.encrypted","id":"rs_2","data":"blob-2","index":0},{"type":"reasoning.text","text":"c","index":0},{"type":"reasoning.summary","summary":"s1","format":"openai-responses-v1","index":0},{"type":"reasoning.summary","summary":"s2","index":0}]}}]}',
        ];

        completeInspectionFromStream(req, events);

        const entry = getEntry(req);
        expect(entry.responseParts).toEqual([
            {
                type: 'reasoning',
                kind: 'details',
                details: [
                    { type: 'reasoning.text', text: 'ab', format: 'anthropic-claude-v1', index: 0 },
                    { type: 'reasoning.encrypted', id: 'rs_1', data: 'blob-1', format: 'openai-responses-v1', index: 0 },
                    { type: 'reasoning.encrypted', id: 'rs_2', data: 'blob-2', index: 0 },
                    { type: 'reasoning.text', text: 'c', index: 0 },
                    { type: 'reasoning.summary', summary: 's1s2', format: 'openai-responses-v1', index: 0 },
                ],
            },
        ]);
    });

    test('streaming keeps a standalone reasoning text part when no details are present', () => {
        const req = newRequest('custom');
        startInspection(req);

        completeInspectionFromStream(req, ['data: {"choices":[{"delta":{"reasoning":"plain thought"}}]}']);

        const entry = getEntry(req);
        expect(entry.responseParts).toEqual([
            { type: 'reasoning', kind: 'text', text: 'plain thought' },
        ]);
    });

    test('non-streaming payload drops the duplicated reasoning string when details carry the same text', () => {
        const req = newRequest('custom');
        startInspection(req);

        const payload = {
            choices: [{
                message: {
                    reasoning: 'dup',
                    reasoning_details: [
                        { type: 'reasoning.text', text: 'du' },
                        { type: 'reasoning.text', text: 'p' },
                    ],
                },
            }],
        };

        completeInspection(req, payload);

        const entry = getEntry(req);
        expect(entry.responseParts).toEqual([
            {
                type: 'reasoning',
                kind: 'details',
                details: [
                    { type: 'reasoning.text', text: 'du' },
                    { type: 'reasoning.text', text: 'p' },
                ],
            },
        ]);
    });

    test('non-streaming payload keeps a differing reasoning string alongside details', () => {
        const req = newRequest('custom');
        startInspection(req);

        const payload = {
            choices: [{
                message: {
                    reasoning: 'other',
                    reasoning_details: [{ type: 'reasoning.text', text: 'dup' }],
                },
            }],
        };

        completeInspection(req, payload);

        const entry = getEntry(req);
        expect(entry.responseParts).toEqual([
            { type: 'reasoning', kind: 'text', text: 'other' },
            {
                type: 'reasoning',
                kind: 'details',
                details: [{ type: 'reasoning.text', text: 'dup' }],
            },
        ]);
    });
});

describe('request-inspector: abort', () => {
    test('startInspection records the generation job id', () => {
        const req = newRequest();
        req.lukerGenerationJob = { id: 'job-abc' };
        startInspection(req);

        const entry = getEntry(req);
        expect(entry.generationJobId).toBe('job-abc');
        expect(getAbortKind(entry)).toBe('job');
    });

    test('abortInspectionByJobId marks the running entry aborted and failInspection cannot overwrite it', () => {
        const req = newRequest();
        req.lukerGenerationJob = { id: 'job-abort-1' };
        startInspection(req);

        const aborted = abortInspectionByJobId(req.user.profile.handle, 'job-abort-1', 'inspector stop');
        expect(aborted).toBeTruthy();
        expect(aborted.status).toBe('aborted');
        expect(aborted.error).toBe('inspector stop');

        failInspection(req, 'The operation was aborted', 500);
        expect(getEntry(req).status).toBe('aborted');
    });

    test('image entries record the generation job id and are job-abortable', () => {
        const req = newRequest('sd');
        req.lukerGenerationJob = { id: 'job-image-1' };
        startImageInspection(req, { source: 'sd', prompt: 'a cat' });

        const entry = getEntry(req);
        expect(entry.generationJobId).toBe('job-image-1');
        expect(getAbortKind(entry)).toBe('job');
    });

    test('embedding entries expose an abort signal and abortInspectionEntry aborts it', () => {
        const req = newRequest('openai');
        startEmbeddingInspection(req, {
            source: 'openai',
            model: 'text-embedding-3-small',
            routeKind: 'query',
            inputCount: 1,
            inputCharTotal: 2,
            inputTexts: [{ index: 0, text: 'hi' }],
        });

        const entry = getEntry(req);
        const signal = getInspectionAbortSignal(req);
        expect(signal).toBeTruthy();
        expect(signal.aborted).toBe(false);
        expect(getAbortKind(entry)).toBe('request');

        const aborted = abortInspectionEntry(req.user.profile.handle, entry.id, 'inspector stop');
        expect(aborted).toBeTruthy();
        expect(aborted.status).toBe('aborted');
        expect(signal.aborted).toBe(true);

        failEmbeddingInspection(req, 'aborted', 500);
        expect(getEntry(req).status).toBe('aborted');
    });

    test('completeEmbeddingInspection cannot overwrite an aborted entry', () => {
        const req = newRequest('openai');
        startEmbeddingInspection(req, {
            source: 'openai',
            model: 'text-embedding-3-small',
            routeKind: 'query',
            inputCount: 1,
            inputCharTotal: 2,
            inputTexts: [{ index: 0, text: 'hi' }],
        });
        const entry = getEntry(req);
        abortInspectionEntry(req.user.profile.handle, entry.id, 'inspector stop');

        completeEmbeddingInspection(req, { resultCount: 1, vectorDim: 3 });
        expect(getEntry(req).status).toBe('aborted');
    });

    test('getAbortKind returns empty for terminal entries', () => {
        const req = newRequest();
        req.lukerGenerationJob = { id: 'job-terminal' };
        startInspection(req);
        const entry = getEntry(req);
        entry.status = 'success';
        expect(getAbortKind(entry)).toBe('');
    });
});

describe('request-inspector: abort route', () => {
    function makeApp(handle) {
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { profile: { handle }, directories: {} };
            next();
        });
        app.use('/api/request-inspector', inspectorRouter);
        return app;
    }

    test('aborts a running embedding entry through its own controller', async () => {
        const req = newRequest('openai');
        startEmbeddingInspection(req, {
            source: 'openai',
            model: 'text-embedding-3-small',
            routeKind: 'query',
            inputCount: 1,
            inputCharTotal: 2,
            inputTexts: [{ index: 0, text: 'hi' }],
        });
        const entry = getEntry(req);
        const signal = getInspectionAbortSignal(req);

        const app = makeApp(req.user.profile.handle);
        const res = await supertest(app).post(`/api/request-inspector/${entry.id}/abort`).send();

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ aborted: true });
        expect(entry.status).toBe('aborted');
        expect(signal.aborted).toBe(true);
    });

    test('rejects job-backed entries with use_generation_abort', async () => {
        const req = newRequest();
        req.lukerGenerationJob = { id: 'job-route-1' };
        startInspection(req);
        const entry = getEntry(req);

        const app = makeApp(req.user.profile.handle);
        const res = await supertest(app).post(`/api/request-inspector/${entry.id}/abort`).send();

        expect(res.status).toBe(409);
        expect(res.body).toEqual({ aborted: false, error: 'use_generation_abort' });
        expect(entry.status).toBe('running');
    });

    test('returns 409 for a terminal entry', async () => {
        const req = newRequest();
        startInspection(req);
        const entry = getEntry(req);
        entry.status = 'success';

        const app = makeApp(req.user.profile.handle);
        const res = await supertest(app).post(`/api/request-inspector/${entry.id}/abort`).send();

        expect(res.status).toBe(409);
        expect(res.body).toEqual({ aborted: false, error: 'not_running' });
    });
});

