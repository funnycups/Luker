// tests/iter-workspace/preview-renderers.test.js
import { describe, test, expect, beforeAll, jest } from '@jest/globals';

// public/lib.js is redirected to tests/util/lib-stub.js via jest config's
// moduleNameMapper — no per-test mock needed.

// popup.js drags in the entire UI shell — stub to no-op exports.
jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    Popup: class { constructor() {} show() { return Promise.resolve(); } },
    POPUP_TYPE: { DISPLAY: 0, INPUT: 1, CONFIRM: 2 },
    POPUP_RESULT: { CANCELLED: 0, AFFIRMATIVE: 1, NEGATIVE: 2 },
    callGenericPopup: () => Promise.resolve(),
    fixToastrForDialogs: () => {},
}));

// Runner pulls in iter-tool-calling which needs the LLM stack — stub.
jest.unstable_mockModule('../../public/scripts/lib/iter-tool-calling.js', () => ({
    requestToolCallsWithRetry: jest.fn(),
    buildExecutionToolCalls: jest.fn(),
    buildPendingToolResults: jest.fn(),
    buildPersistentToolCallsFromRawCalls: jest.fn(),
    buildPersistentToolHistoryMessages: jest.fn(),
    createPersistentToolTurnMessage: jest.fn(),
    makeAiIterationMessageId: jest.fn(() => 'id'),
}));

jest.unstable_mockModule('../../public/scripts/lib/abort-utils.js', () => ({}));

let _testOnly_renderCpaPreviewPane;
let _testOnly_renderMgSchemaPreviewPane;
let _testOnly_applyEmptyPathSet;
let _testOnly_renderOrchPreviewPane;
let _testOnly_orchApplyEmptyPathSet;
let _testOnly_renderCeaEditorPreviewPane;

beforeAll(async () => {
    const mod = await import('../../public/scripts/extensions/completion-preset-assistant/cpa-iteration/studio.js');
    _testOnly_renderCpaPreviewPane = mod._testOnly_renderCpaPreviewPane;
    const mgMod = await import('../../public/scripts/extensions/memory-graph/schema-iteration/studio.js');
    _testOnly_renderMgSchemaPreviewPane = mgMod._testOnly_renderMgSchemaPreviewPane;
    _testOnly_applyEmptyPathSet = mgMod._testOnly_applyEmptyPathSet;
    const orchMod = await import('../../public/scripts/extensions/orchestrator/iter-studio/studio.js');
    _testOnly_renderOrchPreviewPane = orchMod._testOnly_renderOrchPreviewPane;
    _testOnly_orchApplyEmptyPathSet = orchMod._testOnly_applyEmptyPathSet;
    const ceaEditorMod = await import('../../public/scripts/extensions/character-editor-assistant/editor-preview.js');
    _testOnly_renderCeaEditorPreviewPane = ceaEditorMod._testOnly_renderCeaEditorPreviewPane;
});

describe('renderCpaPreviewPane', () => {
    const sampleLive = {
        temperature: 0.7,
        top_p: 1.0,
        top_k: 40,
        freq_pen: 0,
        pres_pen: 0,
        prompts: [
            { identifier: 'main', name: 'Main prompt', role: 'system', content: 'You are a helpful assistant.' },
            { identifier: 'persona', name: 'Persona', role: 'system', content: 'Speak in a calm tone.' },
        ],
    };

    test('renders Sampling params section with current temperature value', () => {
        const html = _testOnly_renderCpaPreviewPane(sampleLive, []);
        expect(html).toMatch(/temperature/i);
        expect(html).toContain('0.7');
    });

    test('renders Prompts section with prompt names', () => {
        const html = _testOnly_renderCpaPreviewPane(sampleLive, []);
        expect(html).toContain('Main prompt');
        expect(html).toContain('Persona');
    });

    test('marks a sampling-param row .pending-change when a pending edit modifies it', () => {
        // Real `set` op shape: { op, path, oldValue, newValue }.
        const edit = { op: 'set', path: 'temperature', oldValue: 0.7, newValue: 0.85 };
        const html = _testOnly_renderCpaPreviewPane(sampleLive, [edit]);
        expect(html).toContain('pending-change');
        expect(html).toContain('0.85');
    });

    test('empty-state when live is null', () => {
        const html = _testOnly_renderCpaPreviewPane(null, []);
        expect(html).toMatch(/no preset loaded|未加载预设|未載入預設/i);
    });

    test('inline pending diff shows old → new value with English source phrasing', () => {
        const edit = { op: 'set', path: 'temperature', oldValue: 0.7, newValue: 0.85 };
        const html = _testOnly_renderCpaPreviewPane(sampleLive, [edit]);
        // The source format is (was X → now Y); locale-specific translations may differ.
        expect(html).toMatch(/was.*0\.7.*now.*0\.85|0\.7.*0\.85/);
    });

    test('saved-presets aside renders when savedPresets is non-empty + clickable rows have ref-name attr', () => {
        const html = _testOnly_renderCpaPreviewPane(sampleLive, [], ['PresetA', 'PresetB'], 'PresetA');
        expect(html).toContain('PresetA');
        expect(html).toContain('PresetB');
        expect(html).toContain('data-cpa-it-preview-action="ref-pick"');
        expect(html).toContain('data-cpa-it-ref-name="PresetA"');
    });
});

describe('renderMgSchemaPreviewPane', () => {
    const sampleSchema = [
        { id: 'character', name: 'Character', fields: [
            { id: 'name', label: 'Name', type: 'string', description: 'Display name' },
            { id: 'goals', label: 'Goals', type: 'array', description: 'Current goals' },
        ] },
        { id: 'location', name: 'Location', fields: [
            { id: 'name', label: 'Name', type: 'string', description: '' },
        ] },
    ];

    test('renders all categories and field counts', () => {
        const html = _testOnly_renderMgSchemaPreviewPane(sampleSchema, []);
        expect(html).toContain('Character');
        expect(html).toContain('Location');
        expect(html).toMatch(/2.*field|2.*个字段|2.*個欄位/);
    });

    test('highlights category when pending edit changes it', () => {
        // MG sandbox-diff emits `{ op: 'set', path: '', oldValue, newValue }`
        // (see schema-iteration/tools.js:256-259). The set-op apply uses
        // `newValue`, not `value`.
        const edit = {
            op: 'set',
            path: '',
            oldValue: sampleSchema,
            newValue: [
                { id: 'character', name: 'Character', fields: [
                    { id: 'name', label: 'Renamed', type: 'string', description: 'New' },
                ] },
                sampleSchema[1],
            ],
        };
        const html = _testOnly_renderMgSchemaPreviewPane(sampleSchema, [edit]);
        expect(html).toContain('pending-change');
    });

    test('empty-state when schema is null/empty', () => {
        const html = _testOnly_renderMgSchemaPreviewPane(null, []);
        expect(html).toMatch(/no schema|未加载|未載入/i);
    });

    test('MG: renders production shape (label + tableColumns) correctly', () => {
        const productionSchema = [
            { id: 'event', label: 'Event', tableColumns: ['summary', 'mood'], description: 'Things that happen' },
        ];
        const html = _testOnly_renderMgSchemaPreviewPane(productionSchema, []);
        expect(html).toContain('Event');
        expect(html).toContain('summary');
        expect(html).toContain('mood');
        // Should also report the field count from tableColumns
        expect(html).toMatch(/2\s*fields|2\s*个字段|2\s*個欄位/);
    });
});

describe('applyEmptyPathSet (auto-apply unblock)', () => {
    test('returns a deep clone of newValue (NOT the same reference)', () => {
        const live = [{ id: 'a', label: 'A', tableColumns: ['x'] }];
        const newValue = [{ id: 'a', label: 'A renamed', tableColumns: ['x', 'y'] }];
        const edit = { op: 'set', path: '', oldValue: live, newValue };
        const result = _testOnly_applyEmptyPathSet(live, edit);
        expect(result).toEqual(newValue);
        expect(result).not.toBe(newValue); // structuredClone => different reference
        // Mutating the clone must NOT touch the source newValue.
        result[0].label = 'mutated';
        expect(newValue[0].label).toBe('A renamed');
    });

    test('actually changes state.live (proves the lodash empty-path no-op is bypassed)', () => {
        // Simulate the applyPendingEdits flow: hold the prior live, then
        // replace via the helper. This is the assertion that would FAIL on
        // the pre-fix codebase where applyEdits silently returns the same ref.
        let live = [{ id: 'event', label: 'Event', tableColumns: ['summary'] }];
        const before = live;
        const newSchema = [
            { id: 'event', label: 'Event', tableColumns: ['summary', 'mood'] },
            { id: 'place', label: 'Place', tableColumns: ['name'] },
        ];
        const edit = { op: 'set', path: '', oldValue: live, newValue: newSchema };
        live = _testOnly_applyEmptyPathSet(live, edit);
        expect(live).not.toBe(before);
        expect(live).toHaveLength(2);
        expect(live[0].tableColumns).toEqual(['summary', 'mood']);
        expect(live[1].id).toBe('place');
    });
});

describe('orchestrator applyEmptyPathSet (auto-apply unblock)', () => {
    test('returns structuredClone of newValue (clone identity)', () => {
        const next = { mode: 'spec', spec: { stages: [{ id: 's1', mode: 'serial', nodes: [] }] } };
        const result = _testOnly_orchApplyEmptyPathSet({}, { op: 'set', path: '', newValue: next });
        expect(result).toEqual(next);
        expect(result).not.toBe(next);
        expect(result.spec).not.toBe(next.spec);
    });

    test('mutation isolation: editing result does not mutate input', () => {
        const next = { mode: 'spec', spec: { stages: [] } };
        const result = _testOnly_orchApplyEmptyPathSet({}, { op: 'set', path: '', newValue: next });
        result.spec.stages.push({ id: 'x' });
        expect(next.spec.stages).toEqual([]);
    });
});

// ──────────────────────────────────────────────────────────────────────────
// Orchestrator preview renderer — 4 modes (spec / loop / agenda / director).
//
// Profile shapes verified against:
//   - public/scripts/extensions/orchestrator/spec-schema.js#sanitizeSpec
//     SPEC clone: {spec: {stages: [{id, mode, nodes: [{id, preset, type}]}],
//                  defaultTools}, presets: {<id>: {systemPrompt, ...}}}
//   - public/scripts/extensions/orchestrator/persistence.js#sanitizeLoopProfile
//     LOOP (FLAT): {mode, apiPresetName, promptPresetName, system_prompt,
//                   tools, max_rounds, wall_clock_budget_ms, capsule_inject}
//   - public/scripts/extensions/orchestrator/agenda-profile.js
//     AGENDA: {planner: {systemPrompt, userPromptTemplate, apiPresetName,
//              promptPresetName, tools}, agents: {<id>: {...}}, finalAgentId,
//              limits, defaultTools}
//     NB: agents is a MAP keyed by id (not an array)
//   - public/scripts/extensions/orchestrator/director-defaults.js
//     DIRECTOR: {mode, director: {mainAgent: {promptPresetName, apiPresetName,
//                systemPrompt}, subAgents: [{id, description, systemPrompt,
//                promptPresetName, apiPresetName}], maxRounds, ...}}
// ──────────────────────────────────────────────────────────────────────────

describe('renderOrchPreviewPane', () => {
    test('spec mode: renders stages and nodes', () => {
        const profile = {
            spec: {
                stages: [
                    {
                        id: 'stage_1',
                        mode: 'serial',
                        nodes: [
                            { id: 'planner', preset: 'planner_preset', type: 'agent' },
                            { id: 'reviewer', preset: 'review_preset', type: 'review' },
                        ],
                    },
                ],
                defaultTools: null,
            },
            presets: {
                planner_preset: { systemPrompt: '', userPromptTemplate: '', apiPresetName: '', promptPresetName: '' },
                review_preset: { systemPrompt: '', userPromptTemplate: '', apiPresetName: '', promptPresetName: '' },
            },
        };
        const html = _testOnly_renderOrchPreviewPane(profile, [], 'spec');
        expect(html).toContain('stage_1');
        expect(html).toContain('planner');
        expect(html).toContain('reviewer');
        expect(html).toMatch(/serial/i);
    });

    test('loop mode: renders loop config (flat shape, no agent wrapper)', () => {
        const profile = {
            mode: 'loop',
            apiPresetName: 'gpt4_api',
            promptPresetName: 'rp_director',
            system_prompt: 'You are a director.',
            tools: {},
            max_rounds: 8,
            wall_clock_budget_ms: 60000,
            capsule_inject: { position: 'after_main', depth: 0, role: 'system', customInstruction: '' },
        };
        const html = _testOnly_renderOrchPreviewPane(profile, [], 'loop');
        // The loop preview surfaces the preset names + the max_rounds limit.
        expect(html).toContain('rp_director');
        expect(html).toMatch(/8/);
    });

    test('agenda mode: renders planner and agents (agents is a map)', () => {
        const profile = {
            planner: {
                systemPrompt: 'plan things',
                userPromptTemplate: 'Make a plan for ${0}',
                apiPresetName: 'planner_api',
                promptPresetName: 'planner_prompt',
            },
            agents: {
                researcher: {
                    systemPrompt: 'research',
                    userPromptTemplate: '',
                    apiPresetName: 'rsh_api',
                    promptPresetName: 'rsh_prompt',
                },
                finalizer: {
                    systemPrompt: 'finalize',
                    userPromptTemplate: '',
                    apiPresetName: 'fin_api',
                    promptPresetName: 'fin_prompt',
                },
            },
            finalAgentId: 'finalizer',
            limits: { plannerMaxRounds: 6, maxConcurrentAgents: 3, maxTotalRuns: 24 },
            defaultTools: null,
        };
        const html = _testOnly_renderOrchPreviewPane(profile, [], 'agenda');
        // Planner identification + at least one agent id.
        expect(html).toMatch(/Planner|planner_prompt/);
        expect(html).toContain('researcher');
        expect(html).toContain('finalizer');
    });

    test('director mode: renders main + sub-agents (nested under director, subAgents is array)', () => {
        const profile = {
            mode: 'director',
            director: {
                mainAgent: {
                    promptPresetName: 'main_prompt',
                    apiPresetName: 'main_api',
                    systemPrompt: 'You orchestrate everything.',
                },
                subAgents: [
                    { id: 'researcher', description: 'looks up facts', systemPrompt: 'research', promptPresetName: 'rsh_prompt', apiPresetName: 'rsh_api' },
                    { id: 'critic', description: '', systemPrompt: 'critique', promptPresetName: 'crit_prompt', apiPresetName: 'crit_api' },
                ],
                maxRounds: 5,
                maxConcurrentSubagents: 2,
                maxTotalSubagentRuns: 10,
                tools: {},
                discardOnAbort: false,
            },
        };
        const html = _testOnly_renderOrchPreviewPane(profile, [], 'director');
        // Main agent + at least one sub-agent id.
        expect(html).toMatch(/Main|main_prompt/i);
        expect(html).toContain('researcher');
        expect(html).toContain('critic');
    });

    test('empty-state when profile is null', () => {
        const html = _testOnly_renderOrchPreviewPane(null, [], 'spec');
        expect(html).toMatch(/no profile|未加载|未載入/i);
    });

    test('marks rows as pending-change when a coarse set("",profile) edit alters them', () => {
        // Orch's sandbox-diff emits one coarse `set('', newProfile)` per turn
        // (orchestrator/iter-studio/studio.js:586-591). The renderer should
        // mark changed paths visually.
        const before = {
            spec: {
                stages: [
                    { id: 'stage_1', mode: 'serial', nodes: [{ id: 'planner', preset: 'p1', type: 'agent' }] },
                ],
                defaultTools: null,
            },
            presets: {},
        };
        const after = {
            spec: {
                stages: [
                    { id: 'stage_1', mode: 'parallel', nodes: [{ id: 'planner', preset: 'p1', type: 'agent' }] },
                ],
                defaultTools: null,
            },
            presets: {},
        };
        const edit = { op: 'set', path: '', oldValue: before, newValue: after };
        const html = _testOnly_renderOrchPreviewPane(before, [edit], 'spec');
        expect(html).toContain('pending-change');
    });

    test('spec mode: surfaces a Presets section that lights up rows when presets.* paths change (旧-8)', () => {
        // The renderer must walk `presets.*` in the changed-path set so a
        // preset-only edit (e.g. bumping a preset's apiPresetName via the
        // sandbox-diff) lights up the matching preset row even when the
        // stage layout is unchanged.
        const before = {
            spec: {
                stages: [
                    { id: 'stage_1', mode: 'serial', nodes: [{ id: 'planner', preset: 'planner_preset', type: 'agent' }] },
                ],
                defaultTools: null,
            },
            presets: {
                planner_preset: { systemPrompt: '', userPromptTemplate: '', apiPresetName: 'old_api', promptPresetName: 'old_prompt' },
                review_preset: { systemPrompt: '', userPromptTemplate: '', apiPresetName: 'r_api', promptPresetName: 'r_prompt' },
            },
        };
        const after = {
            spec: {
                stages: [
                    { id: 'stage_1', mode: 'serial', nodes: [{ id: 'planner', preset: 'planner_preset', type: 'agent' }] },
                ],
                defaultTools: null,
            },
            presets: {
                planner_preset: { systemPrompt: '', userPromptTemplate: '', apiPresetName: 'new_api', promptPresetName: 'new_prompt' },
                review_preset: { systemPrompt: '', userPromptTemplate: '', apiPresetName: 'r_api', promptPresetName: 'r_prompt' },
            },
        };
        const edit = { op: 'set', path: '', oldValue: before, newValue: after };
        const html = _testOnly_renderOrchPreviewPane(before, [edit], 'spec');
        // The Presets section header should be present, and the
        // planner_preset row should be marked pending-change while
        // review_preset stays unmarked.
        expect(html).toMatch(/Presets|预设|預設/);
        expect(html).toContain('planner_preset');
        expect(html).toContain('review_preset');
        // The HTML should mark the planner_preset row's wrapper with
        // pending-change. The stage row above is unchanged (same id /
        // mode / nodes) so its row class should be the plain variant —
        // we don't assert on that to keep the test resilient to small
        // CSS class renames.
        expect(html).toContain('pending-change');
    });

    test('unknown mode falls back to spec rendering without throwing', () => {
        const profile = {
            spec: { stages: [{ id: 'stage_x', mode: 'serial', nodes: [{ id: 'n', preset: 'p' }] }], defaultTools: null },
            presets: {},
        };
        const html = _testOnly_renderOrchPreviewPane(profile, [], 'unknown_mode');
        expect(html).toContain('stage_x');
    });
});

describe('renderCeaEditorPreviewPane', () => {
    const sampleWi = {
        name: 'Alice Lore',
        entries: {
            '1': { uid: 1, key: ['forest'], position: 0, content: 'A dense woodland east of the village.' },
            '2': { uid: 2, key: ['dawn'], position: 1, content: 'Morning light through the canopy.' },
        },
    };

    test('renders title with world book name', () => {
        const html = _testOnly_renderCeaEditorPreviewPane(sampleWi, null);
        expect(html).toContain('Alice Lore');
    });

    test('renders entry rows for each entry', () => {
        const html = _testOnly_renderCeaEditorPreviewPane(sampleWi, null);
        expect(html).toContain('forest');
        expect(html).toContain('dawn');
    });

    test('flags pending entries with draft class', () => {
        // upsert_entry on uid=3 (new) and uid=1 (existing) — the existing entry
        // gets `pending-change` on its row; the new entry renders as a draft row.
        const pending = {
            messageId: 'm1',
            operations: [
                { op: 'upsert_entry', payload: { uid: 3, key: ['mist'], content: 'thick mist' } },
                { op: 'upsert_entry', payload: { uid: 1, key: ['forest'], content: 'A dark forest.' } },
            ],
        };
        const html = _testOnly_renderCeaEditorPreviewPane(sampleWi, pending);
        expect(html).toContain('mist');
        expect(html).toContain('pending-change');
    });

    test('empty-state when no world book bound', () => {
        const html = _testOnly_renderCeaEditorPreviewPane(null, null);
        expect(html).toMatch(/no world book|未绑定|未綁定/i);
    });

    test('Array-shaped entries (旧-7): upsert_entry on existing uid renders as pending-change, not draft', () => {
        // Modern world-info shape: `entries` is an Array, each entry carries
        // its own `uid`. The fix builds a uid-keyed view regardless of source
        // shape so existsInSnapshot resolves correctly. Without the fix,
        // every upsert-by-uid against an Array landed in the draft row at
        // the top instead of marking the existing row pending-change.
        const liveWi = {
            name: 'Eldoria',
            entries: [
                { uid: 1, comment: 'Forest Grove', content: 'Old content', key: ['forest'] },
                { uid: 2, comment: 'Lake', content: 'Lake content', key: ['lake'] },
            ],
        };
        const pendingApproval = {
            messageId: 'm1',
            operations: [
                { op: 'upsert_entry', payload: { uid: 1, content: 'New forest content' } },
            ],
        };
        const html = _testOnly_renderCeaEditorPreviewPane(liveWi, pendingApproval, (s) => s);
        // Existing uid=1 row gets pending-change.
        expect(html).toContain('pending-change');
        // ...but NOT as a draft (i.e. no additional draft row at top).
        // We look for the draft-row badge text the renderer emits.
        const draftMatches = html.match(/Draft \(not applied\)/g) || [];
        // Existing-uid row's pending-change badge IS labeled "Draft (not applied)",
        // so we expect exactly 1 match (the existing row), NOT 2 (which would
        // indicate a phantom draft row at the top).
        expect(draftMatches.length).toBe(1);
        // Existing uid="1" should be present in the body — it didn't get
        // re-emitted as a draft new entry.
        expect(html).toMatch(/uid:\s*1|UID:\s*1|UID：\s*1/i);
    });
});
