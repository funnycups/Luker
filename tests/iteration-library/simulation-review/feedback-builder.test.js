import { buildSimulationToolResult } from '../../../public/scripts/iteration-library/simulation-review/feedback-builder.js';

describe('buildSimulationToolResult', () => {
    test('submitted result with annotations renders inline tags + structured block', () => {
        const out = buildSimulationToolResult({
            kind: 'cea',
            cancelled: false,
            error: null,
            chainSegments: [
                { text: '# CEA Simulation\n\n## Final Output\n' },
                { text: 'Hello world', annotationId: 1 },
                { text: ' and more.' },
            ],
            annotations: [
                { id: 1, snippet: 'Hello world', comment: 'too generic', path: 'Final Output' },
            ],
            worldInfoHits: [
                { book: 'A', entry: 'X', position: 'before' },
            ],
        });
        expect(out).toContain('<simulation_result kind="cea" ok="true">');
        expect(out).toContain('<status submitted="true" annotations_count="1"/>');
        expect(out).toContain('# CEA Simulation');
        expect(out).toContain('<<<ANNOTATION id=1>>>Hello world<<</ANNOTATION>>>');
        expect(out).toContain('[#1] location: Final Output');
        expect(out).toContain('snippet: "Hello world"');
        expect(out).toContain('comment: too generic');
        expect(out).toContain('<world_info_hits>');
        expect(out).toContain('Lorebook "A" → entry "X" (before)');
    });

    test('cancelled result has no inline tags and empty annotations block', () => {
        const out = buildSimulationToolResult({
            kind: 'orch-loop',
            cancelled: true,
            error: null,
            chainSegments: [{ text: '# Loop Simulation\n\nstuff' }],
            annotations: [],
            worldInfoHits: [],
        });
        expect(out).toContain('<simulation_result kind="orch-loop" ok="false" cancelled="true">');
        expect(out).toContain('<status submitted="false"/>');
        expect(out).toContain('<annotations/>');
        expect(out).not.toContain('<<<ANNOTATION');
    });

    test('submitted with zero annotations is valid', () => {
        const out = buildSimulationToolResult({
            kind: 'cpa',
            cancelled: false,
            error: null,
            chainSegments: [{ text: 'chain' }],
            annotations: [],
            worldInfoHits: [],
        });
        expect(out).toContain('<status submitted="true" annotations_count="0"/>');
        expect(out).toContain('<annotations/>');
    });

    test('error result has only error block', () => {
        const out = buildSimulationToolResult({
            kind: 'orch-agenda',
            cancelled: false,
            error: { reason: 'simulation_failed', message: 'Model API 502' },
        });
        expect(out).toContain('<simulation_result kind="orch-agenda" ok="false">');
        expect(out).toContain('<error reason="simulation_failed">');
        expect(out).toContain('Model API 502');
        expect(out).not.toContain('<simulation_chain>');
    });

    test('annotation snippet preserves original chain text verbatim (no escaping)', () => {
        const tricky = 'has <angle> & "quotes" and \n newline';
        const out = buildSimulationToolResult({
            kind: 'cea',
            cancelled: false,
            error: null,
            chainSegments: [
                { text: 'before ' },
                { text: tricky, annotationId: 1 },
                { text: ' after' },
            ],
            annotations: [{ id: 1, snippet: tricky, comment: 'x', path: 'Final Output' }],
            worldInfoHits: [],
        });
        expect(out).toContain(`<<<ANNOTATION id=1>>>${tricky}<<</ANNOTATION>>>`);
    });

    test('renders WI hits with book + entry attribution', () => {
        const out = buildSimulationToolResult({
            kind: 'cea',
            cancelled: false,
            error: null,
            chainSegments: [{ text: 'output' }],
            annotations: [],
            worldInfoHits: [
                { book: 'City Lore', entry: 'Geography', position: 'depth-4/system' },
                { book: 'NPC Sheets', entry: 'NPC Alice', position: 'before-char' },
            ],
        });
        expect(out).toContain('Lorebook "City Lore" → entry "Geography" (depth-4/system)');
        expect(out).toContain('Lorebook "NPC Sheets" → entry "NPC Alice" (before-char)');
    });
});
