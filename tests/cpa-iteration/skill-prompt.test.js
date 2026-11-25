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
        '../../public/scripts/workbench/targets/preset-skill-prompt.js'
    ));
});

describe('CPA — skill-prompt format', () => {
    test('formatCpaSkillsAugmentation interpolates presetName when present and omits it when missing', () => {
        const withHint = formatCpaSkillsAugmentation([], { presetName: 'Atlas' });
        const withoutHint = formatCpaSkillsAugmentation([], {});
        expect(typeof withHint).toBe('string');
        expect(withHint.length).toBeGreaterThan(0);
        expect(withHint).toContain('Atlas');
        expect(typeof withoutHint).toBe('string');
        expect(withoutHint.length).toBeGreaterThan(0);
        expect(withoutHint).not.toContain('Atlas');
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
});

describe('CPA — buildCpaSkillsBlock', () => {
    test('returns empty string when mode is not orchestrator-optimize', async () => {
        const out = await buildCpaSkillsBlock('general', { presetName: 'x' });
        expect(out).toBe('');
        const out2 = await buildCpaSkillsBlock('jailbreak-only', { presetName: 'x' });
        expect(out2).toBe('');
    });

    test('returns a non-empty skills block when mode is orchestrator-optimize', async () => {
        const out = await buildCpaSkillsBlock(
            'orchestrator-optimize',
            { presetName: 'Atlas' },
            { listSkillsInScope: async () => [] },
        );
        expect(typeof out).toBe('string');
        expect(out.length).toBeGreaterThan(0);
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

    test('omitted listSkillsInScope still returns a non-empty block', async () => {
        const out = await buildCpaSkillsBlock(
            'orchestrator-optimize',
            { presetName: 'Atlas' },
        );
        expect(typeof out).toBe('string');
        expect(out.length).toBeGreaterThan(0);
        expect(out).toContain('Atlas');
    });
});
