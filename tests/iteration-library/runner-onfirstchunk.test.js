/**
 * onFirstChunk callback tests for requestToolCallsWithRetry.
 *
 * Streaming callers (spec parallel stage, agenda parallel round, and
 * potentially any other fan-out point) use this hook to feed the
 * cache-warmup barrier: the callback fires the first time an upstream
 * chunk arrives, so followers can proceed only after the lead has
 * warmed the provider's prompt cache.
 *
 * Contract:
 *   - `onFirstChunk` fires exactly once per successful request, on the
 *     first stream chunk regardless of type (text or reasoning).
 *   - Non-streaming path never fires the callback — followers gain no
 *     benefit from waiting on a non-streaming lead (they'd only unblock
 *     when the full response completes, at which point cache-warmth is
 *     moot). Caller code (barrier integration in spec/agenda) is
 *     responsible for skipping the barrier for non-streaming presets.
 *   - Callback errors are swallowed with a console.warn, matching
 *     other observer callbacks in this module (onAssistantText,
 *     onToolCall, onUsage).
 *   - Retries do not double-fire — the callback belongs to the
 *     first-chunk-of-the-request semantic, and a fresh retry attempt
 *     resets that (there's a fresh chunk stream), so it may fire once
 *     per attempt; only the last successful attempt matters to the
 *     barrier consumer, and the caller signalFirstChunk is idempotent
 *     so extras don't harm anything.
 */

import { describe, test, expect, jest } from '@jest/globals';
import * as runner from '../../public/scripts/iteration-library/runner.js';

const dummyTools = [{
    type: 'function',
    function: {
        name: 'noop',
        description: 'Stub tool; never actually called.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
}];

function makeStreamingContext(chunks, terminalResult, streamEnabled = true) {
    // Emulates st-context.js: `generateTaskStream` returns { stream, result }.
    // `isStreamingPresetEnabled` gates whether the caller should even try
    // the stream variant — production code respects this exactly like
    // director-tools.js runOneRound does.
    return {
        // Deliberately included so runner can tell "streaming path is
        // available" — but the caller code prefers generateTaskStream
        // when the preset flag says stream is on.
        generateTask: jest.fn().mockRejectedValue(new Error('should not be called when streaming path is enabled')),
        isStreamingPresetEnabled: jest.fn(() => streamEnabled),
        generateTaskStream: jest.fn(() => {
            const stream = (async function* () {
                for (const c of chunks) yield c;
            })();
            return { stream, result: Promise.resolve(terminalResult) };
        }),
    };
}

function makeNonStreamingContext(result) {
    return {
        generateTask: jest.fn().mockResolvedValue(result),
        // Absent isStreamingPresetEnabled → caller uses non-stream path.
        // We assert below the callback isn't fired in this configuration.
    };
}

describe('requestToolCallsWithRetry — onFirstChunk callback', () => {
    test('fires exactly once on first text chunk when streaming', async () => {
        const context = makeStreamingContext(
            [
                { type: 'text', delta: 'hello ' },
                { type: 'text', delta: 'world' },
            ],
            { assistantText: 'hello world', toolCalls: [] },
        );
        const onFirstChunk = jest.fn();
        await runner.requestToolCallsWithRetry(context, { rpmLimit: 0 }, {
            tools: dummyTools,
            allowNoToolCalls: true,
            includeAssistantText: true,
            onFirstChunk,
        });
        expect(onFirstChunk).toHaveBeenCalledTimes(1);
    });

    test('fires on first chunk even when first chunk is reasoning-type', async () => {
        // Barrier semantics: any chunk arriving means the upstream
        // request is past the cache-write threshold. Text vs reasoning
        // doesn't matter — a reasoning chunk arrived means the server
        // has committed to processing, so followers can proceed.
        const context = makeStreamingContext(
            [
                { type: 'reasoning', delta: 'thinking...' },
                { type: 'text', delta: 'answer' },
            ],
            { assistantText: 'answer', toolCalls: [] },
        );
        const onFirstChunk = jest.fn();
        await runner.requestToolCallsWithRetry(context, { rpmLimit: 0 }, {
            tools: dummyTools,
            allowNoToolCalls: true,
            includeAssistantText: true,
            onFirstChunk,
        });
        expect(onFirstChunk).toHaveBeenCalledTimes(1);
    });

    test('does NOT fire on non-streaming path', async () => {
        // Barrier code MUST skip barrier acquisition for non-streaming
        // presets (a lead that never streams can't unblock followers
        // meaningfully — they'd wait for the whole response). This test
        // asserts the runner doesn't accidentally synthesize a
        // first-chunk event when using generateTask.
        const context = makeNonStreamingContext({
            assistantText: 'answer',
            toolCalls: [],
        });
        const onFirstChunk = jest.fn();
        await runner.requestToolCallsWithRetry(context, { rpmLimit: 0 }, {
            tools: dummyTools,
            allowNoToolCalls: true,
            includeAssistantText: true,
            onFirstChunk,
        });
        expect(onFirstChunk).not.toHaveBeenCalled();
    });

    test('callback error is swallowed and does not derail the run', async () => {
        const context = makeStreamingContext(
            [{ type: 'text', delta: 'x' }],
            { assistantText: 'x', toolCalls: [] },
        );
        const onFirstChunk = jest.fn(() => { throw new Error('boom'); });
        // Silence expected console.warn from the swallowed callback error.
        const origWarn = console.warn;
        console.warn = jest.fn();
        try {
            const result = await runner.requestToolCallsWithRetry(context, { rpmLimit: 0 }, {
                tools: dummyTools,
                allowNoToolCalls: true,
                includeAssistantText: true,
                onFirstChunk,
            });
            expect(result.assistantText).toBe('x');
            expect(onFirstChunk).toHaveBeenCalledTimes(1);
        } finally {
            console.warn = origWarn;
        }
    });

    test('when isStreamingPresetEnabled returns false, stream path is not taken', async () => {
        // Even with generateTaskStream available, when the preset flag
        // says stream is disabled the caller must fall back to
        // generateTask — that's the same gate director-tools uses.
        // Barrier callers should NOT acquire a slot in this case, but
        // the runner itself just needs to not fire onFirstChunk.
        const context = {
            isStreamingPresetEnabled: jest.fn(() => false),
            generateTaskStream: jest.fn(() => { throw new Error('should not be called'); }),
            generateTask: jest.fn().mockResolvedValue({
                assistantText: 'x',
                toolCalls: [],
            }),
        };
        const onFirstChunk = jest.fn();
        await runner.requestToolCallsWithRetry(context, { rpmLimit: 0 }, {
            tools: dummyTools,
            allowNoToolCalls: true,
            includeAssistantText: true,
            onFirstChunk,
            llmPresetName: 'some-preset',
        });
        expect(onFirstChunk).not.toHaveBeenCalled();
        expect(context.generateTask).toHaveBeenCalledTimes(1);
        expect(context.generateTaskStream).not.toHaveBeenCalled();
    });

    test('stream path returns the same shape as non-stream path', async () => {
        // Regression guard: the assistantText / reasoning / toolCalls
        // shape iter-studio consumers depend on must not diverge
        // between paths. Both must produce the same wrapped return.
        const streamChunks = [
            { type: 'reasoning', delta: 'think' },
            { type: 'text', delta: 'hi' },
        ];
        const terminalResult = {
            assistantText: 'hi',
            toolCalls: [],
            reasoning: 'think',
            reasoningBlocks: [{ type: 'thinking', text: 'think', signature: 's' }],
            reasoningDetails: [{ type: 'reasoning.summary', summary: [{ type: 'text', text: 't' }] }],
        };
        const context = makeStreamingContext(streamChunks, terminalResult);
        const returned = await runner.requestToolCallsWithRetry(context, { rpmLimit: 0 }, {
            tools: dummyTools,
            allowNoToolCalls: true,
            includeAssistantText: true,
        });
        expect(returned).toEqual({
            toolCalls: [],
            assistantText: 'hi',
            rawAssistantText: 'hi',
            reasoning: 'think',
            reasoningBlocks: terminalResult.reasoningBlocks,
            reasoningDetails: terminalResult.reasoningDetails,
        });
    });
});
