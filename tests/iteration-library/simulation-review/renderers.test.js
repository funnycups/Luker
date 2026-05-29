/**
 * @jest-environment jsdom
 */
import { render as renderCeaCpa } from '../../../public/scripts/iteration-library/simulation-review/renderers/cea-cpa.js';
import { render as renderSpec } from '../../../public/scripts/iteration-library/simulation-review/renderers/orchestrator-spec.js';
import { render as renderAgenda } from '../../../public/scripts/iteration-library/simulation-review/renderers/orchestrator-agenda.js';
import { render as renderLoop } from '../../../public/scripts/iteration-library/simulation-review/renderers/orchestrator-loop.js';
import { render as renderDirector } from '../../../public/scripts/iteration-library/simulation-review/renderers/orchestrator-director.js';

const noopI18n = (k, fallback) => fallback ?? k;

function getPaths(root) {
    return Array.from(root.querySelectorAll('[data-loc-path]')).map(el => el.getAttribute('data-loc-path'));
}

test('cea-cpa renderer tags Final Output and Reasoning paths', () => {
    const root = renderCeaCpa({
        finalOutput: 'Hi there.',
        reasoning: 'thinking...',
        assembledPrompt: { systemPrompt: 'sys', messages: [{ role: 'user', content: 'hello' }] },
        worldInfoHits: [],
    }, noopI18n);
    const paths = getPaths(root);
    expect(paths).toContain('Final Output');
    expect(paths).toContain('Reasoning');
    expect(paths).toContain('Assembled Prompt → System');
    expect(paths).toContain('Assembled Prompt → User #1');
});

test('spec renderer tags per-stage / per-node / per-turn / per-tool-call paths', () => {
    const root = renderSpec({
        stages: [
            {
                stageIndex: 0,
                id: 's1',
                mode: 'serial',
                nodes: [
                    {
                        nodeIndex: 0,
                        id: 'research',
                        kind: 'worker',
                        turns: [
                            {
                                reasoning: 'r1',
                                assistantText: 'a1',
                                toolCalls: [{ name: 'read_card', args: {}, result: {}, durationMs: 12 }],
                            },
                        ],
                        output: 'final',
                    },
                ],
            },
        ],
    }, noopI18n);
    const paths = getPaths(root);
    expect(paths).toContain('Stage 1 → Node "research" → Turn 1 → Reasoning');
    expect(paths).toContain('Stage 1 → Node "research" → Turn 1 → Assistant');
    expect(paths).toContain('Stage 1 → Node "research" → Turn 1 → Tool call #1 (read_card) → result');
    expect(paths).toContain('Stage 1 → Node "research" → Output');
});

test('agenda renderer tags rounds / planner / dispatches / finalizer / final composed output', () => {
    const root = renderAgenda({
        rounds: [
            {
                roundIndex: 0,
                planner: {
                    turns: [{ reasoning: '', assistantText: 'pa', toolCalls: [] }],
                    output: 'plan-out',
                },
                dispatches: [
                    {
                        todoId: 't1',
                        agentName: 'writer',
                        taskBrief: 'write',
                        turns: [{ reasoning: '', assistantText: 'wa', toolCalls: [] }],
                        output: 'wout',
                    },
                ],
            },
        ],
        finalizer: { turns: [{ reasoning: '', assistantText: 'fa', toolCalls: [] }], output: 'fout' },
        finalComposedOutput: 'composed',
    }, noopI18n);
    const paths = getPaths(root);
    expect(paths).toContain('Round 1 → Planner → Turn 1 → Assistant');
    expect(paths).toContain('Round 1 → Planner → Output');
    expect(paths).toContain('Round 1 → Dispatch "writer" → Turn 1 → Assistant');
    expect(paths).toContain('Round 1 → Dispatch "writer" → Output');
    expect(paths).toContain('Finalizer → Output');
    expect(paths).toContain('Final Composed Output');
});

test('loop renderer tags per-round assistant / reasoning / tool calls + capsule', () => {
    const root = renderLoop({
        rounds: [
            { roundIndex: 0, reasoning: 'r', assistantText: 'a', toolCalls: [{ name: 'read_card', args: {}, result: 'x', durationMs: 1 }] },
        ],
        capsule: 'cap',
        terminationReason: 'finalize',
    }, noopI18n);
    const paths = getPaths(root);
    expect(paths).toContain('Round 1 → Reasoning');
    expect(paths).toContain('Round 1 → Assistant');
    expect(paths).toContain('Round 1 → Tool call #1 (read_card) → result');
    expect(paths).toContain('Capsule');
});

test('director renderer tags main agent rounds + sub-agent outputs + final message', () => {
    const root = renderDirector({
        mainAgent: {
            rounds: [
                { roundIndex: 0, reasoning: 'r', assistantText: 'a', toolCalls: [{ name: 'dispatch_subagent', args: {}, result: { handle: 'h1' }, durationMs: 2 }] },
            ],
        },
        subagents: [{ subagentId: 'writer', isInline: false, task: 'go', reasoning: 'sr', output: 'so' }],
        finalMessage: 'fm',
    }, noopI18n);
    const paths = getPaths(root);
    expect(paths).toContain('Main Agent → Round 1 → Assistant');
    expect(paths).toContain('Main Agent → Round 1 → Tool call #1 (dispatch_subagent) → result');
    expect(paths).toContain('Sub-agent "writer" → Output');
    expect(paths).toContain('Final Message');
});
