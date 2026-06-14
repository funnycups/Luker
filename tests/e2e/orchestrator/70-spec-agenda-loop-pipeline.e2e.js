// Case #70 — Spec / agenda / loop: three independent executionMode values
//
// Original brief (verbatim):
//   "Run a spec phase (mock scripted) → its output drives agenda config
//    → agenda dispatches loop iterations per its plan → loop reaches a
//    documented exit condition. Verify the data flow at each handoff."
//
// Why this rewrite (audit dated 2026-06-14):
//   The premise is wrong. spec / agenda / loop are three alternative
//   `executionMode` values, NOT a runtime pipeline. The orchestrator
//   dispatcher (`main.js::runOrchestration`) reads a single executionMode
//   and routes to ONE of `runSpecOrchestration` / `runAgendaOrchestration`
//   / `runLoopOrchestration` per turn. There is no chained execution
//   path, no slash command that runs all three, and no UI affordance to
//   feed one mode's output into another's config.
//
//   Director mode is a fourth alternative routed through the
//   GENERATE_TAKEOVER_DISPATCH hook; single mode is a fifth (synthesized
//   one-stage one-node spec). Same exclusivity holds.
//
// What we test instead — the actual contract for "the three modes":
//   Each mode can be selected independently and produces its own
//   mode-specific observable output.
//
//   - spec  → a stages-and-nodes spec document
//   - agenda → a planner + agents map (sequenced plan)
//   - loop  → a single-agent tool-call loop iterating to a finalize
//             tool exit
//
//   For spec/agenda we drive the dispatcher's mode-selection path
//   (`getEffectiveProfile(context)` after switching `executionMode`) and
//   assert the mode-specific shape. For loop we additionally invoke
//   `runLoopOrchestration` with injected `deps.sendLlm` to drive the
//   loop body to a real terminal state — that runtime is the only one
//   exposing test-injectable deps.

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
    mock = await startMockLLM({ scriptedReplies: ['*planner output*'] });
    server = await startServer({ batchKey: 'orchestrator', scenarioId: '70-three-modes' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#70 — Spec / agenda / loop are three independent executionMode values', () => {
    test('switching executionMode to "spec" yields a spec-shaped effective profile (stages + nodes)', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        const result = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const settings = ctx.extensionSettings.orchestrator;

            // Switch to spec mode via the user-facing setting.
            settings.executionMode = 'spec';
            // Make sure single-agent shortcut is OFF so dispatch falls
            // through to the regular spec branch.
            settings.singleAgentModeEnabled = false;

            const main = await import('/scripts/extensions/orchestrator/main.js');
            const profile = main.getEffectiveProfile(ctx);

            return {
                mode: profile?.mode,
                hasSpec: Boolean(profile?.spec),
                stageCount: Array.isArray(profile?.spec?.stages) ? profile.spec.stages.length : 0,
                firstStageId: profile?.spec?.stages?.[0]?.id || null,
                firstStageNodeCount: Array.isArray(profile?.spec?.stages?.[0]?.nodes)
                    ? profile.spec.stages[0].nodes.length
                    : 0,
                hasPresets: profile?.presets && typeof profile.presets === 'object',
                // Negative shape — these are agenda / loop fields and MUST be
                // absent on a spec-mode profile.
                hasAgendaPlanner: Boolean(profile?.planner),
                hasAgendaAgents: Boolean(profile?.agents),
                hasLoopMaxRounds: Object.prototype.hasOwnProperty.call(profile || {}, 'max_rounds'),
                hasLoopSystemPrompt: Object.prototype.hasOwnProperty.call(profile || {}, 'system_prompt'),
            };
        });

        expect(result.mode, 'spec mode dispatch returns mode: "spec"').toBe('spec');
        expect(result.hasSpec, 'spec profile carries a `spec` field').toBe(true);
        expect(result.stageCount, 'factory-seeded spec has at least one stage').toBeGreaterThan(0);
        expect(result.firstStageId, 'first stage has a non-empty id').toBeTruthy();
        expect(result.firstStageNodeCount, 'first stage has at least one node').toBeGreaterThan(0);
        expect(result.hasPresets, 'spec profile carries the `presets` map').toBe(true);

        // Exclusivity: a spec-mode profile must NOT carry agenda or loop
        // top-level shape — otherwise the dispatcher couldn't disambiguate
        // and downstream sanitizers would see ambiguous input.
        expect(result.hasAgendaPlanner, 'spec profile has no agenda `planner`').toBe(false);
        expect(result.hasAgendaAgents, 'spec profile has no agenda `agents` map').toBe(false);
        expect(result.hasLoopMaxRounds, 'spec profile has no loop `max_rounds`').toBe(false);
        expect(result.hasLoopSystemPrompt, 'spec profile has no loop `system_prompt`').toBe(false);
    });

    test('switching executionMode to "agenda" yields an agenda-shaped effective profile (planner + agents + finalAgentId + limits)', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        const result = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const settings = ctx.extensionSettings.orchestrator;

            settings.executionMode = 'agenda';
            settings.singleAgentModeEnabled = false;

            const main = await import('/scripts/extensions/orchestrator/main.js');
            const profile = main.getEffectiveProfile(ctx);

            return {
                mode: profile?.mode,
                hasPlanner: Boolean(profile?.planner),
                hasPlannerSystemPrompt: typeof profile?.planner?.systemPrompt === 'string'
                    && profile.planner.systemPrompt.length > 0,
                hasAgents: profile?.agents && typeof profile.agents === 'object',
                agentIds: profile?.agents && typeof profile.agents === 'object'
                    ? Object.keys(profile.agents)
                    : [],
                finalAgentId: profile?.finalAgentId || null,
                hasLimits: profile?.limits && typeof profile.limits === 'object',
                plannerMaxRounds: profile?.limits?.plannerMaxRounds,
                maxConcurrentAgents: profile?.limits?.maxConcurrentAgents,
                // Negative shape — these are spec / loop fields and MUST be
                // absent on an agenda-mode profile.
                hasSpecStages: Boolean(profile?.spec?.stages),
                hasLoopMaxRounds: Object.prototype.hasOwnProperty.call(profile || {}, 'max_rounds'),
                hasLoopSystemPrompt: Object.prototype.hasOwnProperty.call(profile || {}, 'system_prompt'),
            };
        });

        expect(result.mode, 'agenda mode dispatch returns mode: "agenda"').toBe('agenda');
        expect(result.hasPlanner, 'agenda profile carries a `planner` block').toBe(true);
        expect(result.hasPlannerSystemPrompt, 'planner block has a non-empty systemPrompt').toBe(true);
        expect(result.hasAgents, 'agenda profile carries an `agents` map (object, not array)').toBe(true);
        expect(result.agentIds.length, 'agenda has at least one agent').toBeGreaterThan(0);
        expect(result.finalAgentId, 'agenda has a finalAgentId').toBeTruthy();
        // The finalAgentId must reference an entry in the agents map — that
        // is the sequencing contract (planner schedules other agents, the
        // finalizer reads their outputs and produces final guidance).
        expect(result.agentIds, 'finalAgentId references a real entry in the agents map')
            .toContain(result.finalAgentId);
        expect(result.hasLimits, 'agenda profile carries a `limits` block').toBe(true);
        expect(typeof result.plannerMaxRounds, 'limits.plannerMaxRounds is a number').toBe('number');
        expect(typeof result.maxConcurrentAgents, 'limits.maxConcurrentAgents is a number').toBe('number');

        // Exclusivity.
        expect(result.hasSpecStages, 'agenda profile has no `spec.stages`').toBe(false);
        expect(result.hasLoopMaxRounds, 'agenda profile has no loop `max_rounds`').toBe(false);
        expect(result.hasLoopSystemPrompt, 'agenda profile has no loop `system_prompt`').toBe(false);
    });

    test('switching executionMode to "loop" yields a loop-shaped effective profile (system_prompt + tools + max_rounds), AND runLoopOrchestration iterates the loop body to a finalize-tool exit', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // First — profile-shape check via the dispatcher's mode-selection path.
        const profileInfo = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const settings = ctx.extensionSettings.orchestrator;

            settings.executionMode = 'loop';
            settings.singleAgentModeEnabled = false;

            const main = await import('/scripts/extensions/orchestrator/main.js');
            const profile = main.getEffectiveProfile(ctx);

            return {
                mode: profile?.mode,
                hasSystemPrompt: typeof profile?.system_prompt === 'string'
                    && profile.system_prompt.length > 0,
                hasTools: profile?.tools && typeof profile.tools === 'object',
                finalizeToolForced: profile?.tools?.finalize === true,
                maxRounds: profile?.max_rounds,
                wallClockBudget: profile?.wall_clock_budget_ms,
                // Negative shape.
                hasSpecStages: Boolean(profile?.spec?.stages),
                hasAgendaPlanner: Boolean(profile?.planner),
                hasAgendaAgents: Boolean(profile?.agents),
            };
        });

        expect(profileInfo.mode, 'loop mode dispatch returns mode: "loop"').toBe('loop');
        expect(profileInfo.hasSystemPrompt, 'loop profile carries a non-empty `system_prompt`').toBe(true);
        expect(profileInfo.hasTools, 'loop profile carries a `tools` map').toBe(true);
        expect(profileInfo.finalizeToolForced, 'sanitizer forces `tools.finalize=true`').toBe(true);
        expect(typeof profileInfo.maxRounds, 'loop profile has numeric `max_rounds`').toBe('number');
        expect(profileInfo.maxRounds, 'max_rounds is at least 1').toBeGreaterThanOrEqual(1);
        expect(typeof profileInfo.wallClockBudget, 'loop profile has numeric `wall_clock_budget_ms`').toBe('number');

        // Exclusivity.
        expect(profileInfo.hasSpecStages, 'loop profile has no spec.stages').toBe(false);
        expect(profileInfo.hasAgendaPlanner, 'loop profile has no agenda planner').toBe(false);
        expect(profileInfo.hasAgendaAgents, 'loop profile has no agenda agents').toBe(false);

        // Second — drive the loop body itself to a real terminal state.
        // We inject a fake `sendLlm` so the loop driver doesn't go through
        // the real LLM stack — this exercises the loop body's iteration
        // contract end-to-end without depending on mock-LLM tool-call
        // wiring through the chat-completion adapter.
        const runResult = await page.evaluate(async () => {
            const loopRt = await import('/scripts/extensions/orchestrator/loop-runtime.js');
            const persist = await import('/scripts/extensions/orchestrator/persistence.js');
            const storeMod = await import('/scripts/extensions/orchestrator/run-state/store.js');

            // Make sure no prior run is lingering — production main.js
            // clears between turns, tests do it explicitly.
            storeMod.clearCurrentRun();

            const profile = persist.sanitizeLoopProfile({
                mode: 'loop',
                apiPresetName: '',
                promptPresetName: '',
                system_prompt:
                    'You are the cliff-watch keeper. Trim the lantern and report when the reef is steady.',
                tools: {
                    note: { add: true },
                    chat: { read_range: true, search: true },
                    lorebook: { search: true, get: true },
                    memory: { search: false, list_recent: false, get: false },
                },
                max_rounds: 4,
                wall_clock_budget_ms: 30_000,
            });

            // Scripted LLM responses: round 1 returns a non-finalize tool
            // (note.add) so the loop iterates once more; round 2 returns
            // the finalize tool with the capsule body. The runtime should
            // observe `total_rounds === 2` and `status === 'completed'`.
            const FINALIZE_TEXT =
                'Trim the lantern, mark the salt-mark drifters off the north reef, '
                + 'and report in your next reply that the watch held.';
            let call = 0;
            const sendLlm = async () => {
                call += 1;
                if (call === 1) {
                    return {
                        toolCalls: [{
                            id: 'tc-1',
                            name: 'note',
                            args: { action: 'add', text: 'lantern is steady; reef calm so far' },
                        }],
                        assistantText: '',
                    };
                }
                return {
                    toolCalls: [{
                        id: 'tc-2',
                        name: 'finalize',
                        args: { capsule_text: FINALIZE_TEXT },
                    }],
                    assistantText: '',
                };
            };
            // Non-finalize tools must execute without throwing; we stub
            // them to a permissive shape so the loop driver can move on.
            const executeTool = async (name) => ({ ok: true, name });

            const context = { chat: [], chatId: 'scenario-70-loop' };
            const payload = { signal: new AbortController().signal, coreChat: [] };
            const out = await loopRt.runLoopOrchestration(context, payload, profile, {
                sendLlm,
                executeTool,
            });

            // Drop circular refs (abortFn) before returning to the spec.
            const serializableTrace = out?.runtimeTrace
                ? JSON.parse(JSON.stringify(out.runtimeTrace, (k, v) => (k === 'abortFn' ? undefined : v)))
                : null;

            storeMod.clearCurrentRun();
            return {
                status: out?.status,
                capsule: out?.capsule,
                total_rounds: out?.total_rounds,
                FINALIZE_TEXT,
                traceMode: serializableTrace?.mode,
                eventTypes: Array.isArray(serializableTrace?.events)
                    ? serializableTrace.events.map(e => e.type)
                    : [],
            };
        });

        // Loop body terminated by the finalize tool — the canonical
        // "loop iterates to a documented exit condition" assertion.
        expect(runResult.status, 'loop reached the documented completed exit').toBe('completed');
        expect(runResult.capsule, 'loop emits the finalize capsule body 1:1').toBe(runResult.FINALIZE_TEXT);
        expect(runResult.total_rounds, 'loop iterated twice (one tool round + one finalize)').toBe(2);
        // Trace surface independent of any pipeline coupling.
        expect(runResult.traceMode, 'trace declares its mode as "loop"').toBe('loop');
        expect(runResult.eventTypes, 'trace records run lifecycle events').toEqual(
            expect.arrayContaining(['run_started', 'run_finished']),
        );
    });

    test('the dispatcher routes to a SINGLE runtime per turn — switching executionMode swaps the entire profile shape (no pipeline merge)', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Switch through all three modes and capture the dispatcher's
        // chosen profile shape each time. Each shape's defining field
        // appears in exactly one mode — that is the "alternatives, not
        // pipeline" contract.
        const sweep = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const settings = ctx.extensionSettings.orchestrator;
            settings.singleAgentModeEnabled = false;

            const main = await import('/scripts/extensions/orchestrator/main.js');

            const shapes = {};
            for (const mode of ['spec', 'agenda', 'loop']) {
                settings.executionMode = mode;
                const profile = main.getEffectiveProfile(ctx);
                shapes[mode] = {
                    mode: profile?.mode,
                    hasSpecStages: Array.isArray(profile?.spec?.stages),
                    hasAgendaPlanner: Boolean(profile?.planner),
                    hasLoopSystemPrompt: typeof profile?.system_prompt === 'string'
                        && profile.system_prompt.length > 0,
                };
            }
            return shapes;
        });

        // Spec mode: ONLY spec.stages present.
        expect(sweep.spec.mode).toBe('spec');
        expect(sweep.spec.hasSpecStages).toBe(true);
        expect(sweep.spec.hasAgendaPlanner).toBe(false);
        expect(sweep.spec.hasLoopSystemPrompt).toBe(false);

        // Agenda mode: ONLY planner present.
        expect(sweep.agenda.mode).toBe('agenda');
        expect(sweep.agenda.hasAgendaPlanner).toBe(true);
        expect(sweep.agenda.hasSpecStages).toBe(false);
        expect(sweep.agenda.hasLoopSystemPrompt).toBe(false);

        // Loop mode: ONLY loop system_prompt present.
        expect(sweep.loop.mode).toBe('loop');
        expect(sweep.loop.hasLoopSystemPrompt).toBe(true);
        expect(sweep.loop.hasSpecStages).toBe(false);
        expect(sweep.loop.hasAgendaPlanner).toBe(false);
    });
});
