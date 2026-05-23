/**
 * `requestToolCallsWithRetry` is the LLM round-trip used by every plugin-
 * owned iteration popup (CPA, MG schema, orch, CEA char + editor). Each
 * popup needs to react incrementally to a completed LLM round so it can
 * render the assistant turn and its emitted tool calls in the history
 * stream *before* applying edits to the live target.
 *
 * To support that without each popup re-implementing the parsing, the
 * runner accepts these optional hooks invoked once per successful round
 * (after validation, before return):
 *
 *   - `onAssistantText(text)`     fires once if non-empty text was produced
 *   - `onToolCall(call)`          fires once per non-control tool call, in order
 *   - `onControlCall(call)`       fires for any call the caller's
 *                                 `isControlCall(toolCall)` predicate
 *                                 returns truthy for. Without a predicate
 *                                 every call routes to `onToolCall`.
 *
 * Control-call detection lives in the caller, not the runner, because the
 * production control tool names are namespaced per popup (orchestrator
 * uses `luker_orch_continue_iteration` / `_finalize_iteration`,
 * memory-graph schema iteration uses `luker_mg_schema_continue_iteration`
 * / `_finalize_iteration`, CPA and CEA popups have none). Hardcoding a
 * single allowlist in the shared runner would silently misroute calls.
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

    test('onControlCall fires when isControlCall predicate returns true; onToolCall does NOT', async () => {
        const onToolCall = jest.fn();
        const onControlCall = jest.fn();
        // Use stable namespaced names that match the real production tool
        // names (orchestrator's `luker_orch_*_iteration`, memory-graph's
        // `luker_mg_schema_*_iteration`). The predicate inspects the full
        // toolCall, not just the name, so callers can route on args if
        // they ever need to.
        const isControlCall = (tc) => (
            tc.name === 'luker_orch_continue_iteration'
            || tc.name === 'luker_orch_finalize_iteration'
            || tc.name === 'luker_mg_schema_continue_iteration'
            || tc.name === 'luker_mg_schema_finalize_iteration'
        );
        const ctx = makeContext({
            toolCalls: [
                { name: 'do_a', args: {} },
                { name: 'luker_orch_continue_iteration', args: {} },
                { name: 'luker_orch_finalize_iteration', args: {} },
                { name: 'luker_mg_schema_continue_iteration', args: {} },
                { name: 'luker_mg_schema_finalize_iteration', args: {} },
            ],
            assistantText: '',
        });
        await requestToolCallsWithRetry(ctx, SETTINGS, {
            tools: TOOLS,
            onToolCall,
            onControlCall,
            isControlCall,
        });
        // Only the single non-control call fires onToolCall.
        expect(onToolCall).toHaveBeenCalledTimes(1);
        expect(onToolCall.mock.calls[0][0].name).toBe('do_a');
        // All four namespaced control names fire onControlCall, in order.
        expect(onControlCall).toHaveBeenCalledTimes(4);
        const controlNames = onControlCall.mock.calls.map(c => c[0].name);
        expect(controlNames).toEqual([
            'luker_orch_continue_iteration',
            'luker_orch_finalize_iteration',
            'luker_mg_schema_continue_iteration',
            'luker_mg_schema_finalize_iteration',
        ]);
    });

    test('without isControlCall predicate, every call routes to onToolCall', async () => {
        // Single-turn popups (CPA, CEA char-iter, CEA editor) have no
        // continue/finalize tools and should not opt into control routing.
        // The default must be "treat every call as non-control" so the
        // popup's onToolCall observer fires for every tool, with nothing
        // silently misrouted to a missing onControlCall handler.
        const onToolCall = jest.fn();
        const onControlCall = jest.fn();
        const ctx = makeContext({
            toolCalls: [
                { name: 'cea_replace_field', args: {} },
                // Even names that LOOK like control names (e.g. literal
                // `continue` from the old hardcoded set) must NOT route
                // to onControlCall absent a predicate, because the caller
                // has not opted in.
                { name: 'continue', args: {} },
                { name: 'finalize_iteration', args: {} },
            ],
            assistantText: '',
        });
        await requestToolCallsWithRetry(ctx, SETTINGS, {
            tools: TOOLS,
            onToolCall,
            onControlCall,
            // isControlCall intentionally omitted.
        });
        expect(onToolCall).toHaveBeenCalledTimes(3);
        expect(onControlCall).not.toHaveBeenCalled();
    });

    test('a throwing onToolCall / onAssistantText does not break the runner', async () => {
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

    test('a throwing onControlCall does not break the runner; onAssistantText still fires', async () => {
        // Mirror of the onToolCall-throwing test for control routing. If the
        // popup's onControlCall raises (e.g. state-machine bug), the round
        // must still return its parsed calls and onAssistantText must still
        // observe the assistant turn.
        const onAssistantText = jest.fn();
        const onToolCall = jest.fn();
        const onControlCall = jest.fn(() => { throw new Error('boom_ctrl'); });
        const ctx = makeContext({
            toolCalls: [
                { name: 'do_a', args: { ok: true } },
                { name: 'orch_ctrl', args: { phase: 'continue' } },
            ],
            assistantText: 'pondering',
        });
        const result = await requestToolCallsWithRetry(ctx, SETTINGS, {
            tools: TOOLS,
            onAssistantText,
            onToolCall,
            onControlCall,
            isControlCall: (tc) => tc.name === 'orch_ctrl',
        });
        expect(Array.isArray(result)).toBe(true);
        expect(result).toHaveLength(2);
        // onAssistantText fired despite the later throw.
        expect(onAssistantText).toHaveBeenCalledTimes(1);
        expect(onAssistantText).toHaveBeenCalledWith('pondering');
        // Non-control call observed normally.
        expect(onToolCall).toHaveBeenCalledTimes(1);
        expect(onToolCall.mock.calls[0][0].name).toBe('do_a');
        // Control call was attempted once, even though it threw.
        expect(onControlCall).toHaveBeenCalledTimes(1);
        expect(onControlCall.mock.calls[0][0].name).toBe('orch_ctrl');
    });
});
