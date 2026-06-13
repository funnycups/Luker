// Case #78 — Multi-skill visible: director sees N skills; sub-agent inherits
//
// Spec:
//   - Director's profile has 3+ visible skills (modeProfile.skills.visible
//     is a list, not just '*').
//   - Director's main agent prompt's `<available_skills>` block lists all 3.
//   - A dispatched sub-agent (no per-agent skills override → inherits the
//     mode default) sees the same 3.
//
// Source-of-truth: skill-resolution.js — `buildAvailableSkillsBlock`
// renders the catalog block; `resolveAgentVisibleSkills` performs the
// merge. When agentConfig.skills is absent / empty, modeProfile.skills
// is the effective visible list.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import {
    bootstrapCustomBackend,
    appendConnectionProfile,
    markOnboarded,
} from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: ['*ack*'] });
    server = await startServer({ batchKey: 'orchestrator', scenarioId: '78-multi-skill' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

const SKILL_NAMES = ['reef-rotation', 'lantern-protocol', 'salt-mark-history'];

test.describe('#78 — Multi-skill visible: director sees N skills; sub-agent inherits', () => {
    test('mode profile with 3 visible skills → resolver returns all 3 for main agent + each sub-agent that inherits', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        const result = await page.evaluate(async (names) => {
            const mod = await import('/scripts/extensions/orchestrator/skill-resolution.js');
            const ctx = window.SillyTavern.getContext();
            mod.invalidateSkillInventory();
            const orig = ctx.skills.list;

            // Three global-scope skills with the three names.
            ctx.skills.list = async () => names.map(n => ({
                name: n,
                description: `Description for ${n}.`,
                scope: { kind: 'global' },
            }));

            // Mode profile: explicitly visible = the 3 names (not '*').
            const modeProfile = {
                skills: {
                    visible: [...names],
                    deny: [],
                },
            };

            try {
                // Main agent: agentConfig=null → inherits modeProfile.
                const mainVisible = await mod.resolveAgentVisibleSkills({
                    modeProfile,
                    agentConfig: null,
                    runtimeContext: {},
                });

                // Sub-agent 1: agentConfig has no skills field → inherits.
                const sub1Visible = await mod.resolveAgentVisibleSkills({
                    modeProfile,
                    agentConfig: { id: 'sub1', systemPrompt: 'x' },
                    runtimeContext: {},
                });

                // Sub-agent 2: agentConfig.skills.visible = [] → inherits
                // (per resolver doc: empty agent visible means inherit mode).
                const sub2Visible = await mod.resolveAgentVisibleSkills({
                    modeProfile,
                    agentConfig: { skills: { visible: [], deny: [] } },
                    runtimeContext: {},
                });

                // Sub-agent 3: agentConfig.skills.visible = ['+', extra]
                //   → inherits + appends extra (extra isn't in inventory
                //     so it's filtered out; result equals mode default).
                const sub3Visible = await mod.resolveAgentVisibleSkills({
                    modeProfile,
                    agentConfig: { skills: { visible: ['+', 'nonexistent-skill'], deny: [] } },
                    runtimeContext: {},
                });

                const mainBlock = mod.buildAvailableSkillsBlock(mainVisible);
                const sub1Block = mod.buildAvailableSkillsBlock(sub1Visible);

                return {
                    mainNames: mainVisible.map(s => s.name).sort(),
                    sub1Names: sub1Visible.map(s => s.name).sort(),
                    sub2Names: sub2Visible.map(s => s.name).sort(),
                    sub3Names: sub3Visible.map(s => s.name).sort(),
                    mainBlock,
                    sub1Block,
                };
            } finally {
                ctx.skills.list = orig;
                mod.invalidateSkillInventory();
            }
        }, SKILL_NAMES);

        // All four agent shapes see the same 3 inherited skills.
        const expected = [...SKILL_NAMES].sort();
        expect(result.mainNames).toEqual(expected);
        expect(result.sub1Names).toEqual(expected);
        expect(result.sub2Names).toEqual(expected);
        expect(result.sub3Names).toEqual(expected);

        // The rendered catalog block enumerates all 3 names in both the
        // main-agent and sub-agent variants — proving the catalog is
        // identical, not just the resolved list.
        for (const name of SKILL_NAMES) {
            expect(result.mainBlock).toContain(name);
            expect(result.sub1Block).toContain(name);
        }
        expect(result.mainBlock).toContain('<available_skills>');
        expect(result.mainBlock).toContain('</available_skills>');
        expect(result.sub1Block).toContain('<available_skills>');
        expect(result.sub1Block).toContain('</available_skills>');
    });

    test('agent-level deny adds to mode deny (union); a sub-agent denying one of the 3 visible skills loses just that one', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        const result = await page.evaluate(async (names) => {
            const mod = await import('/scripts/extensions/orchestrator/skill-resolution.js');
            const ctx = window.SillyTavern.getContext();
            mod.invalidateSkillInventory();
            const orig = ctx.skills.list;

            ctx.skills.list = async () => names.map(n => ({
                name: n,
                description: `Description for ${n}.`,
                scope: { kind: 'global' },
            }));

            const modeProfile = {
                skills: { visible: [...names], deny: [] },
            };

            try {
                const subWithDeny = await mod.resolveAgentVisibleSkills({
                    modeProfile,
                    agentConfig: { skills: { visible: [], deny: [names[1]] } },
                    runtimeContext: {},
                });
                return { subNames: subWithDeny.map(s => s.name).sort() };
            } finally {
                ctx.skills.list = orig;
                mod.invalidateSkillInventory();
            }
        }, SKILL_NAMES);

        const expected = SKILL_NAMES.filter(n => n !== SKILL_NAMES[1]).sort();
        expect(result.subNames).toEqual(expected);
    });

    test.fixme('live director dispatch: main agent prompt + each dispatched sub-agent payload both contain the same `<available_skills>` block', async () => {
        // Requires a real director dispatch + the mock LLM (or real LLM)
        // producing the dispatch_subagent tool call so we can grep the
        // sub-agent request body in mock.requests. Blocked by the same
        // director-runtime infrastructure gap as cases #67 / #68 / #74.
    });
});
