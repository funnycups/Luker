// tests/memory-graph/graph-iteration-display-prompt.test.js
import {
    DEFAULT_GRAPH_ITER_SYSTEM_PROMPT,
    buildGraphIterSystemPrompt,
} from '../../public/scripts/extensions/memory-graph/graph-iteration/system-prompt.js';

describe('graph-iteration system prompt builder', () => {
    test('built-in prompt is a non-empty string', () => {
        expect(typeof DEFAULT_GRAPH_ITER_SYSTEM_PROMPT).toBe('string');
        expect(DEFAULT_GRAPH_ITER_SYSTEM_PROMPT.length).toBeGreaterThan(0);
    });

    test('rejects empty or missing stored prompts', () => {
        expect(() => buildGraphIterSystemPrompt(null)).toThrow();
        expect(() => buildGraphIterSystemPrompt({})).toThrow();
        expect(() => buildGraphIterSystemPrompt({ graphIterSystemPrompt: '   ' })).toThrow();
    });

    test('uses a configured prompt verbatim', () => {
        expect(buildGraphIterSystemPrompt({ graphIterSystemPrompt: '  custom rules  ' }))
            .toBe('  custom rules  ');
    });
});
