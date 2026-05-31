// tests/orchestrator/custom-tool-runtime-director.test.js
//
// Verifies director runtime constructs the per-run customToolRegistry at
// orchestration entry and threads it into both the main agent's
// executeLoopTool ctx and the sub-agent dispatcher's per-call ctx.

import { describe, test, expect, jest } from '@jest/globals';
import { runMainAgentLoop } from '../../public/scripts/extensions/orchestrator/director-runtime.js';
import { createSubagentDispatcher } from '../../public/scripts/extensions/orchestrator/director-tools.js';
import { createMessageEditorHandle } from '../../public/scripts/message-takeover.js';
import { buildPerRunCustomToolRegistry } from '../../public/scripts/extensions/orchestrator/per-run-custom-tools.js';

function makeHandle() {
    const chat = [{ mes: '', extra: { reasoning: '' }, is_user: false }];
    const handle = createMessageEditorHandle({ generationType: 'normal', flushIntervalMs: 0 });
    handle.setOnUpdate((text, reasoning) => {
        chat[0].mes = text;
        chat[0].extra.reasoning = reasoning;
    });
    return { chat, handle };
}

describe('director main agent Layer-3 dispatch', () => {
    test('threads customToolRegistry into the executeLoopTool ctx', async () => {
        const { chat, handle } = makeHandle();
        const executeLoopToolCalls = [];
        const ev = {
            type: 'normal',
            placeholderMessageId: 0,
            finalPrompt: '',
            generateData: {},
            takeoverHandle: handle,
            abortSignal: new AbortController().signal,
        };

        // First round: call the custom tool. Second round: finalize.
        let callCount = 0;
        const fakeStream = jest.fn(async () => {
            callCount++;
            if (callCount === 1) {
                return {
                    assistantText: '',
                    toolCalls: [{ id: 'tc1', name: 'my_main_tool', args: { x: 1 } }],
                    reasoning: null,
                    finishReason: 'tool_calls',
                    usage: null,
                    raw: null,
                };
            }
            return {
                assistantText: '',
                toolCalls: [{ id: 'tc2', name: 'finalize', args: {} }],
                reasoning: null,
                finishReason: 'tool_calls',
                usage: null,
                raw: null,
            };
        });

        // Need a non-empty draft for finalize to commit successfully.
        handle.setText('placeholder');

        await runMainAgentLoop({
            handle,
            profile: {
                mode: 'director',
                director: {
                    mainAgent: {},
                    subAgents: [],
                    maxRounds: 3,
                    tools: {},
                },
                customTools: [
                    { name: 'my_main_tool', description: 'd', parameters: {}, mode: 'read', body: 'return 1;', simulateBody: '' },
                ],
            },
            eventData: ev,
            deps: {
                generateTaskStreamForMainAgent: fakeStream,
                generateTask: jest.fn(),
                chat,
                executeLoopTool: async (name, args, ctx) => {
                    executeLoopToolCalls.push({ name, args, ctx });
                    return { ok: true };
                },
            },
        });

        const mainCall = executeLoopToolCalls.find(c => c.name === 'my_main_tool');
        expect(mainCall).toBeTruthy();
        expect(mainCall.ctx.__customToolRegistry).toBeTruthy();
        expect(mainCall.ctx.__customToolRegistry.has('my_main_tool')).toBe(true);
    });
});

describe('director sub-agent Layer-3 dispatch', () => {
    test('threads customToolRegistry into the sub-agent executeLoopTool ctx', async () => {
        // Build a customToolRegistry the same way runMainAgentLoop would.
        const customToolRegistry = buildPerRunCustomToolRegistry({
            customTools: [
                { name: 'my_sub_tool', description: 'd', parameters: {}, mode: 'read', body: 'return 2;', simulateBody: '' },
            ],
        }, null);

        const subAgentSpec = {
            id: 'researcher',
            systemPrompt: 'sys',
            tools: { chat: { read_range: true } },
            maxRounds: 3,
        };

        // generateTask stub: round 1 calls custom tool; round 2 returns
        // no tool calls (which terminates the sub-agent loop and returns
        // the assistant text as the sub-agent's output).
        let callCount = 0;
        const generateTask = jest.fn(async () => {
            callCount++;
            if (callCount === 1) {
                return {
                    assistantText: '',
                    toolCalls: [{ id: 'tc1', name: 'my_sub_tool', args: { x: 3 } }],
                    reasoning: null,
                    finishReason: 'tool_calls',
                    usage: null,
                    raw: null,
                };
            }
            return {
                assistantText: 'sub-agent reports: done',
                toolCalls: [],
                reasoning: null,
                finishReason: 'stop',
                usage: null,
                raw: null,
            };
        });

        const executeLoopToolCalls = [];
        const dispatcher = createSubagentDispatcher({
            subAgents: [subAgentSpec],
            limits: { maxConcurrentSubagents: 1, maxTotalSubagentRuns: 4 },
            settings: {},
            generateTask,
            generateTaskStream: null,
            handle: null,
            getContentPayload: () => ({ messages: [] }),
            abortSignal: new AbortController().signal,
            tools: {},
            executeLoopTool: async (name, args, ctx) => {
                executeLoopToolCalls.push({ name, args, ctx });
                return { ok: true };
            },
            chat: [],
            trace: null,
            contextForNotes: null,
            customToolRegistry,
        });

        const handleId = await dispatcher.dispatch({ subagentId: 'researcher', task: 'do it' });
        await dispatcher.awaitAll([handleId]);

        const subCall = executeLoopToolCalls.find(c => c.name === 'my_sub_tool');
        expect(subCall).toBeTruthy();
        expect(subCall.ctx.__customToolRegistry).toBeTruthy();
        expect(subCall.ctx.__customToolRegistry.has('my_sub_tool')).toBe(true);
    });
});
