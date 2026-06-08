import { describe, expect, test, jest } from '@jest/globals';
import { createMessageEditorHandle } from '../../public/scripts/message-takeover.js';

// We need to import a slice of director-tools that exposes runOneRound.
// director-tools.js exports createSubagentDispatcher, which internally
// defines runOneRound. We exercise it by spinning up a dispatcher with
// a fake streaming generateTaskStream and a fake subagent.

import { createSubagentDispatcher } from '../../public/scripts/extensions/orchestrator/director-tools.js';

function makeFakeStream(chunkCount, delayMs = 0) {
    return {
        stream: (async function* () {
            for (let i = 0; i < chunkCount; i++) {
                if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
                yield { type: 'text', delta: `chunk${i} ` };
            }
        })(),
        result: Promise.resolve({ assistantText: '', toolCalls: [] }),
    };
}

describe('runOneRound early-exit when handle settles mid-stream', () => {
    test('stops calling safeAppendToSection within 1 chunk after handle.abort()', async () => {
        const handle = createMessageEditorHandle({
            generationType: 'normal',
            flushIntervalMs: 0,
        });
        const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});
        // 100-chunk stream with 5ms gaps so we have a chance to abort between chunks.
        const generateTaskStream = jest.fn(() => makeFakeStream(100, 5));
        const dispatcher = createSubagentDispatcher({
            subAgents: [{ id: 'sub-a', task: 'demo', systemPrompt: 'demo', toolNames: [] }],
            limits: { maxTotalSubagentRuns: 4 },
            settings: { toolCallRetryMax: 0 },
            generateTask: null,
            generateTaskStream,
            handle,
            getContentPayload: () => ({}),
            abortSignal: undefined,
            tools: [],
            executeLoopTool: async () => ({ ok: true }),
            chat: [],
            trace: { director: { subagents: [] } },
            contextForNotes: {},
        });
        // Kick off a dispatch. We don't await — we want to abort mid-stream.
        const dispatchPromise = dispatcher.dispatch({
            subagentId: 'sub-a',
            task: 'demo',
            __parentMessages: [],
        });
        // Wait long enough for 2-3 chunks to flush.
        await new Promise(r => setTimeout(r, 25));
        // Abort the handle. From this moment on, every further chunk
        // SHOULD be a no-op (loop breaks); we MUST NOT see a barrage of
        // [orchestrator-director] appendToReasoningSection failed debug
        // logs.
        await handle.abort();
        const debugCountAtAbort = debugSpy.mock.calls.filter(
            args => String(args[0] || '').includes('appendToReasoningSection failed'),
        ).length;
        // Let the rest of the stream drain.
        await new Promise(r => setTimeout(r, 200));
        const debugCountAfter = debugSpy.mock.calls.filter(
            args => String(args[0] || '').includes('appendToReasoningSection failed'),
        ).length;
        // Allow at most one extra debug log after abort (the chunk that
        // was already in flight when abort fired). Anything more means
        // the loop did not detect the settle and kept thrashing.
        expect(debugCountAfter - debugCountAtAbort).toBeLessThanOrEqual(1);
        // Cleanup: swallow the dispatch result.
        await dispatchPromise.catch(() => {});
        debugSpy.mockRestore();
    });
});
