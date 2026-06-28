// Case #78 — Multi-skill visible: live director dispatch (real e2e portion)
//
// Spec:
//   - Director's profile has 3+ visible skills (modeProfile.skills.visible
//     is a list, not just '*').
//   - Director's main agent prompt's `<available_skills>` block lists all 3.
//   - A dispatched sub-agent (no per-agent skills override → inherits the
//     mode default) sees the same 3.
//
// What stays as e2e (this file):
//   The live director-dispatch case asserts on the HTTP request bodies
//   the production director runtime sends through the mock LLM — that's
//   cross-module (preset library → director-runtime → chat-completion
//   adapter → outbound request) and there is no smaller useful unit
//   boundary.
//
// What moved to Jest (`tests/orchestrator/multi-skill-visible-resolver.test.js`):
//   The two pure resolver tests (visibility / inheritance). Those
//   previously paid the per-spec server-boot cost despite testing
//   stand-alone module contracts.

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

test.describe('#78 — Multi-skill visible: live director dispatch', () => {
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
            const ctx = window.Luker.getContext();
            const settings = ctx.extensionSettings.orchestrator;
            const presetLib = await import('/scripts/extensions/orchestrator/preset-library.js');
            const dirDefaults = await import('/scripts/extensions/orchestrator/director-defaults.js');
            const currentResult = presetLib.getActivePreset(settings, 'director', { scope: 'global', context: ctx });
            const current = (currentResult.ok && currentResult.state) ? currentResult.state : {};
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
            const writeResult = presetLib.writeActivePreset(settings, 'director', 'global', next);
            if (!writeResult.ok) {
                throw new Error(`writeActivePreset failed: ${writeResult.reason}: ${writeResult.hint}`);
            }
            // No saveSettings flush needed — this spec does not restart the
            // server; the in-memory preset write is all the director-runtime
            // reads from on the very next turn.
        }, SKILL_NAMES);

        // Install the skill inventory stub + invalidate the cache so the
        // director's resolver picks up our test skills on this turn.
        await page.evaluate(async (names) => {
            const ctx = window.Luker.getContext();
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
            const ctx = window.Luker.getContext();
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
