// Per-sub-agent maxRounds contract.
//
// Background: sub-agents used to share a single hardcoded cap
// (`SUB_AGENT_MAX_ROUNDS` in director-tools.js — historically 16, now
// 40; imported here so the test tracks any future raise). That cap is
// the runaway safety net for the sub-agent's own tool-call loop.
// Different sub-agents have different convergence profiles — a
// single-shot critic finishes in 1–3 rounds while a recall-style
// memory scout doing schema + several drills wants more headroom —
// so the cap is now per-agent configurable on the sub-agent profile
// (`subAgents[].maxRounds`).
//
// Sanitizer contract for the new field:
//   - omitted / null / invalid → inherit the legacy default (null kept
//     on the spec so the runtime falls back to SUB_AGENT_MAX_ROUNDS).
//   - integer >= 1 → floored + preserved.
//   - sub-1 → floored to 1.

import { describe, expect, test, jest } from '@jest/globals';
import {
    createDefaultDirectorProfile,
    sanitizeDirectorProfile,
} from '../../../public/scripts/extensions/orchestrator/director-defaults.js';
import {
    createSubagentDispatcher,
    SUB_AGENT_MAX_ROUNDS,
} from '../../../public/scripts/extensions/orchestrator/director-tools.js';

function makeSubAgent(overrides = {}) {
    return {
        id: 'critic',
        description: 'd',
        systemPrompt: 'critic body',
        apiPresetName: '',
        promptPresetName: '',
        ...overrides,
    };
}

describe('director sub-agent maxRounds (per-agent runaway cap)', () => {
    test('explicit valid maxRounds survives sanitize', () => {
        const after = sanitizeDirectorProfile({
            mode: 'director',
            mainAgent: { systemPrompt: 'm' },
            subAgents: [makeSubAgent({ maxRounds: 25 })],
        });
        expect(after.subAgents).toHaveLength(1);
        expect(after.subAgents[0].maxRounds).toBe(25);
    });

    test('sub-1 maxRounds is floored to 1; large values preserved', () => {
        const after = sanitizeDirectorProfile({
            mode: 'director',
            mainAgent: { systemPrompt: 'm' },
            subAgents: [
                makeSubAgent({ id: 'low', maxRounds: 0 }),
                makeSubAgent({ id: 'high', maxRounds: 999 }),
            ],
        });
        const low = after.subAgents.find(a => a.id === 'low');
        const high = after.subAgents.find(a => a.id === 'high');
        expect(low.maxRounds).toBe(1);
        expect(high.maxRounds).toBe(999);
    });

    test('omitted maxRounds yields null (inherit runtime default)', () => {
        const after = sanitizeDirectorProfile({
            mode: 'director',
            mainAgent: { systemPrompt: 'm' },
            subAgents: [makeSubAgent({})],  // no maxRounds key
        });
        expect(after.subAgents[0].maxRounds).toBeNull();
    });

    test('non-numeric maxRounds (string, NaN) coerces to null (inherit default)', () => {
        const after = sanitizeDirectorProfile({
            mode: 'director',
            mainAgent: { systemPrompt: 'm' },
            subAgents: [
                makeSubAgent({ id: 's1', maxRounds: 'twenty' }),
                makeSubAgent({ id: 's2', maxRounds: NaN }),
            ],
        });
        expect(after.subAgents.find(a => a.id === 's1').maxRounds).toBeNull();
        expect(after.subAgents.find(a => a.id === 's2').maxRounds).toBeNull();
    });

    test('fractional values floor to integers', () => {
        const after = sanitizeDirectorProfile({
            mode: 'director',
            mainAgent: { systemPrompt: 'm' },
            subAgents: [makeSubAgent({ maxRounds: 12.9 })],
        });
        expect(after.subAgents[0].maxRounds).toBe(12);
    });

    test('default sub-agents do not carry a maxRounds override out of the box', () => {
        // createDefaultDirectorProfile's built-in scouts/critics should
        // inherit the hardcoded SUB_AGENT_MAX_ROUNDS default — the UI / AI
        // iteration only writes a value when the user explicitly tunes
        // one. This pins that contract so a fresh install does not
        // suddenly cap every sub-agent at an arbitrary value.
        const def = createDefaultDirectorProfile();
        for (const sub of def.subAgents) {
            expect(sub.maxRounds).toBeNull();
        }
    });
});

describe('director sub-agent maxRounds — runtime dispatcher honors per-agent cap', () => {
    test('non-converging sub-agent stops after its own maxRounds (not the module default)', async () => {
        // Fake generateTask that NEVER converges — always returns a tool
        // call so the dispatcher's "no tool calls means done" exit path
        // never fires. The loop must abort at the per-agent cap.
        const generateCalls = [];
        const fakeGenerate = jest.fn(async () => {
            generateCalls.push(Date.now());
            return {
                assistantText: '',
                toolCalls: [{ id: 'tc1', name: 'chat_read_range', args: { start: -3, end: -1 } }],
                reasoning: null,
                finishReason: 'tool_calls',
                usage: null,
                raw: null,
            };
        });
        const fakeExecuteLoopTool = jest.fn(async () => ({ ok: true, lines: [] }));

        const subAgent = {
            id: 'capped',
            description: 'never converges',
            systemPrompt: 'loop forever',
            apiPresetName: '',
            promptPresetName: '',
            tools: null,
            maxRounds: 3,  // pinned per-agent cap
        };

        const dispatcher = createSubagentDispatcher({
            subAgents: [subAgent],
            limits: { maxConcurrentSubagents: 2, maxTotalSubagentRuns: 10 },
            generateTask: fakeGenerate,
            abortSignal: new AbortController().signal,
            tools: { chat: { read_range: true } },
            executeLoopTool: fakeExecuteLoopTool,
        });

        const handleId = await dispatcher.dispatch({ subagentId: 'capped', task: 'go' });
        const [result] = await dispatcher.awaitAll([handleId]);

        expect(fakeGenerate).toHaveBeenCalledTimes(3);
        expect(result.error).toMatch(/did not converge within 3 rounds/);
    });

    test('sub-agent with maxRounds=null falls back to the module-default cap', async () => {
        // No per-agent override → use SUB_AGENT_MAX_ROUNDS. With a
        // never-converging stub, the loop must iterate SUB_AGENT_MAX_ROUNDS
        // times before erroring — the imported constant tracks any
        // future raise.
        const fakeGenerate = jest.fn(async () => ({
            assistantText: '',
            toolCalls: [{ id: 't', name: 'chat_read_range', args: { start: -1, end: -1 } }],
            reasoning: null,
            finishReason: 'tool_calls',
            usage: null,
            raw: null,
        }));
        const fakeExecuteLoopTool = jest.fn(async () => ({ ok: true, lines: [] }));

        const dispatcher = createSubagentDispatcher({
            subAgents: [{
                id: 'inherit',
                description: 'd',
                systemPrompt: 's',
                apiPresetName: '',
                promptPresetName: '',
                tools: null,
                maxRounds: null,
            }],
            limits: { maxTotalSubagentRuns: 10 },
            generateTask: fakeGenerate,
            abortSignal: new AbortController().signal,
            tools: { chat: { read_range: true } },
            executeLoopTool: fakeExecuteLoopTool,
        });

        const handleId = await dispatcher.dispatch({ subagentId: 'inherit', task: 'go' });
        const [result] = await dispatcher.awaitAll([handleId]);

        expect(fakeGenerate).toHaveBeenCalledTimes(SUB_AGENT_MAX_ROUNDS);
        expect(result.error).toMatch(new RegExp(`did not converge within ${SUB_AGENT_MAX_ROUNDS} rounds`));
    });
});
