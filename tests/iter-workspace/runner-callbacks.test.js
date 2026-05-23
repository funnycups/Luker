/**
 * `requestToolCallsWithRetry` is the LLM round-trip used by every plugin-
 * owned iteration popup (CPA, MG schema, orch, CEA char + editor). Each
 * popup needs to react incrementally to a completed LLM round so it can
 * render the assistant turn and its emitted tool calls in the history
 * stream *before* applying edits to the live target.
 *
 * To support that without each popup re-implementing the parsing, the
 * runner accepts three optional callbacks invoked once per successful
 * round (after validation, before return):
 *
 *   - `onAssistantText(text)`     fires once if non-empty text was produced
 *   - `onToolCall(call)`          fires once per non-control tool call, in order
 *   - `onControlCall(call)`       fires for `continue` / `finalize` /
 *                                 `finalize_iteration` / `orch_continue` /
 *                                 `orch_finalize`
 *
 * Adding these callbacks is purely additive: callers that pass nothing get
 * the existing behavior (return-only). A throwing callback must not crash
 * the runner — the caller's instrumentation should never break the round.
 *
 * The validator and `generateTask` driver are mocked at the module
 * boundary via `jest.unstable_mockModule` per the adapter-executor lift
 * pattern memory, so we test the runner in isolation.
 */
import { describe, test, expect, jest, beforeAll } from '@jest/globals';

jest.unstable_mockModule('../../public/scripts/extensions/function-call-runtime.js', () => ({
    TOOL_PROTOCOL_STYLE: { JSON_SCHEMA: 'json_schema' },
    // Permissive validator: tests focus on callback firing, not schema validation.
    validateParsedToolCalls: () => null,
}));

let requestToolCallsWithRetry;
beforeAll(async () => {
    ({ requestToolCallsWithRetry } = await import('../../public/scripts/lib/iter-tool-calling.js'));
});

function makeContext(result) {
    return {
        generateTask: jest.fn(async () => result),
        generateTaskStream: jest.fn(() => ({ result: Promise.resolve(result) })),
    };
}

const TOOLS = [{
    type: 'function',
    function: {
        name: 'whatever',
        description: 'placeholder',
        parameters: { type: 'object', additionalProperties: true },
    },
}];

const SETTINGS = { toolCallRetryMax: 0, rpmLimit: 0, useStreamingTransport: false };

describe('requestToolCallsWithRetry — per-round callbacks', () => {
    test('no callbacks → preserves existing return shape (back-compat)', async () => {
        const ctx = makeContext({
            toolCalls: [{ name: 'do_a', args: { x: 1 } }],
            assistantText: 'hello',
        });
        const result = await requestToolCallsWithRetry(ctx, SETTINGS, {
            tools: TOOLS,
        });
        // Existing callers (no `includeAssistantText`) get the calls array.
        expect(Array.isArray(result)).toBe(true);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('do_a');
        expect(result[0].args).toEqual({ x: 1 });
    });

    test('onAssistantText fires once on non-empty assistantText', async () => {
        const onAssistantText = jest.fn();
        const ctx = makeContext({
            toolCalls: [{ name: 'do_a', args: {} }],
            assistantText: 'thinking out loud',
        });
        await requestToolCallsWithRetry(ctx, SETTINGS, {
            tools: TOOLS,
            onAssistantText,
        });
        expect(onAssistantText).toHaveBeenCalledTimes(1);
        expect(onAssistantText).toHaveBeenCalledWith('thinking out loud');
    });

    test('onAssistantText does NOT fire when assistantText is empty', async () => {
        const onAssistantText = jest.fn();
        const ctx = makeContext({
            toolCalls: [{ name: 'do_a', args: {} }],
            assistantText: '',
        });
        await requestToolCallsWithRetry(ctx, SETTINGS, {
            tools: TOOLS,
            onAssistantText,
        });
        expect(onAssistantText).not.toHaveBeenCalled();
    });

    test('onToolCall fires once per non-control call in array order', async () => {
        const onToolCall = jest.fn();
        const ctx = makeContext({
            toolCalls: [
                { name: 'do_a', args: { i: 1 } },
                { name: 'do_b', args: { i: 2 } },
                { name: 'do_c', args: { i: 3 } },
            ],
            assistantText: '',
        });
        await requestToolCallsWithRetry(ctx, SETTINGS, {
            tools: TOOLS,
            onToolCall,
        });
        expect(onToolCall).toHaveBeenCalledTimes(3);
        expect(onToolCall.mock.calls[0][0].name).toBe('do_a');
        expect(onToolCall.mock.calls[1][0].name).toBe('do_b');
        expect(onToolCall.mock.calls[2][0].name).toBe('do_c');
    });

    test('onControlCall fires for control names; onToolCall does NOT', async () => {
        const onToolCall = jest.fn();
        const onControlCall = jest.fn();
        const ctx = makeContext({
            toolCalls: [
                { name: 'do_a', args: {} },
                { name: 'continue', args: {} },
                { name: 'finalize', args: {} },
                { name: 'orch_continue', args: {} },
                { name: 'orch_finalize', args: {} },
                { name: 'finalize_iteration', args: {} },
            ],
            assistantText: '',
        });
        await requestToolCallsWithRetry(ctx, SETTINGS, {
            tools: TOOLS,
            onToolCall,
            onControlCall,
        });
        // Only the single non-control call fires onToolCall.
        expect(onToolCall).toHaveBeenCalledTimes(1);
        expect(onToolCall.mock.calls[0][0].name).toBe('do_a');
        // All five control names fire onControlCall.
        expect(onControlCall).toHaveBeenCalledTimes(5);
        const controlNames = onControlCall.mock.calls.map(c => c[0].name);
        expect(controlNames).toEqual([
            'continue',
            'finalize',
            'orch_continue',
            'orch_finalize',
            'finalize_iteration',
        ]);
    });

    test('a throwing callback does not break the runner', async () => {
        const onAssistantText = jest.fn(() => { throw new Error('boom1'); });
        const onToolCall = jest.fn(() => { throw new Error('boom2'); });
        const ctx = makeContext({
            toolCalls: [{ name: 'do_a', args: { ok: true } }],
            assistantText: 'whatever',
        });
        // Both throw — but the runner swallows them and returns normally.
        const result = await requestToolCallsWithRetry(ctx, SETTINGS, {
            tools: TOOLS,
            onAssistantText,
            onToolCall,
        });
        expect(Array.isArray(result)).toBe(true);
        expect(result).toHaveLength(1);
        expect(result[0].args).toEqual({ ok: true });
        // Both callbacks were attempted exactly once.
        expect(onAssistantText).toHaveBeenCalledTimes(1);
        expect(onToolCall).toHaveBeenCalledTimes(1);
    });
});
