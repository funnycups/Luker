// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from '@jest/globals';
import {
    resolveStreamingFinalReturn,
    resolveStreamingFrameDisplay,
    resolveStreamingToolReplyTarget,
    shouldSkipIntermediaryFinalizeForToolPreview,
} from '../public/scripts/lib/streaming-tool-reply.js';
import {
    accumulateChunkTextIntoJob,
    createGenerationJob,
    finalizeJobProtocolStream,
    getJobDisplayText,
    notifyJobTextProgress,
    subscribeToJob,
} from '../src/endpoints/backends/luker-generation.js';

describe('streaming tool-reply target resolution', () => {
    const activeTools = [
        { type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { q: { type: 'string' } } } } },
        { type: 'function', function: { name: 'reply', parameters: { type: 'object', properties: { body: { type: 'string' } } } } },
    ];

    test('applies precedence: explicit requestBody hook > preset extensions.luker > registered tool metadata', () => {
        const registeredTools = [{ name: 'reply', streamingPreviewArgument: 'tool_body' }];
        const requestSettings = { extensions: { luker: { streaming_tool_reply: { name: 'reply', argument: 'preset_body' } } } };

        // 1) Explicit hook override wins
        expect(resolveStreamingToolReplyTarget({
            stream: true,
            shouldRunChatCompletionHooks: true,
            requestBody: { tools: activeTools, luker_streaming_tool_reply: { name: 'reply', argument: 'hook.body' } },
            requestSettings,
            registeredTools,
        })).toEqual({ name: 'reply', argument: 'hook.body', path: ['hook', 'body'] });

        // 2) Explicit null/false hook opt-out disables preview even when preset configures it
        expect(resolveStreamingToolReplyTarget({
            stream: true,
            shouldRunChatCompletionHooks: true,
            requestBody: { tools: activeTools, luker_streaming_tool_reply: false },
            requestSettings,
            registeredTools,
        })).toBeNull();

        // 3) Preset extensions.luker wins over tool registration
        expect(resolveStreamingToolReplyTarget({
            stream: true,
            shouldRunChatCompletionHooks: true,
            requestBody: { tools: activeTools },
            requestSettings,
            registeredTools,
        })).toEqual({ name: 'reply', argument: 'preset_body', path: ['preset_body'] });

        // 4) Registered ToolManager tool with streamingPreviewArgument activates automatically when tool is active
        expect(resolveStreamingToolReplyTarget({
            stream: true,
            shouldRunChatCompletionHooks: true,
            requestBody: { tools: activeTools },
            requestSettings: { extensions: {} },
            registeredTools,
        })).toEqual({ name: 'reply', argument: 'tool_body', path: ['tool_body'] });

        // 5) Disabled when non-streaming or extension_internal scope without explicit override
        expect(resolveStreamingToolReplyTarget({
            stream: false,
            shouldRunChatCompletionHooks: true,
            requestBody: { tools: activeTools },
            requestSettings,
            registeredTools,
        })).toBeNull();
        expect(resolveStreamingToolReplyTarget({
            stream: true,
            shouldRunChatCompletionHooks: false,
            requestBody: { tools: activeTools },
            requestSettings,
            registeredTools,
        })).toBeNull();
    });

    test('prefers the forced tool_choice match when multiple registered tools declare streamingPreviewArgument', () => {
        const registeredTools = [
            { name: 'lookup', streamingPreviewArgument: 'q' },
            { name: 'reply', streamingPreviewArgument: 'body' },
        ];
        expect(resolveStreamingToolReplyTarget({
            stream: true,
            shouldRunChatCompletionHooks: true,
            requestBody: {
                tools: activeTools,
                tool_choice: { type: 'function', function: { name: 'reply' } },
            },
            requestSettings: {},
            registeredTools,
        })).toEqual({ name: 'reply', argument: 'body', path: ['body'] });
    });
});

describe('StreamingProcessor preview vs committed output separation', () => {
    test('renders preview even after whitespace-only preamble, flags firstToolPreview once, and replaces cleanly on real EOF output', () => {
        const s1 = resolveStreamingFrameDisplay({
            output: '\n',
            toolCallPreview: '第一段',
            previousResult: '',
            previousShowingPreview: false,
        });
        expect(s1).toEqual({
            displayText: '第一段',
            committedResult: '\n',
            toolCallPreview: '第一段',
            showingToolCallPreview: true,
            firstToolPreview: true,
            previewCleared: false,
        });

        const s2 = resolveStreamingFrameDisplay({
            output: '\n',
            toolCallPreview: '第一段续',
            previousResult: s1.committedResult,
            previousShowingPreview: s1.showingToolCallPreview,
        });
        expect(s2.displayText).toBe('第一段续');
        expect(s2.firstToolPreview).toBe(false);
        expect(s2.previewCleared).toBe(false);
        expect(s2.showingToolCallPreview).toBe(true);

        // Consuming formatter replaces preview with final formatted reply at EOF
        const s3 = resolveStreamingFrameDisplay({
            output: '**Formatted:** 第一段续',
            toolCallPreview: '第一段续',
            previousResult: s2.committedResult,
            previousShowingPreview: s2.showingToolCallPreview,
        });
        expect(s3.displayText).toBe('**Formatted:** 第一段续');
        expect(s3.committedResult).toBe('**Formatted:** 第一段续');
        expect(s3.showingToolCallPreview).toBe(false);
        expect(s3.previewCleared).toBe(true);
        expect(resolveStreamingFinalReturn({
            result: s3.committedResult,
            toolCallPreview: s3.toolCallPreview,
            showingToolCallPreview: s3.showingToolCallPreview,
            hasCompletedToolCalls: false,
        })).toBe('**Formatted:** 第一段续');
    });

    test('completed ToolManager call returns empty committed result and suppresses premature intermediary finalize', () => {
        expect(shouldSkipIntermediaryFinalizeForToolPreview({
            showingToolCallPreview: true,
            result: '',
        })).toBe(true);
        expect(resolveStreamingFinalReturn({
            result: '',
            toolCallPreview: '原始预览',
            showingToolCallPreview: true,
            hasCompletedToolCalls: true,
        })).toBe('');
    });

    test('truncation or abort without completed tool call preserves readable partial preview', () => {
        expect(resolveStreamingFinalReturn({
            result: '',
            toolCallPreview: '半截草稿',
            showingToolCallPreview: true,
            hasCompletedToolCalls: false,
        })).toBe('半截草稿');
    });
});

describe('luker-generation live recovery preview for streaming tool replies', () => {
    test('surfaces streaming tool preview over live status notifications without polluting persisted job.text on completed calls', () => {
        const req = {
            user: { profile: { handle: 'preview-recovery-user' }, directories: {} },
            body: {
                chat_completion_source: 'openai',
                model: 'gpt-4o',
                messages: [{ role: 'user', content: 'hi' }],
            },
        };
        const job = createGenerationJob(req, {
            job_id: 'preview-recovery-job-1',
            streaming_tool_reply: { name: 'reply', argument: 'body', path: ['body'] },
        });
        const statusFrames = [];
        const unsub = subscribeToJob(job.id, (msg) => {
            if (msg.type === 'status') statusFrames.push(msg);
        });
        try {
            accumulateChunkTextIntoJob(job, Buffer.from(
                'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"reply","arguments":"{\\"body\\":\\"你好"}}]}}]}\n\n',
                'utf8',
            ));
            notifyJobTextProgress(job);
            expect(job._toolCallPreview).toBe('你好');
            expect(job.text).toBe('');
            expect(getJobDisplayText(job)).toBe('你好');
            expect(statusFrames.at(-1)?.text).toBe('你好');

            accumulateChunkTextIntoJob(job, Buffer.from(
                'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"世界\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
                'utf8',
            ));
            finalizeJobProtocolStream(job);
            expect(job.parsedTurn.toolCalls).toHaveLength(1);
            expect(job.text).toBe('');
            expect(getJobDisplayText(job)).toBe('');
        } finally {
            unsub();
        }
    });

    test('preserves partial preview on length-truncated generation job when no tool call completed', () => {
        const req = {
            user: { profile: { handle: 'preview-recovery-user-2' }, directories: {} },
            body: {
                chat_completion_source: 'claude',
                model: 'claude-sonnet-4-5',
                messages: [{ role: 'user', content: 'hi' }],
            },
        };
        const job = createGenerationJob(req, {
            job_id: 'preview-recovery-job-2',
            streaming_tool_reply: { name: 'reply', argument: 'body', path: ['body'] },
        });
        const sse = [
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu1","name":"reply","input":{}}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"body\\":\\"半截预览"}}\n\n',
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ].join('');
        accumulateChunkTextIntoJob(job, Buffer.from(sse, 'utf8'));
        finalizeJobProtocolStream(job);
        expect(job.parseError ?? null).toBeNull();
        expect(job.parsedTurn.toolCalls).toEqual([]);
        expect(job.parsedTurn.finishReason).toBe('length');
        expect(job._toolCallPreview).toBe('半截预览');
        expect(getJobDisplayText(job)).toBe('半截预览');
    });
});
