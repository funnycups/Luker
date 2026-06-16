// tests/cpa-iteration/tools.test.js
import { describe, test, expect, beforeAll, jest } from '@jest/globals';

// iteration-library/tools/skill-iter-studio.js captures `skillsApi` + `yaml` from
// `Luker.getContext()` at module load. Stub it before the dynamic
// import so the module's eval succeeds. The CPA-exposed tools all touch
// these (skill_list_visible / skill_inspect / skill_create / etc), but
// these unit tests never fire those handlers — the stub just satisfies
// the module-link contract.
//
// CPA's own tools.js also captures __ctx.lib.lodash + generateQuietPrompt
// at module load; the lib.lodash slot must be a real lodash so the editable
// tool tests' lodash.get/lodash.cloneDeep calls work.
const lodashDefault = (await import('lodash')).default;
globalThis.Luker = {
    getContext: () => ({
        skills: {
            list: jest.fn(async () => []),
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
        },
        lib: {
            yaml: { parse: () => ({}), stringify: () => '' },
            lodash: lodashDefault,
        },
        generateQuietPrompt: async () => 'mocked',
    }),
};

// public/lib.js pulls in a browser bundle that can't be resolved under jest.
// Mirror the same workaround used by tests/iteration-studio-adapters/cpa-smoke.test.js:
// stub the facade to a thin { lodash } re-export.
jest.unstable_mockModule('../../public/lib.js', async () => {
    const { default: lodash } = await import('lodash');
    return {
        lodash,
        // iteration-library/tools/skill-iter-studio.js (pulled in transitively
        // for the CPA skill toolset) imports `yaml` for skill_update_frontmatter.
        // That handler never fires under these unit tests; stub the parse/
        // stringify pair so the module link succeeds.
        yaml: { parse: () => ({}), stringify: () => '' },
    };
});

// cpa-iteration/tools.js captures SillyTavern.getContext() at module load.
// Install a stub bag BEFORE the dynamic imports in beforeAll so the module
// links cleanly. getContext returns a STABLE object so mutations from
// individual tests survive across calls.
const { default: __lodash } = await import('lodash');
const __testCtx = {
    lib: { lodash: __lodash, yaml: { parse: () => ({}), stringify: () => '' } },
    skills: {
        list: () => Promise.resolve([]),
        get: () => Promise.resolve(null),
        listFiles: () => Promise.resolve({ files: [] }),
        readFile: () => Promise.resolve(''),
        search: () => Promise.resolve({ hits: [] }),
        writeFile: () => Promise.resolve({ ok: true }),
        editFile: () => Promise.resolve({ ok: true }),
        install: () => Promise.resolve({ ok: true }),
        rename: () => Promise.resolve({ ok: true }),
        moveScope: () => Promise.resolve({ ok: true }),
        delete: () => Promise.resolve({ ok: true }),
    },
};
globalThis.SillyTavern = globalThis.SillyTavern || {
    getContext: () => __testCtx,
};

// public/script.js cascades into the macro engine and other browser-only
// runtime that doesn't resolve under jest. tools.js only uses
// generateQuietPrompt (and only when preset_simulate fires) — mock it to a
// canned reply so the rest of the file imports cleanly. Generate /
// eventSource / event_types are imported by the shared dry-run-capture
// helper (CPA's simulate path subscribes around the quiet generate to
// snapshot the real prompt) — stub them so the module link succeeds.
jest.unstable_mockModule('../../public/script.js', () => ({
    generateQuietPrompt: jest.fn(async () => 'mocked model reply'),
    Generate: jest.fn(async () => undefined),
    eventSource: { on: jest.fn(), makeLast: jest.fn(), removeListener: jest.fn() },
    event_types: { CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready', GENERATION_WORLD_INFO_FINALIZED: 'generation_world_info_finalized' },
    // skills/api.js (pulled transitively via cpa-iteration/tools.js →
    // iteration-library/tools/skill-iter-studio.js → skills/api.js) wraps
    // every fetch with getRequestHeaders(). The skill tools never fire
    // under these tests (no HTTP available), but module link requires the
    // export to exist.
    getRequestHeaders: jest.fn(() => ({})),
}));

// simulation-review/index.js pulls in popup-host which imports SillyTavern's
// popup.js — same browser-only cascade. Mock the public entry to a no-op
// review that returns a canned tagged-text envelope.
jest.unstable_mockModule('../../public/scripts/iteration-library/simulation-review/index.js', () => ({
    openSimulationReview: jest.fn(async () => ({
        ok: true,
        cancelled: false,
        toolResultText: '<simulation_result kind="cpa" ok="true">mock</simulation_result>',
        annotations: [],
        chainText: '<simulation_result kind="cpa" ok="true">mock</simulation_result>',
    })),
    buildSimulationToolResult: jest.fn(() => '<simulation_result kind="cpa" ok="true">mock</simulation_result>'),
}));

// iteration-library/tools/skill-iter-studio.js — CPA tools.js now imports
// runSkillIterStudioTool + commitApprovedSkillProposal directly from
// iter-lib (no more orchestrator getExtensionApi bridge). Mock the module
// so the auto-commit / proposal-stripping / error-passthrough behaviour
// is observable per-test via __mockRunSkill / __mockCommitSkill.
const __mockRunSkill = jest.fn();
const __mockCommitSkill = jest.fn();
jest.unstable_mockModule('../../public/scripts/iteration-library/tools/skill-iter-studio.js', () => ({
    SKILL_ITER_STUDIO_TOOL_DEFS: [],
    isSkillIterStudioTool: () => true,
    runSkillIterStudioTool: __mockRunSkill,
    commitApprovedSkillProposal: __mockCommitSkill,
}));

let buildToolCatalog;
let EDITABLE_TOOL_NAMES;
let READ_TOOL_NAMES;
let classifyToolCall;
let normalizeToolCallToEdit;
let TOOL_DISPLAY;
let isCpaControlCall;
let runCpaReadTool;

beforeAll(async () => {
    ({
        buildToolCatalog,
        EDITABLE_TOOL_NAMES,
        READ_TOOL_NAMES,
        classifyToolCall,
        normalizeToolCallToEdit,
        TOOL_DISPLAY,
        isCpaControlCall,
        runCpaReadTool,
    } = await import('../../public/scripts/extensions/completion-preset-assistant/cpa-iteration/tools.js'));
});

const call = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } });

describe('CPA — tools', () => {
    test('buildToolCatalog returns at least 17 tools, all with display labels', () => {
        // The full 17-tool catalog appears when hasReference=true. With
        // hasReference=false the catalog is 15 tools (preset_copy_from_reference
        // and preset_read_reference_fields are gated behind a selected reference).
        const catalog = buildToolCatalog({ hasReference: true });
        expect(catalog.length).toBeGreaterThanOrEqual(17);
        for (const def of catalog) {
            expect(def.type).toBe('function');
            expect(TOOL_DISPLAY[def.function.name]).toBeTruthy();
        }
    });

    test('buildToolCatalog includes reference-only tools when hasReference=true', () => {
        const base = buildToolCatalog({ hasReference: false });
        const withRef = buildToolCatalog({ hasReference: true });
        expect(withRef.length).toBeGreaterThanOrEqual(base.length);
    });

    test('preset_set_field → set edit with lodash.get oldValue', async () => {
        const live = { temperature: 0.7, deep: { nested: 'old' } };
        const edits = await normalizeToolCallToEdit(call('preset_set_field', { path: 'deep.nested', value: 'new' }), { live });
        expect(edits).toEqual([{ op: 'set', path: 'deep.nested', oldValue: 'old', newValue: 'new' }]);
    });

    test('preset_set_field accepts value_json for non-primitives', async () => {
        const live = { tools_array: [] };
        const edits = await normalizeToolCallToEdit(
            call('preset_set_field', { path: 'tools_array', value_json: '[{"id":1}]' }),
            { live },
        );
        expect(edits).toEqual([{ op: 'set', path: 'tools_array', oldValue: [], newValue: [{ id: 1 }] }]);
    });

    test('preset_str_replace → str_replace edit (unique-or-fail default, expected_count: 1)', async () => {
        const edits = await normalizeToolCallToEdit(
            call('preset_str_replace', { path: 'main', oldString: 'old', newString: 'new' }),
            { live: {} },
        );
        expect(edits).toEqual([{ op: 'str_replace', path: 'main', find: 'old', replace: 'new', expected_count: 1 }]);
    });

    test('preset_str_replace with replaceAll → expected_count matches live occurrence count', async () => {
        const edits = await normalizeToolCallToEdit(
            call('preset_str_replace', { path: 'main', oldString: 'X', newString: 'Y', replaceAll: true }),
            { live: { main: 'X and X and X' } },
        );
        expect(edits).toEqual([{ op: 'str_replace', path: 'main', find: 'X', replace: 'Y', expected_count: 3 }]);
    });

    test('preset_str_insert → str_insert edit', async () => {
        const edits = await normalizeToolCallToEdit(
            call('preset_str_insert', { path: 'main', after_text: 'foo', insert_text: 'bar' }),
            { live: { main: 'this has foo in it' } },
        );
        expect(edits[0]).toMatchObject({ op: 'str_insert', path: 'main', after_text: 'foo', insert_text: 'bar' });
    });

    test('classifyToolCall returns "editable" for editable tools, "control" otherwise', () => {
        expect(classifyToolCall(call('preset_set_field', {}))).toBe('editable');
        const allTools = buildToolCatalog({ hasReference: true }).map(d => d.function.name);
        const nonEditable = allTools.find(n => !EDITABLE_TOOL_NAMES.has(n));
        if (nonEditable) {
            expect(classifyToolCall(call(nonEditable, {}))).toBe('control');
        }
    });

    test('malformed JSON args → returns null', async () => {
        const bad = { function: { name: 'preset_set_field', arguments: '{not json' } };
        const edits = await normalizeToolCallToEdit(bad, { live: {} });
        expect(edits).toBeNull();
    });
});

describe('CPA control tools — program-driven auto-continue', () => {
    test('buildToolCatalog does NOT include luker_cpa_continue_iteration (legacy, removed)', () => {
        const catalog = buildToolCatalog({ hasReference: true });
        const names = catalog.map(d => d.function?.name);
        // The continue tool was retired — the multi-round loop is now
        // program-driven by tool-call presence (any tool call → next round,
        // none → stop).
        expect(names).not.toContain('luker_cpa_continue_iteration');
    });

    test('buildToolCatalog does NOT include luker_cpa_finalize_iteration (legacy, removed)', () => {
        const catalog = buildToolCatalog({ hasReference: true });
        const names = catalog.map(d => d.function?.name);
        expect(names).not.toContain('luker_cpa_finalize_iteration');
    });

    test('the catalog has no control tools (hasReference is irrelevant for them)', () => {
        const catalog = buildToolCatalog({ hasReference: false });
        const names = catalog.map(d => d.function?.name);
        expect(names).not.toContain('luker_cpa_continue_iteration');
        expect(names).not.toContain('luker_cpa_finalize_iteration');
    });

    test('isCpaControlCall returns false for edit tools and the legacy continue / finalize names', () => {
        // CPA has no popup-side control tools today. A legacy emission of
        // continue / finalize from a stale session replay must NOT route
        // through onControlCall — it should pass through onToolCall and
        // normalize to a no-op edit.
        expect(isCpaControlCall({ name: 'luker_cpa_continue_iteration' })).toBe(false);
        expect(isCpaControlCall({ name: 'luker_cpa_finalize_iteration' })).toBe(false);
        expect(isCpaControlCall({ name: 'preset_set_field' })).toBe(false);
        expect(isCpaControlCall({ name: '' })).toBe(false);
        expect(isCpaControlCall({})).toBe(false);
        expect(isCpaControlCall(null)).toBe(false);
        expect(isCpaControlCall(undefined)).toBe(false);
    });
});

describe('CPA — preset_clone_to_new (proposal-mode read tool)', () => {
    test('buildToolCatalog exposes preset_clone_to_new with or without reference', () => {
        for (const hasReference of [false, true]) {
            const names = buildToolCatalog({ hasReference }).map(d => d.function?.name);
            expect(names).toContain('preset_clone_to_new');
        }
    });

    test('schema is strict (additionalProperties: false) and requires new_name', () => {
        const def = buildToolCatalog({ hasReference: false })
            .find(d => d.function?.name === 'preset_clone_to_new');
        expect(def).toBeDefined();
        expect(def.function.parameters.required).toEqual(['new_name']);
        expect(def.function.parameters.additionalProperties).toBe(false);
        expect(def.function.parameters.properties).toHaveProperty('new_name');
        expect(def.function.parameters.properties).toHaveProperty('reason');
    });

    test('TOOL_DISPLAY contains preset_clone_to_new', () => {
        expect(TOOL_DISPLAY.preset_clone_to_new).toBeTruthy();
    });

    test('READ_TOOL_NAMES contains preset_clone_to_new (routed through read dispatcher)', () => {
        expect(READ_TOOL_NAMES.has('preset_clone_to_new')).toBe(true);
    });

    test('runCpaReadTool returns a pendingCloneEdit envelope and does NOT invoke ctx.cloneAndSwitchTarget', async () => {
        // The dispatcher defers the actual clone to Apply time — studio.js
        // parks the pending envelope on state.pendingCloneEdits for user
        // review, then commitApprovedCloneEditsForCpa calls
        // ctx.cloneAndSwitchTarget at that point. The dispatcher must NOT
        // call it here; verify by spying.
        const spy = jest.fn(async () => ({ ok: true }));
        const ctx = { cloneAndSwitchTarget: spy, presetName: 'source-preset' };
        const out = await runCpaReadTool({ name: 'preset_clone_to_new', args: { new_name: 'foo' } }, ctx);
        expect(spy).not.toHaveBeenCalled();
        expect(out.ok).toBe(true);
        expect(out.result.proposed).toBe(true);
        expect(out.result.new_preset_name).toBe('foo');
        expect(out.result.source_preset_name).toBe('source-preset');
        expect(out.pendingCloneEdit).toEqual({
            kind: 'clone',
            sourceName: 'source-preset',
            newName: 'foo',
            op: { newName: 'foo' },
        });
    });

    test('runCpaReadTool reports unavailable when ctx.cloneAndSwitchTarget is missing', async () => {
        const out = await runCpaReadTool({ name: 'preset_clone_to_new', args: { new_name: 'foo' } }, {});
        expect(out.ok).toBe(false);
        expect(out.error).toMatch(/not wired/);
    });

    test('runCpaReadTool returns an error when new_name is missing or empty', async () => {
        const ctx = { cloneAndSwitchTarget: async () => ({ ok: true }) };
        const noName = await runCpaReadTool({ name: 'preset_clone_to_new', args: {} }, ctx);
        expect(noName.ok).toBe(false);
        expect(noName.error).toMatch(/non-empty new_name/);

        const empty = await runCpaReadTool({ name: 'preset_clone_to_new', args: { new_name: '   ' } }, ctx);
        expect(empty.ok).toBe(false);
        expect(empty.error).toMatch(/non-empty new_name/);
    });

    test('runCpaReadTool surfaces the host duplicate-name pre-check error before proposing', async () => {
        // When the host exposes checkPresetNameAvailable, a duplicate name
        // is rejected synchronously — the AI never sees a pending card for
        // a clone that would fail at commit time anyway.
        const ctx = {
            cloneAndSwitchTarget: async () => ({ ok: true }),
            checkPresetNameAvailable: (name) => ({
                exists: name === 'taken',
                canonical: name === 'taken' ? 'Taken' : null,
            }),
            presetName: 'source-preset',
        };
        const out = await runCpaReadTool({ name: 'preset_clone_to_new', args: { new_name: 'taken' } }, ctx);
        expect(out.ok).toBe(false);
        expect(out.error).toMatch(/already exists/);
        // Fresh name still proposes normally.
        const freshOut = await runCpaReadTool({ name: 'preset_clone_to_new', args: { new_name: 'fresh' } }, ctx);
        expect(freshOut.ok).toBe(true);
        expect(freshOut.pendingCloneEdit).toBeDefined();
    });
});

describe('CPA — preset_str_insert / preset_str_delete expected_count (CPA-9)', () => {
    test('preset_str_insert enforces uniqueness — throws on ambiguous anchor', async () => {
        await expect(normalizeToolCallToEdit(
            call('preset_str_insert', { path: 'main', after_text: 'foo', insert_text: 'bar' }),
            { live: { main: 'foo foo' } },
        )).rejects.toThrow(/expected 1 match.*found 2/);
    });

    test('preset_str_insert enforces uniqueness — throws when anchor missing', async () => {
        await expect(normalizeToolCallToEdit(
            call('preset_str_insert', { path: 'main', after_text: 'missing', insert_text: 'x' }),
            { live: { main: 'no anchor here' } },
        )).rejects.toThrow(/expected 1 match.*found 0/);
    });

    test('preset_str_delete enforces uniqueness — throws on ambiguous anchor', async () => {
        await expect(normalizeToolCallToEdit(
            call('preset_str_delete', { path: 'main', find: 'dup' }),
            { live: { main: 'dup dup' } },
        )).rejects.toThrow(/expected 1 match.*found 2/);
    });

    test('preset_str_insert / preset_str_delete reject expected_count > 1 (engine only supports unique anchors)', async () => {
        await expect(normalizeToolCallToEdit(
            call('preset_str_insert', { path: 'main', after_text: 'foo', insert_text: 'x', expected_count: 2 }),
            { live: { main: 'foo foo' } },
        )).rejects.toThrow(/expected_count = 1/);
    });

    test('preset_str_delete with unique anchor → str_delete edit', async () => {
        const edits = await normalizeToolCallToEdit(
            call('preset_str_delete', { path: 'main', find: 'gone' }),
            { live: { main: 'before gone after' } },
        );
        expect(edits[0]).toMatchObject({ op: 'str_delete', path: 'main', find: 'gone' });
    });
});

// ─────────────────────────────────────────────────────────────────────
// runCpaSkillTool — delegates to iteration-library/tools/skill-iter-studio
// (the shared tool dispatcher). The iter-studio's authoring tools moved
// to proposal-mode (return pendingSkillEdit instead of writing inline),
// and CPA now mirrors orch iter-studio: park the proposal on
// state.pendingSkillEdits for per-card user review, commit at Apply time
// through commitApprovedSkillProposal. The dispatcher transparently
// forwards the envelope to studio.js.
//
// The iter-lib module is mocked at the top of this file so
// __mockRunSkill / __mockCommitSkill can be tuned per-test.
// ─────────────────────────────────────────────────────────────────────
describe('CPA — runCpaSkillTool (proposal-mode passthrough)', () => {
    let runCpaSkillTool;

    beforeAll(async () => {
        ({ runCpaSkillTool } = await import('../../public/scripts/extensions/completion-preset-assistant/cpa-iteration/tools.js'));
    });

    beforeEach(() => {
        __mockRunSkill.mockReset();
        __mockCommitSkill.mockReset();
    });

    test('proposal-mode (pendingSkillEdit) → passes envelope through, does NOT commit', async () => {
        const proposal = {
            kind: 'content',
            skillName: 'foo',
            scope: { kind: 'global' },
            path: 'SKILL.md',
            before: 'OLD',
            after: 'NEW',
            op: { name: 'skill_update_content', args: { scope: { kind: 'global' }, name: 'foo', path: 'SKILL.md', content: 'NEW' } },
        };
        __mockRunSkill.mockResolvedValue({
            ok: true,
            result: { ok: true, proposed: true, kind: 'content', skill: 'foo' },
            pendingSkillEdit: proposal,
        });
        const out = await runCpaSkillTool({ name: 'skill_update_content', args: { name: 'foo', path: 'SKILL.md', content: 'NEW' } });
        expect(out.ok).toBe(true);
        // Commit happens at Apply time inside studio.js, NOT here.
        expect(__mockCommitSkill).not.toHaveBeenCalled();
        // The pendingSkillEdit envelope rides through to studio so it can
        // park the proposal on state.pendingSkillEdits.
        expect(out.pendingSkillEdit).toEqual(proposal);
        expect(out.result.proposed).toBe(true);
    });

    test('pendingEdit (from policy-binding tools) is stripped — never reaches CPA preset pipeline', async () => {
        __mockRunSkill.mockResolvedValue({
            ok: true,
            result: { ok: true, agentId: 'main', skillName: 'foo', list: 'visible' },
            pendingEdit: { op: 'set', path: '', oldValue: {}, newValue: {} },
        });
        const out = await runCpaSkillTool({ name: 'skill_bind_to_agent', args: { agentId: 'main', skillName: 'foo', list: 'visible' } });
        expect(out.ok).toBe(true);
        expect(out).not.toHaveProperty('pendingEdit');
        expect(__mockCommitSkill).not.toHaveBeenCalled();
    });

    test('inventory tools (no proposal) pass through verbatim', async () => {
        __mockRunSkill.mockResolvedValue({
            ok: true,
            result: { inventory: [{ name: 'foo', description: 'd' }] },
        });
        const out = await runCpaSkillTool({ name: 'skill_list_visible', args: {} });
        expect(out.ok).toBe(true);
        expect(out.result.inventory).toHaveLength(1);
        expect(__mockCommitSkill).not.toHaveBeenCalled();
    });

    test('failed dispatch surfaces unchanged', async () => {
        __mockRunSkill.mockResolvedValue({ ok: false, error: 'bad args' });
        const out = await runCpaSkillTool({ name: 'skill_create', args: {} });
        expect(out.ok).toBe(false);
        expect(out.error).toBe('bad args');
        expect(__mockCommitSkill).not.toHaveBeenCalled();
    });
});
