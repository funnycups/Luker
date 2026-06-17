import { describe, test, expect } from '@jest/globals';
import { buildDirectorDefaultSystemPrompt } from '../../public/scripts/extensions/orchestrator/director-default-prompt.js';

/**
 * B2 follow-up: the main agent prompt must reflect the actual sub-agent set
 * for whichever preset variant (Full / Minimal) it is being built for.
 * Hard-coding all 12 historical sub-agents would point the main agent at
 * tools that no longer exist for its current preset, breaking the loop.
 *
 * These tests use STRUCTURAL anchors (heading markers `### <id>`, the
 * literal "subagentId must be one of:" phrase that precedes the dispatch
 * enum) — they intentionally do NOT grep prose wording. See
 * `[[feedback_no_prompt_regex_tests]]` for the rationale.
 */
describe('buildDirectorDefaultSystemPrompt: preset variants', () => {
    test('full variant includes all 11 Full-preset agent sections', () => {
        const prompt = buildDirectorDefaultSystemPrompt({ presetVariant: 'full' });
        for (const id of ['intent_scout', 'memory_scout', 'lorebook_scout', 'notes_pickup_scout', 'canon_scout', 'epistemic_scout', 'plot_brainstormer', 'voice_critic', 'continuity_critic', 'notes_curator', 'memory_curator']) {
            expect(prompt).toContain(`### ${id}`);
        }
        expect(prompt).not.toContain('### chat_scout');
    });

    test('minimal variant includes all 9 Minimal-preset agent sections, omits the rest', () => {
        const prompt = buildDirectorDefaultSystemPrompt({ presetVariant: 'minimal' });
        for (const id of ['intent_scout', 'chat_scout', 'lorebook_scout', 'notes_pickup_scout', 'epistemic_scout', 'plot_brainstormer', 'voice_critic', 'continuity_critic', 'notes_curator']) {
            expect(prompt).toContain(`### ${id}`);
        }
        for (const id of ['memory_scout', 'memory_curator', 'canon_scout']) {
            expect(prompt).not.toContain(`### ${id}`);
        }
    });

    test('full variant dispatch enum lists exactly the 11 Full agents', () => {
        const prompt = buildDirectorDefaultSystemPrompt({ presetVariant: 'full' });
        const enumMatch = prompt.match(/subagentId must be one of:[^\n]+/);
        expect(enumMatch).toBeTruthy();
        for (const id of ['intent_scout', 'memory_scout', 'lorebook_scout', 'notes_pickup_scout', 'canon_scout', 'epistemic_scout', 'plot_brainstormer', 'voice_critic', 'continuity_critic', 'notes_curator', 'memory_curator']) {
            expect(enumMatch[0]).toContain(`\`${id}\``);
        }
        expect(enumMatch[0]).not.toContain('`chat_scout`');
    });

    test('minimal variant dispatch enum lists exactly the 9 Minimal agents', () => {
        const prompt = buildDirectorDefaultSystemPrompt({ presetVariant: 'minimal' });
        const enumMatch = prompt.match(/subagentId must be one of:[^\n]+/);
        expect(enumMatch).toBeTruthy();
        for (const id of ['intent_scout', 'chat_scout', 'lorebook_scout', 'notes_pickup_scout', 'epistemic_scout', 'plot_brainstormer', 'voice_critic', 'continuity_critic', 'notes_curator']) {
            expect(enumMatch[0]).toContain(`\`${id}\``);
        }
        for (const id of ['memory_scout', 'memory_curator', 'canon_scout']) {
            expect(enumMatch[0]).not.toContain(`\`${id}\``);
        }
    });

    test('default call (no args) returns the full variant for back-compat', () => {
        const defaultPrompt = buildDirectorDefaultSystemPrompt();
        const fullPrompt = buildDirectorDefaultSystemPrompt({ presetVariant: 'full' });
        expect(defaultPrompt).toBe(fullPrompt);
    });

    test('minimal variant does not promise "memory_curator MANDATORY every turn"', () => {
        const prompt = buildDirectorDefaultSystemPrompt({ presetVariant: 'minimal' });
        // memory_curator doesn't exist in Minimal — the prompt must not name it as a mandatory step.
        expect(prompt).not.toMatch(/memory_curator.*MANDATORY/i);
        expect(prompt).not.toMatch(/MANDATORY.*memory_curator/i);
    });
});
