/**
 * substituteMacros opt-in tests for requestToolCallsWithRetry.
 *
 * The shared runner hardcodes a default of `substituteMacros: false`
 * because the iter-studio popups edit raw source text and must see
 * literal `{{...}}` templates. Callers that read resolved content —
 * e.g. the search agent reading chat text — opt in by passing
 * `substituteMacros: true`, which is forwarded to generateTask.
 */

import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';
import {
    buildPersistentToolHistoryMessages,
    createPersistentToolTurnMessage,
    requestToolCallsWithRetry,
    waitForRpmSlot,
} from '../../public/scripts/lib/iter-tool-calling.js';
import { TOOL_PROTOCOL_STYLE } from '../../public/scripts/extensions/function-call-runtime.js';

const tools = [{
    type: 'function',
    function: {
        name: 'noop',
        description: 'Stub tool; never actually executed.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
}];

function makeContext() {
    return {
        generateTask: jest.fn(async () => ({
            assistantText: 'ok',
            toolCalls: [{ name: 'noop', args: {} }],
        })),
    };
}

describe('requestToolCallsWithRetry — substituteMacros opt-in', () => {
    test('forwards substituteMacros: true to generateTask when opted in', async () => {
        const context = makeContext();
        await requestToolCallsWithRetry(context, { rpmLimit: 0 }, {
            tools,
            includeAssistantText: true,
            substituteMacros: true,
        });
        expect(context.generateTask).toHaveBeenCalledTimes(1);
        expect(context.generateTask.mock.calls[0][0].substituteMacros).toBe(true);
    });

    test('defaults substituteMacros to false when omitted', async () => {
        const context = makeContext();
        await requestToolCallsWithRetry(context, { rpmLimit: 0 }, {
            tools,
            includeAssistantText: true,
        });
        expect(context.generateTask).toHaveBeenCalledTimes(1);
        expect(context.generateTask.mock.calls[0][0].substituteMacros).toBe(false);
        expect(context.generateTask.mock.calls[0][0].includeCharacterCard).toBe(true);
    });

    test('forwards promptContext, transientSessionId, onPreparedRequest, and explicit includeCharacterCard=false', async () => {
        const context = {
            ...makeContext(),
            isStreamingPresetEnabled: () => false,
        };
        const promptContext = { scope: 'preset', envelope: { version: 1 }, runtimeWorldInfo: {}, macroEnv: {} };
        const onPreparedRequest = jest.fn();
        await requestToolCallsWithRetry(context, { rpmLimit: 0 }, {
            tools,
            includeCharacterCard: false,
            promptContext,
            transientSessionId: '550e8400-e29b-41d4-a716-446655440000',
            onPreparedRequest,
        });
        expect(context.generateTask).toHaveBeenCalledTimes(1);
        expect(context.generateTask.mock.calls[0][0]).toMatchObject({
            includeCharacterCard: false,
            promptContext,
            transientSessionId: '550e8400-e29b-41d4-a716-446655440000',
            onPreparedRequest,
        });
    });

    test('forwards isolation options on the streaming preset path as well', async () => {
        const promptContext = { scope: 'chat', envelope: { version: 1 }, runtimeWorldInfo: {}, macroEnv: {} };
        const onPreparedRequest = jest.fn();
        const generateTaskStream = jest.fn(() => ({
            stream: (async function* () {
                yield { type: 'text', delta: 'ok' };
            })(),
            result: Promise.resolve({
                assistantText: 'ok',
                toolCalls: [{ name: 'noop', args: {} }],
            }),
        }));
        const context = {
            generateTask: jest.fn(),
            generateTaskStream,
            isStreamingPresetEnabled: () => true,
        };
        await requestToolCallsWithRetry(context, { rpmLimit: 0 }, {
            tools,
            llmPresetName: 'StreamPreset',
            includeCharacterCard: false,
            promptContext,
            transientSessionId: '550e8400-e29b-41d4-a716-446655440000',
            onPreparedRequest,
        });
        expect(generateTaskStream).toHaveBeenCalledTimes(1);
        expect(generateTaskStream.mock.calls[0][0]).toMatchObject({
            includeCharacterCard: false,
            promptContext,
            transientSessionId: '550e8400-e29b-41d4-a716-446655440000',
            onPreparedRequest,
        });
    });
});

// ── Generic runner options ──────────────────────────────────────────────
// Defaults must reproduce the existing wire for every caller; memory-graph
// opts into a forced tool choice, empty-response tolerance, its own RPM
// bucket and a log label.

const WIRE_KEYS = [
    'abortSignal',
    'apiPresetName',
    'functionCallMode',
    'functionCallOptions',
    'includeCharacterCard',
    'llmPresetName',
    'runtimeWorldInfo',
    'substituteMacros',
    'taskMessages',
    'toolChoice',
    'tools',
    'worldInfoSource',
];

function makeQueuedContext(results) {
    const queue = [...results];
    return {
        generateTask: jest.fn(async () => queue.shift() ?? { assistantText: '', toolCalls: [] }),
    };
}

describe('requestToolCallsWithRetry — default wire', () => {
    test('omitting the new options keeps the existing generateTask payload', async () => {
        const context = makeContext();
        await requestToolCallsWithRetry(context, { rpmLimit: 0 }, { tools });
        const opts = context.generateTask.mock.calls[0][0];
        expect(Object.keys(opts).sort()).toEqual(WIRE_KEYS);
        expect(opts.toolChoice).toBe('auto');
        expect(opts.functionCallMode).toBe('auto');
        expect(opts.functionCallOptions).toEqual({ protocolStyle: TOOL_PROTOCOL_STYLE.JSON_SCHEMA });
        expect(opts.runtimeWorldInfo).toEqual({});
        expect(opts.includeCharacterCard).toBe(true);
        expect(opts.worldInfoSource).toBe('none');
    });
});

describe('requestToolCallsWithRetry — toolChoice and requiredFunctionName', () => {
    test('passes a forced tool choice through to generateTask', async () => {
        const context = makeContext();
        const forced = { type: 'function', function: { name: 'noop' } };
        await requestToolCallsWithRetry(context, { rpmLimit: 0 }, { tools, toolChoice: forced });
        expect(context.generateTask.mock.calls[0][0].toolChoice).toEqual(forced);
    });

    test('adds requiredFunctionName to functionCallOptions when set', async () => {
        const context = makeContext();
        await requestToolCallsWithRetry(context, { rpmLimit: 0 }, { tools, requiredFunctionName: 'noop' });
        expect(context.generateTask.mock.calls[0][0].functionCallOptions).toEqual({
            protocolStyle: TOOL_PROTOCOL_STYLE.JSON_SCHEMA,
            requiredFunctionName: 'noop',
        });
    });

    test('a blank requiredFunctionName leaves functionCallOptions untouched', async () => {
        const context = makeContext();
        await requestToolCallsWithRetry(context, { rpmLimit: 0 }, { tools, requiredFunctionName: '   ' });
        expect(context.generateTask.mock.calls[0][0].functionCallOptions).toEqual({
            protocolStyle: TOOL_PROTOCOL_STYLE.JSON_SCHEMA,
        });
    });

    test('runner-only options never reach generateTask', async () => {
        const context = makeContext();
        await requestToolCallsWithRetry(context, { rpmLimit: 0 }, {
            tools,
            toolChoice: { type: 'function', function: { name: 'noop' } },
            requiredFunctionName: 'noop',
            allowEmptyResponse: true,
            rpmBucket: 'wire-check',
            logLabel: 'wire-check',
        });
        expect(Object.keys(context.generateTask.mock.calls[0][0]).sort()).toEqual(WIRE_KEYS);
    });
});

describe('requestToolCallsWithRetry — empty responses', () => {
    let warnSpy;
    beforeEach(() => {
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
        warnSpy.mockRestore();
    });

    test('an empty response throws by default and is retried', async () => {
        const context = makeQueuedContext([]);
        await expect(requestToolCallsWithRetry(context, { rpmLimit: 0, toolCallRetryMax: 1 }, { tools }))
            .rejects.toThrow('Model response did not contain any matching tool calls.');
        expect(context.generateTask).toHaveBeenCalledTimes(2);
    });

    test('allowEmptyResponse returns an empty list after one request', async () => {
        const context = makeQueuedContext([]);
        const result = await requestToolCallsWithRetry(context, { rpmLimit: 0, toolCallRetryMax: 2 }, {
            tools,
            allowEmptyResponse: true,
        });
        expect(result).toEqual([]);
        expect(context.generateTask).toHaveBeenCalledTimes(1);
    });

    test('allowEmptyResponse with includeAssistantText returns an empty envelope', async () => {
        const context = makeQueuedContext([]);
        const result = await requestToolCallsWithRetry(context, { rpmLimit: 0, toolCallRetryMax: 2 }, {
            tools,
            allowEmptyResponse: true,
            includeAssistantText: true,
        });
        expect(result.toolCalls).toEqual([]);
        expect(result.assistantText).toBe('');
        expect(context.generateTask).toHaveBeenCalledTimes(1);
    });

    test('allowEmptyResponse also accepts text-only and filtered-out responses', async () => {
        const textOnly = makeQueuedContext([{ assistantText: 'The ledger has nothing new tonight.', toolCalls: [] }]);
        await expect(requestToolCallsWithRetry(textOnly, { rpmLimit: 0, toolCallRetryMax: 2 }, {
            tools,
            allowEmptyResponse: true,
        })).resolves.toEqual([]);
        expect(textOnly.generateTask).toHaveBeenCalledTimes(1);

        const filteredOut = makeQueuedContext([{ assistantText: '', toolCalls: [{ name: 'unlisted_tool', args: {} }] }]);
        await expect(requestToolCallsWithRetry(filteredOut, { rpmLimit: 0, toolCallRetryMax: 2 }, {
            tools,
            allowedNames: ['noop'],
            allowEmptyResponse: true,
        })).resolves.toEqual([]);
        expect(filteredOut.generateTask).toHaveBeenCalledTimes(1);
    });

    test('allowNoToolCalls still requires assistant text', async () => {
        const empty = makeQueuedContext([]);
        await expect(requestToolCallsWithRetry(empty, { rpmLimit: 0, toolCallRetryMax: 0 }, {
            tools,
            allowNoToolCalls: true,
        })).rejects.toThrow('Model response did not contain any matching tool calls.');

        const text = makeQueuedContext([{ assistantText: 'Charted and done.', toolCalls: [] }]);
        const result = await requestToolCallsWithRetry(text, { rpmLimit: 0, toolCallRetryMax: 0 }, {
            tools,
            allowNoToolCalls: true,
            includeAssistantText: true,
        });
        expect(result.toolCalls).toEqual([]);
        expect(result.assistantText).toBe('Charted and done.');
    });
});

describe('requestToolCallsWithRetry — logLabel', () => {
    let warnSpy;
    beforeEach(() => {
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
        warnSpy.mockRestore();
    });

    test('prefixes the retry warning with logLabel', async () => {
        const context = makeQueuedContext([
            { assistantText: '', toolCalls: [] },
            { assistantText: '', toolCalls: [{ name: 'noop', args: {} }] },
        ]);
        await requestToolCallsWithRetry(context, { rpmLimit: 0, toolCallRetryMax: 1 }, {
            tools,
            logLabel: 'memory_graph:extract',
        });
        expect(warnSpy.mock.calls[0][0]).toBe('[memory_graph:extract] Multi tool call request failed. Retrying (1/1)...');
    });

    test('the default prefix stays orchestrator', async () => {
        const context = makeQueuedContext([
            { assistantText: '', toolCalls: [] },
            { assistantText: '', toolCalls: [{ name: 'noop', args: {} }] },
        ]);
        await requestToolCallsWithRetry(context, { rpmLimit: 0, toolCallRetryMax: 1 }, { tools });
        expect(warnSpy.mock.calls[0][0]).toBe('[orchestrator] Multi tool call request failed. Retrying (1/1)...');
    });
});

describe('waitForRpmSlot — buckets', () => {
    const settings = { rpmLimit: 1, toolCallRetryMax: 0 };

    beforeEach(() => {
        jest.useFakeTimers({ now: new Date('2026-10-09T08:00:00Z') });
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    test('named buckets keep independent windows', async () => {
        await waitForRpmSlot(settings, null, 'bucket-iso-a');
        await waitForRpmSlot(settings, null, 'bucket-iso-b');
        let released = false;
        const pending = waitForRpmSlot(settings, null, 'bucket-iso-a').then(() => { released = true; });
        await jest.advanceTimersByTimeAsync(59_000);
        expect(released).toBe(false);
        await jest.advanceTimersByTimeAsync(1_200);
        await pending;
        expect(released).toBe(true);
    });

    test('omitting the bucket uses the shared default window', async () => {
        await waitForRpmSlot(settings, null);
        let released = false;
        const pending = waitForRpmSlot(settings, null, 'default').then(() => { released = true; });
        await jest.advanceTimersByTimeAsync(1_000);
        expect(released).toBe(false);
        await waitForRpmSlot(settings, null, 'bucket-iso-c');
        await jest.advanceTimersByTimeAsync(60_000);
        await pending;
        expect(released).toBe(true);
    });

    test('an aborted wait returns without taking a slot', async () => {
        const controller = new AbortController();
        controller.abort();
        await waitForRpmSlot(settings, controller.signal, 'bucket-iso-d');
        await waitForRpmSlot(settings, null, 'bucket-iso-d');
        let released = false;
        const pending = waitForRpmSlot(settings, null, 'bucket-iso-d').then(() => { released = true; });
        await jest.advanceTimersByTimeAsync(1_000);
        expect(released).toBe(false);
        await jest.advanceTimersByTimeAsync(60_000);
        await pending;
        expect(released).toBe(true);
    });

    test('requestToolCallsWithRetry throttles on its own rpmBucket', async () => {
        const context = makeContext();
        await requestToolCallsWithRetry(context, settings, { tools, rpmBucket: 'runner-iso-a' });
        await requestToolCallsWithRetry(context, settings, { tools, rpmBucket: 'runner-iso-b' });
        expect(context.generateTask).toHaveBeenCalledTimes(2);
        const pending = requestToolCallsWithRetry(context, settings, { tools, rpmBucket: 'runner-iso-a' });
        await jest.advanceTimersByTimeAsync(1_000);
        expect(context.generateTask).toHaveBeenCalledTimes(2);
        await jest.advanceTimersByTimeAsync(60_000);
        await pending;
        expect(context.generateTask).toHaveBeenCalledTimes(3);
    });
});

describe('persistent tool turn native replay metadata', () => {
    test('preserves provider-native replay fields and call-level thought signatures through history rebuild', () => {
        const nativeParts = [
            { thought: true, text: 'plan', thoughtSignature: 'sig-part-1' },
            { functionCall: { name: 'noop', args: { x: 1 } }, thoughtSignature: 'sig-call-1' },
        ];
        const nativeContentBlocks = [
            { type: 'thinking', thinking: 'plan', signature: 'sig-claude-1' },
            { type: 'tool_use', id: 'call_native_1', name: 'noop', input: { x: 1 } },
        ];
        const responsesOutputItems = [
            { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc_blob' },
            { type: 'function_call', call_id: 'call_native_1', name: 'noop', arguments: '{"x":1}' },
        ];

        const persisted = createPersistentToolTurnMessage({
            assistantText: 'Running tool',
            reasoning: 'plan',
            signature: 'sig-claude-1',
            reasoningBlocks: [{ type: 'thinking', thinking: 'plan', signature: 'sig-claude-1' }],
            reasoningDetails: [{ type: 'reasoning.text', text: 'plan' }],
            nativeParts,
            nativeContentBlocks,
            responsesOutputItems,
            toolCalls: [{
                id: 'call_native_1',
                type: 'function',
                function: { name: 'noop', arguments: JSON.stringify({ x: 1 }) },
                signature: 'sig-call-1',
                extra_content: { google: { thought_signature: 'sig-call-1' } },
            }],
            toolResults: [{
                tool_call_id: 'call_native_1',
                content: JSON.stringify({ ok: true }),
            }],
        });

        const rebuilt = buildPersistentToolHistoryMessages([persisted]);
        expect(rebuilt).toHaveLength(2);
        expect(rebuilt[0]).toMatchObject({
            role: 'assistant',
            content: 'Running tool',
            reasoning: 'plan',
            signature: 'sig-claude-1',
            reasoning_blocks: [{ type: 'thinking', thinking: 'plan', signature: 'sig-claude-1' }],
            reasoning_details: [{ type: 'reasoning.text', text: 'plan' }],
            native_parts: nativeParts,
            native_content_blocks: nativeContentBlocks,
            responses_output_items: responsesOutputItems,
        });
        expect(rebuilt[0].tool_calls[0]).toMatchObject({
            id: 'call_native_1',
            signature: 'sig-call-1',
            extra_content: { google: { thought_signature: 'sig-call-1' } },
        });
        expect(rebuilt[1]).toMatchObject({
            role: 'tool',
            tool_call_id: 'call_native_1',
        });
    });
});
