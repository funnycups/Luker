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
//
// What unlocked the runtime-driven leg:
//   The director-aware mock LLM router (`scriptDirectorRun`) lets us
//   drive a real director turn with a sub-agent dispatch. We stub
//   `ctx.skills.list` to return 3 named test skills + invalidate the
//   resolver cache, then send the turn. The main-agent request and
//   the sub-agent request both flow through `resolveAgentVisibleSkills`
//   → `buildAvailableSkillsBlock`, and we assert the catalog appears
//   in both request bodies captured by mock.requests.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import {
    bootstrapCustomBackend,
    appendConnectionProfile,
    markOnboarded,
} from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    installMinimalDirectorProfile,
} from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({});
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

    test('live director dispatch: main agent prompt + dispatched sub-agent payload both contain the same `<available_skills>` block', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // Install a minimal profile that sets the mode-level visible list
        // to our 3 test skills and configures one sub-agent that inherits.
        await installMinimalDirectorProfile(page, {
            mainSystemPrompt: 'Test director.',
            subAgents: [
                { id: 'scout', description: 'noop scout', systemPrompt: 'You are scout.' },
            ],
        });

        // Override the profile's mode-level skills + main-agent + sub-agent
        // skills to all inherit the 3 SKILL_NAMES. installMinimalDirectorProfile
        // sets them to empty lists by default for a clean baseline; we
        // explicitly opt into the 3-skill catalog here.
        await page.evaluate(async (names) => {
            const ctx = window.SillyTavern.getContext();
            const settings = ctx.extensionSettings.orchestrator;
            const presetLib = await import('/scripts/extensions/orchestrator/preset-library.js');
            const dirDefaults = await import('/scripts/extensions/orchestrator/director-defaults.js');
            const current = presetLib.getActivePreset(settings, 'director', { scope: 'global', context: ctx });
            const next = dirDefaults.sanitizeDirectorProfile({
                ...current,
                skills: { visible: [...names], deny: [] },
                mainAgent: {
                    ...(current?.mainAgent || {}),
                    skills: { visible: ['+'], deny: [] }, // inherit mode
                },
                subAgents: (current?.subAgents || []).map(a => ({
                    ...a,
                    skills: { visible: ['+'], deny: [] }, // inherit mode
                })),
            });
            presetLib.writeActivePreset(settings, 'director', 'global', next);
            try { await ctx.saveSettings?.(0, { directSave: true }); } catch (_) {}
        }, SKILL_NAMES);

        // Install the skill inventory stub + invalidate the cache so the
        // director's resolver picks up our test skills on this turn.
        await page.evaluate(async (names) => {
            const ctx = window.SillyTavern.getContext();
            const mod = await import('/scripts/extensions/orchestrator/skill-resolution.js');
            mod.invalidateSkillInventory();
            window.__test78OrigSkillsList = ctx.skills.list;
            ctx.skills.list = async () => names.map(n => ({
                name: n,
                description: `Description for ${n}.`,
                scope: { kind: 'global' },
            }));
        }, SKILL_NAMES);

        const requestStartIdx = mock.requests.length;
        mock.scriptDirectorRun({
            route: ({ role, turn }) => {
                if (role === 'director-main' && turn === 0) {
                    return { tool: 'dispatch_subagent', arguments: { subagentId: 'scout', task: 'noop' } };
                }
                if (role === 'subagent') {
                    return { text: 'noop' };
                }
                if (role === 'director-main' && turn === 1) {
                    return { tool: 'await_subagents', arguments: { handles: ['subagent-0'] } };
                }
                if (role === 'director-main' && turn === 2) {
                    return { tool: 'write_message', arguments: { text: 'Done.', mode: 'replace' } };
                }
                if (role === 'director-main' && turn === 3) {
                    return { tool: 'finalize', arguments: {} };
                }
                return null;
            },
        });

        await sendMessageAndAwaitReply(page, '*She nods.* "Begin."', { timeoutMs: 60_000 });

        // Restore the skills.list stub so we don't pollute other tests.
        await page.evaluate(async () => {
            const ctx = window.SillyTavern.getContext();
            if (window.__test78OrigSkillsList) {
                ctx.skills.list = window.__test78OrigSkillsList;
                window.__test78OrigSkillsList = null;
            }
        });

        const turnRequests = mock.requests.slice(requestStartIdx).filter(r => /chat\/completions/.test(r.url));
        const mainRequests = [];
        const subAgentRequests = [];
        for (const r of turnRequests) {
            const body = r.body || {};
            const msgs = Array.isArray(body.messages) ? body.messages : [];
            const toolDefs = Array.isArray(body.tools) ? body.tools : [];
            const toolNames = toolDefs.map(t => t?.function?.name || '');
            const sysContents = msgs
                .filter(m => m && m.role === 'system')
                .map(m => typeof m.content === 'string' ? m.content : '');
            const isSubagent = sysContents.some(c => c.includes('<orchestration_role>'));
            const isMain = !isSubagent && toolNames.some(n => ['write_message', 'finalize', 'dispatch_subagent'].includes(n));
            if (isMain) mainRequests.push(r);
            else if (isSubagent) subAgentRequests.push(r);
        }

        expect(mainRequests.length, 'main-agent requests fired').toBeGreaterThan(0);
        expect(subAgentRequests.length, 'sub-agent requests fired').toBeGreaterThan(0);

        // Every main + sub request body should carry the <available_skills>
        // wrapper. We don't assert all 3 names are listed in EVERY request
        // because the director runtime constructs the block once per agent
        // and includes it as a system message; we assert that the wrapper
        // is present (proving the catalog block was injected) and that
        // each of the 3 names appears.
        const reqHasCatalog = (req) => {
            const body = JSON.stringify(req.body || {});
            if (!body.includes('<available_skills>')) return false;
            for (const name of SKILL_NAMES) {
                if (!body.includes(name)) return false;
            }
            return true;
        };
        const mainAllHaveCatalog = mainRequests.every(reqHasCatalog);
        const subAllHaveCatalog = subAgentRequests.every(reqHasCatalog);

        expect(mainAllHaveCatalog, 'every main-agent request carries the 3-skill <available_skills> catalog').toBe(true);
        expect(subAllHaveCatalog, 'every sub-agent request carries the 3-skill <available_skills> catalog').toBe(true);
    });
});
