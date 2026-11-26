// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from '@jest/globals';

import {
    ProtocolParseError,
    WIRE_PROTOCOLS,
    createProtocolStreamParser,
    createSseFramer,
    isParsedTurnEmpty,
    parseProtocolResponse,
    parsedTurnToChatCompletion,
    resolveWireProtocol,
} from '../public/scripts/lib/protocol-parser/index.js';
import {
    completeInspection,
    completeInspectionFromStream,
    getBufferForHandle,
    startInspection,
} from '../src/request-inspector.js';
import {
    accumulateChunkTextIntoJob,
    createGenerationJob,
    finalizeJobProtocolStream,
} from '../src/endpoints/backends/luker-generation.js';

let counter = 0;
function makeInspectorRequest(source) {
    counter += 1;
    return {
        user: { profile: { handle: `pp-parity-${counter}` }, directories: {} },
        body: {
            chat_completion_source: source,
            model: 'parity-model',
            messages: [{ role: 'user', content: 'hi' }],
        },
    };
}

function getInspectorEntry(req) {
    return getBufferForHandle(req.user.profile.handle).find(e => e.id === req.__inspectorId) ?? null;
}

describe('createSseFramer', () => {
    test('normalizes CRLF/CR across chunk boundaries, ignores comments, and preserves trailing whitespace', () => {
        const framer = createSseFramer();
        const frames = [
            ...framer.push(': keep-alive\r\nevent: content_block_delta\r\ndata: {"text":"hello "}\r'),
            ...framer.push('\n\r\ndata: {"text":" world"}\r\n\r\n: OPENROUTER PROCESSING\n\ndata: [DONE]'),
            ...framer.flush(),
        ];
        expect(frames).toHaveLength(3);
        expect(frames[0]).toMatchObject({ event: 'content_block_delta', data: '{"text":"hello "}' });
        expect(frames[1]).toMatchObject({ event: '', data: '{"text":" world"}' });
        expect(frames[2]).toMatchObject({ event: '', data: '[DONE]' });
    });
});

describe('resolveWireProtocol', () => {
    test('maps declared chat sources strictly and returns null for non-chat backends', () => {
        expect(resolveWireProtocol('claude')).toBe(WIRE_PROTOCOLS.CLAUDE);
        expect(resolveWireProtocol('makersuite')).toBe(WIRE_PROTOCOLS.GEMINI);
        expect(resolveWireProtocol('vertexai')).toBe(WIRE_PROTOCOLS.GEMINI);
        expect(resolveWireProtocol('openai_responses')).toBe(WIRE_PROTOCOLS.OPENAI_RESPONSES);
        expect(resolveWireProtocol('cohere')).toBe(WIRE_PROTOCOLS.COHERE);
        expect(resolveWireProtocol('openai')).toBe(WIRE_PROTOCOLS.OPENAI_CHAT);
        expect(resolveWireProtocol('openrouter')).toBe(WIRE_PROTOCOLS.OPENAI_CHAT);
        expect(resolveWireProtocol('deepseek')).toBe(WIRE_PROTOCOLS.OPENAI_CHAT);
        expect(resolveWireProtocol('kobold')).toBeNull();
        expect(resolveWireProtocol('novelai')).toBeNull();
        expect(resolveWireProtocol('unknown')).toBeNull();
    });
});

describe('Shared fixture parity across parser, luker-generation, and Request Inspector', () => {
    test('Gemini streaming separates thought parts from visible text identically across all consumers', () => {
        const frames = [
            JSON.stringify({
                candidates: [{
                    content: {
                        role: 'model',
                        parts: [
                            { thought: true, text: 'Private chain of thought.', thoughtSignature: 'sig-t1' },
                            { text: 'Visible answer ' },
                        ],
                    },
                }],
            }),
            JSON.stringify({
                candidates: [{
                    content: {
                        role: 'model',
                        parts: [
                            { text: 'part 2.' },
                            { functionCall: { id: 'gem_1', name: 'lookup', args: { q: 'cats' } }, thoughtSignature: 'sig-fc1' },
                        ],
                    },
                    finishReason: 'STOP',
                }],
                usageMetadata: {
                    promptTokenCount: 100,
                    candidatesTokenCount: 20,
                    thoughtsTokenCount: 30,
                    cachedContentTokenCount: 50,
                    toolUsePromptTokenCount: 10,
                    totalTokenCount: 160,
                },
            }),
        ];

        // 1. Shared parser direct
        const parser = createProtocolStreamParser('makersuite');
        for (const f of frames) parser.feedFrame(f);
        const turn = parser.finish();
        expect(turn.text).toBe('Visible answer part 2.');
        expect(turn.reasoning).toBe('Private chain of thought.');
        expect(turn.text).not.toContain('Private chain of thought.');
        expect(turn.toolCalls).toHaveLength(1);
        expect(turn.toolCalls[0].signature).toBe('sig-fc1');
        expect(turn.finishReason).toBe('tool_calls');
        expect(turn.nativeFinishReason).toBe('STOP');
        expect(turn.usage.completion_tokens).toBe(50);

        // 2. Request Inspector
        const req = makeInspectorRequest('makersuite');
        startInspection(req);
        completeInspectionFromStream(req, frames);
        const entry = getInspectorEntry(req);
        expect(entry.status).toBe('success');
        expect(entry.responseText).toBe('Visible answer part 2.');
        expect(entry.responseParts[0]).toMatchObject({ type: 'reasoning', kind: 'thinking', text: 'Private chain of thought.' });
        expect(entry.responseParts[1]).toEqual({ type: 'text', text: 'Visible answer part 2.' });
        expect(entry.responseParts[2]).toMatchObject({ type: 'tool_call', name: 'lookup', args: { q: 'cats' } });
        expect(entry.usage).toEqual({
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 160,
            cache_read: 50,
            cache_write: null,
        });

        // 3. luker-generation job accumulation
        const jobReq = makeInspectorRequest('makersuite');
        const job = createGenerationJob(jobReq, { job_id: `pp-gem-${counter}` });
        const sseWire = frames.map(f => `data: ${f}\n\n`).join('');
        accumulateChunkTextIntoJob(job, Buffer.from(sseWire, 'utf8'));
        finalizeJobProtocolStream(job);
        expect(job.text).toBe('Visible answer part 2.');
        expect(job.parsedTurn.reasoning).toBe('Private chain of thought.');
        expect(job.parsedTurn.nativeParts).toHaveLength(3);
    });

    test('Claude streaming parity preserves ordered blocks, disjoint usage, and signatures across consumers', () => {
        const frames = [
            JSON.stringify({
                type: 'message_start',
                message: { usage: { input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 20, output_tokens: 1 } },
            }),
            JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
            JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me think' } }),
            JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } }),
            JSON.stringify({ type: 'content_block_stop', index: 0 }),
            JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
            JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer.' } }),
            JSON.stringify({ type: 'content_block_stop', index: 1 }),
            JSON.stringify({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'search', input: {} } }),
            JSON.stringify({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"q":"sky"}' } }),
            JSON.stringify({ type: 'content_block_stop', index: 2 }),
            JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 25 } }),
            JSON.stringify({ type: 'message_stop' }),
        ];

        const parser = createProtocolStreamParser('claude');
        for (const f of frames) parser.feedFrame(f);
        const turn = parser.finish();
        expect(turn.text).toBe('Answer.');
        expect(turn.reasoning).toBe('Let me think');
        expect(turn.reasoningBlocks).toEqual([{ type: 'thinking', thinking: 'Let me think', signature: 'sig-abc' }]);
        expect(turn.nativeContentBlocks).toHaveLength(3);
        expect(turn.usage.prompt_tokens).toBe(110);
        expect(turn.usage.completion_tokens).toBe(25);
        expect(turn.usage.total_tokens).toBe(135);
        expect(turn.finishReason).toBe('tool_calls');

        const req = makeInspectorRequest('claude');
        startInspection(req);
        completeInspectionFromStream(req, frames);
        const entry = getInspectorEntry(req);
        expect(entry.status).toBe('success');
        expect(entry.responseText).toBe('Answer.');
        expect(entry.usage).toEqual({
            prompt_tokens: 110,
            completion_tokens: 25,
            total_tokens: 135,
            cache_read: 80,
            cache_write: 20,
        });
        expect(entry.finishReason).toBe('tool_calls');
        expect(entry.nativeFinishReason).toBe('tool_use');

        const jobReq = makeInspectorRequest('claude');
        const job = createGenerationJob(jobReq, { job_id: `pp-claude-${counter}` });
        accumulateChunkTextIntoJob(job, Buffer.from(frames.map(f => `data: ${f}\n\n`).join(''), 'utf8'));
        finalizeJobProtocolStream(job);
        expect(job.text).toBe('Answer.');
        expect(job.parsedTurn.reasoningBlocks).toEqual([{ type: 'thinking', thinking: 'Let me think', signature: 'sig-abc' }]);
    });

    test('Cohere v2 streaming and non-streaming parse cleanly', () => {
        const turn = parseProtocolResponse('cohere', {
            id: 'coh_1',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'Hello from Cohere' }],
            },
            finish_reason: 'COMPLETE',
            usage: { billed_units: { input_tokens: 12, output_tokens: 5 } },
        });
        expect(turn.text).toBe('Hello from Cohere');
        expect(turn.finishReason).toBe('stop');
        expect(turn.usage).toEqual({ prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 });
        expect(isParsedTurnEmpty(turn)).toBe(false);
        expect(parsedTurnToChatCompletion(turn).choices[0].message.content).toBe('Hello from Cohere');
    });
});

describe('Strict protocol mismatch, malformed JSON, tool correlation, and premature EOF enforcement', () => {
    test('rejects cross-protocol payloads and prevents Inspector from displaying them as valid output', () => {
        const openaiPayload = { choices: [{ message: { role: 'assistant', content: 'wrong protocol' }, finish_reason: 'stop' }] };
        expect(() => parseProtocolResponse('claude', openaiPayload)).toThrow(ProtocolParseError);
        expect(() => parseProtocolResponse('makersuite', openaiPayload)).toThrow(ProtocolParseError);
        expect(() => parseProtocolResponse('openai_responses', openaiPayload)).toThrow(ProtocolParseError);
        expect(() => parseProtocolResponse('cohere', openaiPayload)).toThrow(ProtocolParseError);

        const responsesPayload = {
            object: 'response',
            status: 'completed',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }],
        };
        expect(() => parseProtocolResponse('openai', responsesPayload)).toThrow(ProtocolParseError);

        // Request Inspector marks mismatch as error with structured parseError + rawDiagnostic and empty output
        const req = makeInspectorRequest('claude');
        startInspection(req);
        completeInspection(req, openaiPayload, openaiPayload);
        const entry = getInspectorEntry(req);
        expect(entry.status).toBe('error');
        expect(entry.parseError).toMatchObject({ protocol: 'claude', stage: 'protocol_mismatch' });
        expect(entry.rawDiagnostic).toMatchObject({ kind: 'non-streaming', protocol: 'claude' });
        expect(entry.responseText).toBe('');
        expect(entry.responseParts).toEqual([]);
    });

    test('rejects malformed JSON in SSE streams without silent skipping', () => {
        const req = makeInspectorRequest('openai');
        startInspection(req);
        completeInspectionFromStream(req, [
            JSON.stringify({ choices: [{ delta: { content: 'a' } }] }),
            '{broken-json',
            '[DONE]',
        ]);
        const entry = getInspectorEntry(req);
        expect(entry.status).toBe('error');
        expect(entry.parseError).toMatchObject({ protocol: 'openai-chat', stage: 'json' });
        expect(entry.rawDiagnostic?.events).toContain('{broken-json');
        expect(entry.responseText).toBe('');
    });

    test('rejects broken tool correlation on Claude and Responses streams', () => {
        const claude = createProtocolStreamParser('claude');
        expect(() => claude.feedFrame(JSON.stringify({
            type: 'content_block_delta',
            index: 3,
            delta: { type: 'input_json_delta', partial_json: '{"a":1}' },
        }))).toThrow(expect.objectContaining({ name: 'ProtocolParseError', stage: 'tool_correlation' }));

        const responses = createProtocolStreamParser('openai_responses');
        expect(() => responses.feedFrame(JSON.stringify({
            type: 'response.function_call_arguments.delta',
            output_index: 5,
            delta: '{"a":1}',
        }))).toThrow(expect.objectContaining({ name: 'ProtocolParseError', stage: 'tool_correlation' }));
    });

    test('rejects premature EOF across Claude, Responses, Gemini, OpenAI Chat, and Cohere', () => {
        const claude = createProtocolStreamParser('claude');
        claude.feedFrame(JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
        claude.feedFrame(JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }));
        expect(() => claude.finish()).toThrow(expect.objectContaining({ name: 'ProtocolParseError', stage: 'eof' }));

        const responses = createProtocolStreamParser('openai_responses');
        responses.feedFrame(JSON.stringify({ type: 'response.output_text.delta', delta: 'partial' }));
        expect(() => responses.finish()).toThrow(expect.objectContaining({ name: 'ProtocolParseError', stage: 'eof' }));

        const gemini = createProtocolStreamParser('makersuite');
        gemini.feedFrame(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'partial' }] } }] }));
        expect(() => gemini.finish()).toThrow(expect.objectContaining({ name: 'ProtocolParseError', stage: 'eof' }));

        const oai = createProtocolStreamParser('openai');
        oai.feedFrame(JSON.stringify({ choices: [{ delta: { content: 'partial' } }] }));
        expect(() => oai.finish()).toThrow(expect.objectContaining({ name: 'ProtocolParseError', stage: 'eof' }));

        const cohere = createProtocolStreamParser('cohere');
        cohere.feedFrame(JSON.stringify({ type: 'content-delta', delta: { message: { content: { text: 'partial' } } } }));
        expect(() => cohere.finish()).toThrow(expect.objectContaining({ name: 'ProtocolParseError', stage: 'eof' }));
    });

    test('allows valid usage-only frames and tool-only responses without false errors', () => {
        const oai = createProtocolStreamParser('openai');
        oai.feedFrame(JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'ping', arguments: '{}' } }] } }],
        }));
        oai.feedFrame(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
        oai.feedFrame(JSON.stringify({ choices: [], usage: { prompt_tokens: 15, completion_tokens: 4, total_tokens: 19 } }));
        oai.feedFrame('[DONE]');
        const turn = oai.finish();
        expect(turn.text).toBe('');
        expect(turn.toolCalls).toHaveLength(1);
        expect(turn.usage.total_tokens).toBe(19);
        expect(isParsedTurnEmpty(turn)).toBe(false);
    });

    test('Gemini stream parser throws ProtocolParseError on promptFeedback.blockReason and empty BLOCKLIST/SPII turns', () => {
        const blocked = createProtocolStreamParser('makersuite');
        blocked.feedFrame(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }));
        expect(() => blocked.finish()).toThrow(expect.objectContaining({
            name: 'ProtocolParseError',
            stage: 'provider_error',
            location: 'promptFeedback.blockReason',
        }));

        const blocklist = createProtocolStreamParser('makersuite');
        blocklist.feedFrame(JSON.stringify({ candidates: [{ finishReason: 'BLOCKLIST', content: { parts: [] } }] }));
        expect(() => blocklist.finish()).toThrow(expect.objectContaining({
            name: 'ProtocolParseError',
            stage: 'provider_error',
            location: 'candidates[0].finishReason',
        }));
    });

    test('OpenAI Chat stream parser preserves citations and refusal parity', () => {
        const oai = createProtocolStreamParser('openai');
        oai.feedFrame(JSON.stringify({
            choices: [{ index: 0, delta: { refusal: 'Cannot assist with that.' } }],
            citations: ['https://example.test/policy'],
        }));
        oai.feedFrame(JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
        oai.feedFrame('[DONE]');
        const turn = oai.finish();
        expect(turn.refusal).toBe('Cannot assist with that.');
        expect(turn.text).toBe('Cannot assist with that.');
        expect(turn.citations).toEqual(['https://example.test/policy']);
    });

    test('Cohere parsedTurnToChatCompletion does not duplicate tool_plan into both content and reasoning_content', () => {
        const raw = {
            id: 'cohere-1',
            finish_reason: 'TOOL_CALL',
            message: {
                role: 'assistant',
                tool_plan: 'Checking the harbor schedule.',
                tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'get_tide', arguments: '{}' } }],
            },
        };
        const turn = parseProtocolResponse('cohere', raw);
        const oai = parsedTurnToChatCompletion(turn, raw);
        expect(oai.choices[0].message.content).toBe('Checking the harbor schedule.');
        expect(oai.choices[0].message.reasoning_content).toBeUndefined();
    });

    test('OpenAI Responses non-streaming rejects status=failed even without error object', () => {
        expect(() => parseProtocolResponse('openai_responses', {
            id: 'resp_fail',
            object: 'response',
            status: 'failed',
            output: [],
        })).toThrow(expect.objectContaining({
            name: 'ProtocolParseError',
            stage: 'provider_error',
            location: 'status',
        }));
    });

    test('Gemini non-streaming classifies array-wrapped HTTP 200 error object as provider_error', () => {
        expect(() => parseProtocolResponse('makersuite', [{
            error: { code: 503, message: 'service unavailable', status: 'UNAVAILABLE' },
        }])).toThrow(expect.objectContaining({
            name: 'ProtocolParseError',
            stage: 'provider_error',
            location: '[0].error',
            message: 'service unavailable',
        }));
    });

    test('Cohere non-streaming classifies native string message HTTP 200 error as provider_error', () => {
        expect(() => parseProtocolResponse('cohere', {
            message: 'invalid api token',
        })).toThrow(expect.objectContaining({
            name: 'ProtocolParseError',
            stage: 'provider_error',
            location: 'message',
            message: 'invalid api token',
        }));
    });

    test('isParsedTurnEmpty treats a textless Claude pause_turn with server-tool blocks as non-empty', () => {
        const pausedTurn = parseProtocolResponse('claude', {
            id: 'msg_pause_1',
            type: 'message',
            role: 'assistant',
            stop_reason: 'pause_turn',
            content: [
                { type: 'thinking', thinking: 'Searching...', signature: 'sig_1' },
                { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'foo' } },
                { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [] },
            ],
            usage: { input_tokens: 10, output_tokens: 20 },
        });
        expect(pausedTurn.finishReason).toBe('pause_turn');
        expect(pausedTurn.text).toBe('');
        expect(isParsedTurnEmpty(pausedTurn)).toBe(false);

        const emptyEndTurn = parseProtocolResponse('claude', {
            id: 'msg_empty_1',
            type: 'message',
            role: 'assistant',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: '' }],
            usage: { input_tokens: 10, output_tokens: 0 },
        });
        expect(isParsedTurnEmpty(emptyEndTurn)).toBe(true);
    });

    test('Cohere v2 streaming parser captures citation-start records into turn.citations', () => {
        const parser = createProtocolStreamParser('cohere');
        parser.feedFrame(JSON.stringify({ type: 'message-start', delta: { message: { role: 'assistant' } } }), 'message-start');
        parser.feedFrame(JSON.stringify({ type: 'content-delta', delta: { message: { content: { text: 'Bryn reef shifts.' } } } }), 'content-delta');
        parser.feedFrame(JSON.stringify({
            type: 'citation-start',
            delta: {
                message: {
                    citations: {
                        start: 0,
                        end: 17,
                        text: 'Bryn reef shifts.',
                        sources: [{ type: 'document', id: 'doc_1', document: { title: 'Hydrography', url: 'https://charts.example.org/bryn' } }],
                    },
                },
            },
        }), 'citation-start');
        parser.feedFrame(JSON.stringify({ type: 'citation-end' }), 'citation-end');
        parser.feedFrame(JSON.stringify({ type: 'message-end', delta: { finish_reason: 'COMPLETE' } }), 'message-end');
        const turn = parser.finish();
        expect(turn.text).toBe('Bryn reef shifts.');
        expect(turn.citations).toHaveLength(1);
        expect(turn.citations[0].sources[0].document.url).toBe('https://charts.example.org/bryn');
    });

    test('OpenAI Responses streaming refusal delta emits refusalDelta without polluting textDelta', () => {
        const parser = createProtocolStreamParser('openai_responses');
        const d1 = parser.feedFrame(JSON.stringify({ type: 'response.output_text.delta', delta: 'Allowed text.' }), 'response.output_text.delta');
        expect(d1.textDelta).toBe('Allowed text.');
        expect(d1.refusalDelta).toBe('');
        const d2 = parser.feedFrame(JSON.stringify({ type: 'response.refusal.delta', delta: 'Cannot comply.' }), 'response.refusal.delta');
        expect(d2.textDelta).toBe('');
        expect(d2.refusalDelta).toBe('Cannot comply.');
        parser.feedFrame(JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [] } }), 'response.completed');
        const turn = parser.finish();
        expect(turn.text).toBe('Allowed text.');
        expect(turn.refusal).toBe('Cannot comply.');
    });

    test('accumulateChunkTextIntoJob decodes multi-byte UTF-8 split across chunk boundaries without replacement characters', () => {
        const req = {
            user: { profile: { handle: 'utf8-user' }, directories: {} },
            body: { chat_completion_source: 'openai', model: 'gpt-5.6-terra', stream: true },
        };
        const job = createGenerationJob(req, { job_id: 'utf8-split-job' });
        const sseBuf = Buffer.from(
            `data: ${JSON.stringify({ choices: [{ delta: { content: '海潮🌊灯塔' }, finish_reason: null }] })}\n\n`
            + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
            'utf8',
        );
        // Cut straight through the middle of the 3-byte UTF-8 sequence for '海' (0xE6 0xB5 0xB7).
        const cut = sseBuf.indexOf(0xE6) + 1;
        accumulateChunkTextIntoJob(job, sseBuf.subarray(0, cut));
        accumulateChunkTextIntoJob(job, sseBuf.subarray(cut));
        finalizeJobProtocolStream(job);
        expect(job.text).toBe('海潮🌊灯塔');
        expect(job.text).not.toContain('\uFFFD');
    });

    test('Request Inspector transitions pending plainTextFunctionCall status on HTTP 200 provider_error', () => {
        const reqNonStream = makeInspectorRequest('openai');
        reqNonStream.__lukerPlainTextMeta = { enabled: true, mode: 'prompt_xml', triggerSignal: '<Function_TEST_Start/>', attempt: 1, maxAttempts: 2 };
        startInspection(reqNonStream, 'chat');
        completeInspection(reqNonStream, { error: { message: 'rate limit exceeded' } });
        const nsEntry = getBufferForHandle(reqNonStream.user.profile.handle)[0];
        expect(nsEntry.status).toBe('error');
        expect(nsEntry.plainTextFunctionCall.status).toBe('network_error');

        const reqStream = makeInspectorRequest('claude');
        reqStream.__lukerPlainTextMeta = { enabled: true, mode: 'prompt_xml', triggerSignal: '<Function_TEST_Start/>', attempt: 1, maxAttempts: 2 };
        startInspection(reqStream, 'chat');
        completeInspectionFromStream(reqStream, [
            { event: 'error', data: JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } }) },
        ]);
        const stEntry = getBufferForHandle(reqStream.user.profile.handle)[0];
        expect(stEntry.status).toBe('error');
        expect(stEntry.plainTextFunctionCall.status).toBe('network_error');
    });

    test('rejects HTTP 200 non-SSE body as ProtocolParseError while allowing keepalive-only SSE comments', () => {
        const badStream = createProtocolStreamParser('openai');
        badStream.feedSseChunk('{"error":{"message":"upstream html proxy"}}\n');
        expect(() => badStream.finish()).toThrow(expect.objectContaining({
            name: 'ProtocolParseError',
            stage: 'sse',
        }));

        const keepaliveOnly = createProtocolStreamParser('openai');
        keepaliveOnly.feedSseChunk(': keep-alive\n\n: OPENROUTER PROCESSING\n\n');
        const turn = keepaliveOnly.finish();
        expect(turn.text).toBe('');
    });

    test('DeepSeek prompt_cache_miss_tokens is NOT mapped to cache_creation_tokens', () => {
        const turn = parseProtocolResponse('deepseek', {
            id: 'ds_1',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
            usage: {
                prompt_tokens: 1000,
                completion_tokens: 50,
                total_tokens: 1050,
                prompt_cache_hit_tokens: 400,
                prompt_cache_miss_tokens: 600,
            },
        });
        expect(turn.usage.prompt_tokens_details?.cached_tokens).toBe(400);
        expect(turn.usage.prompt_tokens_details?.cache_creation_tokens).toBeUndefined();
    });

    test('Cohere streaming routes tool-plan-delta to reasoning and reads content-start initial text', () => {
        const parser = createProtocolStreamParser('cohere');
        const dPlan = parser.feedFrame(JSON.stringify({
            type: 'tool-plan-delta',
            delta: { message: { tool_plan: 'Step 1: check weather.' } },
        }), 'tool-plan-delta');
        expect(dPlan.reasoningDelta).toBe('Step 1: check weather.');
        expect(dPlan.textDelta).toBe('');

        const dStart = parser.feedFrame(JSON.stringify({
            type: 'content-start',
            delta: { message: { content: { text: 'Initial ' } } },
        }), 'content-start');
        expect(dStart.textDelta).toBe('Initial ');

        parser.feedFrame(JSON.stringify({
            type: 'content-delta',
            delta: { message: { content: { text: 'reply.' } } },
        }), 'content-delta');
        parser.feedFrame(JSON.stringify({ type: 'message-end', delta: { finish_reason: 'COMPLETE' } }), 'message-end');

        const turn = parser.finish();
        expect(turn.reasoning).toBe('Step 1: check weather.');
        expect(turn.text).toBe('Initial reply.');
    });

    test('Gemini groundingMetadata chunks and OpenAI Responses annotations extract into turn.citations', () => {
        const gemTurn = parseProtocolResponse('makersuite', {
            candidates: [{
                content: { role: 'model', parts: [{ text: 'Grounded answer.' }] },
                finishReason: 'STOP',
                groundingMetadata: {
                    groundingChunks: [
                        { web: { uri: 'https://example.com/a', title: 'Article A' } },
                    ],
                },
            }],
        });
        expect(gemTurn.citations).toEqual([
            { type: 'grounding_web', url: 'https://example.com/a', title: 'Article A' },
        ]);

        const respTurn = parseProtocolResponse('openai_responses', {
            id: 'resp_cite',
            object: 'response',
            status: 'incomplete',
            incomplete_details: { reason: 'content_filter' },
            output: [{
                type: 'message',
                role: 'assistant',
                content: [{
                    type: 'output_text',
                    text: 'Cited answer.',
                    annotations: [{ type: 'url_citation', url: 'https://example.com/b', title: 'Article B', start_index: 0, end_index: 5 }],
                }],
            }],
        });
        expect(respTurn.citations).toEqual([
            { type: 'url_citation', url: 'https://example.com/b', title: 'Article B', start_index: 0, end_index: 5 },
        ]);
        expect(respTurn.finishReason).toBe('content_filter');
        expect(respTurn.nativeFinishReason).toBe('content_filter');
        const adapted = parsedTurnToChatCompletion(respTurn);
        expect(adapted.choices[0].native_finish_reason).toBe('content_filter');
        expect(adapted.citations).toHaveLength(1);
    });

    test('OpenAI Responses streaming handles response.cancelled, kind=thinking, and interleaved tool_call order', () => {
        const parser = createProtocolStreamParser('openai_responses');
        parser.feedFrame(JSON.stringify({ type: 'response.reasoning_summary_text.delta', delta: 'Plan.' }));
        parser.feedFrame(JSON.stringify({ type: 'response.output_text.delta', delta: 'Before tool.' }));
        parser.feedFrame(JSON.stringify({
            type: 'response.output_item.added',
            output_index: 1,
            item: { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '' },
        }));
        parser.feedFrame(JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"q":"x"}' }));
        parser.feedFrame(JSON.stringify({
            type: 'response.output_item.done',
            output_index: 1,
            item: { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' },
        }));
        parser.feedFrame(JSON.stringify({ type: 'response.output_text.delta', delta: 'After tool.' }));
        parser.feedFrame(JSON.stringify({ type: 'response.cancelled', response: { status: 'cancelled' } }));
        const turn = parser.finish();
        expect(turn.finishReason).toBe('cancelled');
        expect(turn.parts.map(p => p.type)).toEqual(['reasoning', 'text', 'tool_call', 'text']);
        expect(turn.parts[0].kind).toBe('thinking');
    });

    test('Claude streaming accepts mcp_tool_use input_json_delta and OpenAI Chat handles unindexed parallel tool_calls', () => {
        const claude = createProtocolStreamParser('claude');
        claude.feedFrame(JSON.stringify({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'mcp_tool_use', id: 'mcptoolu_1', name: 'remote_search', server_name: 'docs', input: {} },
        }));
        claude.feedFrame(JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"q":"mcp"}' },
        }));
        claude.feedFrame(JSON.stringify({ type: 'content_block_stop', index: 0 }));
        claude.feedFrame(JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }));
        claude.feedFrame(JSON.stringify({ type: 'message_stop' }));
        const claudeTurn = claude.finish();
        expect(claudeTurn.nativeContentBlocks[0].input).toEqual({ q: 'mcp' });

        const oai = createProtocolStreamParser('openai');
        oai.feedFrame(JSON.stringify({
            choices: [{ index: 0, delta: { tool_calls: [{ id: 'call_a', function: { name: 'fn_a', arguments: '{"a":1}' } }] } }],
        }));
        oai.feedFrame(JSON.stringify({
            choices: [{ index: 0, delta: { tool_calls: [{ id: 'call_b', function: { name: 'fn_b', arguments: '{"b":2}' } }] } }],
        }));
        oai.feedFrame(JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
        const oaiTurn = oai.finish();
        expect(oaiTurn.toolCalls.map(tc => tc.id)).toEqual(['call_a', 'call_b']);
        expect(oaiTurn.toolCalls.map(tc => tc.function.name)).toEqual(['fn_a', 'fn_b']);
    });

    test('OpenAI Chat non-streaming attaches per-tool encrypted signatures from reasoning_details', () => {
        const turn = parseProtocolResponse('openrouter', {
            id: 'or_1',
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: '',
                    reasoning_details: [
                        { type: 'reasoning.encrypted', id: 'call_42', data: 'sig_tool_42' },
                    ],
                    tool_calls: [{ id: 'call_42', type: 'function', function: { name: 'act', arguments: '{}' } }],
                },
                finish_reason: 'tool_calls',
            }],
        });
        expect(turn.toolCalls[0].signature).toBe('sig_tool_42');
    });

    test('OpenAI Chat streaming tolerates delta.tool_calls: null and benign metadata keepalive chunks', () => {
        const oai = createProtocolStreamParser('openai');
        expect(oai.feedFrame(JSON.stringify({}))).toMatchObject({ textDelta: '' });
        expect(oai.feedFrame(JSON.stringify({ id: 'cmpl-1', object: 'chat.completion.chunk', model: 'gpt-4o' }))).toMatchObject({ textDelta: '' });
        expect(oai.feedFrame(JSON.stringify({
            choices: [{ index: 0, delta: { content: 'Hello', tool_calls: null }, finish_reason: null }],
        }))).toMatchObject({ textDelta: 'Hello' });
        oai.feedFrame(JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: null }, finish_reason: 'stop' }] }));
        oai.feedFrame('[DONE]');
        const turn = oai.finish();
        expect(turn.text).toBe('Hello');
        expect(turn.toolCalls).toEqual([]);
    });

    test('OpenAI Chat classifies HTTP 200 message/detail/quota_error payloads as provider_error', () => {
        expect(() => parseProtocolResponse('openai', { message: 'quota exceeded' })).toThrow(expect.objectContaining({
            name: 'ProtocolParseError',
            stage: 'provider_error',
            message: 'quota exceeded',
        }));
        const stream = createProtocolStreamParser('openai');
        expect(() => stream.feedFrame(JSON.stringify({ detail: 'rate limited' }))).toThrow(expect.objectContaining({
            name: 'ProtocolParseError',
            stage: 'provider_error',
            message: 'rate limited',
        }));
    });

    test('Claude streaming auto-initializes missing content_block_start for text_delta while still rejecting orphan input_json_delta', () => {
        const claude = createProtocolStreamParser('claude');
        expect(claude.feedFrame(JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'proxy text' },
        }))).toMatchObject({ textDelta: 'proxy text' });
        claude.feedFrame(JSON.stringify({ type: 'message_stop' }));
        expect(claude.finish().text).toBe('proxy text');
    });

    test('Gemini non-streaming zero-candidate usageMetadata-only payload parses as retriable empty turn', () => {
        const turn = parseProtocolResponse('makersuite', {
            usageMetadata: { promptTokenCount: 20, totalTokenCount: 20 },
            modelVersion: 'gemini-2.5-flash',
        });
        expect(isParsedTurnEmpty(turn)).toBe(true);
    });

    test('Cohere non-streaming supports string message.content and preserves tool_plan as reasoning alongside text', () => {
        const strTurn = parseProtocolResponse('cohere', {
            id: 'c-str',
            finish_reason: 'COMPLETE',
            message: { role: 'assistant', content: 'Plain string reply', tool_plan: 'Internal plan' },
        });
        expect(strTurn.text).toBe('Plain string reply');
        expect(strTurn.reasoning).toBe('Internal plan');
    });

    test('buildCompatChatCompletionPayload and parseCompatChatCompletionResponse preserve native fields, OAI choices, and hook edits', async () => {
        const {
            buildCompatChatCompletionPayload,
            parseCompatChatCompletionResponse,
        } = await import('../public/scripts/lib/protocol-parser/index.js');

        const rawClaude = {
            id: 'msg_compat_1',
            type: 'message',
            role: 'assistant',
            content: [
                { type: 'thinking', thinking: 'step', signature: 'sig-1' },
                { type: 'text', text: 'Original reply' },
            ],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 },
        };
        const claudeTurn = parseProtocolResponse('claude', rawClaude);
        const compatClaude = buildCompatChatCompletionPayload(claudeTurn, rawClaude);
        expect(compatClaude.choices[0].message.content).toBe('Original reply');
        expect(compatClaude.content).toEqual(rawClaude.content);
        expect(compatClaude.usage.input_tokens).toBe(10);
        expect(compatClaude.usage.prompt_tokens).toBe(13);

        compatClaude.choices[0].message.content = 'Hook edited reply';
        const parsedCompat = parseCompatChatCompletionResponse('claude', compatClaude);
        expect(parsedCompat.text).toBe('Hook edited reply');
        expect(parsedCompat.reasoning).toBe('step');
        expect(parsedCompat.nativeContentBlocks).toEqual(rawClaude.content);

        const rawGemini = {
            candidates: [{
                content: { role: 'model', parts: [{ text: 'Gemini reply', thoughtSignature: 'g-sig' }] },
                finishReason: 'STOP',
            }],
            usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, totalTokenCount: 12 },
        };
        const compatGemini = buildCompatChatCompletionPayload(parseProtocolResponse('makersuite', rawGemini), rawGemini);
        expect(compatGemini.candidates).toEqual(rawGemini.candidates);
        expect(compatGemini.responseContent).toEqual(rawGemini.candidates[0].content);
        expect(compatGemini.choices[0].message.content).toBe('Gemini reply');
        const parsedGeminiCompat = parseCompatChatCompletionResponse('makersuite', compatGemini);
        expect(parsedGeminiCompat.text).toBe('Gemini reply');
        expect(parsedGeminiCompat.signature).toBe('g-sig');
        expect(parsedGeminiCompat.nativeParts).toEqual(rawGemini.candidates[0].content.parts);
    });

    test('Claude stream parser never fabricates {} tool calls on truncated or unclosed premature EOF', () => {
        // 1) Truncated JSON mid-arguments throws tool_correlation and hides incomplete tool block
        const truncated = createProtocolStreamParser('claude');
        truncated.feedFrame(JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_trunc', name: 'delete_file', input: {} } }), 'content_block_start');
        truncated.feedFrame(JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"/tmp/a' } }), 'content_block_delta');
        expect(truncated.getSnapshot().toolCalls).toEqual([]);
        expect(() => truncated.finish()).toThrow(expect.objectContaining({ name: 'ProtocolParseError', stage: 'tool_correlation' }));
        expect(truncated.getSnapshot().toolCalls).toEqual([]);

        // 2) Unclosed content_block_start with no deltas throws eof and leaves snapshot empty
        const unclosed = createProtocolStreamParser('claude');
        unclosed.feedFrame(JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_open', name: 'delete_file', input: {} } }), 'content_block_start');
        expect(() => unclosed.finish()).toThrow(expect.objectContaining({ name: 'ProtocolParseError', stage: 'eof' }));
        expect(unclosed.getSnapshot().toolCalls).toEqual([]);
        expect(isParsedTurnEmpty(unclosed.getSnapshot())).toBe(true);

        // 3) Complete valid JSON buffered before premature EOF is preserved on snapshot
        const completeBuffered = createProtocolStreamParser('claude');
        completeBuffered.feedFrame(JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_ok', name: 'lookup', input: {} } }), 'content_block_start');
        completeBuffered.feedFrame(JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":"luker"}' } }), 'content_block_delta');
        expect(() => completeBuffered.finish()).toThrow(expect.objectContaining({ name: 'ProtocolParseError', stage: 'eof' }));
        expect(completeBuffered.getSnapshot().toolCalls).toEqual([
            { id: 'toolu_ok', type: 'function', function: { name: 'lookup', arguments: '{"q":"luker"}' } },
        ]);
    });

    test('OpenAI Chat stream parser treats repeated delta function.name as assign-once', () => {
        const oai = createProtocolStreamParser('openai');
        oai.feedFrame(JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"a":' } }] } }],
        }));
        oai.feedFrame(JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '1}' } }] } }],
        }));
        oai.feedFrame(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
        oai.feedFrame('[DONE]');
        const turn = oai.finish();
        expect(turn.toolCalls).toEqual([
            { id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"a":1}' } },
        ]);
    });
});
