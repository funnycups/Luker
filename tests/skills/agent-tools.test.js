import { describe, test, expect, beforeEach, jest } from '@jest/globals';

// Mock skillsApi at the module boundary before importing agent-tools.
// This isolates the handler logic from real fetch calls.
jest.unstable_mockModule('../../public/scripts/skills/api.js', () => ({
    skillsApi: {
        list: jest.fn(async () => [
            { name: 'foo-skill', description: 'a foo skill', scope: { kind: 'global' }, metadata: { tags: ['t'] } },
            { name: 'bar-skill', description: 'a bar skill', scope: { kind: 'preset', name: 'rp' }, metadata: { tags: [] } },
        ]),
        readFile: jest.fn(async () => ({ content: 'body', totalLines: 1 })),
        search: jest.fn(async () => ({ hits: [{ path: 'SKILL.md', lineStart: 1, lineEnd: 2, snippet: 'hit' }] })),
    },
}));

const { registerSkillAgentTools } = await import('../../public/scripts/skills/agent-tools.js');

describe('registerSkillAgentTools', () => {
    let registered;
    let toolManager;

    beforeEach(() => {
        registered = {};
        toolManager = {
            registerFunctionTool(spec) { registered[spec.name] = spec; },
        };
        registerSkillAgentTools(toolManager);
    });

    test('registers 3 tools', () => {
        expect(Object.keys(registered).sort()).toEqual(['skill_list', 'skill_read', 'skill_search']);
    });

    test('all tool specs include name, description, parameters, action', () => {
        for (const spec of Object.values(registered)) {
            expect(typeof spec.name).toBe('string');
            expect(typeof spec.description).toBe('string');
            expect(spec.parameters).toBeDefined();
            expect(typeof spec.action).toBe('function');
        }
    });

    test('skill_list returns visible skills filtered by query', async () => {
        const result = await registered.skill_list.action({ query: 'foo' });
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('foo-skill');
        expect(result[0].tags).toEqual(['t']);
    });

    test('skill_list uses agentContext.__visibleSkillsForAgent if present', async () => {
        const result = await registered.skill_list.action(
            {},
            {
                __visibleSkillsForAgent: [
                    { name: 'only-this', description: 'only', metadata: { tags: [] } },
                ],
            },
        );
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('only-this');
    });

    test('skill_list without query returns all visible skills', async () => {
        const result = await registered.skill_list.action({});
        // Falls back to global list (2 mocked skills)
        expect(result).toHaveLength(2);
    });

    test('skill_read resolves via agentContext.__visibleSkillsForAgent', async () => {
        const result = await registered.skill_read.action(
            { name: 'foo-skill' },
            {
                __visibleSkillsForAgent: [
                    { name: 'foo-skill', scope: { kind: 'global' } },
                ],
            },
        );
        expect(result.content).toBe('body');
    });

    test('skill_read rejects unknown name when visibility context is provided', async () => {
        await expect(registered.skill_read.action(
            { name: 'unknown' },
            { __visibleSkillsForAgent: [] },
        )).rejects.toThrow(/not visible/);
    });

    test('skill_read falls back to global list when no agentContext', async () => {
        // foo-skill exists in the mocked global list
        const result = await registered.skill_read.action({ name: 'foo-skill' });
        expect(result.content).toBe('body');
    });

    test('skill_read rejects unknown name in global fallback', async () => {
        await expect(registered.skill_read.action({ name: 'no-such-skill' }))
            .rejects.toThrow(/not found/);
    });

    test('resolveSkill fallback gives character > preset > global precedence on name collision', async () => {
        // Spec §5 says character beats preset beats global when names collide;
        // the orchestrator (Unit 6) enforces this via getVisible. The fallback
        // path (no __visibleSkillsForAgent) must mirror that ordering so
        // direct/test access resolves identically.
        //
        // skillsApi.list returns entries in repository order (global → preset →
        // character); resolveSkill must NOT just pick the first match.
        const { skillsApi } = await import('../../public/scripts/skills/api.js');
        skillsApi.list.mockResolvedValueOnce([
            { name: 'shared', description: 'global version', scope: { kind: 'global' } },
            { name: 'shared', description: 'preset version', scope: { kind: 'preset', name: 'rp' } },
            { name: 'shared', description: 'char version', scope: { kind: 'character', characterFile: 'a.png' } },
        ]);

        await registered.skill_read.action({ name: 'shared' });

        // The most recent readFile call should target the character-scope skill.
        const calls = skillsApi.readFile.mock.calls;
        const lastCall = calls[calls.length - 1];
        expect(lastCall[0].scope).toEqual({ kind: 'character', characterFile: 'a.png' });
    });

    test('resolveSkill fallback picks preset over global when no character entry exists', async () => {
        const { skillsApi } = await import('../../public/scripts/skills/api.js');
        skillsApi.list.mockResolvedValueOnce([
            { name: 'shared', description: 'global version', scope: { kind: 'global' } },
            { name: 'shared', description: 'preset version', scope: { kind: 'preset', name: 'rp' } },
        ]);

        await registered.skill_read.action({ name: 'shared' });

        const calls = skillsApi.readFile.mock.calls;
        const lastCall = calls[calls.length - 1];
        expect(lastCall[0].scope.kind).toBe('preset');
    });

    test('skill_search delegates to api.search with target scope', async () => {
        const result = await registered.skill_search.action(
            { name: 'foo-skill', query: 'q' },
            { __visibleSkillsForAgent: [{ name: 'foo-skill', scope: { kind: 'global' } }] },
        );
        expect(result.hits).toHaveLength(1);
    });

    test('handles missing ToolManager gracefully', () => {
        // Suppress the expected "ToolManager not available" warnings so test
        // output stays pristine. The warning is the documented behaviour.
        const originalWarn = console.warn;
        console.warn = () => {};
        try {
            expect(() => registerSkillAgentTools(null)).not.toThrow();
            expect(() => registerSkillAgentTools({})).not.toThrow();
            expect(() => registerSkillAgentTools({ registerFunctionTool: 'not a function' })).not.toThrow();
        } finally {
            console.warn = originalWarn;
        }
    });
});
