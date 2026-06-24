// tests/cpa-iteration/skill-prompt.test.js
import { describe, test, expect, beforeAll } from '@jest/globals';

// skill-prompt.js is pure (no DOM, no Luker globals, no transitive script.js
// pull) — no module mocks needed. The catalog fetch is supplied by the caller
// via opts.listSkillsInScope, so the test threads stubs directly.

let formatCpaSkillsAugmentation;
let buildCpaSkillsBlock;

beforeAll(async () => {
    ({
        formatCpaSkillsAugmentation,
        buildCpaSkillsBlock,
    } = await import(
        '../../public/scripts/extensions/completion-preset-assistant/cpa-iteration/skill-prompt.js'
    ));
});

describe('CPA — skill-prompt format', () => {
    test('formatCpaSkillsAugmentation includes the proactive-sweep header and the "verbatim" warning', () => {
        const block = formatCpaSkillsAugmentation([], { presetName: 'Atlas' });
        expect(block).toMatch(/Skill management/);
        expect(block).toMatch(/Proactive sweep/i);
        expect(block).toMatch(/MUST be verbatim|VERBATIM|verbatim/);
    });

    test('formatCpaSkillsAugmentation tells the AI to sweep AS PART OF the adapt round (not wait for an explicit ask)', () => {
        const block = formatCpaSkillsAugmentation([], {});
        expect(block).toMatch(/AS PART OF|as part of/i);
        expect(block).toMatch(/same round|do not wait/i);
    });

    test('formatCpaSkillsAugmentation surfaces preset scope hint when presetName is present', () => {
        const block = formatCpaSkillsAugmentation([], { presetName: 'Atlas' });
        expect(block).toContain('Atlas');
        expect(block).toContain("kind: 'preset'");
    });

    test('formatCpaSkillsAugmentation falls back to generic scope wording when hint is missing', () => {
        const block = formatCpaSkillsAugmentation([], {});
        // Generic wording uses placeholder tokens, not a specific preset name.
        expect(block).toContain("kind: 'preset'");
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

    test('formatCpaSkillsAugmentation sorts skills by name so input order does not float through', () => {
        // Input order would put 'zeta' first; output should always be
        // alpha-sorted so Anthropic prompt cache stays stable when the
        // registry reorders its array (skill install / uninstall reshuffles
        // the in-memory cache).
        const block = formatCpaSkillsAugmentation([
            { name: 'zeta-skill', description: 'z', scope: { kind: 'preset' } },
            { name: 'alpha-skill', description: 'a', scope: { kind: 'preset' } },
            { name: 'mid-skill', description: 'm', scope: { kind: 'global' } },
        ], {});
        const alphaIdx = block.indexOf('alpha-skill');
        const midIdx = block.indexOf('mid-skill');
        const zetaIdx = block.indexOf('zeta-skill');
        expect(alphaIdx).toBeGreaterThan(-1);
        expect(midIdx).toBeGreaterThan(alphaIdx);
        expect(zetaIdx).toBeGreaterThan(midIdx);
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

describe('CPA — buildCpaSkillsBlock', () => {
    test('returns empty string when mode is not orchestrator-optimize', async () => {
        const out = await buildCpaSkillsBlock('general', { presetName: 'x' });
        expect(out).toBe('');
        const out2 = await buildCpaSkillsBlock('jailbreak-only', { presetName: 'x' });
        expect(out2).toBe('');
    });

    test('returns the skills block (no basePrompt wrapping) when mode is orchestrator-optimize', async () => {
        const out = await buildCpaSkillsBlock(
            'orchestrator-optimize',
            { presetName: 'Atlas' },
            { listSkillsInScope: async () => [] },
        );
        expect(out).toMatch(/Skill management/);
        expect(out).toContain('Atlas');
    });

    test('threads listSkillsInScope result into the catalog', async () => {
        const out = await buildCpaSkillsBlock(
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

    test('rethrows when listSkillsInScope fails (no silent fallback to empty catalog)', async () => {
        // Silent fallback would let the prompt lie ("(none installed)") and
        // risk the AI duplicating an existing skill. The caller (studio.js)
        // surfaces the failure to the user instead.
        await expect(
            buildCpaSkillsBlock(
                'orchestrator-optimize',
                {},
                { listSkillsInScope: async () => { throw new Error('http 500'); } },
            ),
        ).rejects.toThrow(/http 500/);
    });

    test('omitted listSkillsInScope still returns the block with an empty catalog', async () => {
        const out = await buildCpaSkillsBlock(
            'orchestrator-optimize',
            { presetName: 'Atlas' },
        );
        expect(out).toMatch(/Skill management/);
        expect(out).toMatch(/none installed|\(none/);
    });
});
