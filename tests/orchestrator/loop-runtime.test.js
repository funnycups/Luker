/**
 * Loop-runtime tests.
 *
 * Layered against the plan's Task 5/6/7 boundaries:
 *
 *   - Task 5: minimum happy path. The agent calls `finalize` on the first
 *     round, the runtime returns the capsule and reports `total_rounds=1`.
 *     Only a fake `sendLlm` is injected; no other tools exist yet.
 *   - Task 6: failure-safety budgets — `max_rounds` exhaustion (with
 *     fallback to last natural assistant text), the `no_tool_call_streak`
 *     short-circuit at 3 consecutive empty tool-call rounds, and the
 *     wall-clock deadline.
 *   - Task 7: real LLM wiring + structured tool-error feedback. A failing
 *     tool surfaces a `ToolError` that the runtime re-injects as a tool
 *     message so the next round sees it; the agent then self-corrects.
 *
 * The runtime accepts a `deps` parameter for dependency injection so we
 * never need to call the real `requestToolCallsWithRetry` here. Tests
 * exercise the protection envelope and the messages-array contract — the
 * real-LLM adapter is exercised via integration in later tasks.
 */

import { describe, test, expect, jest } from '@jest/globals';

import {
    runLoopOrchestration,
    ToolError,
} from '../../public/scripts/extensions/orchestrator/loop-runtime.js';

function makeProfile(overrides = {}) {
    return {
        mode: 'loop',
        apiPresetName: '',
        promptPresetName: '',
        system_prompt: 'You are a research agent.',
        tools: {
            note: { add: false },
            chat: { read_range: false, search: false },
            lorebook: { search: false, get: false },
            memory: { search: false, list_recent: false, get: false },
            finalize: true,
        },
        max_rounds: 5,
        wall_clock_budget_ms: 60000,
        capsule_inject: { position: 'atDepth', depth: 0, role: 'system', customInstruction: '' },
        ...overrides,
    };
}

function makePayload(overrides = {}) {
    return {
        signal: new AbortController().signal,
        coreChat: [],
        ...overrides,
    };
}

function makeContext(overrides = {}) {
    return {
        chat: [],
        ...overrides,
    };
}

describe('runLoopOrchestration minimal happy path (Task 5)', () => {
    test('returns capsule when agent calls finalize on first round', async () => {
        const sendLlm = jest.fn().mockResolvedValueOnce({
            toolCalls: [
                { id: 'tc1', name: 'finalize', args: { capsule_text: 'Final guidance.' } },
            ],
            assistantText: '',
        });

        const result = await runLoopOrchestration(makeContext(), makePayload(), makeProfile(), {
            sendLlm,
        });

        expect(result.status).toBe('completed');
        expect(result.capsule).toBe('Final guidance.');
        expect(result.total_rounds).toBe(1);
        expect(sendLlm).toHaveBeenCalledTimes(1);
    });

    test('records run_started / run_finished trace events', async () => {
        const sendLlm = jest.fn().mockResolvedValueOnce({
            toolCalls: [
                { id: 'tc1', name: 'finalize', args: { capsule_text: 'ok' } },
            ],
            assistantText: '',
        });

        const result = await runLoopOrchestration(makeContext(), makePayload(), makeProfile(), { sendLlm });

        expect(result.runtimeTrace).toBeTruthy();
        const types = result.runtimeTrace.events.map(e => e.type);
        expect(types).toContain('run_started');
        expect(types).toContain('run_finished');
    });

    test('records spec-aligned event types (llm_request/llm_response/tool_call/tool_result)', async () => {
        const sendLlm = jest.fn().mockResolvedValueOnce({
            toolCalls: [
                { id: 'tc1', name: 'finalize', args: { capsule_text: 'ok' } },
            ],
            assistantText: 'thinking...',
        });

        const result = await runLoopOrchestration(makeContext(), makePayload(), makeProfile(), { sendLlm });

        const types = result.runtimeTrace.events.map(e => e.type);
        expect(types).toContain('llm_request');
        expect(types).toContain('llm_response');
        expect(types).toContain('tool_call');
        expect(types).toContain('tool_result');

        // llm_request carries message_count for sink consumers
        const req = result.runtimeTrace.events.find(e => e.type === 'llm_request');
        expect(typeof req.message_count).toBe('number');
        expect(req.round).toBe(1);

        // llm_response carries tool_call_count
        const resp = result.runtimeTrace.events.find(e => e.type === 'llm_response');
        expect(resp.tool_call_count).toBe(1);
        expect(resp.has_assistant_text).toBe(true);
    });

    test('throws when payload signal is already aborted', async () => {
        const aborter = new AbortController();
        aborter.abort();
        const sendLlm = jest.fn();
        await expect(
            runLoopOrchestration(makeContext(), makePayload({ signal: aborter.signal }), makeProfile(), { sendLlm }),
        ).rejects.toThrow(/aborted/i);
        expect(sendLlm).not.toHaveBeenCalled();
    });

    test('forwards deps.settings to sendLlm so retries/timeout/rpm are honored', async () => {
        // Regression: the orchestrator dispatcher must thread `settings`
        // into the loop runtime so `requestToolCallsWithRetry` reads
        // `toolCallRetryMax` / `agentTimeoutSeconds` / `rpmLimit`. The
        // production transport (`defaultSendLlm`) takes `settings` from
        // the deps and passes it straight through; here we verify the
        // runtime forwards it on every round, including before finalize.
        const sendLlm = jest.fn().mockResolvedValueOnce({
            toolCalls: [{ id: 'tc1', name: 'finalize', args: { capsule_text: 'ok' } }],
            assistantText: '',
        });
        const settings = { toolCallRetryMax: 3, agentTimeoutSeconds: 30, rpmLimit: 60 };
        await runLoopOrchestration(makeContext(), makePayload(), makeProfile(), {
            sendLlm,
            settings,
        });
        expect(sendLlm).toHaveBeenCalledTimes(1);
        const args = sendLlm.mock.calls[0][0];
        expect(args.settings).toBe(settings);
        expect(args.settings.toolCallRetryMax).toBe(3);
        expect(args.settings.agentTimeoutSeconds).toBe(30);
        expect(args.settings.rpmLimit).toBe(60);
    });
});

describe('runLoopOrchestration failure-safety budgets (Task 6)', () => {
    test('exhausts at max_rounds and falls back to last natural assistant text', async () => {
        const sendLlm = jest.fn()
            .mockResolvedValueOnce({
                toolCalls: [{ id: 't1', name: 'unknown', args: {} }],
                assistantText: '',
            })
            .mockResolvedValueOnce({
                toolCalls: [{ id: 't2', name: 'unknown', args: {} }],
                assistantText: 'partial draft',
            })
            .mockResolvedValueOnce({
                toolCalls: [{ id: 't3', name: 'unknown', args: {} }],
                assistantText: 'better draft',
            });

        const result = await runLoopOrchestration(makeContext(), makePayload(), makeProfile({ max_rounds: 3 }), {
            sendLlm,
        });

        expect(result.status).toBe('budget_exhausted');
        expect(result.capsule).toBe('better draft');
        expect(result.total_rounds).toBe(3);
        expect(sendLlm).toHaveBeenCalledTimes(3);
    });

    test('breaks early after no_tool_call_streak >= 3 with no fallback text', async () => {
        const sendLlm = jest.fn().mockResolvedValue({ toolCalls: [], assistantText: '' });

        const result = await runLoopOrchestration(makeContext(), makePayload(), makeProfile({ max_rounds: 20 }), {
            sendLlm,
        });

        expect(result.status).toBe('budget_exhausted');
        expect(result.total_rounds).toBe(3);
        expect(sendLlm).toHaveBeenCalledTimes(3);
        expect(result.capsule).toBeNull();
    });

    test('streak break still preserves assistant text fallback when present', async () => {
        const sendLlm = jest.fn().mockResolvedValue({ toolCalls: [], assistantText: 'just talking' });

        const result = await runLoopOrchestration(makeContext(), makePayload(), makeProfile({ max_rounds: 20 }), {
            sendLlm,
        });

        expect(result.status).toBe('budget_exhausted');
        expect(result.capsule).toBe('just talking');
        expect(result.total_rounds).toBe(3);
    });

    test('breaks at wall_clock deadline before max_rounds', async () => {
        const sendLlm = jest.fn().mockImplementation(async () => {
            await new Promise(resolve => setTimeout(resolve, 30));
            return { toolCalls: [{ id: 'x', name: 'unknown', args: {} }], assistantText: '' };
        });

        const profile = makeProfile({ max_rounds: 100, wall_clock_budget_ms: 50 });

        const result = await runLoopOrchestration(makeContext(), makePayload(), profile, { sendLlm });

        expect(result.status).toBe('budget_exhausted');
        expect(result.total_rounds).toBeLessThan(100);
    });

    test('streak counter resets when a tool call appears mid-loop', async () => {
        // Two empty rounds, then one tool call (resets streak), then two
        // more empty rounds — should NOT trigger streak break (we only had
        // 2 in a row at the end). Loop hits max_rounds=5 instead.
        const sendLlm = jest.fn()
            .mockResolvedValueOnce({ toolCalls: [], assistantText: '' })
            .mockResolvedValueOnce({ toolCalls: [], assistantText: '' })
            .mockResolvedValueOnce({ toolCalls: [{ id: 'x', name: 'unknown', args: {} }], assistantText: '' })
            .mockResolvedValueOnce({ toolCalls: [], assistantText: '' })
            .mockResolvedValueOnce({ toolCalls: [], assistantText: 'final draft' });

        const result = await runLoopOrchestration(makeContext(), makePayload(), makeProfile({ max_rounds: 5 }), {
            sendLlm,
        });

        expect(result.status).toBe('budget_exhausted');
        expect(result.total_rounds).toBe(5);
        expect(result.capsule).toBe('final draft');
        expect(sendLlm).toHaveBeenCalledTimes(5);
    });

    test('budget_exhausted trace records reason note', async () => {
        const sendLlm = jest.fn().mockResolvedValue({ toolCalls: [], assistantText: '' });

        const result = await runLoopOrchestration(makeContext(), makePayload(), makeProfile({ max_rounds: 20 }), {
            sendLlm,
        });

        expect(result.runtimeTrace.status).toBe('budget_exhausted');
        const finalEvent = result.runtimeTrace.events.find(e => e.type === 'run_finished');
        expect(finalEvent.status).toBe('budget_exhausted');
    });

    test('emits agent_no_tool_call and budget_exhausted with reason on streak exhaustion', async () => {
        const sendLlm = jest.fn().mockResolvedValue({ toolCalls: [], assistantText: '' });
        const result = await runLoopOrchestration(makeContext(), makePayload(), makeProfile({ max_rounds: 20 }), {
            sendLlm,
        });

        const noToolEvents = result.runtimeTrace.events.filter(e => e.type === 'agent_no_tool_call');
        expect(noToolEvents.length).toBeGreaterThanOrEqual(3);
        const budgetEvents = result.runtimeTrace.events.filter(e => e.type === 'budget_exhausted');
        expect(budgetEvents.length).toBeGreaterThan(0);
        const streakEvent = budgetEvents.find(e => e.reason === 'no_tool_call_streak');
        expect(streakEvent).toBeTruthy();
        expect(streakEvent.streak).toBe(3);
    });

    test('emits budget_exhausted with reason="max_rounds" when loop runs to its hard cap', async () => {
        // Agent calls a non-existent tool every round → tool_error feedback,
        // never finalize → max_rounds hit.
        const sendLlm = jest.fn().mockResolvedValue({
            toolCalls: [{ id: 'tc1', name: 'unknown.tool', args: {} }],
            assistantText: '',
        });
        const executeTool = jest.fn().mockImplementation(async () => {
            throw new ToolError('unknown tool', 'UNKNOWN');
        });

        const result = await runLoopOrchestration(makeContext(), makePayload(), makeProfile({ max_rounds: 2 }), {
            sendLlm,
            executeTool,
        });

        expect(result.status).toBe('budget_exhausted');
        const budgetEvent = result.runtimeTrace.events.find(
            e => e.type === 'budget_exhausted' && e.reason === 'max_rounds',
        );
        expect(budgetEvent).toBeTruthy();
        expect(budgetEvent.limit).toBe(2);
    });
});

describe('runLoopOrchestration tool errors and self-correction (Task 7)', () => {
    test('ToolError carries code and hint metadata', () => {
        const err = new ToolError('boom', 'BAD_THING', 'try again');
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toBe('boom');
        expect(err.code).toBe('BAD_THING');
        expect(err.hint).toBe('try again');
    });

    test('ToolError defaults code to TOOL_ERROR and hint to empty string', () => {
        const err = new ToolError('boom');
        expect(err.code).toBe('TOOL_ERROR');
        expect(err.hint).toBe('');
    });

    test('writes structured error back to messages on tool failure and lets agent self-correct', async () => {
        let observedMessages = null;
        const sendLlm = jest.fn()
            .mockImplementationOnce(async () => ({
                toolCalls: [{ id: 'tc1', name: 'note.add', args: { text: '' } }],
                assistantText: '',
            }))
            .mockImplementationOnce(async ({ messages }) => {
                observedMessages = messages;
                return {
                    toolCalls: [{ id: 'tc2', name: 'finalize', args: { capsule_text: 'recovered' } }],
                    assistantText: '',
                };
            });

        const executeTool = jest.fn().mockImplementation(async (name, args) => {
            if (name === 'note.add') {
                if (!String(args?.text || '').trim()) {
                    throw new ToolError(
                        'note.add text must be non-empty',
                        'NOTE_EMPTY',
                        'Provide non-empty text.',
                    );
                }
                return { ok: true };
            }
            throw new Error(`unexpected tool ${name}`);
        });

        const result = await runLoopOrchestration(makeContext(), makePayload(), makeProfile({
            tools: {
                note: { add: true },
                chat: { read_range: false, search: false },
                lorebook: { search: false, get: false },
                memory: { search: false, list_recent: false, get: false },
                finalize: true,
            },
        }), {
            sendLlm,
            executeTool,
        });

        expect(result.status).toBe('completed');
        expect(result.capsule).toBe('recovered');
        expect(sendLlm).toHaveBeenCalledTimes(2);

        // Verify the error tool message landed in the messages array seen
        // by round 2. Tool message content is JSON-serialized per the
        // OpenAI tool-message convention.
        const errMsg = (observedMessages || []).find(m => m?.role === 'tool' && m?.tool_call_id === 'tc1');
        expect(errMsg).toBeTruthy();
        const content = typeof errMsg.content === 'string' ? JSON.parse(errMsg.content) : errMsg.content;
        expect(content.ok).toBe(false);
        expect(content.code).toBe('NOTE_EMPTY');
        expect(String(content.error || '')).toContain('note.add');
        expect(String(content.hint || '')).toContain('Provide');
    });

    test('successful tool call appends ok-shaped tool message for next round', async () => {
        let secondRoundMessages = null;
        const sendLlm = jest.fn()
            .mockImplementationOnce(async () => ({
                toolCalls: [{ id: 'tc1', name: 'note.add', args: { text: 'remember X' } }],
                assistantText: '',
            }))
            .mockImplementationOnce(async ({ messages }) => {
                secondRoundMessages = messages;
                return {
                    toolCalls: [{ id: 'tc2', name: 'finalize', args: { capsule_text: 'done' } }],
                    assistantText: '',
                };
            });

        const executeTool = jest.fn().mockResolvedValue({ ok: true, recorded: true });

        const result = await runLoopOrchestration(makeContext(), makePayload(), makeProfile({
            tools: {
                note: { add: true },
                chat: { read_range: false, search: false },
                lorebook: { search: false, get: false },
                memory: { search: false, list_recent: false, get: false },
                finalize: true,
            },
        }), {
            sendLlm,
            executeTool,
        });

        expect(result.status).toBe('completed');
        expect(result.capsule).toBe('done');
        const toolMsg = (secondRoundMessages || []).find(m => m?.role === 'tool' && m?.tool_call_id === 'tc1');
        expect(toolMsg).toBeTruthy();
        const parsed = typeof toolMsg.content === 'string' ? JSON.parse(toolMsg.content) : toolMsg.content;
        expect(parsed.recorded).toBe(true);
    });

    test('finalize with empty capsule_text re-injects an error and lets agent retry', async () => {
        let secondRoundMessages = null;
        const sendLlm = jest.fn()
            .mockImplementationOnce(async () => ({
                toolCalls: [{ id: 'tc1', name: 'finalize', args: { capsule_text: '' } }],
                assistantText: '',
            }))
            .mockImplementationOnce(async ({ messages }) => {
                secondRoundMessages = messages;
                return {
                    toolCalls: [{ id: 'tc2', name: 'finalize', args: { capsule_text: 'real one' } }],
                    assistantText: '',
                };
            });

        const result = await runLoopOrchestration(makeContext(), makePayload(), makeProfile(), { sendLlm });

        expect(result.status).toBe('completed');
        expect(result.capsule).toBe('real one');
        expect(sendLlm).toHaveBeenCalledTimes(2);

        const errMsg = (secondRoundMessages || []).find(m => m?.role === 'tool' && m?.tool_call_id === 'tc1');
        expect(errMsg).toBeTruthy();
        const content = typeof errMsg.content === 'string' ? JSON.parse(errMsg.content) : errMsg.content;
        expect(content.ok).toBe(false);
        expect(content.code).toBe('FINALIZE_EMPTY');
    });

    test('non-ToolError tool failure propagates as runtime error', async () => {
        const sendLlm = jest.fn().mockResolvedValueOnce({
            toolCalls: [{ id: 'tc1', name: 'note.add', args: { text: 'x' } }],
            assistantText: '',
        });
        const executeTool = jest.fn().mockImplementation(async () => {
            throw new Error('something exploded');
        });

        await expect(
            runLoopOrchestration(makeContext(), makePayload(), makeProfile({
                tools: {
                    note: { add: true },
                    chat: { read_range: false, search: false },
                    lorebook: { search: false, get: false },
                    memory: { search: false, list_recent: false, get: false },
                    finalize: true,
                },
            }), { sendLlm, executeTool }),
        ).rejects.toThrow(/something exploded/);
    });

    test('default executeTool rejects unknown tools with a ToolError-shaped message', async () => {
        // Without a deps.executeTool the production default treats any
        // non-finalize call as "not implemented" and surfaces a structured
        // error to the agent. Loop continues so the agent can self-correct.
        // Use a name that's not in the registry across all tasks so this
        // doesn't drift into a tool-specific error code (e.g. memory.* now
        // surfaces MEMORY_DISABLED when the store is unavailable).
        let observedMessages = null;
        const sendLlm = jest.fn()
            .mockImplementationOnce(async () => ({
                toolCalls: [{ id: 'tc1', name: 'no.such.tool', args: { query: 'x' } }],
                assistantText: '',
            }))
            .mockImplementationOnce(async ({ messages }) => {
                observedMessages = messages;
                return {
                    toolCalls: [{ id: 'tc2', name: 'finalize', args: { capsule_text: 'continued anyway' } }],
                    assistantText: '',
                };
            });

        const result = await runLoopOrchestration(makeContext(), makePayload(), makeProfile(), { sendLlm });

        expect(result.status).toBe('completed');
        expect(result.capsule).toBe('continued anyway');
        const errMsg = (observedMessages || []).find(m => m?.role === 'tool' && m?.tool_call_id === 'tc1');
        expect(errMsg).toBeTruthy();
        const parsed = typeof errMsg.content === 'string' ? JSON.parse(errMsg.content) : errMsg.content;
        expect(parsed.ok).toBe(false);
        expect(String(parsed.code || '')).toMatch(/NOT_IMPLEMENTED|TOOL_ERROR/);
    });

    test('round assistant message records the prior tool_calls so the conversation is well-formed', async () => {
        // OpenAI tool-message convention requires the assistant message
        // that produced the tool calls to be in the conversation before the
        // matching tool-result messages. We push it just before the tool
        // results so the agent sees a valid messages array on the next round.
        let secondRoundMessages = null;
        const sendLlm = jest.fn()
            .mockImplementationOnce(async () => ({
                toolCalls: [{ id: 'tc1', name: 'note.add', args: { text: 'kept' } }],
                assistantText: 'thinking...',
            }))
            .mockImplementationOnce(async ({ messages }) => {
                secondRoundMessages = messages;
                return {
                    toolCalls: [{ id: 'tc2', name: 'finalize', args: { capsule_text: 'ok' } }],
                    assistantText: '',
                };
            });

        const executeTool = jest.fn().mockResolvedValue({ ok: true });

        await runLoopOrchestration(makeContext(), makePayload(), makeProfile({
            tools: {
                note: { add: true },
                chat: { read_range: false, search: false },
                lorebook: { search: false, get: false },
                memory: { search: false, list_recent: false, get: false },
                finalize: true,
            },
        }), { sendLlm, executeTool });

        // Find the assistant message preceding the tool result for tc1.
        const toolIdx = (secondRoundMessages || []).findIndex(m => m?.role === 'tool' && m?.tool_call_id === 'tc1');
        expect(toolIdx).toBeGreaterThan(0);
        const prior = secondRoundMessages[toolIdx - 1];
        expect(prior?.role).toBe('assistant');
        expect(Array.isArray(prior?.tool_calls)).toBe(true);
        expect(prior.tool_calls[0]?.id).toBe('tc1');
        expect(prior.tool_calls[0]?.function?.name).toBe('note.add');
    });
});
