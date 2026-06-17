// tests/memory-graph/list-candidates-no-seq-window.test.js
//
// A6 — the LLM-facing `memory_list_candidates` tool no longer accepts a
// `seq_window` input. Per spec §2.7, with floorRange landing in tool
// output (A5), seqTo is no longer a concept the LLM should see — neither
// as output (A5 swap to floorRange) nor as input (this task, A6). The
// underlying `session.listVisibleCandidates({seqWindow})` Layer-1 API
// still supports it for internal callers (verified by read-api tests).
//
// What this pins:
//   - schema declares no `seq_window` property.
//   - `types` and `exclude_recent_messages` are preserved.
//   - `additionalProperties: false` keeps the schema closed, so a
//     malicious / legacy LLM still passing `seq_window` is rejected at
//     the schema layer rather than silently filtered through.
//
// Phrased as schema-shape assertions (not runtime exec) because the
// schema IS the LLM contract — that's what the model sees in its tool
// list, and that's what the orchestrator's tool-call validator enforces.

import { describe, test, expect } from '@jest/globals';
import './_mocks/main-module-stack.js';

const { SCHEMAS } = await import('../../public/scripts/extensions/memory-graph/orchestrator-tools.js');

describe('memory_list_candidates schema: seq_window removed', () => {
    test('seq_window parameter is not declared in the input schema', () => {
        const tool = SCHEMAS.find(s => s.name === 'memory_list_candidates');
        expect(tool).toBeDefined();
        expect(tool.parameters.properties.seq_window).toBeUndefined();
    });

    test('types and exclude_recent_messages parameters remain', () => {
        const tool = SCHEMAS.find(s => s.name === 'memory_list_candidates');
        expect(tool.parameters.properties.types).toBeDefined();
        expect(tool.parameters.properties.exclude_recent_messages).toBeDefined();
    });

    test('additionalProperties is false (so unknown args including legacy seq_window are rejected at the schema layer)', () => {
        const tool = SCHEMAS.find(s => s.name === 'memory_list_candidates');
        expect(tool.parameters.additionalProperties).toBe(false);
    });
});
