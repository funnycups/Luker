import { describe, expect, test, jest, beforeEach } from '@jest/globals';
import { runMainAgentLoop } from '../../../public/scripts/extensions/orchestrator/director-runtime.js';
import { createMessageEditorHandle } from '../../../public/scripts/message-takeover.js';
import {
    clearCurrentRun,
    getCurrentRun,
    startRun,
} from '../../../public/scripts/extensions/orchestrator/run-state/store.js';

function makeHandle() {
    const chat = [{ mes: '', extra: { reasoning: '' }, is_user: false }];
    const emit = jest.fn(async () => {});
    const handle = createMessageEditorHandle({ generationType: 'normal', flushIntervalMs: 0 });
    // Test-mode chat mirror: in production the kernel (script.js takeover
    // branch) installs this listener. Here we install it directly so the
    // tests can assert on chat[0] state after handle writes.
    handle.setOnUpdate((text, reasoning) => {
        chat[0].mes = text;
        chat[0].extra.reasoning = reasoning;
    });
    return { chat, handle };
}

function findSectionBody(sectionId) {
    const run = getCurrentRun();
    if (!run) return '';
    for (const round of run.rounds || []) {
        for (const section of round.sections || []) {
            if (section.id === sectionId) return section.body || '';
        }
    }
    return '';
}

function findSubAgentRound(handleId, subagentId) {
    // Dispatcher names each sub-agent round `sub-<subagentId>-<tail>`,
    // where tail is the numeric suffix of `subagent-N`. The tests refer
    // to handles by their canonical id (`subagent-0`, `subagent-1`),
    // so we strip the `subagent-` prefix to derive the round id.
    const tail = String(handleId || '').replace(/^subagent-/, '');
    const expectedId = `sub-${subagentId}-${tail}`;
    const run = getCurrentRun();
    if (!run) return null;
    return (run.rounds || []).find(r => r.id === expectedId) || null;
}

function findSubAgentSection(handleId, subagentId, sectionId) {
    const round = findSubAgentRound(handleId, subagentId);
    if (!round) return null;
    return (round.sections || []).find(s => s.id === sectionId) || null;
}

describe('director integration — scripted main agent', () => {
    beforeEach(() => { clearCurrentRun(); });

    test('main agent text chunks stream into the run-panel text section as they arrive', async () => {
        // Stage 3 of the run-panel refactor moves live streaming off the
        // chat-message reasoning fold and into RunStateStore. We prove
        // here that each text-chunk delta is reflected in the active
        // run's `text` section the moment onChunk fires.
        const { chat, handle } = makeHandle();
        const runId = startRun({ mode: 'director', chatKey: 'test', abortFn: null });
        const ev = {
            type: 'normal',
            placeholderMessageId: 0,
            finalPrompt: '',
            generateData: {},
            takeoverHandle: handle,
            abortSignal: new AbortController().signal,
        };

        const snapshots = [];
        let callCount = 0;
        const fakeStream = jest.fn(async ({ onChunk }) => {
            callCount++;
            if (callCount === 1) {
                onChunk({ type: 'text', delta: 'First ' });
                snapshots.push(findSectionBody('text'));
                onChunk({ type: 'text', delta: 'second ' });
                snapshots.push(findSectionBody('text'));
                onChunk({ type: 'text', delta: 'third.' });
                snapshots.push(findSectionBody('text'));
                return {
                    assistantText: 'First second third.',
                    toolCalls: [{ id: 'tf', name: 'finalize', args: {} }],
                    reasoning: null,
                    finishReason: 'tool_calls',
                    usage: null,
                    raw: null,
                };
            }
            return { assistantText: '', toolCalls: [], reasoning: null, finishReason: 'stop', usage: null, raw: null };
        });

        // Need a non-empty draft for finalize to commit successfully.
        handle.setText('placeholder');
        await runMainAgentLoop({
            handle,
            profile: { mode: 'director', director: { mainAgent: {}, subAgents: [], maxRounds: 3, tools: {} } },
            eventData: ev,
            deps: {
                generateTaskStreamForMainAgent: fakeStream,
                generateTask: jest.fn(),
                chat,
                runId,
            },
        });

        expect(snapshots[0]).toContain('First ');
        expect(snapshots[1]).toContain('First second ');
        expect(snapshots[2]).toContain('First second third.');

        // The chat-message reasoning fold is left untouched by director;
        // no Stage-3 writes flow into chat[0].extra.reasoning anymore.
        expect(chat[0].extra.reasoning).toBe('');
        // The final section body equals the assembled text exactly once
        // (non-streaming fallback must NOT re-append if chunks arrived).
        expect(findSectionBody('text').match(/First second third\./g)).toHaveLength(1);
    });

    test('main agent falls back to assistantText in the text section when no chunks arrive (non-streaming transport)', async () => {
        // The non-streaming path (`useStreamingTransport=false` →
        // `context.generateTask`) returns the final assistantText with
        // no chunk events. The runtime must still write that text into
        // the run-panel text section so the panel isn't left with empty
        // sections when the user disables streaming.
        const { chat, handle } = makeHandle();
        const runId = startRun({ mode: 'director', chatKey: 'test', abortFn: null });
        const ev = {
            type: 'normal',
            placeholderMessageId: 0,
            finalPrompt: '',
            generateData: {},
            takeoverHandle: handle,
            abortSignal: new AbortController().signal,
        };

        const fakeStream = jest.fn(async () => ({
            // No onChunk call — simulating the non-streaming transport.
            assistantText: 'this came in one shot',
            toolCalls: [{ id: 'tf', name: 'finalize', args: {} }],
            reasoning: null,
            finishReason: 'tool_calls',
            usage: null,
            raw: null,
        }));

        handle.setText('placeholder');
        await runMainAgentLoop({
            handle,
            profile: { mode: 'director', director: { mainAgent: {}, subAgents: [], maxRounds: 3, tools: {} } },
            eventData: ev,
            deps: {
                generateTaskStreamForMainAgent: fakeStream,
                generateTask: jest.fn(),
                chat,
                runId,
            },
        });

        expect(findSectionBody('text')).toContain('this came in one shot');
        // Chat reasoning fold is no longer touched.
        expect(chat[0].extra.reasoning).toBe('');
    });

    test('main agent: write → patch → finalize produces expected final message', async () => {
        const { chat, handle } = makeHandle();
        const ev = {
            type: 'normal',
            placeholderMessageId: 0,
            finalPrompt: '',
            generateData: {},
            takeoverHandle: handle,
            abortSignal: new AbortController().signal,
        };

        // Scripted tool-call sequence.
        const calls = [
            [{ id: 't1', name: 'write_message', args: { text: 'The cat sat on the mat.', mode: 'append' } }],
            [{ id: 't2', name: 'apply_message_patches', args: { patches: [{ kind: 'context_replace', oldString: 'cat', newString: 'dog' }] } }],
            [{ id: 't3', name: 'finalize', args: {} }],
        ];
        let i = 0;
        const fakeStream = jest.fn(async () => ({
            assistantText: '',
            toolCalls: calls[i++] || [],
            reasoning: null,
            finishReason: 'tool_calls',
            usage: null,
            raw: null,
        }));

        await runMainAgentLoop({
            handle,
            profile: { mode: 'director', director: { mainAgent: {}, subAgents: [], maxRounds: 5, tools: {} } },
            eventData: ev,
            deps: {
                generateTaskStreamForMainAgent: fakeStream,
                generateTask: jest.fn(),
                chat,
            },
        });

        expect(chat[0].mes).toBe('The dog sat on the mat.');
        const outcome = await handle.complete;
        expect(outcome.status).toBe('committed');
        expect(fakeStream).toHaveBeenCalledTimes(3);
    });

    test('main agent: dispatch sub-agent, await, write integrated → finalize', async () => {
        const { chat, handle } = makeHandle();
        const runId = startRun({ mode: 'director', chatKey: 'test', abortFn: null });
        const ev = {
            type: 'normal',
            placeholderMessageId: 0,
            finalPrompt: '',
            generateData: {},
            takeoverHandle: handle,
            abortSignal: new AbortController().signal,
        };

        const calls = [
            [{ id: 't1', name: 'dispatch_subagent', args: { subagentId: 'critic', task: 'critique' } }],
            [{ id: 't2', name: 'await_subagents', args: { handles: ['subagent-0'] } }],
            [{ id: 't3', name: 'write_message', args: { text: 'Final body referencing critic.', mode: 'replace' } }],
            [{ id: 't4', name: 'finalize', args: {} }],
        ];
        let i = 0;
        const fakeStream = jest.fn(async () => ({
            assistantText: '',
            toolCalls: calls[i++] || [],
            reasoning: null,
            finishReason: 'tool_calls',
            usage: null,
            raw: null,
        }));
        const fakeSubagent = jest.fn(async () => ({ assistantText: 'critic says: tighten the pacing', toolCalls: [], reasoning: null, finishReason: 'stop', usage: null, raw: null }));

        await runMainAgentLoop({
            handle,
            profile: {
                mode: 'director',
                director: {
                    mainAgent: {},
                    subAgents: [{ id: 'critic', description: 'd', systemPrompt: 's' }],
                    maxRounds: 10,
                    maxConcurrentSubagents: 2,
                    maxTotalSubagentRuns: 5,
                    tools: {},
                },
            },
            eventData: ev,
            deps: {
                generateTaskStreamForMainAgent: fakeStream,
                generateTask: fakeSubagent,
                chat,
                runId,
            },
        });

        expect(chat[0].mes).toBe('Final body referencing critic.');
        expect(fakeSubagent).toHaveBeenCalledTimes(1);
        const outcome = await handle.complete;
        expect(outcome.status).toBe('committed');
        // Sub-agent output is routed through the RunStateStore — each
        // dispatch gets its own top-level round with a `text` section
        // that captures the sub-agent's terminal output. With the non-
        // streaming fallback the text lands in one shot; with streaming
        // each chunk would land live.
        const textSection = findSubAgentSection('subagent-0', 'critic', 'text');
        expect(textSection).toBeTruthy();
        expect(textSection.body).toContain('critic says: tighten the pacing');
        // Chat reasoning fold is no longer written by the director.
        expect(chat[0].extra.reasoning).toBe('');
    });

    test('streaming sub-agent: chunks land in the run-panel text section as they arrive', async () => {
        const { chat, handle } = makeHandle();
        const runId = startRun({ mode: 'director', chatKey: 'test', abortFn: null });
        const ev = {
            type: 'normal',
            placeholderMessageId: 0,
            finalPrompt: '',
            generateData: {},
            takeoverHandle: handle,
            abortSignal: new AbortController().signal,
        };

        // Main agent: dispatch one sub-agent, await, finalize.
        const mainCalls = [
            [{ id: 't1', name: 'dispatch_subagent', args: { subagentId: 'critic', task: 't' } }],
            [{ id: 't2', name: 'await_subagents', args: { handles: ['subagent-0'] } }],
            [{ id: 't3', name: 'finalize', args: {} }],
        ];
        let mainIdx = 0;
        const fakeMainStream = jest.fn(async () => {
            const r = mainCalls[mainIdx++];
            return r
                ? { assistantText: '', toolCalls: r, reasoning: null, finishReason: 'tool_calls', usage: null, raw: null }
                : { assistantText: '', toolCalls: [], reasoning: null, finishReason: 'stop', usage: null, raw: null };
        });

        // Sub-agent: streaming provider yields text deltas one at a time.
        const subChunks = ['The ', 'pacing ', 'drags.'];
        const fakeSubStream = jest.fn((opts) => {
            const stream = (async function* () {
                for (const delta of subChunks) {
                    yield { type: 'text', delta };
                }
            })();
            const result = Promise.resolve({
                assistantText: subChunks.join(''),
                toolCalls: [],
                reasoning: null,
                finishReason: 'stop',
                usage: null,
                raw: null,
            });
            return { stream, result };
        });

        await runMainAgentLoop({
            handle,
            profile: {
                mode: 'director',
                director: {
                    mainAgent: {},
                    subAgents: [{ id: 'critic', description: 'crit', systemPrompt: 'be a critic' }],
                    maxRounds: 5,
                    maxConcurrentSubagents: 2,
                    maxTotalSubagentRuns: 5,
                    tools: {},
                },
            },
            eventData: ev,
            deps: {
                generateTaskStreamForMainAgent: fakeMainStream,
                generateTask: jest.fn(),
                generateTaskStream: fakeSubStream,
                chat,
                runId,
            },
        });

        // Each chunk lands in the dispatch round's text section. The
        // final section body is the concatenated stream output.
        const textSection = findSubAgentSection('subagent-0', 'critic', 'text');
        expect(textSection).toBeTruthy();
        expect(textSection.body).toBe('The pacing drags.');
        // Section status flipped from running → done at end.
        expect(textSection.status).toBe('done');
        // Chat reasoning fold stays empty — sub-agent activity is fully
        // routed through the store, not the chat-message channel.
        expect(chat[0].extra.reasoning).toBe('');
    });

    test('two concurrent streaming sub-agents do not interleave at character level', async () => {
        const { chat, handle } = makeHandle();
        const runId = startRun({ mode: 'director', chatKey: 'test', abortFn: null });
        const ev = {
            type: 'normal',
            placeholderMessageId: 0,
            finalPrompt: '',
            generateData: {},
            takeoverHandle: handle,
            abortSignal: new AbortController().signal,
        };

        // Main agent: dispatch two sub-agents in one round (parallel),
        // await both, finalize.
        const mainCalls = [
            [
                { id: 't1', name: 'dispatch_subagent', args: { subagentId: 'critic', task: 'crit' } },
                { id: 't2', name: 'dispatch_subagent', args: { subagentId: 'planner', task: 'plan' } },
            ],
            [{ id: 't3', name: 'await_subagents', args: { handles: ['subagent-0', 'subagent-1'] } }],
            [{ id: 't4', name: 'finalize', args: {} }],
        ];
        let mainIdx = 0;
        const fakeMainStream = jest.fn(async () => {
            const r = mainCalls[mainIdx++];
            return r
                ? { assistantText: '', toolCalls: r, reasoning: null, finishReason: 'tool_calls', usage: null, raw: null }
                : { assistantText: '', toolCalls: [], reasoning: null, finishReason: 'stop', usage: null, raw: null };
        });

        // Two sub-agents stream interleaved chunks. We control the
        // ordering of chunk delivery by yielding from both generators
        // in alternating order via Promise.race-style scheduling.
        const criticChunks = ['The ', 'pacing ', 'drags.'];
        const plannerChunks = ['Outline: ', '1. open, ', '2. close.'];

        let dispatchCounter = 0;
        const fakeSubStream = jest.fn(() => {
            const chunks = dispatchCounter++ === 0 ? criticChunks : plannerChunks;
            const stream = (async function* () {
                for (const delta of chunks) {
                    // Yield to the event loop so the other generator can
                    // interleave its chunks if it's also pulling.
                    await Promise.resolve();
                    yield { type: 'text', delta };
                }
            })();
            const result = Promise.resolve({
                assistantText: chunks.join(''),
                toolCalls: [],
                reasoning: null,
                finishReason: 'stop',
                usage: null,
                raw: null,
            });
            return { stream, result };
        });

        await runMainAgentLoop({
            handle,
            profile: {
                mode: 'director',
                director: {
                    mainAgent: {},
                    subAgents: [
                        { id: 'critic', description: 'd', systemPrompt: 's' },
                        { id: 'planner', description: 'd', systemPrompt: 's' },
                    ],
                    maxRounds: 5,
                    maxConcurrentSubagents: 2,
                    maxTotalSubagentRuns: 5,
                    tools: {},
                },
            },
            eventData: ev,
            deps: {
                generateTaskStreamForMainAgent: fakeMainStream,
                generateTask: jest.fn(),
                generateTaskStream: fakeSubStream,
                chat,
                runId,
            },
        });

        // Each dispatch has its own top-level round in the store; the
        // text sections are independent (no shared buffer), so the
        // chunks cannot interleave at the character level.
        const criticText = findSubAgentSection('subagent-0', 'critic', 'text');
        const plannerText = findSubAgentSection('subagent-1', 'planner', 'text');
        expect(criticText).toBeTruthy();
        expect(plannerText).toBeTruthy();
        expect(criticText.body).toBe('The pacing drags.');
        expect(plannerText.body).toBe('Outline: 1. open, 2. close.');
        // Rounds appear in dispatch order in the store.
        const run = getCurrentRun();
        const criticIdx = (run?.rounds || []).findIndex(r => r.id === 'sub-critic-0');
        const plannerIdx = (run?.rounds || []).findIndex(r => r.id === 'sub-planner-1');
        expect(criticIdx).toBeGreaterThanOrEqual(0);
        expect(plannerIdx).toBeGreaterThan(criticIdx);
        // Chat reasoning fold stays empty regardless of how many
        // sub-agents fan out.
        expect(chat[0].extra.reasoning).toBe('');
    });

    test('main-agent reasoning between tool calls appears in run-panel text sections', async () => {
        const { chat, handle } = makeHandle();
        const runId = startRun({ mode: 'director', chatKey: 'test', abortFn: null });
        const ev = {
            type: 'normal',
            placeholderMessageId: 0,
            finalPrompt: '',
            generateData: {},
            takeoverHandle: handle,
            abortSignal: new AbortController().signal,
        };

        // Main agent narrates between tool calls — this text should land
        // in each round's text section in the run-panel store (the chat
        // reasoning fold is no longer touched).
        const rounds = [
            { assistantText: 'Let me start by writing a draft.', toolCalls: [{ id: 't1', name: 'write_message', args: { text: 'Hello.', mode: 'append' } }] },
            { assistantText: 'On reflection, the tone feels off. Rewriting.', toolCalls: [{ id: 't2', name: 'write_message', args: { text: 'Hi there.', mode: 'replace' } }] },
            { assistantText: 'I think this is ready.', toolCalls: [{ id: 't3', name: 'finalize', args: {} }] },
        ];
        let i = 0;
        const fakeStream = jest.fn(async () => {
            const r = rounds[i++];
            return r ? { ...r, reasoning: null, finishReason: 'tool_calls', usage: null, raw: null } : { assistantText: '', toolCalls: [], reasoning: null, finishReason: 'stop', usage: null, raw: null };
        });

        await runMainAgentLoop({
            handle,
            profile: { mode: 'director', director: { mainAgent: {}, subAgents: [], maxRounds: 5, tools: {} } },
            eventData: ev,
            deps: {
                generateTaskStreamForMainAgent: fakeStream,
                generateTask: jest.fn(),
                chat,
                runId,
            },
        });

        expect(chat[0].mes).toBe('Hi there.');
        // Each round's text section in the store carries the narration.
        const run = getCurrentRun();
        const textBodies = (run?.rounds || []).map(r => r.sections.find(s => s.id === 'text')?.body || '');
        expect(textBodies[0]).toContain('Let me start by writing a draft.');
        expect(textBodies[1]).toContain('On reflection, the tone feels off. Rewriting.');
        expect(textBodies[2]).toContain('I think this is ready.');
        // Three main rounds, ids `main-0`/`main-1`/`main-2`.
        const mainRounds = (run?.rounds || []).filter(r => r.id.startsWith('main-'));
        expect(mainRounds).toHaveLength(3);
        // Chat reasoning fold stays untouched on director writes.
        expect(chat[0].extra.reasoning).toBe('');
    });

    test('no-tool-call attempt is retried; the failed attempt is recorded in the run-panel store', async () => {
        const { chat, handle } = makeHandle();
        const runId = startRun({ mode: 'director', chatKey: 'test', abortFn: null });
        const ev = {
            type: 'normal',
            placeholderMessageId: 0,
            finalPrompt: '',
            generateData: {},
            takeoverHandle: handle,
            abortSignal: new AbortController().signal,
        };

        // toolCallRetryMax = 2 allows up to 2 retries (3 total attempts).
        // Attempt 0: silent → discarded, retried.
        // Attempt 1: write + finalize → round 0 succeeds.
        const attempts = [
            { assistantText: 'I balked.', toolCalls: [] },
            { assistantText: '', toolCalls: [
                { id: 't1', name: 'write_message', args: { text: 'Done.', mode: 'append' } },
                { id: 't2', name: 'finalize', args: {} },
            ] },
        ];
        let i = 0;
        const fakeStream = jest.fn(async () => {
            const r = attempts[i++];
            return r
                ? { ...r, reasoning: null, finishReason: r.toolCalls.length ? 'tool_calls' : 'stop', usage: null, raw: null }
                : { assistantText: '', toolCalls: [], reasoning: null, finishReason: 'stop', usage: null, raw: null };
        });

        await runMainAgentLoop({
            handle,
            profile: { mode: 'director', director: { mainAgent: {}, subAgents: [], maxRounds: 10, tools: {} } },
            eventData: ev,
            deps: {
                generateTaskStreamForMainAgent: fakeStream,
                generateTask: jest.fn(),
                chat,
                settings: { toolCallRetryMax: 2 },
                runId,
            },
        });

        // 1 retry + 1 success = 2 stream calls.
        expect(fakeStream).toHaveBeenCalledTimes(2);
        expect(chat[0].mes).toBe('Done.');
        const outcome = await handle.complete;
        expect(outcome.status).toBe('committed');
        // The failed first attempt is recorded in the store: text section
        // for `main-0` is marked failed after no tool call arrives. The
        // retry overwrites within the same round/section.
        const run = getCurrentRun();
        const mainRound = (run?.rounds || []).find(r => r.id === 'main-0');
        expect(mainRound).toBeTruthy();
        // Chat reasoning fold stays untouched on director writes.
        expect(chat[0].extra.reasoning).toBe('');
    });

    test('no-tool-call attempts exhaust toolCallRetryMax and throw', async () => {
        const { chat, handle } = makeHandle();
        const ev = {
            type: 'normal',
            placeholderMessageId: 0,
            finalPrompt: '',
            generateData: {},
            takeoverHandle: handle,
            abortSignal: new AbortController().signal,
        };

        // Model balks on every attempt. toolCallRetryMax=2 → 3 total
        // attempts (1 initial + 2 retries) before the loop throws.
        const fakeStream = jest.fn(async () => ({
            assistantText: 'still balking',
            toolCalls: [],
            reasoning: null,
            finishReason: 'stop',
            usage: null,
            raw: null,
        }));

        await expect(runMainAgentLoop({
            handle,
            profile: { mode: 'director', director: { mainAgent: {}, subAgents: [], maxRounds: 10, tools: {} } },
            eventData: ev,
            deps: {
                generateTaskStreamForMainAgent: fakeStream,
                generateTask: jest.fn(),
                chat,
                settings: { toolCallRetryMax: 2 },
            },
        })).rejects.toThrow(/no tool call/i);

        expect(fakeStream).toHaveBeenCalledTimes(3);
    });

    test('agent that never finalizes is auto-committed when maxRounds is hit', async () => {
        const { chat, handle } = makeHandle();
        const ev = {
            type: 'normal',
            placeholderMessageId: 0,
            finalPrompt: '',
            generateData: {},
            takeoverHandle: handle,
            abortSignal: new AbortController().signal,
        };

        // The agent writes a draft, then keeps poking `get_draft` instead
        // of calling finalize. With maxRounds=4 the loop must auto-commit
        // so the user sees the draft.
        const rounds = [
            [{ id: 't1', name: 'write_message', args: { text: 'draft', mode: 'append' } }],
            [{ id: 't2', name: 'get_draft', args: {} }],
            [{ id: 't3', name: 'get_draft', args: {} }],
            [{ id: 't4', name: 'get_draft', args: {} }],
        ];
        let i = 0;
        const fakeStream = jest.fn(async () => {
            const r = rounds[i++];
            return r
                ? { assistantText: '', toolCalls: r, reasoning: null, finishReason: 'tool_calls', usage: null, raw: null }
                : { assistantText: '', toolCalls: [{ id: 'tF', name: 'get_draft', args: {} }], reasoning: null, finishReason: 'tool_calls', usage: null, raw: null };
        });

        await runMainAgentLoop({
            handle,
            profile: { mode: 'director', director: { mainAgent: {}, subAgents: [], maxRounds: 4, tools: {} } },
            eventData: ev,
            deps: {
                generateTaskStreamForMainAgent: fakeStream,
                generateTask: jest.fn(),
                chat,
            },
        });

        expect(fakeStream).toHaveBeenCalledTimes(4);
        // Draft preserved; auto-committed without finalize.
        expect(chat[0].mes).toBe('draft');
        const outcome = await handle.complete;
        expect(outcome.status).toBe('committed');
    });

    test('sub-agent can use loop tools before emitting its terminal text', async () => {
        const { chat, handle } = makeHandle();
        const runId = startRun({ mode: 'director', chatKey: 'test', abortFn: null });
        const ev = {
            type: 'normal',
            placeholderMessageId: 0,
            finalPrompt: '',
            generateData: {},
            takeoverHandle: handle,
            abortSignal: new AbortController().signal,
        };

        // Main agent: dispatch one critic, await, finalize.
        const mainCalls = [
            [{ id: 't1', name: 'dispatch_subagent', args: { subagentId: 'critic', task: 'critique using chat history' } }],
            [{ id: 't2', name: 'await_subagents', args: { handles: ['subagent-0'] } }],
            [{ id: 't3', name: 'finalize', args: {} }],
        ];
        let mainIdx = 0;
        const fakeMainStream = jest.fn(async () => {
            const r = mainCalls[mainIdx++];
            return r
                ? { assistantText: '', toolCalls: r, reasoning: null, finishReason: 'tool_calls', usage: null, raw: null }
                : { assistantText: '', toolCalls: [], reasoning: null, finishReason: 'stop', usage: null, raw: null };
        });

        // Sub-agent runs its own mini-loop:
        //   round 0: call chat_read_range
        //   round 1: emit text (the answer)
        const subRounds = [
            { assistantText: 'let me peek at the chat first', toolCalls: [{ id: 's1', name: 'chat_read_range', args: { start: -3, end: -1 } }] },
            { assistantText: 'The pacing feels rushed in the last line.', toolCalls: [] },
        ];
        let subIdx = 0;
        const fakeSubGenerateTask = jest.fn(async () => {
            const r = subRounds[subIdx++];
            return r
                ? { ...r, reasoning: null, finishReason: r.toolCalls.length ? 'tool_calls' : 'stop', usage: null, raw: null }
                : { assistantText: '', toolCalls: [], reasoning: null, finishReason: 'stop', usage: null, raw: null };
        });

        // executeLoopTool fakes the chat-history return.
        const fakeExecuteLoopTool = jest.fn(async (name, args) => {
            if (name === 'chat_read_range') {
                return [{ index: 0, role: 'user', text: 'hi' }];
            }
            throw new Error(`unexpected tool: ${name}`);
        });

        await runMainAgentLoop({
            handle,
            profile: {
                mode: 'director',
                director: {
                    mainAgent: {},
                    subAgents: [{ id: 'critic', description: 'a critic', systemPrompt: 'be a critic' }],
                    maxRounds: 5,
                    maxConcurrentSubagents: 2,
                    maxTotalSubagentRuns: 5,
                    // Enable the chat tool so the sub-agent can use it.
                    tools: { chat: { read_range: true } },
                },
            },
            eventData: ev,
            deps: {
                generateTaskStreamForMainAgent: fakeMainStream,
                generateTask: fakeSubGenerateTask,
                chat,
                executeLoopTool: fakeExecuteLoopTool,
                runId,
            },
        });

        // Sub-agent's tool got invoked and its terminal text reached the
        // run-panel text section. Two rounds: one tool-using, one
        // text-only terminator.
        expect(fakeExecuteLoopTool).toHaveBeenCalledWith('chat_read_range', { start: -3, end: -1 }, expect.any(Object));
        expect(fakeSubGenerateTask).toHaveBeenCalledTimes(2);
        const outcome = await handle.complete;
        expect(outcome.status).toBe('committed');
        // Terminal text lives in the dispatch round's `text` section.
        // The accumulated body is the concatenation of every round's
        // assistant text streamed into the section (round 0 narration +
        // round 1 terminator).
        const textSection = findSubAgentSection('subagent-0', 'critic', 'text');
        expect(textSection).toBeTruthy();
        expect(textSection.body).toContain('The pacing feels rushed in the last line.');
        // The tool call itself shows up as its own section under the
        // dispatch round so the panel can render it next to the text.
        const subRound = findSubAgentRound('subagent-0', 'critic');
        const toolCallSection = (subRound?.sections || []).find(s => s.kind === 'tool_call');
        expect(toolCallSection).toBeTruthy();
        expect(toolCallSection.title).toMatch(/chat_read_range/);
        // Chat reasoning fold stays empty across the entire sub-agent
        // mini-loop, including the tool call.
        expect(chat[0].extra.reasoning).toBe('');
    });

    test('main agent can call get_draft to re-read the in-flight message body', async () => {
        const { chat, handle } = makeHandle();
        const ev = {
            type: 'normal',
            placeholderMessageId: 0,
            finalPrompt: '',
            generateData: {},
            takeoverHandle: handle,
            abortSignal: new AbortController().signal,
        };

        const calls = [
            [{ id: 't1', name: 'write_message', args: { text: 'Hello there.', mode: 'append' } }],
            [{ id: 't2', name: 'get_draft', args: {} }],
            [{ id: 't3', name: 'finalize', args: {} }],
        ];
        let i = 0;
        const fakeStream = jest.fn(async () => ({
            assistantText: '',
            toolCalls: calls[i++] || [],
            reasoning: null,
            finishReason: 'tool_calls',
            usage: null,
            raw: null,
        }));

        await runMainAgentLoop({
            handle,
            profile: { mode: 'director', director: { mainAgent: {}, subAgents: [], maxRounds: 5, tools: {} } },
            eventData: ev,
            deps: {
                generateTaskStreamForMainAgent: fakeStream,
                generateTask: jest.fn(),
                chat,
            },
        });

        expect(chat[0].mes).toBe('Hello there.');
        // After round 1 (get_draft), the next round's messages should contain
        // a tool message with the draft text.
        const round3CallOpts = fakeStream.mock.calls[2][0];
        const toolMsg = round3CallOpts.taskMessages.find(m => m.role === 'tool' && m.tool_call_id === 't2');
        expect(toolMsg).toBeDefined();
        const parsed = JSON.parse(toolMsg.content);
        expect(parsed.ok).toBe(true);
        expect(parsed.text).toBe('Hello there.');
    });

    test('sub-agent completion notification appears as a system message in the next round', async () => {
        const { chat, handle } = makeHandle();
        const ev = {
            type: 'normal',
            placeholderMessageId: 0,
            finalPrompt: '',
            generateData: {},
            takeoverHandle: handle,
            abortSignal: new AbortController().signal,
        };

        // Main agent: dispatch (round 0), poke get_draft (round 1), then
        // finalize (round 2). Between rounds 0 and 1, the sub-agent
        // completes, and at the top of round 1 the runtime should inject
        // a `[Runtime] sub-agent ... completed ...` system message.
        const mainCalls = [
            [{ id: 't1', name: 'dispatch_subagent', args: { subagentId: 'critic', task: 'just say done' } }],
            [{ id: 'tg', name: 'get_draft', args: {} }],
            [{ id: 't2', name: 'finalize', args: {} }],
        ];
        let mainIdx = 0;
        const fakeMainStream = jest.fn(async () => {
            const r = mainCalls[mainIdx++];
            return r !== undefined
                ? { assistantText: '', toolCalls: r, reasoning: null, finishReason: 'tool_calls', usage: null, raw: null }
                : { assistantText: '', toolCalls: [], reasoning: null, finishReason: 'stop', usage: null, raw: null };
        });

        const fakeSubAgent = jest.fn(async () => ({ assistantText: 'done', toolCalls: [], reasoning: null, finishReason: 'stop' }));

        await runMainAgentLoop({
            handle,
            profile: {
                mode: 'director',
                director: {
                    mainAgent: {},
                    subAgents: [{ id: 'critic', description: 'c', systemPrompt: 'c' }],
                    maxRounds: 5,
                    maxConcurrentSubagents: 2,
                    maxTotalSubagentRuns: 5,
                    tools: {},
                },
            },
            eventData: ev,
            deps: {
                generateTaskStreamForMainAgent: fakeMainStream,
                generateTask: fakeSubAgent,
                chat,
            },
        });

        // mock.calls[i][0].taskMessages all reference the same `messages`
        // array (the runtime mutates it in place across rounds), so we
        // look at the final state and assert exactly one [Runtime]
        // sub-agent notification was injected — fired once per handle
        // and never re-emitted.
        const finalMsgs = fakeMainStream.mock.calls.at(-1)[0].taskMessages;
        const runtimeNotifs = finalMsgs.filter(m =>
            m.role === 'system' && String(m.content).startsWith('[Runtime] sub-agent'));
        expect(runtimeNotifs).toHaveLength(1);
        expect(runtimeNotifs[0].content).toMatch(/subagent-0/);
        expect(runtimeNotifs[0].content).toMatch(/critic/);
        expect(runtimeNotifs[0].content).toMatch(/completed/);
    });

    test('main agent can cancel an in-flight sub-agent mid-run', async () => {
        const { chat, handle } = makeHandle();
        const ev = {
            type: 'normal',
            placeholderMessageId: 0,
            finalPrompt: '',
            generateData: {},
            takeoverHandle: handle,
            abortSignal: new AbortController().signal,
        };

        // Sub-agent stalls until aborted.
        const fakeSubAgent = jest.fn(async (opts) => {
            await new Promise((resolve, reject) => {
                if (opts.abortSignal?.aborted) {
                    reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                    return;
                }
                opts.abortSignal?.addEventListener('abort', () => {
                    reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                }, { once: true });
                // Don't resolve naturally — wait for abort. Fallback at
                // 200ms in case the test logic misses cancel, so the test
                // doesn't hang forever; the assertion will still catch
                // the missing cancel.
                setTimeout(resolve, 200);
            });
            return { assistantText: 'never reached', toolCalls: [], reasoning: null, finishReason: 'stop' };
        });

        const mainCalls = [
            [{ id: 't1', name: 'dispatch_subagent', args: { subagentId: 'slow', task: 'long' } }],
            [{ id: 't2', name: 'cancel_subagent', args: { handle: 'subagent-0' } }],
            [{ id: 't3', name: 'await_subagents', args: { handles: ['subagent-0'] } }],
            [{ id: 't4', name: 'finalize', args: {} }],
        ];
        let mainIdx = 0;
        const fakeMainStream = jest.fn(async () => {
            const r = mainCalls[mainIdx++];
            return r
                ? { assistantText: '', toolCalls: r, reasoning: null, finishReason: 'tool_calls', usage: null, raw: null }
                : { assistantText: '', toolCalls: [], reasoning: null, finishReason: 'stop', usage: null, raw: null };
        });

        await runMainAgentLoop({
            handle,
            profile: {
                mode: 'director',
                director: {
                    mainAgent: {},
                    subAgents: [{ id: 'slow', description: '', systemPrompt: 's' }],
                    maxRounds: 6,
                    maxConcurrentSubagents: 2,
                    maxTotalSubagentRuns: 5,
                    tools: {},
                },
            },
            eventData: ev,
            deps: {
                generateTaskStreamForMainAgent: fakeMainStream,
                generateTask: fakeSubAgent,
                chat,
            },
        });

        // The await result for subagent-0 should be an error (cancelled).
        // We check by inspecting the messages from the await round's
        // next round opts.
        const round3Opts = fakeMainStream.mock.calls[3][0];
        const awaitToolMsg = round3Opts.taskMessages.find(m => m.role === 'tool' && m.tool_call_id === 't3');
        expect(awaitToolMsg).toBeDefined();
        const parsed = JSON.parse(awaitToolMsg.content);
        const result0 = parsed.results.find(r => r.handleId === 'subagent-0');
        expect(result0.error).toMatch(/cancel|abort/i);
        // And cancel's tool result was ok.
        const cancelToolMsg = round3Opts.taskMessages.find(m => m.role === 'tool' && m.tool_call_id === 't2');
        const cancelParsed = JSON.parse(cancelToolMsg.content);
        expect(cancelParsed.ok).toBe(true);
    });

    test('fork-on-dispatch — sub-agent dispatched after await sees prior sub outputs via digest', async () => {
        // Scenario: round 1 dispatches curator, round 2 awaits, round 3
        // dispatches brainstormer. Brainstormer must see curator's
        // outputText inside its rendered digest message.
        const { chat, handle } = makeHandle();
        const ev = {
            type: 'normal',
            placeholderMessageId: 0,
            finalPrompt: '',
            generateData: {},
            takeoverHandle: handle,
            abortSignal: new AbortController().signal,
        };

        const mainCalls = [
            [{ id: 't1', name: 'dispatch_subagent', args: { subagentId: 'curator', task: 'gather' } }],
            [{ id: 't2', name: 'await_subagents', args: { handles: ['subagent-0'] } }],
            [{ id: 't3', name: 'dispatch_subagent', args: { subagentId: 'brainstormer', task: 'tension up' } }],
            [{ id: 't4', name: 'await_subagents', args: { handles: ['subagent-1'] } }],
            [{ id: 't5', name: 'finalize', args: {} }],
        ];
        let mi = 0;
        const fakeMainStream = jest.fn(async () => ({
            assistantText: `main round ${mi}`,
            toolCalls: mainCalls[mi++] || [],
            reasoning: null, finishReason: 'tool_calls', usage: null, raw: null,
        }));

        const capturedSubTaskMessages = [];
        const fakeSubGenerate = jest.fn(async ({ taskMessages }) => {
            const allContent = taskMessages.map(m => String(m?.content || '')).join('\n');
            const role = allContent.includes('You are a curator.') ? 'curator' : 'brainstormer';
            capturedSubTaskMessages.push({ role, messages: taskMessages.slice() });
            if (role === 'curator') {
                return { assistantText: 'CURATOR_BRIEFING_X', toolCalls: [], reasoning: null, finishReason: 'stop', usage: null, raw: null };
            }
            return { assistantText: 'brainstormer output', toolCalls: [], reasoning: null, finishReason: 'stop', usage: null, raw: null };
        });

        handle.setText('placeholder');
        await runMainAgentLoop({
            handle,
            profile: {
                mode: 'director',
                director: {
                    mainAgent: {},
                    subAgents: [
                        { id: 'curator', description: 'cur', systemPrompt: 'You are a curator.' },
                        { id: 'brainstormer', description: 'b', systemPrompt: 'You are a brainstormer.' },
                    ],
                    maxRounds: 8,
                    maxConcurrentSubagents: 2,
                    maxTotalSubagentRuns: 5,
                    tools: {},
                },
            },
            eventData: ev,
            deps: {
                generateTaskStreamForMainAgent: fakeMainStream,
                generateTask: fakeSubGenerate,
                chat,
            },
        });

        const brainstormerCall = capturedSubTaskMessages.find(c => c.role === 'brainstormer');
        expect(brainstormerCall).toBeDefined();
        const digestMessage = brainstormerCall.messages.find(m =>
            m.role === 'system' && String(m.content || '').includes('## Main agent context'),
        );
        expect(digestMessage).toBeDefined();
        expect(digestMessage.content).toContain('CURATOR_BRIEFING_X');
    });

    test('fork-on-dispatch — same-round sibling sub-agents do not see each other', async () => {
        // Scenario: round 1 dispatches 3 brainstormers in parallel.
        // None of the three should see any sibling's outputText (none
        // have completed yet from each one's parent-snapshot perspective,
        // which was captured BEFORE this round's generate).
        const { chat, handle } = makeHandle();
        const ev = {
            type: 'normal',
            placeholderMessageId: 0,
            finalPrompt: '',
            generateData: {},
            takeoverHandle: handle,
            abortSignal: new AbortController().signal,
        };

        const mainCalls = [
            [
                { id: 'd1', name: 'dispatch_subagent', args: { subagentId: 'brainstormer', task: 'A' } },
                { id: 'd2', name: 'dispatch_subagent', args: { subagentId: 'brainstormer', task: 'B' } },
                { id: 'd3', name: 'dispatch_subagent', args: { subagentId: 'brainstormer', task: 'C' } },
            ],
            [{ id: 'tf', name: 'finalize', args: {} }],
        ];
        let mi = 0;
        const fakeMainStream = jest.fn(async () => ({
            assistantText: '',
            toolCalls: mainCalls[mi++] || [],
            reasoning: null, finishReason: 'tool_calls', usage: null, raw: null,
        }));

        const captured = [];
        let subCounter = 0;
        const fakeSubGenerate = jest.fn(async ({ taskMessages }) => {
            captured.push(taskMessages.slice());
            subCounter++;
            return { assistantText: `SIBLING_OUT_${subCounter}`, toolCalls: [], reasoning: null, finishReason: 'stop', usage: null, raw: null };
        });

        handle.setText('placeholder');
        await runMainAgentLoop({
            handle,
            profile: {
                mode: 'director',
                director: {
                    mainAgent: {},
                    subAgents: [{ id: 'brainstormer', description: '', systemPrompt: 'You are a brainstormer.' }],
                    maxRounds: 4,
                    maxConcurrentSubagents: 3,
                    maxTotalSubagentRuns: 5,
                    tools: {},
                },
            },
            eventData: ev,
            deps: {
                generateTaskStreamForMainAgent: fakeMainStream,
                generateTask: fakeSubGenerate,
                chat,
            },
        });

        // All three brainstormers' captured task-messages must NOT
        // contain any sibling's output text. (They each see the same
        // parent snapshot taken BEFORE the dispatch round generate ran
        // — so no sibling has produced anything yet from their POV.)
        expect(captured).toHaveLength(3);
        for (const subMsgs of captured) {
            const joined = subMsgs.map(m => String(m.content || '')).join('\n');
            expect(joined).not.toMatch(/SIBLING_OUT_/);
        }
    });

    test("fork-on-dispatch — sub-agent's parent snapshot prefix is stable across its internal loop", async () => {
        // Sub-agent takes 3 internal rounds before converging. Across
        // those rounds, the BASE prefix of taskMessages (system + chat
        // + task) must be byte-identical — the snapshot taken at
        // dispatch time does not get replaced or rewritten as the sub
        // loops.
        const { chat, handle } = makeHandle();
        const ev = {
            type: 'normal',
            placeholderMessageId: 0,
            finalPrompt: '',
            generateData: {},
            takeoverHandle: handle,
            abortSignal: new AbortController().signal,
        };

        const mainCalls = [
            [{ id: 'd1', name: 'dispatch_subagent', args: { subagentId: 's1', task: 'long-running' } }],
            [{ id: 'a1', name: 'await_subagents', args: { handles: ['subagent-0'] } }],
            [{ id: 'tf', name: 'finalize', args: {} }],
        ];
        let mi = 0;
        const fakeMainStream = jest.fn(async () => ({
            assistantText: '',
            toolCalls: mainCalls[mi++] || [],
            reasoning: null, finishReason: 'tool_calls', usage: null, raw: null,
        }));

        const subCaptures = [];
        let s1Round = 0;
        const fakeSubGenerate = jest.fn(async ({ taskMessages }) => {
            s1Round++;
            subCaptures.push(taskMessages.slice());
            if (s1Round < 3) {
                // get_draft is always available to sub-agents and is
                // a no-op for this scenario — keeps the sub looping.
                return {
                    assistantText: `s1 round ${s1Round}`,
                    toolCalls: [{ id: `s1tc${s1Round}`, name: 'get_draft', args: {} }],
                    reasoning: null, finishReason: 'tool_calls', usage: null, raw: null,
                };
            }
            return { assistantText: 'final', toolCalls: [], reasoning: null, finishReason: 'stop', usage: null, raw: null };
        });

        handle.setText('placeholder');
        await runMainAgentLoop({
            handle,
            profile: {
                mode: 'director',
                director: {
                    mainAgent: {},
                    subAgents: [{ id: 's1', description: '', systemPrompt: 'sub one' }],
                    maxRounds: 5,
                    maxConcurrentSubagents: 1,
                    maxTotalSubagentRuns: 5,
                    tools: {},
                },
            },
            eventData: ev,
            deps: {
                generateTaskStreamForMainAgent: fakeMainStream,
                generateTask: fakeSubGenerate,
                chat,
            },
        });

        expect(subCaptures.length).toBeGreaterThanOrEqual(3);
        // First round dispatch had no main rounds prior → no digest
        // user message. So sub messages on each internal round start
        // with [system, task, ...sub's own internal turns]. The first
        // 2 entries are the frozen base.
        const baseline = subCaptures[0].slice(0, 2);
        for (let i = 1; i < subCaptures.length; i++) {
            expect(subCaptures[i].slice(0, 2)).toEqual(baseline);
        }
    });

    test('fork-on-dispatch — sub dispatched after another non-awaited sub sees only the dispatch tool-invocation line, not the prior output', async () => {
        // Round 1: dispatch sub-A (no await).
        // Round 2: dispatch sub-B. sub-B's digest should mention that
        // dispatch_subagent was invoked in round 1, but must NOT include
        // sub-A's outputText (it has not been awaited; its output is
        // not in main's messages, only its handle is).
        const { chat, handle } = makeHandle();
        const ev = {
            type: 'normal',
            placeholderMessageId: 0,
            finalPrompt: '',
            generateData: {},
            takeoverHandle: handle,
            abortSignal: new AbortController().signal,
        };

        const mainCalls = [
            [{ id: 'd1', name: 'dispatch_subagent', args: { subagentId: 'A', task: 'a-task' } }],
            [{ id: 'd2', name: 'dispatch_subagent', args: { subagentId: 'B', task: 'b-task' } }],
            [{ id: 'tf', name: 'finalize', args: {} }],
        ];
        let mi = 0;
        const fakeMainStream = jest.fn(async () => ({
            assistantText: '',
            toolCalls: mainCalls[mi++] || [],
            reasoning: null, finishReason: 'tool_calls', usage: null, raw: null,
        }));

        const capturedB = [];
        const fakeSubGenerate = jest.fn(async ({ taskMessages }) => {
            const allContent = taskMessages.map(m => String(m?.content || '')).join('\n');
            const role = allContent.includes('sub B') ? 'B' : 'A';
            if (role === 'B') capturedB.push(taskMessages.slice());
            return { assistantText: `OUT_${role}_UNIQUE`, toolCalls: [], reasoning: null, finishReason: 'stop', usage: null, raw: null };
        });

        handle.setText('placeholder');
        await runMainAgentLoop({
            handle,
            profile: {
                mode: 'director',
                director: {
                    mainAgent: {},
                    subAgents: [
                        { id: 'A', description: '', systemPrompt: 'sub A' },
                        { id: 'B', description: '', systemPrompt: 'sub B' },
                    ],
                    maxRounds: 4,
                    maxConcurrentSubagents: 2,
                    maxTotalSubagentRuns: 5,
                    tools: {},
                },
            },
            eventData: ev,
            deps: {
                generateTaskStreamForMainAgent: fakeMainStream,
                generateTask: fakeSubGenerate,
                chat,
            },
        });

        expect(capturedB).toHaveLength(1);
        const bMsgs = capturedB[0];
        const digest = bMsgs.find(m => m.role === 'system' && String(m.content || '').includes('## Main agent context'));
        expect(digest).toBeDefined();
        expect(digest.content).toContain('[Main agent invoked tools: dispatch_subagent]');
        // sub-A's outputText was not yet in main's messages (no await
        // happened) so it must not appear in sub-B's digest.
        expect(digest.content).not.toContain('OUT_A_UNIQUE');
    });

    test('main agent executeLoopTool sees __floorStateForNotes via contextForNotes overlay', async () => {
        // Symmetric regression for the notes adapter: same root cause as
        // the memory overlay miss — main.js wires contextForNotes, but
        // the main-agent's executeLoopTool ctx never spread it, so
        // note_open / note_close from main agent silently lacked the
        // floor-state adapter.
        const { chat, handle } = makeHandle();
        const ev = {
            type: 'normal',
            placeholderMessageId: 0,
            finalPrompt: '',
            generateData: {},
            takeoverHandle: handle,
            abortSignal: new AbortController().signal,
        };

        const notesCtx = {
            __floorStateForNotes: {
                appendForFloor: async () => 'n1',
                listAcrossFloors: async () => [],
                updateStatusById: async () => ({ ok: true }),
            },
        };

        const seenToolCtx = [];
        const executeLoopTool = jest.fn(async (_name, _args, ctx) => {
            seenToolCtx.push(ctx);
            return { id: 'n1' };
        });

        const calls = [
            [{ id: 't1', name: 'note_open', args: { text: 'pending' } }],
            [{ id: 'tf', name: 'finalize', args: {} }],
        ];
        let i = 0;
        const fakeStream = jest.fn(async () => ({
            assistantText: '',
            toolCalls: calls[i++] || [],
            reasoning: null,
            finishReason: 'tool_calls',
            usage: null,
            raw: null,
        }));

        handle.setText('placeholder');
        await runMainAgentLoop({
            handle,
            profile: { mode: 'director', director: { mainAgent: {}, subAgents: [], maxRounds: 3, tools: { note: { open: true } } } },
            eventData: ev,
            deps: {
                generateTaskStreamForMainAgent: fakeStream,
                generateTask: jest.fn(),
                chat,
                executeLoopTool,
                contextForNotes: notesCtx,
            },
        });

        expect(executeLoopTool).toHaveBeenCalledTimes(1);
        expect(executeLoopTool.mock.calls[0][0]).toBe('note_open');
        expect(seenToolCtx[0].__floorStateForNotes).toBe(notesCtx.__floorStateForNotes);
        expect(seenToolCtx[0].chat).toBe(chat);
    });

    test('main agent executeLoopTool ctx inherits updateChatState from contextForNotes prototype', async () => {
        const { chat, handle } = makeHandle();
        const ev = {
            type: 'normal',
            placeholderMessageId: 0,
            finalPrompt: '',
            generateData: {},
            takeoverHandle: handle,
            abortSignal: new AbortController().signal,
        };

        const updateChatState = jest.fn(async () => ({ ok: true }));
        const stContext = { updateChatState };
        const notesCtx = Object.create(stContext);
        notesCtx.__floorStateForNotes = {
            appendForFloor: async () => 'n1',
            listAcrossFloors: async () => [],
            updateStatusById: async () => ({ ok: true }),
        };

        const seenToolCtx = [];
        const executeLoopTool = jest.fn(async (_name, _args, ctx) => {
            seenToolCtx.push(ctx);
            return { ok: true };
        });

        const calls = [
            [{ id: 't1', name: 'memory_keyword_search', args: { query: 'x' } }],
            [{ id: 'tf', name: 'finalize', args: {} }],
        ];
        let i = 0;
        const fakeStream = jest.fn(async () => ({
            assistantText: '',
            toolCalls: calls[i++] || [],
            reasoning: null,
            finishReason: 'tool_calls',
            usage: null,
            raw: null,
        }));

        handle.setText('placeholder');
        await runMainAgentLoop({
            handle,
            profile: { mode: 'director', director: { mainAgent: {}, subAgents: [], maxRounds: 3, tools: { custom: { memory_keyword_search: true } } } },
            eventData: ev,
            deps: {
                generateTaskStreamForMainAgent: fakeStream,
                generateTask: jest.fn(),
                chat,
                executeLoopTool,
                contextForNotes: notesCtx,
            },
        });

        expect(seenToolCtx[0].updateChatState).toBe(updateChatState);
    });

    test('tool_call / tool_result sections carry full args + result in body, plus source meta', async () => {
        // The simulation review popup reads tool args and results out of
        // the RunStateStore section bodies (the panel uses meta for chip
        // labels; the popup needs the full payload). director-runtime
        // appends the JSON-serialized arg / result to each section body
        // alongside ensureSection, and stamps the tool's source layer
        // (builtin / extension / profile) onto meta.source.
        const { chat, handle } = makeHandle();
        clearCurrentRun();
        const runId = startRun({ mode: 'director', chatKey: 'k' });

        const ev = {
            type: 'normal',
            placeholderMessageId: 0,
            finalPrompt: '',
            generateData: {},
            takeoverHandle: handle,
            abortSignal: new AbortController().signal,
        };
        // Use a Layer-1 loop-tool (chat_read_range) routed through
        // executeLoopTool — resolveToolSource recognizes it as 'builtin'.
        // Director's own native tools (write_message / finalize / etc.)
        // are owned by director-runtime, not the loop-tool registry, so
        // they would tag as 'unknown'; the source value surfaces verbatim
        // on meta so the popup can decide whether to render the layer
        // chip either way.
        const calls = [
            [{ id: 't1', name: 'chat_read_range', args: { start: 0, end: 1 } }],
            [{ id: 'tf', name: 'finalize', args: {} }],
        ];
        let i = 0;
        const fakeStream = jest.fn(async () => ({
            assistantText: '',
            toolCalls: calls[i++] || [],
            reasoning: null,
            finishReason: 'tool_calls',
        }));
        const executeLoopTool = jest.fn(async () => ({ ok: true, lines: ['line0'] }));

        handle.setText('placeholder');
        await runMainAgentLoop({
            handle,
            profile: { mode: 'director', mainAgent: {}, subAgents: [], maxRounds: 3, tools: { chat: { read_range: true } } },
            eventData: ev,
            deps: {
                generateTaskStreamForMainAgent: fakeStream,
                generateTask: jest.fn(),
                chat,
                executeLoopTool,
                runId,
            },
        });

        const run = getCurrentRun();
        const mainRound = run.rounds.find(r => r.id === 'main-0');
        expect(mainRound).toBeDefined();
        const toolCallSection = mainRound.sections.find(s => s.kind === 'tool_call' && s.id === 'tool-0');
        const toolResultSection = mainRound.sections.find(s => s.kind === 'tool_result' && s.id === 'tool-result-0');
        expect(toolCallSection).toBeDefined();
        expect(toolResultSection).toBeDefined();
        // args land in both meta (for the panel's chip) and body (for
        // the simulation review popup's full-payload card).
        expect(toolCallSection.meta?.args).toEqual({ start: 0, end: 1 });
        expect(JSON.parse(toolCallSection.body)).toEqual({ start: 0, end: 1 });
        // chat_read_range lives in loop-tools' REGISTRY → 'builtin'.
        expect(toolCallSection.meta?.source).toBe('builtin');
        // tool_result body carries the executor's return wrapped in `{ok, result}`.
        const parsedResult = JSON.parse(toolResultSection.body);
        expect(parsedResult.ok).toBe(true);
        expect(parsedResult.result).toEqual({ ok: true, lines: ['line0'] });
    });
});

