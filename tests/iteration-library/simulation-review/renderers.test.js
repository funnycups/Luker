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

test('every renderer marks exactly one final-output section and collapses process wrappers', () => {
    // The popup's autoscroll + Expand-all toggle rely on:
    //   - `[data-sim-final-output="true"]` on the section the user
    //     came to see (Final Output / Final Capsule / Final Composed
    //     Output / Capsule / Final Message). Exactly one per popup.
    //   - `[data-collapsible="true"]` + `.luker-sim-section--collapsed`
    //     on every process wrapper so the popup opens compact and
    //     the toggle can re-collapse them after expanding.
    const ceaRoot = renderCeaCpa({
        finalOutput: 'X',
        reasoning: 'thinking',
        assembledPrompt: { systemPrompt: 'sys', messages: [{ role: 'user', content: 'hi' }] },
    }, noopI18n);
    const specRoot = renderSpec({
        stages: [{ stageIndex: 0, mode: 'serial', nodes: [{ id: 'n', kind: 'worker', turns: [{ reasoning: 'r', assistantText: 'a', toolCalls: [] }], output: 'o' }] }],
        finalCapsule: 'cap',
    }, noopI18n);
    const agendaRoot = renderAgenda({
        rounds: [{ roundIndex: 0, planner: { turns: [], output: 'p' }, dispatches: [{ todoId: 't', agentName: 'w', taskBrief: 'b', turns: [], output: 'o' }] }],
        finalizer: { turns: [], output: 'f' },
        finalComposedOutput: 'composed',
    }, noopI18n);
    const loopRoot = renderLoop({
        rounds: [{ roundIndex: 0, reasoning: 'r', assistantText: 'a', toolCalls: [] }],
        capsule: 'cap',
        terminationReason: 'finalize',
    }, noopI18n);
    const directorRoot = renderDirector({
        mainAgent: { rounds: [{ roundIndex: 0, reasoning: 'r', assistantText: 'a', toolCalls: [] }] },
        subagents: [{ subagentId: 'w', task: 'go', reasoning: 'sr', output: 'so' }],
        finalMessage: 'final',
    }, noopI18n);
    [ceaRoot, specRoot, agendaRoot, loopRoot, directorRoot].forEach((root, i) => {
        const finals = root.querySelectorAll('[data-sim-final-output="true"]');
        expect(finals.length).toBe(1);
        // The final-output section is NEVER collapsible — the user
        // opened the popup specifically to see it.
        expect(finals[0].getAttribute('data-collapsible')).toBeNull();
        // At least one process section exists and is collapsible.
        const collapsibles = root.querySelectorAll('[data-collapsible="true"]');
        expect(collapsibles.length).toBeGreaterThan(0);
        // Every collapsible starts collapsed by default.
        collapsibles.forEach(s => {
            expect(s.classList.contains('luker-sim-section--collapsed')).toBe(true);
        });
    });
});

describe('tool-source chip rendering (FINAL.1)', () => {
    // Each renderer reads `source` off the per-tool-call entry produced by
    // simulation-payload-adapter and appends a layer chip via
    // `appendToolSourceChip`. Builtin and unknown calls render no chip;
    // profile / extension / st-bridge each get their own label.

    function chipsOf(root) {
        return Array.from(root.querySelectorAll('.sim-review-tool-chip[class*="--source-"]'))
            .map(el => ({
                text: el.textContent,
                classList: Array.from(el.classList),
            }));
    }

    test('loop renderer emits [profile] / [ext] / [ST] chips for non-builtin sources', () => {
        const root = renderLoop({
            rounds: [
                {
                    roundIndex: 0,
                    reasoning: '', assistantText: '',
                    toolCalls: [
                        { name: 'chat_read_range', args: {}, result: {}, source: 'builtin' },
                        { name: 'my_weather', args: {}, result: {}, source: 'profile' },
                        { name: 'ext_thing', args: {}, result: {}, source: 'extension' },
                        { name: 'st_read_wi', args: {}, result: {}, source: 'st-bridge' },
                        { name: 'no_source_field', args: {}, result: {} },
                    ],
                },
            ],
            terminationReason: 'finalize',
        }, noopI18n);

        const chips = chipsOf(root);
        // Exactly 3 chips: profile, ext, ST. builtin + missing-source render no chip.
        expect(chips).toHaveLength(3);
        expect(chips.map(c => c.text).sort()).toEqual(['[ST]', '[ext]', '[profile]']);
        // Each chip carries the family + the source-specific modifier class
        // so styles.css can color them per layer.
        expect(chips.find(c => c.text === '[profile]').classList).toContain('sim-review-tool-chip--source-profile');
        expect(chips.find(c => c.text === '[ext]').classList).toContain('sim-review-tool-chip--source-extension');
        expect(chips.find(c => c.text === '[ST]').classList).toContain('sim-review-tool-chip--source-st-bridge');
    });

    test('director renderer emits source chips on main-agent tool calls', () => {
        const root = renderDirector({
            mainAgent: {
                rounds: [
                    {
                        roundIndex: 0,
                        reasoning: '', assistantText: '',
                        toolCalls: [
                            { name: 'dispatch_subagent', args: {}, result: {}, source: 'builtin' },
                            { name: 'my_weather', args: {}, result: {}, source: 'profile' },
                        ],
                    },
                ],
            },
            subagents: [],
            finalMessage: 'fm',
        }, noopI18n);

        const chips = chipsOf(root);
        expect(chips).toHaveLength(1);
        expect(chips[0].text).toBe('[profile]');
    });

    test('agenda renderer emits source chips on planner + dispatch tool calls', () => {
        const root = renderAgenda({
            rounds: [
                {
                    roundIndex: 0,
                    planner: {
                        turns: [{ reasoning: '', assistantText: '', toolCalls: [{ name: 'ext_thing', args: {}, result: {}, source: 'extension' }] }],
                        output: '',
                    },
                    dispatches: [
                        {
                            todoId: 't1', agentName: 'w', taskBrief: '',
                            turns: [{ reasoning: '', assistantText: '', toolCalls: [{ name: 'my_weather', args: {}, result: {}, source: 'profile' }] }],
                            output: '',
                        },
                    ],
                },
            ],
            finalizer: { turns: [], output: '' },
            finalComposedOutput: 'composed',
        }, noopI18n);

        const chips = chipsOf(root);
        expect(chips).toHaveLength(2);
        expect(chips.map(c => c.text).sort()).toEqual(['[ext]', '[profile]']);
    });

    test('spec renderer emits source chips on per-turn tool calls', () => {
        const root = renderSpec({
            stages: [
                {
                    stageIndex: 0, mode: 'serial',
                    nodes: [
                        {
                            nodeIndex: 0, id: 'n', kind: 'worker',
                            turns: [
                                {
                                    reasoning: '', assistantText: '',
                                    toolCalls: [{ name: 'st_read_wi', args: {}, result: {}, source: 'st-bridge' }],
                                },
                            ],
                            output: '',
                        },
                    ],
                },
            ],
            finalCapsule: 'cap',
        }, noopI18n);

        const chips = chipsOf(root);
        expect(chips).toHaveLength(1);
        expect(chips[0].text).toBe('[ST]');
    });

    test('unknown source values produce no chip (defensive: future layer additions or broken traces)', () => {
        const root = renderLoop({
            rounds: [
                {
                    roundIndex: 0,
                    reasoning: '', assistantText: '',
                    toolCalls: [
                        { name: 'x', args: {}, result: {}, source: 'unknown' },
                        { name: 'y', args: {}, result: {}, source: 'whatever-new' },
                        { name: 'z', args: {}, result: {}, source: '' },
                        { name: 'q', args: {}, result: {}, source: null },
                    ],
                },
            ],
            terminationReason: 'finalize',
        }, noopI18n);
        expect(chipsOf(root)).toHaveLength(0);
    });
});
