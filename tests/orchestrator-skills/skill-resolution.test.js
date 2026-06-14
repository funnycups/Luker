import { describe, test, expect, beforeEach, jest } from '@jest/globals';

/**
 * Unit tests for `skill-resolution.js`. The module resolves
 * `Luker.getContext().skills.list({ scope: 'all' })` at module load,
 * so we install a dedicated SillyTavern stub here whose `.skills.list` is
 * a jest spy we can rewire between tests. This replaces the jest.setup.js
 * default stub for this suite only.
 */
const skillsApi = { list: jest.fn() };
const stub = {
    getContext: () => ({
        skills: skillsApi,
        translate: (s) => String(s ?? ''),
    }),
};
globalThis.Luker = stub;
globalThis.st = stub;
globalThis.Luker = stub;

const {
    ensureSkillsFieldShape,
    resolveAgentVisibleSkills,
    buildAvailableSkillsBlock,
    invalidateSkillInventory,
} = await import('../../public/scripts/extensions/orchestrator/skill-resolution.js');

describe('ensureSkillsFieldShape', () => {
    test('defaults mode-level skills to wildcard visible / empty deny', () => {
        const p = {};
        ensureSkillsFieldShape(p);
        expect(p.skills).toEqual({ visible: ['*'], deny: [] });
    });

    test('preserves existing mode-level skills', () => {
        const p = { skills: { visible: ['a', 'b'], deny: ['c'] } };
        ensureSkillsFieldShape(p);
        expect(p.skills).toEqual({ visible: ['a', 'b'], deny: ['c'] });
    });

    test('repairs mode-level shape with missing arrays', () => {
        const p = { skills: { /* both missing */ } };
        ensureSkillsFieldShape(p);
        expect(p.skills).toEqual({ visible: ['*'], deny: [] });
    });

    test('leaves agent-level skills undefined when absent', () => {
        const a = { id: 'x' };
        ensureSkillsFieldShape(a, { isAgent: true });
        expect(a.skills).toBeUndefined();
    });

    test('normalizes agent-level partial shape', () => {
        const a = { id: 'x', skills: { visible: ['+', 'foo'] } };
        ensureSkillsFieldShape(a, { isAgent: true });
        expect(a.skills.deny).toEqual([]);
        expect(a.skills.visible).toEqual(['+', 'foo']);
    });

    test('no-op on null/undefined input', () => {
        expect(() => ensureSkillsFieldShape(null)).not.toThrow();
        expect(() => ensureSkillsFieldShape(undefined, { isAgent: true })).not.toThrow();
    });
});

describe('resolveAgentVisibleSkills', () => {
    beforeEach(() => {
        invalidateSkillInventory();
        skillsApi.list.mockReset();
        skillsApi.list.mockResolvedValue([
            { name: 'global-a', description: 'g a', scope: { kind: 'global' } },
            { name: 'global-b', description: 'g b', scope: { kind: 'global' } },
            { name: 'preset-x', description: 'p x', scope: { kind: 'preset', name: 'rp' } },
            { name: 'char-y', description: 'c y', scope: { kind: 'character', characterFile: 'alice.png' } },
        ]);
    });

    test('mode default visible=["*"] returns all in-scope skills', async () => {
        const result = await resolveAgentVisibleSkills({
            modeProfile: { skills: { visible: ['*'], deny: [] } },
            agentConfig: null,
            runtimeContext: { presetName: 'rp', characterFile: 'alice.png' },
        });
        expect(result.map(s => s.name).sort()).toEqual(['char-y', 'global-a', 'global-b', 'preset-x']);
    });

    test('mode visible whitelist filters', async () => {
        const result = await resolveAgentVisibleSkills({
            modeProfile: { skills: { visible: ['global-a', 'preset-x'], deny: [] } },
            agentConfig: null,
            runtimeContext: { presetName: 'rp' },
        });
        expect(result.map(s => s.name).sort()).toEqual(['global-a', 'preset-x']);
    });

    test('agent visible "+" inherits mode default and appends', async () => {
        const result = await resolveAgentVisibleSkills({
            modeProfile: { skills: { visible: ['global-a'], deny: [] } },
            agentConfig: { skills: { visible: ['+', 'preset-x'] } },
            runtimeContext: { presetName: 'rp' },
        });
        expect(result.map(s => s.name).sort()).toEqual(['global-a', 'preset-x']);
    });

    test('agent visible without "+" fully replaces mode default', async () => {
        const result = await resolveAgentVisibleSkills({
            modeProfile: { skills: { visible: ['global-a', 'global-b'], deny: [] } },
            agentConfig: { skills: { visible: ['preset-x'] } },
            runtimeContext: { presetName: 'rp' },
        });
        expect(result.map(s => s.name)).toEqual(['preset-x']);
    });

    test('agent visible "+" alone with no append items still inherits mode default', async () => {
        const result = await resolveAgentVisibleSkills({
            modeProfile: { skills: { visible: ['global-a'], deny: [] } },
            agentConfig: { skills: { visible: ['+'] } },
            runtimeContext: {},
        });
        expect(result.map(s => s.name)).toEqual(['global-a']);
    });

    test('mode deny removes from visible', async () => {
        const result = await resolveAgentVisibleSkills({
            modeProfile: { skills: { visible: ['*'], deny: ['global-a'] } },
            agentConfig: null,
            runtimeContext: { presetName: 'rp', characterFile: 'alice.png' },
        });
        expect(result.map(s => s.name).sort()).toEqual(['char-y', 'global-b', 'preset-x']);
    });

    test('agent deny unions with mode deny', async () => {
        const result = await resolveAgentVisibleSkills({
            modeProfile: { skills: { visible: ['*'], deny: ['global-a'] } },
            agentConfig: { skills: { visible: ['*'], deny: ['preset-x'] } },
            runtimeContext: { presetName: 'rp', characterFile: 'alice.png' },
        });
        expect(result.map(s => s.name).sort()).toEqual(['char-y', 'global-b']);
    });

    test('character scope only resolved when characterFile in context', async () => {
        const withChar = await resolveAgentVisibleSkills({
            modeProfile: { skills: { visible: ['*'], deny: [] } },
            agentConfig: null,
            runtimeContext: { characterFile: 'alice.png' },
        });
        expect(withChar.map(s => s.name)).toContain('char-y');

        invalidateSkillInventory();
        const withoutChar = await resolveAgentVisibleSkills({
            modeProfile: { skills: { visible: ['*'], deny: [] } },
            agentConfig: null,
            runtimeContext: {},
        });
        expect(withoutChar.map(s => s.name)).not.toContain('char-y');
    });

    test('preset scope only resolved when presetApiId+presetName both present', async () => {
        const partial = await resolveAgentVisibleSkills({
            modeProfile: { skills: { visible: ['*'], deny: [] } },
            agentConfig: null,
            runtimeContext: { presetApiId: 'openai' /* no name */ },
        });
        expect(partial.map(s => s.name)).not.toContain('preset-x');
    });

    test('character-scope skill overrides same-name preset/global skill (last-wins merge)', async () => {
        invalidateSkillInventory();
        skillsApi.list.mockResolvedValueOnce([
            { name: 'shared', description: 'global version', scope: { kind: 'global' } },
            { name: 'shared', description: 'preset version', scope: { kind: 'preset', name: 'rp' } },
            { name: 'shared', description: 'character version', scope: { kind: 'character', characterFile: 'alice.png' } },
        ]);
        const result = await resolveAgentVisibleSkills({
            modeProfile: { skills: { visible: ['*'], deny: [] } },
            agentConfig: null,
            runtimeContext: { presetName: 'rp', characterFile: 'alice.png' },
        });
        expect(result).toHaveLength(1);
        expect(result[0].description).toBe('character version');
    });

    test('inventory cache amortizes repeat calls within TTL', async () => {
        await resolveAgentVisibleSkills({
            modeProfile: { skills: { visible: ['*'], deny: [] } },
            agentConfig: null,
            runtimeContext: {},
        });
        await resolveAgentVisibleSkills({
            modeProfile: { skills: { visible: ['*'], deny: [] } },
            agentConfig: null,
            runtimeContext: {},
        });
        expect(skillsApi.list).toHaveBeenCalledTimes(1);
        invalidateSkillInventory();
        await resolveAgentVisibleSkills({
            modeProfile: { skills: { visible: ['*'], deny: [] } },
            agentConfig: null,
            runtimeContext: {},
        });
        expect(skillsApi.list).toHaveBeenCalledTimes(2);
    });

    test('falls back to empty array when inventory load fails', async () => {
        invalidateSkillInventory();
        skillsApi.list.mockRejectedValueOnce(new Error('network'));
        const result = await resolveAgentVisibleSkills({
            modeProfile: { skills: { visible: ['*'], deny: [] } },
            agentConfig: null,
            runtimeContext: {},
        });
        expect(result).toEqual([]);
    });

    test('null modeProfile is repaired by ensureSkillsFieldShape default', async () => {
        const profile = {};
        const result = await resolveAgentVisibleSkills({
            modeProfile: profile,
            agentConfig: null,
            runtimeContext: { presetName: 'rp' },
        });
        // Default visible=['*'] applied; preset-x reachable since preset ctx provided.
        expect(result.map(s => s.name).sort()).toContain('preset-x');
        expect(profile.skills).toEqual({ visible: ['*'], deny: [] });
    });
});

describe('buildAvailableSkillsBlock', () => {
    test('returns empty string when no skills are visible', () => {
        expect(buildAvailableSkillsBlock([])).toBe('');
        expect(buildAvailableSkillsBlock(null)).toBe('');
        expect(buildAvailableSkillsBlock(undefined)).toBe('');
    });

    test('formats name + description as bullet list inside XML tags', () => {
        const result = buildAvailableSkillsBlock([
            { name: 'a', description: 'desc a' },
            { name: 'b', description: 'desc b' },
        ]);
        expect(result).toContain('<available_skills>');
        expect(result).toContain('- a: desc a');
        expect(result).toContain('- b: desc b');
        expect(result).toContain('</available_skills>');
        expect(result).toContain('skill_read');
        expect(result).toContain('skill_search');
    });

    test('skips skills missing a name', () => {
        const result = buildAvailableSkillsBlock([
            { name: 'good', description: 'ok' },
            { description: 'no name' },
        ]);
        expect(result).toContain('- good: ok');
        expect(result).not.toContain('- :');
    });

    test('handles missing description gracefully', () => {
        const result = buildAvailableSkillsBlock([{ name: 'noisy' }]);
        expect(result).toContain('- noisy: ');
    });
});
