import { describe, expect, test, jest } from '@jest/globals';
import { createSubagentDispatcher } from '../../../public/scripts/extensions/orchestrator/director-tools.js';
import { createMessageEditorHandle } from '../../../public/scripts/message-takeover.js';

const TOTAL_CHUNKS = 50;
const SETTLE_AT_CHUNK = 3;

describe('sub-agent stream loop stops reading once the takeover handle settles', () => {
    test('no further chunks are pulled after handle.abort()', async () => {
        const handle = createMessageEditorHandle({
            generationType: 'normal',
            flushIntervalMs: 0,
        });
        let pulled = 0;
        let pulledAtSettle = null;
        const generateTaskStream = jest.fn(() => ({
            stream: (async function* () {
                for (let i = 0; i < TOTAL_CHUNKS; i++) {
                    pulled += 1;
                    if (pulled === SETTLE_AT_CHUNK) {
                        await handle.abort();
                        pulledAtSettle = pulled;
                    }
                    yield { type: 'text', delta: `chunk${i} ` };
                }
            })(),
            result: Promise.resolve({
                assistantText: '',
                toolCalls: [],
                reasoning: null,
                finishReason: 'stop',
                usage: null,
                raw: null,
            }),
        }));

        const dispatcher = createSubagentDispatcher({
            subAgents: [{ id: 'sub-a', description: 'd', systemPrompt: 's' }],
            directorProfile: { subAgents: [{ id: 'sub-a' }], skills: {} },
            limits: { maxRounds: 1, maxConcurrentSubagents: 1, maxTotalSubagentRuns: 1 },
            settings: { toolCallRetryMax: 0 },
            generateTask: jest.fn(),
            generateTaskStream,
            isStreamingPresetEnabled: () => true,
            handle,
            getContentPayload: () => ({ messages: [] }),
            abortSignal: undefined,
            tools: {},
            executeLoopTool: jest.fn(async () => ({ ok: true })),
            chat: [],
            contextForNotes: null,
            customToolRegistry: null,
        });

        const handleId = await dispatcher.dispatch({ subagentId: 'sub-a', task: 'demo' });
        await dispatcher.awaitAll([handleId]);

        expect(generateTaskStream).toHaveBeenCalledTimes(1);
        expect(pulledAtSettle).toBe(SETTLE_AT_CHUNK);
        // The chunk yielded alongside the settle is the last one read;
        // the generator is never resumed afterwards.
        expect(pulled).toBe(SETTLE_AT_CHUNK);
    });
});
