import { buildSimulationToolResult } from '../../public/scripts/iteration-library/simulation-review/feedback-builder.js';

test('orch-spec envelope is well-formed', () => {
    const out = buildSimulationToolResult({
        kind: 'orch-spec',
        cancelled: false,
        error: null,
        chainSegments: [
            { text: '# Spec Simulation\n\n## Stage 1\n\nthought, calls, output...\n' },
            { text: 'final stage output', annotationId: 1 },
        ],
        annotations: [
            { id: 1, snippet: 'final stage output', comment: 'too short', path: 'Stage 2 → Node "writer" → Output' },
        ],
        worldInfoHits: [],
    });
    expect(out).toContain('<simulation_result kind="orch-spec" ok="true">');
    expect(out).toContain('<<<ANNOTATION id=1>>>final stage output<<</ANNOTATION>>>');
    expect(out).toContain('Stage 2 → Node "writer" → Output');
});

test('orch-agenda envelope is well-formed', () => {
    const out = buildSimulationToolResult({
        kind: 'orch-agenda',
        cancelled: false,
        error: null,
        chainSegments: [{ text: '# Agenda Simulation\n\nplanner → dispatches → finalizer → composed.' }],
        annotations: [],
        worldInfoHits: [],
    });
    expect(out).toContain('<simulation_result kind="orch-agenda" ok="true">');
    expect(out).toContain('<status submitted="true" annotations_count="0"/>');
});

test('orch-loop envelope handles cancel correctly', () => {
    const out = buildSimulationToolResult({
        kind: 'orch-loop',
        cancelled: true,
        error: null,
        chainSegments: [{ text: '# Loop Simulation\n\nRound 1, Round 2, capsule.' }],
        annotations: [],
        worldInfoHits: [],
    });
    expect(out).toContain('<simulation_result kind="orch-loop" ok="false" cancelled="true">');
    expect(out).toContain('<status submitted="false"/>');
    expect(out).toContain('<annotations/>');
});

test('orch-director envelope renders main + subagents', () => {
    const out = buildSimulationToolResult({
        kind: 'orch-director',
        cancelled: false,
        error: null,
        chainSegments: [
            { text: '# Director Simulation\n\nMain Agent → dispatched subagent → final message: ' },
            { text: 'too generic, needs rewrite', annotationId: 1 },
            { text: '.' },
        ],
        annotations: [
            { id: 1, snippet: 'too generic, needs rewrite', comment: 'rewrite for emotional depth', path: 'Final Message' },
        ],
        worldInfoHits: [],
    });
    expect(out).toContain('<simulation_result kind="orch-director" ok="true">');
    expect(out).toContain('<<<ANNOTATION id=1>>>too generic, needs rewrite<<</ANNOTATION>>>');
    expect(out).toContain('comment: rewrite for emotional depth');
});

test('orch-agenda error envelope shape', () => {
    const out = buildSimulationToolResult({
        kind: 'orch-agenda',
        cancelled: false,
        error: { reason: 'simulation_failed', message: 'Planner timed out' },
    });
    expect(out).toContain('<simulation_result kind="orch-agenda" ok="false">');
    expect(out).toContain('<error reason="simulation_failed">');
    expect(out).toContain('Planner timed out');
});
