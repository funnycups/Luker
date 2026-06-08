// tests/orchestrator-skills/skill-orchestration-tools.test.js
import { describe, test, expect, beforeEach, jest } from '@jest/globals';

/**
 * Unit tests for `skill-orchestration-tools.js`. The source captures
 * `skillsApi` at module-load via `SillyTavern.getContext().skills` (post
 * upstream commit 571c529c2), so we install a `globalThis.SillyTavern`
 * stub BEFORE the dynamic import. `registerOrchestrationTool` is mocked
 * via `jest.unstable_mockModule` so each call writes into a local
 * `registered` table the tests can inspect.
 *
 * Tests exercise each registered tool's `exec` path: visibility from
 * `ctx.__visibleSkillsForAgent`, the fallback to a global list when
 * context is missing, and scope-precedence ordering in the fallback path.
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

const skillsApi = {
    list: jest.fn(async () => [
        { name: 'foo-skill', description: 'foo', scope: { kind: 'global' }, metadata: { tags: [] } },
        { name: 'shared', description: 'global ver', scope: { kind: 'global' } },
        { name: 'shared', description: 'char ver', scope: { kind: 'character', characterFile: 'a.png' } },
    ]),
    readFile: jest.fn(async () => ({ content: 'body', totalLines: 1, truncated: false })),
    listFiles: jest.fn(async () => ({ files: [{ path: 'SKILL.md', size: 4, isBinary: false }] })),
};

globalThis.SillyTavern = {
    getContext: () => ({ skills: skillsApi }),
};

const { registerSkillOrchestrationTools, unregisterSkillOrchestrationTools } = await import(
    '../../public/scripts/extensions/orchestrator/skill-orchestration-tools.js'
);

describe('skill-orchestration-tools', () => {
    beforeEach(() => {
        for (const k of Object.keys(registered)) delete registered[k];
        skillsApi.list.mockClear();
        skillsApi.readFile.mockClear();
        skillsApi.listFiles.mockClear();
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

    test('skill_search regex scans all files when no path supplied (grep -n shape, multi-file prefix)', async () => {
        skillsApi.listFiles.mockResolvedValueOnce({
            files: [
                { path: 'SKILL.md', size: 20, isBinary: false },
                { path: 'usage.md', size: 20, isBinary: false },
            ],
        });
        skillsApi.readFile
            .mockResolvedValueOnce({ content: '茶杯在窗边\n手里端着茶杯', totalLines: 2, truncated: false })
            .mockResolvedValueOnce({ content: '使用方法\n端着茶杯前进', totalLines: 2, truncated: false });

        const result = await registered.skill_search.exec(
            { name: 'foo-skill', pattern: '茶杯' },
            { __visibleSkillsForAgent: [{ name: 'foo-skill', scope: { kind: 'global' } }] },
        );

        expect(result.ok).toBe(true);
        expect(result.output).toContain('foo-skill/SKILL.md:1: 茶杯在窗边');
        expect(result.output).toContain('foo-skill/SKILL.md:2: 手里端着茶杯');
        expect(result.output).toContain('foo-skill/usage.md:2: 端着茶杯前进');
        // listFiles must be called with the resolved target's scope.
        expect(skillsApi.listFiles).toHaveBeenCalledWith(expect.objectContaining({
            scope: { kind: 'global' }, name: 'foo-skill',
        }));
    });

    test('skill_search regex scans only supplied path when path argument is set', async () => {
        skillsApi.readFile.mockResolvedValueOnce({
            content: '行一\n行二命中\n行三', totalLines: 3, truncated: false,
        });

        const result = await registered.skill_search.exec(
            { name: 'foo-skill', pattern: '命中', path: 'notes/extra.md' },
            { __visibleSkillsForAgent: [{ name: 'foo-skill', scope: { kind: 'global' } }] },
        );

        expect(result.ok).toBe(true);
        expect(result.output).toContain('foo-skill/notes/extra.md:2: 行二命中');
        // When path is supplied, listFiles is bypassed.
        expect(skillsApi.listFiles).not.toHaveBeenCalled();
        expect(skillsApi.readFile).toHaveBeenCalledWith(expect.objectContaining({
            scope: { kind: 'global' }, name: 'foo-skill', path: 'notes/extra.md',
        }));
    });

    test('skill_search invalid regex returns ok=false with escape hint', async () => {
        skillsApi.listFiles.mockResolvedValueOnce({
            files: [{ path: 'SKILL.md', size: 4, isBinary: false }],
        });
        skillsApi.readFile.mockResolvedValueOnce({ content: 'body', totalLines: 1, truncated: false });

        const result = await registered.skill_search.exec(
            { name: 'foo-skill', pattern: '[bad' },
            { __visibleSkillsForAgent: [{ name: 'foo-skill', scope: { kind: 'global' } }] },
        );
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/escape regex metacharacters/);
    });

    test('skill_search throws when pattern is missing', async () => {
        await expect(registered.skill_search.exec(
            { name: 'foo-skill' },
            { __visibleSkillsForAgent: [{ name: 'foo-skill', scope: { kind: 'global' } }] },
        )).rejects.toThrow(/pattern/i);
    });

    test('skill_search throws when pattern is empty string', async () => {
        await expect(registered.skill_search.exec(
            { name: 'foo-skill', pattern: '' },
            { __visibleSkillsForAgent: [{ name: 'foo-skill', scope: { kind: 'global' } }] },
        )).rejects.toThrow(/pattern/i);
    });

    test('skill_search uses scope-precedence fallback when no visible set is provided', async () => {
        skillsApi.listFiles.mockResolvedValueOnce({
            files: [{ path: 'SKILL.md', size: 4, isBinary: false }],
        });
        skillsApi.readFile.mockResolvedValueOnce({ content: 'shared text', totalLines: 1, truncated: false });

        const result = await registered.skill_search.exec({ name: 'shared', pattern: 'shared' });
        expect(result.ok).toBe(true);
        expect(result.output).toContain('shared/SKILL.md:1: shared text');
        // Verify the character-scope `shared` (not global) was chosen.
        const lastListFilesCall = skillsApi.listFiles.mock.calls[skillsApi.listFiles.mock.calls.length - 1];
        expect(lastListFilesCall[0].scope.kind).toBe('character');
        expect(lastListFilesCall[0].scope.characterFile).toBe('a.png');
    });

    test('unregisterSkillOrchestrationTools removes the three entries', () => {
        unregisterSkillOrchestrationTools();
        expect(Object.keys(registered)).toEqual([]);
    });
});
