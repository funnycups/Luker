// tests/cpa-iteration/skill-prompt.test.js
import { describe, test, expect, beforeAll, jest } from '@jest/globals';

// skill-prompt.js is pure (no DOM, no Luker globals, no transitive script.js
// pull) — no module mocks needed. The catalog fetch is supplied by the caller
// via opts.listSkillsInScope, so the test threads stubs directly.

let formatCpaSkillsAugmentation;
let augmentCpaPromptWithSkills;

beforeAll(async () => {
    ({
        formatCpaSkillsAugmentation,
        augmentCpaPromptWithSkills,
    } = await import(
        '../../public/scripts/extensions/completion-preset-assistant/cpa-iteration/skill-prompt.js'
    ));
});

describe('CPA — skill-prompt format', () => {
    test('formatCpaSkillsAugmentation includes the proactive-sweep header and the "verbatim" warning', () => {
        const block = formatCpaSkillsAugmentation([], { presetName: 'Atlas', apiId: 'openai' });
        expect(block).toMatch(/Skill management/);
        expect(block).toMatch(/Proactive sweep/i);
        expect(block).toMatch(/MUST be verbatim|VERBATIM|verbatim/);
    });

    test('formatCpaSkillsAugmentation tells the AI to sweep AS PART OF the adapt round (not wait for an explicit ask)', () => {
        const block = formatCpaSkillsAugmentation([], {});
        expect(block).toMatch(/AS PART OF|as part of/i);
        expect(block).toMatch(/same round|do not wait/i);
    });

    test('formatCpaSkillsAugmentation surfaces preset scope hint when both apiId and presetName are present', () => {
        const block = formatCpaSkillsAugmentation([], { presetName: 'Atlas', apiId: 'openai' });
        expect(block).toContain('Atlas');
        expect(block).toContain('openai');
    });

    test('formatCpaSkillsAugmentation falls back to generic scope wording when hint is missing', () => {
        const block = formatCpaSkillsAugmentation([], {});
        // Generic wording uses placeholder tokens, not a specific preset name.
        expect(block).toContain('apiId');
        expect(block).toContain('name');
        expect(block).not.toContain('Atlas');
    });

    test('formatCpaSkillsAugmentation renders the empty-catalog marker when no skills are visible', () => {
        const block = formatCpaSkillsAugmentation([], {});
        expect(block).toMatch(/none installed|\(none/);
    });

    test('formatCpaSkillsAugmentation lists each visible skill with its scope tag and description', () => {
        const block = formatCpaSkillsAugmentation([
            { name: 'voice-critic-zh', description: 'Voice critique rules', scope: { kind: 'preset' } },
            { name: 'director-anti-cliche-zh', description: 'Anti-cliche patterns', scope: { kind: 'global' } },
        ], {});
        expect(block).toContain('voice-critic-zh');
        expect(block).toContain('Voice critique rules');
        expect(block).toContain('[preset]');
        expect(block).toContain('director-anti-cliche-zh');
        expect(block).toContain('[global]');
    });

    test('formatCpaSkillsAugmentation cross-references the splice-in-reference workflow with preset_str_* tools', () => {
        const block = formatCpaSkillsAugmentation([], {});
        expect(block).toContain('preset_str_delete_in_prompt');
        expect(block).toContain('preset_str_insert_in_prompt');
    });

    test('formatCpaSkillsAugmentation tells the AI to skip sweeping for one-off tweaks', () => {
        const block = formatCpaSkillsAugmentation([], {});
        expect(block).toMatch(/one-off tweak|focused .* tweak|small one-off/i);
        expect(block).toMatch(/do not sweep|skip/i);
    });

    test('formatCpaSkillsAugmentation tells the AI to respect explicit "no skills" instructions', () => {
        const block = formatCpaSkillsAugmentation([], {});
        expect(block).toMatch(/no skills|do not author skills/i);
    });

    test('formatCpaSkillsAugmentation does not re-propose rejected candidates from earlier rounds', () => {
        const block = formatCpaSkillsAugmentation([], {});
        expect(block).toMatch(/rejected|earlier round/i);
    });

    test('formatCpaSkillsAugmentation tells the AI that binding lives in the orchestrator iter-studio, not here', () => {
        const block = formatCpaSkillsAugmentation([], {});
        expect(block).toMatch(/orchestrator iter-studio|orchestrator/i);
        expect(block).toMatch(/not here|NOT here/i);
    });
});

describe('CPA — augmentCpaPromptWithSkills', () => {
    test('returns the base prompt unchanged when mode is not orchestrator-optimize', async () => {
        const base = 'Base system prompt.';
        const out = await augmentCpaPromptWithSkills(base, 'general', { presetName: 'x', apiId: 'y' });
        expect(out).toBe(base);
        const out2 = await augmentCpaPromptWithSkills(base, 'jailbreak-only', { presetName: 'x', apiId: 'y' });
        expect(out2).toBe(base);
    });

    test('appends the skills block when mode is orchestrator-optimize', async () => {
        const base = 'Base system prompt.';
        const out = await augmentCpaPromptWithSkills(
            base,
            'orchestrator-optimize',
            { presetName: 'Atlas', apiId: 'openai' },
            { listSkillsInScope: async () => [] },
        );
        expect(out.startsWith(base)).toBe(true);
        expect(out).toMatch(/Skill management/);
        expect(out).toContain('Atlas');
    });

    test('threads listSkillsInScope result into the catalog', async () => {
        const out = await augmentCpaPromptWithSkills(
            'B',
            'orchestrator-optimize',
            {},
            {
                listSkillsInScope: async () => [
                    { name: 'fmt-rule-zh', description: 'output format rule', scope: { kind: 'preset' } },
                ],
            },
        );
        expect(out).toContain('fmt-rule-zh');
        expect(out).toContain('output format rule');
    });

    test('failing listSkillsInScope falls back to the empty-catalog marker (no throw)', async () => {
        const out = await augmentCpaPromptWithSkills(
            'B',
            'orchestrator-optimize',
            {},
            { listSkillsInScope: async () => { throw new Error('http 500'); } },
        );
        expect(out).toMatch(/none installed|\(none/);
        expect(out.startsWith('B')).toBe(true);
    });

    test('omitted listSkillsInScope still appends the block with an empty catalog', async () => {
        const out = await augmentCpaPromptWithSkills(
            'B',
            'orchestrator-optimize',
            { presetName: 'Atlas', apiId: 'openai' },
        );
        expect(out).toMatch(/Skill management/);
        expect(out).toMatch(/none installed|\(none/);
    });
});
