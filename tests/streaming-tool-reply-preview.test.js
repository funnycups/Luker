// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from '@jest/globals';
import {
    createProtocolStreamParser,
    ProtocolParseError,
} from '../public/scripts/lib/protocol-parser/index.js';
import {
    createIncrementalJsonStringExtractor,
    extractStreamingJsonStringAtPath,
} from '../public/scripts/lib/protocol-parser/parsers/json-argument-preview.js';
import {
    isStringSchemaNode,
    normalizeStreamingToolReplyConfig,
    parseArgumentPath,
    resolveSchemaPropertyAtPath,
} from '../public/scripts/lib/streaming-tool-reply.js';

describe('streaming-tool-reply path & schema helpers', () => {
    test('parses top-level, nested dot/bracket, JSONPath, and array paths while rejecting prototype keys', () => {
        expect(parseArgumentPath('body')).toEqual(['body']);
        expect(parseArgumentPath('payload.paragraphs[0].text')).toEqual(['payload', 'paragraphs', 0, 'text']);
        expect(parseArgumentPath('$.items[2]["a.b"]')).toEqual(['items', 2, 'a.b']);
        expect(parseArgumentPath(['reply', 'text'])).toEqual(['reply', 'text']);
        expect(parseArgumentPath('__proto__.x')).toBeNull();
        expect(parseArgumentPath('[0].text')).toBeNull();
        expect(parseArgumentPath('')).toBeNull();
    });

    test('normalizes streaming_tool_reply declarations and resolves string schema leaves', () => {
        expect(normalizeStreamingToolReplyConfig({ name: ' reply ', argument: 'payload.body' })).toEqual({
            name: 'reply',
            argument: 'payload.body',
            path: ['payload', 'body'],
        });
        expect(normalizeStreamingToolReplyConfig({ name: '', argument: 'body' })).toBeNull();
        expect(normalizeStreamingToolReplyConfig({ name: 'reply', argument: '' })).toBeNull();

        const schema = {
            type: 'object',
            properties: {
                body: { type: 'STRING' },
                count: { type: 'number' },
                payload: {
                    type: 'object',
                    properties: {
                        items: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    text: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                                },
                            },
                        },
                    },
                },
            },
        };
        expect(isStringSchemaNode(resolveSchemaPropertyAtPath(schema, 'body'))).toBe(true);
        expect(isStringSchemaNode(resolveSchemaPropertyAtPath(schema, 'count'))).toBe(false);
        expect(isStringSchemaNode(resolveSchemaPropertyAtPath(schema, 'payload.items[0].text'))).toBe(true);
        expect(resolveSchemaPropertyAtPath(schema, 'missing')).toBeNull();
    });
});

describe('incremental JSON string-field extractor', () => {
    test('decodes growing strings, split escape sequences, and UTF-16 surrogate pairs without flashing incomplete sequences', () => {
        const extractor = createIncrementalJsonStringExtractor(['body']);
        const chunks = [
            '{"meta": {"id": 1}, "bo',
            'dy": "你好\\',
            'n\\"花\\',
            'u4e',
            '2d\\uD8',
            '3D',
            '\\uDE00',
            '尾',
            '"}',
        ];
        const snapshots = chunks.map(chunk => {
            extractor.feed(chunk);
            return extractor.getValue();
        });
        expect(snapshots).toEqual([
            '',
            '你好',
            '你好\n"花',
            '你好\n"花',
            '你好\n"花中',
            '你好\n"花中',
            '你好\n"花中😀',
            '你好\n"花中😀尾',
            '你好\n"花中😀尾',
        ]);
    });

    test('ignores decoy key names inside earlier sibling string values and handles nested paths', () => {
        const json = '{"note":"fake \\"body\\":\\"WRONG\\"","arr":[{"text":"skip"},{"text":"RIGHT\\t!"}],"body":"TOP"}';
        expect(extractStreamingJsonStringAtPath(json, ['body'])).toBe('TOP');
        expect(extractStreamingJsonStringAtPath(json, ['arr', 1, 'text'])).toBe('RIGHT\t!');
        expect(extractStreamingJsonStringAtPath('{"body": 123}', ['body'])).toBe('');
        expect(extractStreamingJsonStringAtPath('{"body": null}', ['body'])).toBe('');
        expect(extractStreamingJsonStringAtPath('{"body": {"nested":"x"}}', ['body'])).toBe('');
    });
});

describe('all-protocol streaming tool argument previews and length truncation', () => {
    test('OpenAI Chat streams argument previews across parallel calls and preserves preview on length truncation', () => {
        const parser = createProtocolStreamParser('openrouter');
        parser.feedFrame(JSON.stringify({
            choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c_meta', function: { name: 'log', arguments: '{"k":"v"}' } }] } }],
        }));
        parser.feedFrame(JSON.stringify({
            choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'c_reply', function: { name: 'reply', arguments: '{"body":"第' } }] } }],
        }));
        expect(parser.getToolCallPreview('reply', 'body')).toBe('第');
        parser.feedFrame(JSON.stringify({
            choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '一句\\n第二句' } }] } }],
        }));
        expect(parser.getToolCallPreview('reply', 'body')).toBe('第一句\n第二句');
        expect(parser.getSnapshot().toolCalls.map(c => c.id)).toEqual(['c_meta']);

        // Truncated by finish_reason: 'length' — incomplete reply call must NOT leak into toolCalls.
        parser.feedFrame(JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }));
        parser.feedFrame('[DONE]');
        const turn = parser.finish();
        expect(turn.finishReason).toBe('length');
        expect(turn.toolCalls.map(c => c.id)).toEqual(['c_meta']);
        expect(parser.getToolCallPreview('reply', 'body')).toBe('第一句\n第二句');
    });

    test('Claude streams input_json_delta previews and excludes max_tokens truncated tool blocks cleanly', () => {
        const parser = createProtocolStreamParser('claude');
        parser.feedFrame(JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }));
        parser.feedFrame(JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } }));
        parser.feedFrame(JSON.stringify({ type: 'content_block_stop', index: 0 }));
        parser.feedFrame(JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'reply', input: {} } }));
        parser.feedFrame(JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"payload":{"body":"月' } }));
        expect(parser.getToolCallPreview('reply', 'payload.body')).toBe('月');
        parser.feedFrame(JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '光如水' } }));
        expect(parser.getToolCallPreview('reply', 'payload.body')).toBe('月光如水');
        // Anthropic sends content_block_stop BEFORE message_delta(stop_reason: max_tokens).
        parser.feedFrame(JSON.stringify({ type: 'content_block_stop', index: 1 }));
        parser.feedFrame(JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }));
        parser.feedFrame(JSON.stringify({ type: 'message_stop' }));

        const turn = parser.finish();
        expect(turn.finishReason).toBe('length');
        expect(turn.toolCalls).toEqual([]);
        expect(turn.nativeContentBlocks).toEqual([{ type: 'thinking', thinking: 'plan' }]);
        expect(parser.getToolCallPreview('reply', 'payload.body')).toBe('月光如水');
    });

    test('Claude still rejects malformed tool JSON when stop_reason is tool_use', () => {
        const parser = createProtocolStreamParser('claude');
        parser.feedFrame(JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_bad', name: 'reply', input: {} } }));
        parser.feedFrame(JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"body":"unclosed' } }));
        parser.feedFrame(JSON.stringify({ type: 'content_block_stop', index: 0 }));
        parser.feedFrame(JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }));
        parser.feedFrame(JSON.stringify({ type: 'message_stop' }));
        expect(() => parser.finish()).toThrow(expect.objectContaining({
            name: 'ProtocolParseError',
            stage: 'tool_correlation',
        }));
    });

    test('OpenAI Responses streams function_call_arguments.delta previews and tolerates response.incomplete length truncation', () => {
        const parser = createProtocolStreamParser('openai_responses');
        parser.feedFrame(JSON.stringify({
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'function_call', call_id: 'fc_1', name: 'reply', arguments: '' },
        }));
        parser.feedFrame(JSON.stringify({
            type: 'response.function_call_arguments.delta',
            output_index: 0,
            delta: '{"body":"星',
        }));
        expect(parser.getToolCallPreview('reply', 'body')).toBe('星');
        parser.feedFrame(JSON.stringify({
            type: 'response.function_call_arguments.delta',
            output_index: 0,
            delta: '辰大海',
        }));
        expect(parser.getToolCallPreview('reply', 'body')).toBe('星辰大海');
        parser.feedFrame(JSON.stringify({
            type: 'response.incomplete',
            response: {
                status: 'incomplete',
                incomplete_details: { reason: 'max_output_tokens' },
                output: [{ type: 'function_call', call_id: 'fc_1', name: 'reply', arguments: '{"body":"星辰大海', status: 'incomplete' }],
            },
        }));

        const turn = parser.finish();
        expect(turn.finishReason).toBe('length');
        expect(turn.toolCalls).toEqual([]);
        expect(turn.responsesOutputItems).toBeNull();
        expect(parser.getToolCallPreview('reply', 'body')).toBe('星辰大海');
    });

    test('Cohere v2 streams tool-call-delta previews and tolerates MAX_TOKENS truncation', () => {
        const parser = createProtocolStreamParser('cohere');
        parser.feedFrame(JSON.stringify({
            type: 'tool-call-start',
            index: 0,
            delta: { message: { tool_calls: { id: 'co_reply', function: { name: 'reply', arguments: '' } } } },
        }));
        parser.feedFrame(JSON.stringify({
            type: 'tool-call-delta',
            index: 0,
            delta: { message: { tool_calls: { function: { arguments: '{"body":"清风' } } } },
        }));
        expect(parser.getToolCallPreview('reply', 'body')).toBe('清风');
        parser.feedFrame(JSON.stringify({
            type: 'tool-call-delta',
            index: 0,
            delta: { message: { tool_calls: { function: { arguments: '徐来' } } } },
        }));
        expect(parser.getToolCallPreview('reply', 'body')).toBe('清风徐来');
        parser.feedFrame(JSON.stringify({ type: 'tool-call-end', index: 0 }));
        parser.feedFrame(JSON.stringify({ type: 'message-end', delta: { finish_reason: 'MAX_TOKENS' } }));

        const turn = parser.finish();
        expect(turn.finishReason).toBe('length');
        expect(turn.toolCalls).toEqual([]);
        expect(parser.getToolCallPreview('reply', 'body')).toBe('清风徐来');
    });

    test('completed calls across all 4 JSON-string protocols keep preview readable after completion', () => {
        const oai = createProtocolStreamParser('openai');
        oai.feedFrame(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'reply', arguments: '{"body":"done"}' } }] } }] }));
        oai.feedFrame(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
        expect(oai.finish().toolCalls).toHaveLength(1);
        expect(oai.getToolCallPreview('reply', 'body')).toBe('done');

        const claude = createProtocolStreamParser('claude');
        claude.feedFrame(JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'reply', input: {} } }));
        claude.feedFrame(JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"body":"done"}' } }));
        claude.feedFrame(JSON.stringify({ type: 'content_block_stop', index: 0 }));
        claude.feedFrame(JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }));
        claude.feedFrame(JSON.stringify({ type: 'message_stop' }));
        expect(claude.finish().toolCalls).toHaveLength(1);
        expect(claude.getToolCallPreview('reply', 'body')).toBe('done');

        const resp = createProtocolStreamParser('openai_responses');
        resp.feedFrame(JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'r1', name: 'reply', arguments: '' } }));
        resp.feedFrame(JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"body":"done"}' }));
        resp.feedFrame(JSON.stringify({ type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"body":"done"}' }));
        resp.feedFrame(JSON.stringify({ type: 'response.completed', response: { status: 'completed' } }));
        expect(resp.finish().toolCalls).toHaveLength(1);
        expect(resp.getToolCallPreview('reply', 'body')).toBe('done');

        const cohere = createProtocolStreamParser('cohere');
        cohere.feedFrame(JSON.stringify({ type: 'tool-call-start', index: 0, delta: { message: { tool_calls: { id: 'co1', function: { name: 'reply', arguments: '{"body":"done"}' } } } } }));
        cohere.feedFrame(JSON.stringify({ type: 'tool-call-end', index: 0 }));
        cohere.feedFrame(JSON.stringify({ type: 'message-end', delta: { finish_reason: 'TOOL_CALL' } }));
        expect(cohere.finish().toolCalls).toHaveLength(1);
        expect(cohere.getToolCallPreview('reply', 'body')).toBe('done');
    });
});
