// tests/orchestrator-skills/skill-orchestration-tools.test.js
import { describe, test, expect, beforeEach, jest } from '@jest/globals';

/**
 * Unit tests for `skill-orchestration-tools.js`. We mock both the
 * orchestrator's `registerOrchestrationTool` (to capture spec arguments
 * without touching the live registry) and `skillsApi` (to feed deterministic
 * fixtures). The tests then exercise each registered tool's `exec` path:
 * visibility from `ctx.__visibleSkillsForAgent`, the fallback to a global
 * list when context is missing, and scope-precedence ordering in the
 * fallback path.
 */

const registered = {};

jest.unstable_mockModule(
    '../../public/scripts/extensions/orchestrator/register-custom-tool.js',
    () => ({
        registerOrchestrationTool: jest.fn((spec) => {
            registered[spec.name] = spec;
        }),
        unregisterOrchestrationTool: jest.fn((name) => {
            delete registered[name];
        }),
    }),
);

jest.unstable_mockModule('../../public/scripts/skills/api.js', () => ({
    skillsApi: {
        list: jest.fn(async () => [
            { name: 'foo-skill', description: 'foo', scope: { kind: 'global' }, metadata: { tags: [] } },
            { name: 'shared', description: 'global ver', scope: { kind: 'global' } },
            { name: 'shared', description: 'char ver', scope: { kind: 'character', characterFile: 'a.png' } },
        ]),
        readFile: jest.fn(async () => ({ content: 'body', totalLines: 1, truncated: false })),
        search: jest.fn(async () => ({ hits: [] })),
    },
}));

const { skillsApi } = await import('../../public/scripts/skills/api.js');
const { registerSkillOrchestrationTools, unregisterSkillOrchestrationTools } = await import(
    '../../public/scripts/extensions/orchestrator/skill-orchestration-tools.js'
);

describe('skill-orchestration-tools', () => {
    beforeEach(() => {
        for (const k of Object.keys(registered)) delete registered[k];
        skillsApi.list.mockClear();
        skillsApi.readFile.mockClear();
        skillsApi.search.mockClear();
        registerSkillOrchestrationTools();
    });

    test('registers skill_list / skill_read / skill_search via registerOrchestrationTool', () => {
        expect(Object.keys(registered).sort()).toEqual(['skill_list', 'skill_read', 'skill_search']);
        for (const t of Object.values(registered)) {
            expect(t.mode).toBe('read');
            expect(typeof t.exec).toBe('function');
            // schema parameters object so the orchestrator's loop schema merge
            // doesn't reject the entry with a `parameters must be object` error.
            expect(typeof t.parameters).toBe('object');
        }
    });

    test('skill_list uses ctx.__visibleSkillsForAgent when present', async () => {
        const result = await registered.skill_list.exec(
            {},
            { __visibleSkillsForAgent: [{ name: 'only-this', description: 'x', metadata: {} }] },
        );
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('only-this');
        // No global fallback fired.
        expect(skillsApi.list).not.toHaveBeenCalled();
    });

    test('skill_list filters by query substring (case-insensitive)', async () => {
        const result = await registered.skill_list.exec(
            { query: 'CHAR' },
            { __visibleSkillsForAgent: [
                { name: 'character-tools', description: 'd', metadata: {} },
                { name: 'foo', description: 'd', metadata: {} },
            ] },
        );
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('character-tools');
    });

    test('skill_read rejects unknown name when visible set is provided', async () => {
        await expect(registered.skill_read.exec(
            { name: 'unknown' },
            { __visibleSkillsForAgent: [] },
        )).rejects.toThrow(/not visible/);
    });

    test('skill_read falls back to global list with character > global precedence', async () => {
        const result = await registered.skill_read.exec({ name: 'shared' });
        expect(result.content).toBe('body');
        // Verify it picked the character-scope `shared` (not the global one)
        // by inspecting the scope passed to skillsApi.readFile.
        const lastCall = skillsApi.readFile.mock.calls[skillsApi.readFile.mock.calls.length - 1];
        expect(lastCall[0].scope.kind).toBe('character');
        expect(lastCall[0].scope.characterFile).toBe('a.png');
    });

    test('skill_read fallback rejects unknown name', async () => {
        await expect(registered.skill_read.exec({ name: 'nope' }))
            .rejects.toThrow(/not found/);
    });

    test('skill_search delegates to skillsApi.search with target scope', async () => {
        await registered.skill_search.exec(
            { name: 'foo-skill', query: 'q' },
            { __visibleSkillsForAgent: [{ name: 'foo-skill', scope: { kind: 'global' } }] },
        );
        const lastCall = skillsApi.search.mock.calls[skillsApi.search.mock.calls.length - 1];
        expect(lastCall[0].name).toBe('foo-skill');
        expect(lastCall[0].query).toBe('q');
        expect(lastCall[0].scope.kind).toBe('global');
    });

    test('unregisterSkillOrchestrationTools removes the three entries', () => {
        unregisterSkillOrchestrationTools();
        expect(Object.keys(registered)).toEqual([]);
    });
});
