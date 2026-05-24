// tests/mg-schema-iteration/system-prompt.test.js
import { describe, test, expect } from '@jest/globals';
import { buildSystemPrompt } from '../../public/scripts/extensions/memory-graph/schema-iteration/system-prompt.js';

describe('MG Schema — system prompt', () => {
    test('returns a non-trivial string', () => {
        const out = buildSystemPrompt();
        expect(typeof out).toBe('string');
        expect(out.length).toBeGreaterThan(200);
    });

    test('mentions all 3 tools by name', () => {
        const out = buildSystemPrompt();
        // Tool names are ported verbatim from schema-adapter.js, which uses
        // the `mg_schema_*` prefix (the spec block's narrower `/mg_set.../`
        // regex would miss the `_schema_` middle segment).
        expect(out).toMatch(/mg_schema_set_node_type/);
        expect(out).toMatch(/mg_schema_remove_node_type/);
        expect(out).toMatch(/mg_schema_reorder_node_types/);
    });

    test('describes core schema concepts', () => {
        const out = buildSystemPrompt();
        // The prompt should reference these — adapt if the ported text uses
        // different wording:
        expect(out.toLowerCase()).toMatch(/node[- ]?type/);
        expect(out.toLowerCase()).toMatch(/schema/);
    });

    test('documents finalize-sticky ordering so the LLM knows finalize wins over continue in the same round', () => {
        // Sticky-finalize: when a round emits both continue + finalize, the
        // popup ends the iteration (finalize wins). The behavior lives in
        // onControlCall; this assertion guards the doc line that surfaces
        // the rule in the prompt itself so the model can plan accordingly.
        const out = buildSystemPrompt();
        expect(out).toMatch(/luker_mg_schema_continue_iteration/);
        expect(out).toMatch(/luker_mg_schema_finalize_iteration/);
        expect(out.toLowerCase()).toMatch(/finalize wins/);
    });
});
