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
        original.director.mainAgent = {
            systemPrompt: 'custom system prompt',
            apiPresetName: 'openai-main',
            promptPresetName: 'preset-main',
        };
        original.director.subAgents = [
            { id: 'critic', description: 'tonal critic', systemPrompt: 'crit', apiPresetName: 'openai-crit', promptPresetName: 'preset-crit' },
            { id: 'planner', description: 'scene planner', systemPrompt: 'plan', apiPresetName: '', promptPresetName: '' },
        ];
        original.director.maxRounds = 12;
        original.director.maxConcurrentSubagents = 3;
        original.director.maxTotalSubagentRuns = 10;
        original.director.discardOnAbort = true;
        original.director.tools = {
            chat: { read_range: true, search: true },
            memory: { search: true, list_recent: false, get: true },
            lorebook: { search: true, get: false },
            note: { add: false, delete: false },
            search: { search: false, visit: false },
        };

        const after = sanitizeDirectorProfile(original);

        // Mode root preserved.
        expect(after).toHaveProperty('director');
        // Main agent fields preserved.
        expect(after.director.mainAgent.systemPrompt).toBe('custom system prompt');
        expect(after.director.mainAgent.apiPresetName).toBe('openai-main');
        expect(after.director.mainAgent.promptPresetName).toBe('preset-main');
        // Sub-agents preserved.
        expect(after.director.subAgents).toHaveLength(2);
        expect(after.director.subAgents[0]).toMatchObject({
            id: 'critic', description: 'tonal critic', systemPrompt: 'crit',
            apiPresetName: 'openai-crit', promptPresetName: 'preset-crit',
        });
        expect(after.director.subAgents[1]).toMatchObject({
            id: 'planner', description: 'scene planner', systemPrompt: 'plan',
        });
        // Limits preserved.
        expect(after.director.maxRounds).toBe(12);
        expect(after.director.maxConcurrentSubagents).toBe(3);
        expect(after.director.maxTotalSubagentRuns).toBe(10);
        expect(after.director.discardOnAbort).toBe(true);
        // Tool flags preserved.
        expect(after.director.tools.chat.read_range).toBe(true);
        expect(after.director.tools.chat.search).toBe(true);
        expect(after.director.tools.memory.search).toBe(true);
        expect(after.director.tools.memory.list_recent).toBe(false);
        expect(after.director.tools.lorebook.search).toBe(true);
        // tools.finalize is forced to false (no leakage between modes).
        if (after.director.tools.finalize !== undefined) {
            expect(after.director.tools.finalize).toBe(false);
        }
    });

    test('sanitizer is idempotent (sanitize twice yields equivalent result)', () => {
        const original = createDefaultDirectorProfile();
        original.director.mainAgent.systemPrompt = 'two-pass';
        original.director.subAgents = [
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
        profile.director.subAgents = [
            { id: 'keep', description: '', systemPrompt: 'real', apiPresetName: '', promptPresetName: '' },
            { id: 'drop', description: '', systemPrompt: '', apiPresetName: '', promptPresetName: '' },
        ];
        const after = sanitizeDirectorProfile(profile);
        expect(after.director.subAgents.map(a => a.id)).toEqual(['keep']);
    });

    test('mode constant matches the value Studio adapter checks against', () => {
        // Smoke check: ORCH_EXECUTION_MODE_DIRECTOR is the constant the
        // mode dispatch uses everywhere. If this value drifts, every
        // director branch in main.js / iteration-adapter.js silently
        // becomes dead code.
        expect(ORCH_EXECUTION_MODE_DIRECTOR).toBe('director');
    });
});
