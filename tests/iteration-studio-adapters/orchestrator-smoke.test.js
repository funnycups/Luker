/**
 * Orchestrator iteration-adapter — v2 contract smoke tests.
 *
 * NOT a full LLM-loop test. Verifies:
 *   1. The adapter object returned by `createOrchestratorIterationAdapter`
 *      conforms to the shell's required hook surface (v2 contract).
 *   2. `live()` routes through the deps editor helpers and returns the
 *      sanitized profile shape the shell would consume.
 *   3. `normalizeToolCallToEdit` clones live, defers to the deps executor,
 *      and emits exactly one coarse `set` edit at root path '' carrying the
 *      mutated sandbox profile.
 *   4. `sessionScope()` collapses to 'global' when no character is active.
 *
 * Both smoke specs mock `SillyTavern.getContext()` + `extension_settings`
 * before importing the adapter factory so its module-level resolution of
 * those globals lands on the test fakes.
 */

import { describe, test, expect, beforeAll, jest } from '@jest/globals';

// `iteration-studio/index.js` re-exports `studio.js`, `runner.js`, etc., which
// pull in `popup.js` → `lib.js` → a built bundle that does not exist in
// source. The adapter only needs `defineAdapter`; mock the module so loading
// stays cheap and Node-friendly. The pass-through preserves all v2 contract
// validation the real defineAdapter does — re-import it through `session.js`
// (a pure module with no DOM deps) and re-export.
jest.unstable_mockModule('../../public/scripts/iteration-studio/index.js', async () => {
    const session = await import('../../public/scripts/iteration-studio/session.js');
    return { defineAdapter: session.defineAdapter };
});

const fakeContext = {
    extensionSettings: {
        orchestrator: {
            orchestrationSpec: { stages: [{ name: 'one' }] },
            presets: {},
            loopProfile: {},
            agendaPlanner: {},
            agendaAgents: {},
            directorProfile: {},
        },
    },
    characters: [],
    characterId: null,
};

globalThis.SillyTavern = { getContext: () => fakeContext };
globalThis.saveSettingsDebounced = () => {};

let createOrchestratorIterationAdapter;

beforeAll(async () => {
    ({ createOrchestratorIterationAdapter } = await import(
        '../../public/scripts/extensions/orchestrator/iteration-adapter.js'
    ));
});

function makeDeps(overrides = {}) {
    return {
        i18n: (k) => k,
        i18nFormat: (k, ...args) => k + ':' + args.join('|'),
        getIterationDefaultScope: () => 'global',
        getEditorByScope: () => ({ stages: [{ name: 'one' }] }),
        getAgendaEditorByScope: () => ({}),
        getLoopEditorByScope: () => ({}),
        getDirectorEditorByScope: () => ({}),
        syncCharacterEditorWithActiveAvatar: () => {},
        cloneWorkingProfileFromEditor: (x) => structuredClone(x || {}),
        cloneAgendaWorkingProfileFromEditor: (x) => structuredClone(x || {}),
        cloneDirectorWorkingProfileFromEditor: (x) => structuredClone(x || {}),
        sanitizeLoopProfile: (x) => structuredClone(x || {}),
        sanitizeAgendaWorkingProfile: (x) => structuredClone(x || {}),
        sanitizeDirectorProfile: (x) => structuredClone(x || {}),
        buildAiIterationToolSet: () => ([
            { type: 'function', function: { name: 'orch_test_mutate', description: '', parameters: { type: 'object' } } },
        ]),
        buildAiIterationSystemPrompt: () => 'sys',
        buildAiIterationUserPrompt: () => 'user',
        buildAiIterationAutoContinuePrompt: () => 'auto',
        executeAiIterationToolCalls: async (_ctx, fakeSession, _calls, _signal) => {
            // Stub: mutate sandbox so the structural diff is non-empty and
            // the adapter emits a coarse `set` edit.
            if (fakeSession?.workingProfile) {
                fakeSession.workingProfile.testField = 'mutated';
            }
            return { toolResults: [], actions: [], changed: true };
        },
        renderAiIterationWorkingProfile: () => '<div>preview</div>',
        resolveOrchestrationRuntimeWorldInfo: async () => null,
        applyAiIterationSessionToGlobal: async () => {},
        applyAiIterationSessionToCharacter: async () => {},
        ORCH_EXECUTION_MODES: { LOOP: 'loop', AGENDA: 'agenda', DIRECTOR: 'director', SPEC: 'spec' },
        MODULE_NAME: 'orchestrator',
        ...overrides,
    };
}

describe('orchestrator adapter (spec mode) — v2 contract smoke', () => {
    test('has all required v2 hooks', () => {
        const a = createOrchestratorIterationAdapter('spec', makeDeps());
        expect(a.id).toBe('orch_spec');
        expect(a.mode).toBe('spec');
        expect(a.layout).toBe('split');
        for (const k of ['live', 'commit', 'sessionScope',
                          'listSessions', 'loadSession', 'saveSession', 'deleteSession',
                          'buildToolCatalog', 'normalizeToolCallToEdit',
                          'buildSystemPrompt', 'buildUserPrompt',
                          'renderMessageCard', 'renderHistoryItem', 'renderPreviewPane']) {
            expect(typeof a[k]).toBe('function');
        }
    });

    test('live() returns the cloned editor profile', () => {
        const a = createOrchestratorIterationAdapter('spec', makeDeps());
        const live = a.live();
        // spec mode (not loop/agenda/director) falls through to
        // cloneWorkingProfileFromEditor(getEditorByScope(scope)).
        expect(live).toEqual({ stages: [{ name: 'one' }] });
    });

    test('normalizeToolCallToEdit emits a coarse set edit at root', async () => {
        const a = createOrchestratorIterationAdapter('spec', makeDeps());
        const before = a.live();
        const edits = await a.normalizeToolCallToEdit(
            { id: 't1', name: 'orch_test_mutate', args: {} },
            { session: {}, live: before },
        );
        expect(Array.isArray(edits)).toBe(true);
        expect(edits).toHaveLength(1);
        expect(edits[0]).toMatchObject({ op: 'set', path: '' });
        expect(edits[0].newValue.testField).toBe('mutated');
        // oldValue must equal the pre-mutation live, not the post-mutation sandbox.
        expect(edits[0].oldValue).toEqual({ stages: [{ name: 'one' }] });
    });

    test('normalizeToolCallToEdit returns [] when sandbox is unchanged', async () => {
        const deps = makeDeps({
            // No-op executor: do not mutate sandbox.
            executeAiIterationToolCalls: async () => ({ toolResults: [], actions: [], changed: false }),
        });
        const a = createOrchestratorIterationAdapter('spec', deps);
        const before = a.live();
        const edits = await a.normalizeToolCallToEdit(
            { id: 't2', name: 'noop', args: {} },
            { session: {}, live: before },
        );
        expect(edits).toEqual([]);
    });

    test('normalizeToolCallToEdit returns null when executor throws', async () => {
        const deps = makeDeps({
            executeAiIterationToolCalls: async () => { throw new Error('boom'); },
        });
        const a = createOrchestratorIterationAdapter('spec', deps);
        const before = a.live();
        const edits = await a.normalizeToolCallToEdit(
            { id: 't3', name: 'whatever', args: {} },
            { session: {}, live: before },
        );
        expect(edits).toBeNull();
    });

    test('sessionScope returns "global" when no character is active', () => {
        const a = createOrchestratorIterationAdapter('spec', makeDeps());
        expect(a.sessionScope()).toBe('global');
    });

    test('buildToolCatalog strips orchestrator control tool names', () => {
        const deps = makeDeps({
            buildAiIterationToolSet: () => ([
                { type: 'function', function: { name: 'orch_test_mutate', description: '', parameters: { type: 'object' } } },
                { type: 'function', function: { name: 'luker_orch_continue_iteration', description: '', parameters: { type: 'object' } } },
                { type: 'function', function: { name: 'luker_orch_finalize_iteration', description: '', parameters: { type: 'object' } } },
            ]),
        });
        const a = createOrchestratorIterationAdapter('spec', deps);
        const tools = a.buildToolCatalog({});
        expect(tools.map(t => t.function.name)).toEqual(['orch_test_mutate']);
    });
});
