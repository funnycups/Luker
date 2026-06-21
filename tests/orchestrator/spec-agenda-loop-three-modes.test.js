// Case #70 — Spec / agenda / loop: three independent executionMode values (ported from e2e).
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
//   Each mode's factory profile (sanitized through the production
//   sanitizer the dispatcher uses at runtime) produces its own
//   mode-specific shape, with mutually-exclusive fields.
//
//   For loop we additionally invoke `runLoopOrchestration` with
//   injected `deps.sendLlm` to drive the loop body to a real terminal
//   state — that runtime is the only one exposing test-injectable deps.
//
// The original e2e file's fourth test (the dispatcher routes to a SINGLE
// runtime per turn) is implicit in tests 1-3: each mode's sanitized
// shape carries the field set unique to that mode. Together with
// `tests/orchestrator/get-effective-profile-presets.test.js` (which
// asserts main.getEffectiveProfile picks the right active preset per
// scope per mode), the dispatcher's mode-selection contract is fully
// covered without spinning a browser.

import { describe, test, expect, jest, beforeAll } from '@jest/globals';

// `agenda-profile.js` transitively imports `connection-manager/profile-resolver.js`
// which pulls in `public/script.js` + `public/scripts/openai.js` + textgen
// settings — those eagerly touch `document` at module load and fail under
// node. Mock the resolver at the same shim we use elsewhere in this suite
// (see `get-effective-profile-presets.test.js`).
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/agent-resolution.js', () => ({
    buildAgentApiRoutingPromptData: () => ({}),
    buildAgentPromptPresetRoutingPromptData: () => ({}),
    getPresetApiPresetName: () => '',
    getPresetPromptPresetName: () => '',
    refreshOpenAIPresetSelectors: () => {},
    renderConnectionProfileOptions: () => '',
    renderOpenAIPresetOptions: () => '',
    resolveAgentToolFlags: (override) => override || null,
    resolveOrchestrationRuntimeWorldInfo: () => null,
    sanitizeConnectionProfileName: (v) => String(v || ''),
    sanitizePromptPresetName: (v) => String(v || ''),
}));

let createFactoryPresetForMode;
let ORCH_EXECUTION_MODE_AGENDA;
let ORCH_EXECUTION_MODE_LOOP;
let ORCH_EXECUTION_MODE_SPEC;
let defaultLoopProfile;
let sanitizeAgendaWorkingProfile;
let sanitizeLoopProfile;
let sanitizeSpec;
let runLoopOrchestration;
let clearCurrentRun;

beforeAll(async () => {
    ({
        createFactoryPresetForMode,
        ORCH_EXECUTION_MODE_AGENDA,
        ORCH_EXECUTION_MODE_LOOP,
        ORCH_EXECUTION_MODE_SPEC,
        defaultLoopProfile,
    } = await import('../../public/scripts/extensions/orchestrator/defaults.js'));
    ({ sanitizeAgendaWorkingProfile } = await import('../../public/scripts/extensions/orchestrator/agenda-profile.js'));
    ({ sanitizeLoopProfile } = await import('../../public/scripts/extensions/orchestrator/persistence.js'));
    ({ sanitizeSpec } = await import('../../public/scripts/extensions/orchestrator/spec-schema.js'));
    ({ runLoopOrchestration } = await import('../../public/scripts/extensions/orchestrator/loop-runtime.js'));
    ({ clearCurrentRun } = await import('../../public/scripts/extensions/orchestrator/run-state/store.js'));
});

describe('#70 — Spec / agenda / loop are three independent executionMode values', () => {
    test('SPEC mode factory profile → spec-shaped (stages + nodes); no agenda planner / loop max_rounds / loop system_prompt', () => {
        const factory = createFactoryPresetForMode(ORCH_EXECUTION_MODE_SPEC);
        const spec = sanitizeSpec(factory?.spec);
        const presets = factory?.presets;

        // Positive shape — spec carries stages + nodes.
        expect(Array.isArray(spec.stages)).toBe(true);
        expect(spec.stages.length).toBeGreaterThan(0);
        const firstStage = spec.stages[0];
        expect(typeof firstStage.id).toBe('string');
        expect(firstStage.id.length).toBeGreaterThan(0);
        expect(Array.isArray(firstStage.nodes)).toBe(true);
        expect(firstStage.nodes.length).toBeGreaterThan(0);
        expect(presets && typeof presets === 'object').toBe(true);

        // Negative shape — these are agenda / loop fields and MUST be
        // absent on a spec-mode factory profile (the dispatcher relies
        // on them being absent to disambiguate the branch).
        expect(Boolean(factory?.planner)).toBe(false);
        expect(Boolean(factory?.agents)).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(factory, 'max_rounds')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(factory, 'system_prompt')).toBe(false);
    });

    test('AGENDA mode factory profile → agenda-shaped (planner + agents + finalAgentId + limits); no spec stages / loop fields', () => {
        const factory = createFactoryPresetForMode(ORCH_EXECUTION_MODE_AGENDA);
        const p = sanitizeAgendaWorkingProfile(factory);

        // Positive shape.
        expect(Boolean(p.planner)).toBe(true);
        expect(typeof p.planner.systemPrompt).toBe('string');
        expect(p.planner.systemPrompt.length).toBeGreaterThan(0);
        expect(p.agents && typeof p.agents === 'object').toBe(true);
        const agentIds = Object.keys(p.agents);
        expect(agentIds.length).toBeGreaterThan(0);
        expect(p.finalAgentId).toBeTruthy();
        // The finalAgentId must reference an entry in the agents map — that
        // is the sequencing contract (planner schedules other agents, the
        // finalizer reads their outputs and produces final guidance).
        expect(agentIds).toContain(p.finalAgentId);
        expect(p.limits && typeof p.limits === 'object').toBe(true);
        expect(typeof p.limits.plannerMaxRounds).toBe('number');
        expect(typeof p.limits.maxConcurrentAgents).toBe('number');

        // Negative shape — spec / loop fields are absent.
        expect(Boolean(factory?.spec?.stages)).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(factory, 'max_rounds')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(factory, 'system_prompt')).toBe(false);
    });

    test('LOOP mode factory profile → loop-shaped (system_prompt + tools + max_rounds + wall_clock_budget_ms); no spec stages / agenda planner / agenda agents', async () => {
        const factory = createFactoryPresetForMode(ORCH_EXECUTION_MODE_LOOP);
        const profile = sanitizeLoopProfile(factory);

        // Positive shape.
        expect(typeof profile.system_prompt).toBe('string');
        expect(profile.system_prompt.length).toBeGreaterThan(0);
        expect(profile.tools && typeof profile.tools === 'object').toBe(true);
        // Sanitizer forces tools.finalize=true so the agent always has a terminator.
        expect(profile.tools.finalize).toBe(true);
        expect(typeof profile.max_rounds).toBe('number');
        expect(profile.max_rounds).toBeGreaterThanOrEqual(1);
        expect(typeof profile.wall_clock_budget_ms).toBe('number');

        // Negative shape.
        expect(Boolean(factory?.spec?.stages)).toBe(false);
        expect(Boolean(factory?.planner)).toBe(false);
        expect(Boolean(factory?.agents)).toBe(false);

        // Drive the loop body itself to a real terminal state.
        // We inject a fake `sendLlm` so the loop driver doesn't go through
        // the real LLM stack — this exercises the loop body's iteration
        // contract end-to-end without depending on mock-LLM tool-call
        // wiring through the chat-completion adapter.
        clearCurrentRun();

        const loopProfile = sanitizeLoopProfile({
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
        const out = await runLoopOrchestration(context, payload, loopProfile, {
            sendLlm,
            executeTool,
        });

        // Loop body terminated by the finalize tool — the canonical
        // "loop iterates to a documented exit condition" assertion.
        expect(out?.status).toBe('completed');
        expect(out?.capsule).toBe(FINALIZE_TEXT);
        expect(out?.total_rounds).toBe(2);
        // Trace surface independent of any pipeline coupling.
        expect(out?.runtimeTrace?.mode).toBe('loop');
        const eventTypes = Array.isArray(out?.runtimeTrace?.events)
            ? out.runtimeTrace.events.map(e => e.type) : [];
        expect(eventTypes).toEqual(expect.arrayContaining(['run_started', 'run_finished']));

        clearCurrentRun();
    });

    test('exclusivity sweep — each mode\'s sanitized factory profile carries exactly its own defining field, none of the others', () => {
        // The "alternatives, not pipeline" contract: each shape's defining
        // field appears in exactly one mode.
        const specFactory = createFactoryPresetForMode(ORCH_EXECUTION_MODE_SPEC);
        const agendaFactory = createFactoryPresetForMode(ORCH_EXECUTION_MODE_AGENDA);
        const loopFactory = createFactoryPresetForMode(ORCH_EXECUTION_MODE_LOOP);
        const loopSanitized = sanitizeLoopProfile(loopFactory);

        // Spec mode: ONLY spec.stages present.
        expect(Array.isArray(specFactory.spec?.stages)).toBe(true);
        expect(Boolean(specFactory.planner)).toBe(false);
        expect(typeof specFactory.system_prompt).toBe('undefined');

        // Agenda mode: ONLY planner present.
        expect(Boolean(agendaFactory.planner)).toBe(true);
        expect(Boolean(agendaFactory.spec?.stages)).toBe(false);
        expect(typeof agendaFactory.system_prompt).toBe('undefined');

        // Loop mode: ONLY loop system_prompt present.
        expect(typeof loopSanitized.system_prompt).toBe('string');
        expect(loopSanitized.system_prompt.length).toBeGreaterThan(0);
        expect(Boolean(loopFactory.spec?.stages)).toBe(false);
        expect(Boolean(loopFactory.planner)).toBe(false);

        // Sanity: defaultLoopProfile is what createFactoryPresetForMode(LOOP) spreads.
        expect(typeof defaultLoopProfile.system_prompt).toBe('string');
    });
});
