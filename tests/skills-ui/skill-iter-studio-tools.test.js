// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Plan 2 Unit 7 — iter-studio 15-tool skills catalog + system prompt
 * augmentation.
 *
 * Two source modules under test:
 *
 *   public/scripts/extensions/orchestrator/skill-iter-studio-tools.js
 *     - SKILL_ITER_STUDIO_TOOL_DEFS: tool catalog spliced into studio.js
 *     - isSkillIterStudioTool / SKILL_ITER_STUDIO_TOOL_NAMES
 *     - runSkillIterStudioTool dispatcher
 *     - applyFrontmatterPatch (pure helper)
 *
 *   public/scripts/extensions/orchestrator/skill-iter-studio-prompt.js
 *     - augmentIterStudioPromptWithSkills
 *     - detectLongSystemPromptAgents + formatSkillsAugmentation
 *
 * Both modules import via the public/lib.js facade (for yaml) and
 * skillsApi (the REST transport wrapper). We mock both at the module
 * boundary with jest.unstable_mockModule and exercise each handler's
 * happy path + at least one error branch.
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

// ── Module-boundary mocks ────────────────────────────────────────────────
// lib.js is heavy + DOM-bound; supply yaml so applyFrontmatterPatch works.
jest.unstable_mockModule('../../public/lib.js', () => ({
    yaml: { parse: parseYaml, stringify: stringifyYaml },
}));

// skillsApi: each test resets the mock fns so we can assert per-call args.
const mockSkillsApi = {
    list: jest.fn(),
    get: jest.fn(),
    listFiles: jest.fn(),
    readFile: jest.fn(),
    search: jest.fn(),
    writeFile: jest.fn(),
    editFile: jest.fn(),
    install: jest.fn(),
    rename: jest.fn(),
    moveScope: jest.fn(),
    delete: jest.fn(),
};
jest.unstable_mockModule('../../public/scripts/skills/api.js', () => ({
    skillsApi: mockSkillsApi,
}));

// skill-resolution.js: prompt augmentation calls resolveAgentVisibleSkills.
const mockResolve = jest.fn();
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/skill-resolution.js', () => ({
    resolveAgentVisibleSkills: mockResolve,
    buildSkillRuntimeContext: () => ({}),
    ensureSkillsFieldShape: () => {},
    invalidateSkillInventory: () => {},
    buildAvailableSkillsBlock: () => '',
}));

const {
    SKILL_ITER_STUDIO_TOOL_DEFS,
    SKILL_ITER_STUDIO_TOOL_NAMES,
    isSkillIterStudioTool,
    runSkillIterStudioTool,
    applyFrontmatterPatch,
} = await import('../../public/scripts/extensions/orchestrator/skill-iter-studio-tools.js');

const {
    augmentIterStudioPromptWithSkills,
    detectLongSystemPromptAgents,
    formatSkillsAugmentation,
    LONG_PROMPT_HEURISTIC_CHARS,
} = await import('../../public/scripts/extensions/orchestrator/skill-iter-studio-prompt.js');

beforeEach(() => {
    for (const fn of Object.values(mockSkillsApi)) fn.mockReset();
    mockResolve.mockReset();
});

// ── Tool catalog shape ───────────────────────────────────────────────────
//
// Spec §6.1 categories: inventory (4) + authoring (7) + policy binding (3) +
// migration helpers (2) = 16 tools total. The migration category dropped from
// 3 to 2 when skill_propose_extraction was deleted — extraction-candidate
// judgment is the iter-studio AI's job, not a regex heuristic baked into
// this module.

describe('SKILL_ITER_STUDIO_TOOL_DEFS — catalog shape', () => {
    test('exposes all 16 spec-listed tools (4 inventory + 7 authoring + 3 policy + 2 migration)', () => {
        expect(SKILL_ITER_STUDIO_TOOL_DEFS).toHaveLength(16);
        expect(SKILL_ITER_STUDIO_TOOL_NAMES).toHaveLength(16);
    });

    test('all names are isSkillIterStudioTool-recognized', () => {
        for (const name of SKILL_ITER_STUDIO_TOOL_NAMES) {
            expect(isSkillIterStudioTool(name)).toBe(true);
        }
        expect(isSkillIterStudioTool('skill_list')).toBe(false);
        expect(isSkillIterStudioTool('')).toBe(false);
        expect(isSkillIterStudioTool(null)).toBe(false);
    });

    test('each tool def is OpenAI-shape with name + description + parameters', () => {
        const seen = new Set();
        for (const def of SKILL_ITER_STUDIO_TOOL_DEFS) {
            expect(def.type).toBe('function');
            const fn = def.function;
            expect(typeof fn.name).toBe('string');
            expect(fn.name.length).toBeGreaterThan(0);
            expect(typeof fn.description).toBe('string');
            expect(fn.description.length).toBeGreaterThan(20);
            expect(fn.parameters && typeof fn.parameters).toBe('object');
            expect(fn.parameters.type).toBe('object');
            expect(seen.has(fn.name)).toBe(false);
            seen.add(fn.name);
        }
    });

    test('catalog covers all four spec categories', () => {
        const names = new Set(SKILL_ITER_STUDIO_TOOL_NAMES);
        // inventory
        for (const n of ['skill_list_visible', 'skill_inspect', 'skill_read_content', 'skill_search_content']) {
            expect(names.has(n)).toBe(true);
        }
        // authoring
        for (const n of ['skill_create', 'skill_update_content', 'skill_edit_content', 'skill_update_frontmatter', 'skill_rename', 'skill_change_scope', 'skill_delete']) {
            expect(names.has(n)).toBe(true);
        }
        // policy
        for (const n of ['skill_bind_to_agent', 'skill_unbind_from_agent', 'skill_set_mode_defaults']) {
            expect(names.has(n)).toBe(true);
        }
        // migration
        for (const n of ['skill_extract_from_text', 'skill_replace_in_systemprompt']) {
            expect(names.has(n)).toBe(true);
        }
    });
});

// ── Inventory inspection ────────────────────────────────────────────────

describe('runSkillIterStudioTool — inventory inspection', () => {
    test('skill_list_visible (no agentId) returns modeLevel + inventory', async () => {
        mockSkillsApi.list.mockResolvedValue([
            { name: 'alpha', description: 'a', scope: { kind: 'global' } },
            { name: 'beta', description: 'b', scope: { kind: 'global' } },
        ]);
        const profile = { skills: { visible: ['alpha'], deny: [] } };
        const out = await runSkillIterStudioTool(
            { name: 'skill_list_visible', args: {} },
            { getWorkingProfile: () => profile },
        );
        expect(out.ok).toBe(true);
        expect(out.result.modeLevel).toEqual({ visible: ['alpha'], deny: [] });
        expect(out.result.inventory).toHaveLength(2);
        expect(mockSkillsApi.list).toHaveBeenCalledWith({ scope: 'all' });
    });

    test('skill_list_visible (with agentId) resolves director sub-agent', async () => {
        mockSkillsApi.list.mockResolvedValue([]);
        const profile = {
            skills: { visible: ['*'], deny: [] },
            subAgents: [{ id: 'memory_curator', skills: { visible: ['mem-skill'], deny: [] } }],
        };
        const out = await runSkillIterStudioTool(
            { name: 'skill_list_visible', args: { agentId: 'memory_curator' } },
            { getWorkingProfile: () => profile },
        );
        expect(out.ok).toBe(true);
        expect(out.result.agentLevel).toEqual({ visible: ['mem-skill'], deny: [] });
    });

    test('skill_list_visible errors when agent not found', async () => {
        mockSkillsApi.list.mockResolvedValue([]);
        const out = await runSkillIterStudioTool(
            { name: 'skill_list_visible', args: { agentId: 'ghost' } },
            { getWorkingProfile: () => ({ subAgents: [] }) },
        );
        expect(out.ok).toBe(false);
        expect(out.error).toMatch(/agent not found/);
    });

    test('skill_inspect returns frontmatter + fileTree + sizeBytes', async () => {
        mockSkillsApi.list.mockResolvedValue([
            { name: 'foo', description: 'the foo skill', scope: { kind: 'global' }, metadata: { tags: ['x'] } },
        ]);
        mockSkillsApi.get.mockImplementation(async (n) => ({
            name: n,
            description: 'the foo skill',
            scope: { kind: 'global' },
            metadata: { tags: ['x'] },
        }));
        mockSkillsApi.listFiles.mockResolvedValue({
            files: [
                { path: 'SKILL.md', size: 100, isBinary: false },
                { path: 'helpers.md', size: 250, isBinary: false },
            ],
        });
        const out = await runSkillIterStudioTool(
            { name: 'skill_inspect', args: { name: 'foo' } },
            { getWorkingProfile: () => ({}) },
        );
        expect(out.ok).toBe(true);
        expect(out.result.frontmatter.name).toBe('foo');
        expect(out.result.frontmatter.description).toBe('the foo skill');
        expect(out.result.frontmatter.tags).toEqual(['x']);
        expect(out.result.fileTree).toHaveLength(2);
        expect(out.result.sizeBytes).toBe(350);
    });

    test('skill_read_content wraps skillsApi.readFile', async () => {
        mockSkillsApi.readFile.mockResolvedValue({ content: 'body', totalLines: 1, truncated: false });
        const out = await runSkillIterStudioTool(
            { name: 'skill_read_content', args: { name: 'foo', path: 'helpers.md', offset: 1, limit: 50 } },
            { getWorkingProfile: () => ({}) },
        );
        expect(out.ok).toBe(true);
        expect(mockSkillsApi.readFile).toHaveBeenCalledWith({
            scope: { kind: 'global' },
            name: 'foo',
            path: 'helpers.md',
            offset: 1,
            limit: 50,
        });
    });

    test('skill_search_content wraps skillsApi.search', async () => {
        mockSkillsApi.search.mockResolvedValue({ hits: [] });
        const out = await runSkillIterStudioTool(
            { name: 'skill_search_content', args: { name: 'foo', query: 'bar' } },
            { getWorkingProfile: () => ({}) },
        );
        expect(out.ok).toBe(true);
        expect(mockSkillsApi.search).toHaveBeenCalledWith({
            scope: { kind: 'global' },
            name: 'foo',
            query: 'bar',
        });
    });

    test('skill_search_content errors without query', async () => {
        const out = await runSkillIterStudioTool(
            { name: 'skill_search_content', args: { name: 'foo' } },
            { getWorkingProfile: () => ({}) },
        );
        expect(out.ok).toBe(false);
        expect(out.error).toMatch(/query/);
    });
});

// ── Authoring ───────────────────────────────────────────────────────────

describe('runSkillIterStudioTool — authoring', () => {
    test('skill_create wraps frontmatter around body and installs', async () => {
        mockSkillsApi.install.mockResolvedValue({ installed: ['new-skill'] });
        const out = await runSkillIterStudioTool(
            { name: 'skill_create', args: { name: 'new-skill', description: 'does X', body: '# X\n\nrules.' } },
            { getWorkingProfile: () => ({}) },
        );
        expect(out.ok).toBe(true);
        expect(mockSkillsApi.install).toHaveBeenCalledTimes(1);
        const callArg = mockSkillsApi.install.mock.calls[0][0];
        expect(callArg.scope).toEqual({ kind: 'global' });
        expect(callArg.payload.files[0].path).toBe('SKILL.md');
        expect(callArg.payload.files[0].content).toMatch(/^---\nname: new-skill\ndescription: does X\n---\n/);
        expect(callArg.payload.files[0].content).toMatch(/# X/);
    });

    test('skill_create attaches extra files (skipping SKILL.md duplicates)', async () => {
        mockSkillsApi.install.mockResolvedValue({ installed: ['multi'] });
        await runSkillIterStudioTool(
            {
                name: 'skill_create',
                args: {
                    name: 'multi', description: 'd', body: 'b',
                    files: [
                        { path: 'helpers.md', encoding: 'utf8', content: 'helpers' },
                        { path: 'SKILL.md', encoding: 'utf8', content: 'should be skipped' },
                        { path: 'logo.png', encoding: 'base64', content: 'aGVsbG8=' },
                    ],
                },
            },
            { getWorkingProfile: () => ({}) },
        );
        const callArg = mockSkillsApi.install.mock.calls[0][0];
        expect(callArg.payload.files.map(f => f.path)).toEqual(['SKILL.md', 'helpers.md', 'logo.png']);
        expect(callArg.payload.files[2].encoding).toBe('base64');
    });

    test('skill_update_content wraps skillsApi.writeFile', async () => {
        mockSkillsApi.writeFile.mockResolvedValue({ ok: true, sha256: 'x' });
        await runSkillIterStudioTool(
            { name: 'skill_update_content', args: { name: 'foo', path: 'SKILL.md', content: 'new', expectedSha256: 'abc' } },
            { getWorkingProfile: () => ({}) },
        );
        expect(mockSkillsApi.writeFile).toHaveBeenCalledWith({
            scope: { kind: 'global' },
            name: 'foo',
            path: 'SKILL.md',
            content: 'new',
            expectedSha256: 'abc',
        });
    });

    test('skill_edit_content rejects empty oldString', async () => {
        const out = await runSkillIterStudioTool(
            { name: 'skill_edit_content', args: { name: 'foo', path: 'SKILL.md', oldString: '', newString: 'x' } },
            { getWorkingProfile: () => ({}) },
        );
        expect(out.ok).toBe(false);
        expect(out.error).toMatch(/oldString/);
    });

    test('skill_edit_content wraps skillsApi.editFile', async () => {
        mockSkillsApi.editFile.mockResolvedValue({ ok: true });
        await runSkillIterStudioTool(
            { name: 'skill_edit_content', args: { name: 'foo', path: 'SKILL.md', oldString: 'a', newString: 'b', replaceAll: true } },
            { getWorkingProfile: () => ({}) },
        );
        expect(mockSkillsApi.editFile).toHaveBeenCalledWith({
            scope: { kind: 'global' },
            name: 'foo',
            path: 'SKILL.md',
            oldString: 'a',
            newString: 'b',
            replaceAll: true,
        });
    });

    test('skill_update_frontmatter reads, merges, writes', async () => {
        mockSkillsApi.readFile.mockResolvedValue(
            '---\nname: foo\ndescription: old\ntags:\n  - one\n---\nbody text\n',
        );
        mockSkillsApi.writeFile.mockResolvedValue({ ok: true });
        const out = await runSkillIterStudioTool(
            { name: 'skill_update_frontmatter', args: { name: 'foo', patch: { description: 'new', tags: ['two'] } } },
            { getWorkingProfile: () => ({}) },
        );
        expect(out.ok).toBe(true);
        const writeArg = mockSkillsApi.writeFile.mock.calls[0][0];
        expect(writeArg.content).toContain('description: new');
        expect(writeArg.content).toContain('body text');
        expect(writeArg.content).not.toContain('old');
    });

    test('skill_rename wraps skillsApi.rename', async () => {
        mockSkillsApi.rename.mockResolvedValue({ ok: true });
        await runSkillIterStudioTool(
            { name: 'skill_rename', args: { fromName: 'old', toName: 'new' } },
            { getWorkingProfile: () => ({}) },
        );
        expect(mockSkillsApi.rename).toHaveBeenCalledWith({ kind: 'global' }, 'old', 'new');
    });

    test('skill_change_scope wraps skillsApi.moveScope', async () => {
        mockSkillsApi.moveScope.mockResolvedValue({ ok: true });
        await runSkillIterStudioTool(
            {
                name: 'skill_change_scope',
                args: {
                    name: 'foo',
                    fromScope: { kind: 'global' },
                    toScope: { kind: 'character', characterFile: 'alice.png' },
                },
            },
            { getWorkingProfile: () => ({}) },
        );
        expect(mockSkillsApi.moveScope).toHaveBeenCalledWith(
            'foo',
            { kind: 'global' },
            { kind: 'character', characterFile: 'alice.png' },
        );
    });

    test('skill_delete wraps skillsApi.delete', async () => {
        mockSkillsApi.delete.mockResolvedValue({ ok: true });
        await runSkillIterStudioTool(
            { name: 'skill_delete', args: { name: 'foo' } },
            { getWorkingProfile: () => ({}) },
        );
        expect(mockSkillsApi.delete).toHaveBeenCalledWith({ kind: 'global' }, 'foo');
    });
});

// ── Policy binding ──────────────────────────────────────────────────────

describe('runSkillIterStudioTool — policy binding', () => {
    test('skill_bind_to_agent adds skill to sub-agent visible + emits pendingEdit', async () => {
        const profile = {
            mainAgent: { systemPrompt: 'x' },
            subAgents: [{ id: 'memory_curator', skills: { visible: [], deny: [] } }],
        };
        const out = await runSkillIterStudioTool(
            { name: 'skill_bind_to_agent', args: { agentId: 'memory_curator', skillName: 'new-skill', list: 'visible' } },
            { getWorkingProfile: () => profile },
        );
        expect(out.ok).toBe(true);
        expect(out.result.skills.visible).toEqual(['new-skill']);
        expect(out.pendingEdit.op).toBe('set');
        expect(out.pendingEdit.path).toBe('');
        // Original profile must NOT be mutated (clone).
        expect(profile.subAgents[0].skills.visible).toEqual([]);
        // newValue MUST contain the mutation.
        expect(out.pendingEdit.newValue.subAgents[0].skills.visible).toEqual(['new-skill']);
    });

    test('skill_bind_to_agent rejects unknown list value', async () => {
        const profile = { subAgents: [{ id: 'a', skills: { visible: [], deny: [] } }] };
        const out = await runSkillIterStudioTool(
            { name: 'skill_bind_to_agent', args: { agentId: 'a', skillName: 's', list: 'blocked' } },
            { getWorkingProfile: () => profile },
        );
        expect(out.ok).toBe(false);
        expect(out.error).toMatch(/visible.*deny|list/);
    });

    test('skill_bind_to_agent is idempotent (no duplicate skill name)', async () => {
        const profile = { subAgents: [{ id: 'a', skills: { visible: ['existing'], deny: [] } }] };
        const out = await runSkillIterStudioTool(
            { name: 'skill_bind_to_agent', args: { agentId: 'a', skillName: 'existing', list: 'visible' } },
            { getWorkingProfile: () => profile },
        );
        expect(out.ok).toBe(true);
        expect(out.result.skills.visible).toEqual(['existing']);
    });

    test('skill_unbind_from_agent removes skill + emits pendingEdit', async () => {
        const profile = { subAgents: [{ id: 'a', skills: { visible: ['old', 'keep'], deny: [] } }] };
        const out = await runSkillIterStudioTool(
            { name: 'skill_unbind_from_agent', args: { agentId: 'a', skillName: 'old', list: 'visible' } },
            { getWorkingProfile: () => profile },
        );
        expect(out.ok).toBe(true);
        expect(out.result.skills.visible).toEqual(['keep']);
        expect(out.pendingEdit.newValue.subAgents[0].skills.visible).toEqual(['keep']);
    });

    test('skill_unbind_from_agent is a no-op when skill not present', async () => {
        const profile = { subAgents: [{ id: 'a', skills: { visible: ['x'], deny: [] } }] };
        const out = await runSkillIterStudioTool(
            { name: 'skill_unbind_from_agent', args: { agentId: 'a', skillName: 'never-bound', list: 'visible' } },
            { getWorkingProfile: () => profile },
        );
        expect(out.ok).toBe(true);
        expect(out.result.skills.visible).toEqual(['x']);
    });

    test('skill_set_mode_defaults replaces visible + deny on the profile', async () => {
        const profile = { skills: { visible: ['*'], deny: [] } };
        const out = await runSkillIterStudioTool(
            { name: 'skill_set_mode_defaults', args: { visible: ['a', 'b'], deny: ['c'] } },
            { getWorkingProfile: () => profile },
        );
        expect(out.ok).toBe(true);
        expect(out.result.skills).toEqual({ visible: ['a', 'b'], deny: ['c'] });
        expect(out.pendingEdit.newValue.skills).toEqual({ visible: ['a', 'b'], deny: ['c'] });
    });

    test('skill_bind_to_agent resolves agenda agent (map keyed by id)', async () => {
        const profile = {
            skills: { visible: ['*'], deny: [] },
            agents: {
                writer: { skills: { visible: [], deny: [] } },
                editor: { skills: { visible: [], deny: [] } },
            },
        };
        const out = await runSkillIterStudioTool(
            { name: 'skill_bind_to_agent', args: { agentId: 'writer', skillName: 'voice', list: 'visible' } },
            { getWorkingProfile: () => profile },
        );
        expect(out.ok).toBe(true);
        expect(out.pendingEdit.newValue.agents.writer.skills.visible).toEqual(['voice']);
    });

    test('skill_bind_to_agent resolves director main agent', async () => {
        const profile = { mainAgent: { systemPrompt: 'x', skills: { visible: [], deny: [] } } };
        const out = await runSkillIterStudioTool(
            { name: 'skill_bind_to_agent', args: { agentId: 'main', skillName: 'foo', list: 'visible' } },
            { getWorkingProfile: () => profile },
        );
        expect(out.ok).toBe(true);
        expect(out.pendingEdit.newValue.mainAgent.skills.visible).toEqual(['foo']);
    });
});

// ── Migration helpers ───────────────────────────────────────────────────

describe('runSkillIterStudioTool — migration helpers', () => {
    test('skill_extract_from_text creates a skill verbatim from sourceText', async () => {
        mockSkillsApi.install.mockResolvedValue({ installed: ['extracted-rules'] });
        const sourceText = 'IMPORTANT RULES:\n1. Never break character.\n2. Always preserve voice.\n';
        await runSkillIterStudioTool(
            {
                name: 'skill_extract_from_text',
                args: {
                    sourceText,
                    suggestedName: 'extracted-rules',
                    description: 'Extracted from main systemPrompt',
                },
            },
            { getWorkingProfile: () => ({}) },
        );
        expect(mockSkillsApi.install).toHaveBeenCalledTimes(1);
        const installCallArg = mockSkillsApi.install.mock.calls[0][0];
        // Body is verbatim — no paraphrasing.
        expect(installCallArg.payload.files[0].content).toContain('IMPORTANT RULES:');
        expect(installCallArg.payload.files[0].content).toContain('1. Never break character.');
        expect(installCallArg.payload.files[0].content).toContain('2. Always preserve voice.');
    });

    test('skill_replace_in_systemprompt splices out ranges and inserts replacement', async () => {
        const profile = {
            mainAgent: {
                systemPrompt: 'BEFORE\nMIDDLE BLOCK TO REMOVE\nAFTER',
                skills: { visible: [], deny: [] },
            },
        };
        const orig = profile.mainAgent.systemPrompt;
        const removeStart = orig.indexOf('MIDDLE');
        const removeEnd = removeStart + 'MIDDLE BLOCK TO REMOVE'.length;
        const out = await runSkillIterStudioTool(
            {
                name: 'skill_replace_in_systemprompt',
                args: {
                    agentId: 'main',
                    removeRanges: [[removeStart, removeEnd]],
                    insertText: '(see skill: extracted-rules)',
                },
            },
            { getWorkingProfile: () => profile },
        );
        expect(out.ok).toBe(true);
        const newPrompt = out.pendingEdit.newValue.mainAgent.systemPrompt;
        expect(newPrompt).toContain('(see skill: extracted-rules)');
        expect(newPrompt).not.toContain('MIDDLE BLOCK TO REMOVE');
        // Original untouched.
        expect(profile.mainAgent.systemPrompt).toBe(orig);
    });

    test('skill_replace_in_systemprompt rejects out-of-bounds range', async () => {
        const profile = {
            mainAgent: { systemPrompt: 'short', skills: { visible: [], deny: [] } },
        };
        const out = await runSkillIterStudioTool(
            {
                name: 'skill_replace_in_systemprompt',
                args: { agentId: 'main', removeRanges: [[100, 200]], insertText: 'x' },
            },
            { getWorkingProfile: () => profile },
        );
        expect(out.ok).toBe(false);
    });
});

// ── Dispatcher safety ───────────────────────────────────────────────────

describe('runSkillIterStudioTool — dispatcher', () => {
    test('returns error for unknown tool name', async () => {
        const out = await runSkillIterStudioTool(
            { name: 'definitely_not_a_tool', args: {} },
            { getWorkingProfile: () => ({}) },
        );
        expect(out.ok).toBe(false);
        expect(out.error).toMatch(/not a skill iter-studio tool/);
    });

    test('caught error becomes ok:false (no throws to caller)', async () => {
        mockSkillsApi.readFile.mockRejectedValue(new Error('disk gone'));
        const out = await runSkillIterStudioTool(
            { name: 'skill_read_content', args: { name: 'foo' } },
            { getWorkingProfile: () => ({}) },
        );
        expect(out.ok).toBe(false);
        expect(out.error).toMatch(/disk gone/);
    });
});

// ── Pure helpers ────────────────────────────────────────────────────────

describe('applyFrontmatterPatch', () => {
    test('assigns and deletes keys, preserves body', () => {
        const input = '---\nname: foo\ndescription: old\nstale: yes\n---\n# Heading\n\nbody text\n';
        const out = applyFrontmatterPatch(input, { description: 'new', stale: null, added: 'value' });
        expect(out).toContain('description: new');
        expect(out).toContain('added: value');
        expect(out).not.toContain('stale: yes');
        expect(out).toContain('# Heading');
        expect(out).toContain('body text');
    });

    test('rejects content without opening ---', () => {
        expect(() => applyFrontmatterPatch('no frontmatter', { x: 1 })).toThrow(/frontmatter/);
    });

    test('rejects unclosed frontmatter', () => {
        expect(() => applyFrontmatterPatch('---\nname: foo\nbody but no close', { x: 1 })).toThrow(/closed/);
    });
});

// ── System prompt augmentation ──────────────────────────────────────────

describe('detectLongSystemPromptAgents', () => {
    test('finds main + sub-agents above the threshold', () => {
        const long = 'x'.repeat(LONG_PROMPT_HEURISTIC_CHARS + 1);
        const profile = {
            mainAgent: { systemPrompt: long },
            subAgents: [
                { id: 'long_one', systemPrompt: long },
                { id: 'short_one', systemPrompt: 'tiny' },
            ],
        };
        const out = detectLongSystemPromptAgents(profile);
        expect(out.map(x => x.agentId).sort()).toEqual(['long_one', 'main']);
    });

    test('agenda + spec presets included', () => {
        const long = 'x'.repeat(LONG_PROMPT_HEURISTIC_CHARS + 1);
        const profile = {
            agents: { worker: { systemPrompt: long } },
            presets: { specPreset: { systemPrompt: long } },
        };
        const out = detectLongSystemPromptAgents(profile);
        expect(out.map(x => x.agentId).sort()).toEqual(['specPreset', 'worker']);
    });

    test('loop flat system_prompt picked up', () => {
        const long = 'x'.repeat(LONG_PROMPT_HEURISTIC_CHARS + 1);
        const profile = { system_prompt: long };
        const out = detectLongSystemPromptAgents(profile);
        expect(out).toHaveLength(1);
        expect(out[0].agentId).toBe('loop');
    });
});

describe('formatSkillsAugmentation', () => {
    test('includes discipline rules + intensity warning', () => {
        const text = formatSkillsAugmentation(
            [{ name: 'alpha', description: 'a' }],
            [{ agentId: 'main', length: 2000 }],
        );
        expect(text).toMatch(/Discipline for skill manipulation/);
        expect(text).toMatch(/skill_create/);
        expect(text).toMatch(/skill_extract_from_text/);
        expect(text).toMatch(/skill_replace_in_systemprompt/);
        expect(text).toMatch(/VERBATIM/);
        expect(text).toMatch(/paraphrase/);
    });

    test('lists visible skills as `name: description`', () => {
        const text = formatSkillsAugmentation(
            [{ name: 'alpha', description: 'desc-A' }, { name: 'beta', description: 'desc-B' }],
            [],
        );
        expect(text).toMatch(/- alpha: desc-A/);
        expect(text).toMatch(/- beta: desc-B/);
    });

    test('shows "(none installed)" when catalog empty', () => {
        const text = formatSkillsAugmentation([], [{ agentId: 'main', length: 2000 }]);
        expect(text).toMatch(/none installed/);
    });

    test('mentions agentId + length when long systemPrompts detected', () => {
        const text = formatSkillsAugmentation([], [{ agentId: 'main', length: 2500 }]);
        expect(text).toMatch(/main \(2500 chars\)/);
    });
});

describe('augmentIterStudioPromptWithSkills', () => {
    test('passes through base prompt when nothing to extract and no skills', async () => {
        mockResolve.mockResolvedValue([]);
        const base = 'BASE PROMPT';
        const out = await augmentIterStudioPromptWithSkills(base, { mainAgent: { systemPrompt: 'short' } }, {});
        expect(out).toBe(base);
    });

    test('appends augmentation when long systemPrompt present', async () => {
        mockResolve.mockResolvedValue([]);
        const long = 'x'.repeat(LONG_PROMPT_HEURISTIC_CHARS + 1);
        const out = await augmentIterStudioPromptWithSkills('BASE', { mainAgent: { systemPrompt: long } }, {});
        expect(out).toMatch(/^BASE/);
        expect(out).toMatch(/Discipline for skill manipulation/);
    });

    test('appends augmentation when visible skills present (even if no long prompts)', async () => {
        mockResolve.mockResolvedValue([{ name: 'foo', description: 'd' }]);
        const out = await augmentIterStudioPromptWithSkills('BASE', { mainAgent: { systemPrompt: 'short' } }, {});
        expect(out).toMatch(/- foo: d/);
    });

    test('resolver failure falls back to empty catalog (does not throw)', async () => {
        mockResolve.mockRejectedValue(new Error('inventory down'));
        const long = 'x'.repeat(LONG_PROMPT_HEURISTIC_CHARS + 1);
        // Long prompt triggers augmentation; resolver fails; should still
        // produce an augmented prompt with the discipline + "(none installed)".
        const out = await augmentIterStudioPromptWithSkills('BASE', { mainAgent: { systemPrompt: long } }, {});
        expect(out).toMatch(/none installed/);
    });

    test('uses opts.resolveVisibleSkills when provided (test seam)', async () => {
        const customResolve = jest.fn(async () => [{ name: 'custom', description: 'd' }]);
        const out = await augmentIterStudioPromptWithSkills(
            'BASE',
            { mainAgent: { systemPrompt: 'short' } },
            {},
            { resolveVisibleSkills: customResolve },
        );
        expect(customResolve).toHaveBeenCalled();
        expect(out).toMatch(/- custom: d/);
    });
});
