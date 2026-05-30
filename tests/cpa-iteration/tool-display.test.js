// tests/cpa-iteration/tool-display.test.js
import { jest } from '@jest/globals';

// public/lib.js pulls in a browser bundle that can't be resolved under jest.
// Mirror the workaround used by tests/cpa-iteration/tools.test.js: stub the
// facade to a thin { lodash } re-export so the transitive import in tools.js
// resolves without dragging the bundle in.
jest.unstable_mockModule('../../public/lib.js', async () => {
    const { default: lodash } = await import('lodash');
    return { lodash };
});

// public/script.js + simulation-review/index.js are pulled in by tools.js
// (for the simulate-prompt → real generate + popup flow) and cascade into
// browser-only runtime under jest. Mock both at the module boundary so the
// tool-display registry import resolves cleanly. The Generate / eventSource /
// event_types stubs are required by the shared dry-run-capture helper.
jest.unstable_mockModule('../../public/script.js', () => ({
    generateQuietPrompt: jest.fn(async () => 'mocked model reply'),
    Generate: jest.fn(async () => undefined),
    eventSource: { on: jest.fn(), makeLast: jest.fn(), removeListener: jest.fn() },
    event_types: { CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready', GENERATION_WORLD_INFO_FINALIZED: 'generation_world_info_finalized' },
}));
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

let CPA_TOOL_DISPLAY;

beforeAll(async () => {
    ({ CPA_TOOL_DISPLAY } = await import(
        '../../public/scripts/extensions/completion-preset-assistant/cpa-iteration/tool-display.js'
    ));
});

describe('CPA tool-display map', () => {
    it('exposes friendly label for preset_set_field', () => {
        expect(CPA_TOOL_DISPLAY.preset_set_field?.label).toMatch(/Set preset field|设置预设字段/);
        expect(CPA_TOOL_DISPLAY.preset_set_field?.icon).toBe('✏️');
        expect(CPA_TOOL_DISPLAY.preset_set_field?.type).toBe('edit');
    });

    it('classifies preset_read_live_fields as read with summarize that uses result', () => {
        const entry = CPA_TOOL_DISPLAY.preset_read_live_fields;
        expect(entry.type).toBe('read');
        expect(typeof entry.summarize).toBe('function');
        expect(entry.summarize({ paths: ['a', 'b'] }, { a: 1, b: 2 })).toMatch(/2/);
    });

    it('covers every CPA tool name listed in cpa-iteration/tools.js', async () => {
        const tools = await import(
            '../../public/scripts/extensions/completion-preset-assistant/cpa-iteration/tools.js'
        );
        // tools.TOOL_DISPLAY is the authoritative registry the studio uses to
        // resolve tool-name → fallback metadata. Every key in that map must
        // have a CPA_TOOL_DISPLAY entry so the new shared chip never falls
        // back to the generic '(tool)' rendering for a known CPA tool.
        const allNames = Object.keys(tools.TOOL_DISPLAY || {});
        expect(allNames.length).toBeGreaterThan(0);
        for (const name of allNames) {
            expect(CPA_TOOL_DISPLAY[name]).toBeDefined();
        }
    });

    it('contains preset_clone_to_new entry with read-type summarize that surfaces the new name', () => {
        const entry = CPA_TOOL_DISPLAY.preset_clone_to_new;
        expect(entry).toBeDefined();
        expect(entry.type).toBe('read');
        expect(typeof entry.summarize).toBe('function');
        // Successful clone result → "Cloned to <new_name>"
        const ok = entry.summarize({ new_name: 'foo' }, { new_name: 'foo' }, (s) => String(s ?? ''));
        expect(ok).toMatch(/Cloned to foo/);
        // Error result → ❌ prefix with truncated message
        const err = entry.summarize({ new_name: 'foo' }, { error: 'duplicate name' }, (s) => String(s ?? ''));
        expect(err).toMatch(/❌/);
        expect(err).toMatch(/duplicate name/);
        // Pre-result placeholder → just the arg new_name
        const pre = entry.summarize({ new_name: 'pending' }, null, (s) => String(s ?? ''));
        expect(pre).toBe('pending');
    });
});

describe('CPA — preset_list_insert summarize (CPA-2)', () => {
    it('renders "after N" when anchor.after is set', () => {
        const entry = CPA_TOOL_DISPLAY.preset_list_insert;
        expect(entry.summarize({ path: 'prompts', anchor: { after: 3 } })).toBe('prompts @ after 3');
    });

    it('renders "before N" when anchor.before is set', () => {
        const entry = CPA_TOOL_DISPLAY.preset_list_insert;
        expect(entry.summarize({ path: 'prompts', anchor: { before: 0 } })).toBe('prompts @ before 0');
    });

    it('renders "?" when anchor is missing', () => {
        const entry = CPA_TOOL_DISPLAY.preset_list_insert;
        expect(entry.summarize({ path: 'prompts' })).toBe('prompts @ ?');
    });

    it('does not regress to anchor.after = 0 falsy bug', () => {
        // anchor.after = 0 is a real valid index — make sure the summarize
        // doesn't treat it as missing due to truthy check.
        const entry = CPA_TOOL_DISPLAY.preset_list_insert;
        expect(entry.summarize({ path: 'p', anchor: { after: 0 } })).toBe('p @ after 0');
    });
});

describe('CPA — preset_list_move summarize (CPA-2)', () => {
    it('reads from_index / to_index (the tool emits those, not from / to)', () => {
        const entry = CPA_TOOL_DISPLAY.preset_list_move;
        expect(entry.summarize({ path: 'prompts', from_index: 2, to_index: 5 })).toBe('prompts: 2 → 5');
    });

    it('renders "?" when indices missing', () => {
        const entry = CPA_TOOL_DISPLAY.preset_list_move;
        expect(entry.summarize({ path: 'prompts' })).toBe('prompts: ? → ?');
    });

    it('does not regress to from = 0 falsy bug', () => {
        const entry = CPA_TOOL_DISPLAY.preset_list_move;
        expect(entry.summarize({ path: 'p', from_index: 0, to_index: 1 })).toBe('p: 0 → 1');
    });
});

describe('CPA — read-tool error result renders error summary (CPA-3)', () => {
    const identity = (s) => String(s ?? '');

    it('preset_read_live_fields error result renders error label, not "Returned N values"', () => {
        const entry = CPA_TOOL_DISPLAY.preset_read_live_fields;
        const out = entry.summarize({ paths: ['a'] }, { error: 'No reference preset is selected.' }, identity);
        expect(out).toMatch(/❌/);
        expect(out).toMatch(/No reference preset/);
        expect(out).not.toMatch(/Returned/);
    });

    it('preset_read_reference_fields error result renders error label', () => {
        const entry = CPA_TOOL_DISPLAY.preset_read_reference_fields;
        const out = entry.summarize({ paths: ['x'] }, { error: 'boom' }, identity);
        expect(out).toMatch(/❌ boom/);
    });

    it('preset_diff_reference error result renders error label, not "N fields differ"', () => {
        const entry = CPA_TOOL_DISPLAY.preset_diff_reference;
        const out = entry.summarize({}, { error: 'no reference' }, identity);
        expect(out).toMatch(/❌/);
        expect(out).not.toMatch(/fields differ/);
    });

    it('preset_simulate error result renders error label, not "Assembled N chars"', () => {
        const entry = CPA_TOOL_DISPLAY.preset_simulate;
        const out = entry.summarize({}, { error: 'simulator unavailable' }, identity);
        expect(out).toMatch(/❌/);
        expect(out).not.toMatch(/Assembled/);
    });

    it('preset_diff_reference success result still renders "N fields differ"', () => {
        const entry = CPA_TOOL_DISPLAY.preset_diff_reference;
        const out = entry.summarize({}, { differing_paths: ['a', 'b'] }, identity);
        expect(out).toMatch(/2 fields differ/);
    });

    it('preset_simulate success result still renders "Assembled N chars"', () => {
        const entry = CPA_TOOL_DISPLAY.preset_simulate;
        const out = entry.summarize({}, { assembled_length: 1234 }, identity);
        expect(out).toMatch(/Assembled 1234 chars/);
    });

    it('long error messages are truncated to 40 chars', () => {
        const entry = CPA_TOOL_DISPLAY.preset_read_live_fields;
        const longErr = 'x'.repeat(200);
        const out = entry.summarize({ paths: [] }, { error: longErr }, identity);
        // Error portion (after the ❌ + space) should be <= 40 chars.
        // We test by extracting the post-prefix tail and capping at 40.
        const match = out.match(/❌ (.+)/);
        expect(match?.[1]?.length).toBeLessThanOrEqual(40);
    });
});
