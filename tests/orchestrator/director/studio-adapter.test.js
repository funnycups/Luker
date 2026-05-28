import { describe, expect, test } from '@jest/globals';
import {
    sanitizeDirectorProfile,
    createDefaultDirectorProfile,
    ORCH_EXECUTION_MODE_DIRECTOR,
} from '../../../public/scripts/extensions/orchestrator/director-defaults.js';

/**
 * Director-mode studio data round-trip.
 *
 * The pre-fix bug was: AI Iteration Studio's mode-branched plumbing
 * had NO director branch. A director profile fed to the Studio fell
 * through to the spec branch, which cloned only `spec` + `presets` —
 * silently dropping `mainAgent`, `subAgents`, limits, tools.
 *
 * This test guards the data-shape contract that every Studio-side
 * helper must respect: a director profile round-tripped through
 * `sanitizeDirectorProfile` (the canonical clone+normalize path) must
 * preserve every field that gets persisted back to settings.
 *
 * We can't test main.js's cloneAiIterationWorkingProfile directly
 * (main.js has no exports; the iteration-adapter requires browser
 * deps), but the studio plumbing routes ALL director clones through
 * sanitizeDirectorProfile — so this test pins the data invariant.
 */
describe('director profile round-trip through Studio sanitizer', () => {
    test('a populated director profile survives sanitize round-trip with all fields intact', () => {
        const original = createDefaultDirectorProfile();
        original.mainAgent = {
            systemPrompt: 'custom system prompt',
            apiPresetName: 'openai-main',
            promptPresetName: 'preset-main',
        };
        original.subAgents = [
            { id: 'critic', description: 'tonal critic', systemPrompt: 'crit', apiPresetName: 'openai-crit', promptPresetName: 'preset-crit' },
            { id: 'planner', description: 'scene planner', systemPrompt: 'plan', apiPresetName: '', promptPresetName: '' },
        ];
        original.maxRounds = 12;
        original.maxConcurrentSubagents = 3;
        original.maxTotalSubagentRuns = 10;
        original.discardOnAbort = true;
        original.tools = {
            chat: { read_range: true, search: true },
            memory: {
                list_candidates: true, edge_summary: false, node_brief: true,
                expand_seeds: false, rank: true, schema: true,
            },
            lorebook: { search: true, get: false },
            note: { add: false, delete: false },
            search: { search: false, visit: false },
        };

        const after = sanitizeDirectorProfile(original);

        // Flat shape — sanitizer drops the legacy `director:` wrapper.
        expect(after).not.toHaveProperty('director');
        expect(after.mode).toBe(ORCH_EXECUTION_MODE_DIRECTOR);
        // Main agent fields preserved.
        expect(after.mainAgent.systemPrompt).toBe('custom system prompt');
        expect(after.mainAgent.apiPresetName).toBe('openai-main');
        expect(after.mainAgent.promptPresetName).toBe('preset-main');
        // Sub-agents preserved.
        expect(after.subAgents).toHaveLength(2);
        expect(after.subAgents[0]).toMatchObject({
            id: 'critic', description: 'tonal critic', systemPrompt: 'crit',
            apiPresetName: 'openai-crit', promptPresetName: 'preset-crit',
        });
        expect(after.subAgents[1]).toMatchObject({
            id: 'planner', description: 'scene planner', systemPrompt: 'plan',
        });
        // Limits preserved.
        expect(after.maxRounds).toBe(12);
        expect(after.maxConcurrentSubagents).toBe(3);
        expect(after.maxTotalSubagentRuns).toBe(10);
        expect(after.discardOnAbort).toBe(true);
        // Tool flags preserved.
        expect(after.tools.chat.read_range).toBe(true);
        expect(after.tools.chat.search).toBe(true);
        expect(after.tools.memory.list_candidates).toBe(true);
        expect(after.tools.memory.edge_summary).toBe(false);
        expect(after.tools.memory.node_brief).toBe(true);
        expect(after.tools.lorebook.search).toBe(true);
        // tools.finalize is forced to false (no leakage between modes).
        if (after.tools.finalize !== undefined) {
            expect(after.tools.finalize).toBe(false);
        }
    });

    test('sanitizer is idempotent (sanitize twice yields equivalent result)', () => {
        const original = createDefaultDirectorProfile();
        original.mainAgent.systemPrompt = 'two-pass';
        original.subAgents = [
            { id: 'x', description: 'd', systemPrompt: 's', apiPresetName: '', promptPresetName: '' },
        ];
        const once = sanitizeDirectorProfile(original);
        const twice = sanitizeDirectorProfile(once);
        expect(twice).toEqual(once);
    });

    test('sub-agents with empty systemPrompt are dropped (sanitizer contract)', () => {
        // This is a known sanitizer behavior: sub-agents without systemPrompt
        // are dropped on save. Studio's diff UI must NOT assume they survive.
        const profile = createDefaultDirectorProfile();
        profile.subAgents = [
            { id: 'keep', description: '', systemPrompt: 'real', apiPresetName: '', promptPresetName: '' },
            { id: 'drop', description: '', systemPrompt: '', apiPresetName: '', promptPresetName: '' },
        ];
        const after = sanitizeDirectorProfile(profile);
        expect(after.subAgents.map(a => a.id)).toEqual(['keep']);
    });

    test('mode constant matches the value Studio adapter checks against', () => {
        // Smoke check: ORCH_EXECUTION_MODE_DIRECTOR is the constant the
        // mode dispatch uses everywhere. If this value drifts, every
        // director branch in main.js / iteration-adapter.js silently
        // becomes dead code.
        expect(ORCH_EXECUTION_MODE_DIRECTOR).toBe('director');
    });
});
