// tests/memory-graph/graph-iteration-display-prompt.test.js
import {
    GRAPH_TOOL_DEFS,
    GRAPH_READ_TOOL_NAMES,
    GRAPH_WRITE_TOOL_NAMES,
} from '../../public/scripts/extensions/memory-graph/graph-iteration/tools.js';
import { MG_GRAPH_TOOL_DISPLAY } from '../../public/scripts/extensions/memory-graph/graph-iteration/tool-display.js';
import {
    DEFAULT_GRAPH_ITER_SYSTEM_PROMPT,
    buildGraphIterSystemPrompt,
} from '../../public/scripts/extensions/memory-graph/graph-iteration/system-prompt.js';

describe('graph-iteration tool display map', () => {
    test('every tool definition has a display entry of the right kind', () => {
        for (const def of GRAPH_TOOL_DEFS) {
            const name = def?.function?.name;
            expect(name).toBeTruthy();
            const entry = MG_GRAPH_TOOL_DISPLAY[name];
            expect(entry).toBeTruthy();
            expect(typeof entry.icon).toBe('string');
            expect(typeof entry.label).toBe('string');
            const readKindOk = !GRAPH_READ_TOOL_NAMES.has(name) || entry.type === 'read';
            const writeKindOk = !GRAPH_WRITE_TOOL_NAMES.has(name) || entry.type === 'edit';
            expect(readKindOk && writeKindOk).toBe(true);
        }
    });

    test('display map has no entries for tools outside the catalog', () => {
        const known = new Set(GRAPH_TOOL_DEFS.map(def => def?.function?.name));
        for (const key of Object.keys(MG_GRAPH_TOOL_DISPLAY)) {
            expect(known.has(key)).toBe(true);
        }
    });

    test('read_fields summarize lists paths compactly', () => {
        const summarize = MG_GRAPH_TOOL_DISPLAY.mg_graph_read_fields.summarize;
        expect(summarize({ paths: ['nodes.n_1.title'] })).toBe('nodes.n_1.title');
        expect(summarize({ paths: ['a', 'b', 'c', 'd'] })).toBe('a, b, c +1');
        expect(summarize({})).toBe('');
    });

    test('create_node summarize keeps the type and title', () => {
        const summarize = MG_GRAPH_TOOL_DISPLAY.mg_graph_create_node.summarize;
        expect(summarize({ type: 'event', title: 'Lantern guard shift' })).toBe('event: Lantern guard shift');
    });
});

describe('graph-iteration system prompt builder', () => {
    test('built-in prompt is a non-empty string', () => {
        expect(typeof DEFAULT_GRAPH_ITER_SYSTEM_PROMPT).toBe('string');
        expect(DEFAULT_GRAPH_ITER_SYSTEM_PROMPT.length).toBeGreaterThan(0);
    });

    test('empty or missing settings fall back to the built-in prompt', () => {
        expect(buildGraphIterSystemPrompt(null)).toBe(DEFAULT_GRAPH_ITER_SYSTEM_PROMPT);
        expect(buildGraphIterSystemPrompt({})).toBe(DEFAULT_GRAPH_ITER_SYSTEM_PROMPT);
        expect(buildGraphIterSystemPrompt({ graphIterSystemPrompt: '   ' })).toBe(DEFAULT_GRAPH_ITER_SYSTEM_PROMPT);
    });

    test('a configured override wins (trimmed)', () => {
        expect(buildGraphIterSystemPrompt({ graphIterSystemPrompt: '  custom rules  ' }))
            .toBe('custom rules');
    });
});
