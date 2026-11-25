import { jest, afterEach } from '@jest/globals';
import { installBrowserModuleContext } from '../util/browser-module-context.js';
import { STATE_ERROR_REASONS } from '../../public/scripts/lib/state-errors.js';
import { LOREBOOK_READ_TOOL_DEFS } from '../../public/scripts/iteration-library/tools/lorebook-reads.js';
import { CHARACTER_PRESET_READ_TOOL_DEFS } from '../../public/scripts/iteration-library/tools/character-presets-reads.js';

jest.unstable_mockModule('../../public/lib.js', async () => {
    const { default: lodash } = await import('lodash');
    return { lodash };
});

let tools;
beforeAll(async () => {
    tools = await import('../../public/scripts/workbench/targets/card-tools.js');
});

describe('unified CEA editor tools.js', () => {
    it('isCeaEditorReadTool classifies helpers correctly', () => {
        expect(tools.isCeaEditorReadTool('lorebook_query')).toBe(true);
        expect(tools.isCeaEditorReadTool('lorebook_list')).toBe(true);
        expect(tools.isCeaEditorReadTool('lorebook_get')).toBe(true);
        expect(tools.isCeaEditorReadTool('world_book_list')).toBe(true);
        expect(tools.isCeaEditorReadTool('web_search')).toBe(true);
        expect(tools.isCeaEditorReadTool('simulate_prompt')).toBe(true);
        expect(tools.isCeaEditorReadTool('cea_set_card_field')).toBe(false);
        expect(tools.isCeaEditorReadTool('cea_update_lorebook_entry')).toBe(false);
        expect(tools.isCeaEditorReadTool('luker_cea_editor_continue_iteration')).toBe(false);
        expect(tools.isCeaEditorReadTool('')).toBe(false);
        expect(tools.isCeaEditorReadTool(null)).toBe(false);
    });

    it('classifies the shared preset read tool as a read tool', () => {
        expect(tools.isCeaEditorReadTool('inspect_bound_preset')).toBe(true);
        expect(tools.isCeaEditorReadTool('cea_read_card_fields')).toBe(true);
    });

    it('read catalog splices the shared lorebook and preset definitions unchanged', () => {
        const set = tools.buildCeaEditorToolSet({}, {}, { hasSearchTools: true });
        const names = set.map(t => t.function?.name);
        expect(names.slice(names.indexOf('cea_read_card_fields'))).toEqual([
            'cea_read_card_fields',
            'world_book_list',
            'lorebook_list',
            'lorebook_query',
            'lorebook_get',
            'inspect_bound_preset',
            'simulate_prompt',
            'web_search',
        ]);
        for (const def of LOREBOOK_READ_TOOL_DEFS) {
            expect(set.find(t => t.function?.name === def.function.name)).toBe(def);
        }
        expect(set.find(t => t.function?.name === 'inspect_bound_preset')).toBe(CHARACTER_PRESET_READ_TOOL_DEFS[0]);
    });

    it('normalizeToolCallToEdit annotates character target for cea_set_card_field', async () => {
        const edits = await tools.normalizeToolCallToEdit(
            { id: 'c1', name: 'cea_set_card_field', args: { field: 'description', value: 'new' } },
            { context: {}, live: { character: { description: 'old' } } },
        );
        expect(Array.isArray(edits)).toBe(true);
        expect(edits.length).toBeGreaterThan(0);
        expect(edits[0].target?.kind).toBe('character');
    });

    it('normalizeToolCallToEdit annotates character target for cea_str_replace_card_field', async () => {
        // Use the correct arg names (oldString/newString, not the legacy
        // engine-op find/replace) and make sure the anchor is present in
        // the live value exactly once — pre-refactor this test slipped
        // through with find:'a' / description:'abc' and a silent
        // expected_count:1 fallback that would have failed at the
        // engine layer. That silent coercion is now the anchor-drift
        // diagnosis path ([[project_iter_studio_noop_error_contract]]).
        const edits = await tools.normalizeToolCallToEdit(
            { id: 'c1b', name: 'cea_str_replace_card_field', args: { field: 'description', oldString: 'unique-phrase', newString: 'zz' } },
            { context: {}, live: { character: { description: 'prefix unique-phrase suffix' } } },
        );
        expect(Array.isArray(edits)).toBe(true);
        expect(edits.length).toBeGreaterThan(0);
        expect(edits[0].target?.kind).toBe('character');
        expect(edits[0].op).toBe('str_replace');
        expect(edits[0].find).toBe('unique-phrase');
        expect(edits[0].replace).toBe('zz');
    });

    it('normalizeToolCallToEdit annotates lorebook target with bookName when book_name is present', async () => {
        const edits = await tools.normalizeToolCallToEdit(
            { id: 'c2', name: 'cea_update_lorebook_entry', args: { book_name: 'BookA', uid: 3, patch: { content: 'x' } } },
            { context: {}, live: { lorebooks: { BookA: { entries: { 3: { content: 'old' } } } } } },
        );
        expect(Array.isArray(edits)).toBe(true);
        expect(edits.length).toBeGreaterThan(0);
        expect(edits[0].target?.kind).toBe('lorebook');
        expect(edits[0].target?.bookName).toBe('BookA');
    });

    it('normalizeToolCallToEdit annotates lorebook target for cea_add_lorebook_entry', async () => {
        const edits = await tools.normalizeToolCallToEdit(
            { id: 'c3', name: 'cea_add_lorebook_entry', args: { book_name: 'BookB', entry: { uid: 7, content: 'hi' } } },
            { context: {}, live: { lorebooks: { BookB: { entries: {} } } } },
        );
        expect(Array.isArray(edits)).toBe(true);
        expect(edits.length).toBeGreaterThan(0);
        expect(edits[0].target?.kind).toBe('lorebook');
        expect(edits[0].target?.bookName).toBe('BookB');
    });

    it('normalizeToolCallToEdit annotates lorebook target for cea_remove_lorebook_entry', async () => {
        const edits = await tools.normalizeToolCallToEdit(
            { id: 'c4', name: 'cea_remove_lorebook_entry', args: { book_name: 'BookC', uid: 5 } },
            { context: {}, live: { lorebooks: { BookC: { entries: { 5: { content: 'doomed' } } } } } },
        );
        expect(Array.isArray(edits)).toBe(true);
        expect(edits.length).toBeGreaterThan(0);
        expect(edits[0].target?.kind).toBe('lorebook');
        expect(edits[0].target?.bookName).toBe('BookC');
    });

    it('normalizeToolCallToEdit annotates lorebook target for cea_set_lorebook_metadata', async () => {
        const edits = await tools.normalizeToolCallToEdit(
            { id: 'c5', name: 'cea_set_lorebook_metadata', args: { book_name: 'BookD', key: 'scan_depth', value: 12 } },
            { context: {}, live: { lorebooks: { BookD: {} } } },
        );
        expect(Array.isArray(edits)).toBe(true);
        expect(edits.length).toBeGreaterThan(0);
        expect(edits[0].target?.kind).toBe('lorebook');
        expect(edits[0].target?.bookName).toBe('BookD');
    });

    it('normalizeToolCallToEdit rejects cea_set_lorebook_metadata with key === bookName immediately', async () => {
        await expect(tools.normalizeToolCallToEdit(
            { id: 'c5b', name: 'cea_set_lorebook_metadata', args: { book_name: 'BookD', key: 'bookName', value: 'Renamed' } },
            { context: {}, live: { lorebooks: { BookD: {} } } },
        )).rejects.toThrow(/bookName/);
    });

    it('normalizeToolCallToEdit rejects a lorebook edit without book_name when no single book can be inferred', async () => {
        await expect(tools.normalizeToolCallToEdit(
            { id: 'c6', name: 'cea_update_lorebook_entry', args: { uid: 1, patch: {} } },
            { context: {}, live: {} },
        )).rejects.toThrow(/^cea_update_lorebook_entry: invalid_args — book_name is required/);
    });

    it('normalizeToolCallToEdit infers the only live book when book_name is missing', async () => {
        const edits = await tools.normalizeToolCallToEdit(
            { id: 'c7', name: 'cea_update_lorebook_entry', args: { uid: 1, patch: { content: 'x' } } },
            { context: {}, live: { lorebooks: { BookE: { entries: { 1: { content: 'old' } } } } } },
        );
        expect(edits[0].target).toEqual({ kind: 'lorebook', bookName: 'BookE' });
        expect(edits[0].before).toEqual({ content: 'old' });
    });

    it('normalizeToolCallToEdit returns null when args fail to parse / are malformed', async () => {
        // Malformed call returns null (distinct from [] which means
        // "valid call but no edits").
        const out = await tools.normalizeToolCallToEdit(
            { id: 'bad', name: 'cea_set_card_field', args: 'not-an-object' },
            { context: {}, live: {} },
        );
        // Either null (malformed) or [] (no-op) is acceptable here; both signal
        // "nothing to apply". We just must not crash.
        expect(out === null || Array.isArray(out)).toBe(true);
    });

    // The next three cases pin behavior that used to silently return [] —
    // collapsing anchor / argument failures onto the iter-studio's generic
    // "likely already matches" noop, which made the AI think a broken patch
    // had succeeded. They now throw with an explicit code so studio.js's
    // catch arm surfaces a real `{ error: '...' }` tool result.
    it('cea_str_replace_lorebook_entry_field throws not_found when oldString is absent', async () => {
        await expect(tools.normalizeToolCallToEdit(
            { id: 'a1', name: 'cea_str_replace_lorebook_entry_field', args: { book_name: 'BookA', uid: 3, field: 'content', oldString: 'absent', newString: 'x' } },
            { context: {}, live: { lorebooks: { BookA: { entries: { 3: { content: 'hello world' } } } } } },
        )).rejects.toThrow(/not_found/);
    });

    it('cea_str_replace_lorebook_entry_field not_found error carries structured envelope (anchor-drift diagnosis)', async () => {
        // The thrown Error must carry an `envelope` property so
        // studio.js's catch arm surfaces a machine-readable
        // `{error:'not_found', match_diagnosis, next_step, currentLength}`
        // payload instead of a flat `{error: '<message>'}` string. This
        // is the read-first refactor's structural contract — the AI has
        // to see WHY the anchor missed and which read call resolves
        // it, without a second reasoning round-trip.
        let caught = null;
        try {
            await tools.normalizeToolCallToEdit(
                { id: 'diag1', name: 'cea_str_replace_lorebook_entry_field', args: { book_name: 'BookA', uid: 3, field: 'content', oldString: 'absent', newString: 'x' } },
                { context: {}, live: { lorebooks: { BookA: { entries: { 3: { content: 'hello world' } } } } } },
            );
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeTruthy();
        expect(caught.envelope).toBeTruthy();
        expect(caught.envelope.error).toBe('not_found');
        expect(typeof caught.envelope.currentLength).toBe('number');
        expect(caught.envelope.match_diagnosis).toBeTruthy();
        expect(typeof caught.envelope.next_step).toBe('string');
        expect(caught.envelope.next_step.length).toBeGreaterThan(0);
    });

    it('cea_str_replace_card_field throws not_found + envelope on anchor miss (pre-refactor: silent expected_count:1 fallback)', async () => {
        // Pre-refactor: `find:'nope' / expected_count: 0 → Math.max(1,0)=1`
        // fell through and let the engine reject the edit with a
        // generic conflict — no structured diagnosis for the AI. Now
        // the tools.js normalize step pre-validates and throws with
        // an envelope carrying the match_diagnosis.
        let caught = null;
        try {
            await tools.normalizeToolCallToEdit(
                { id: 'diag2', name: 'cea_str_replace_card_field', args: { field: 'description', oldString: 'never-in-source', newString: 'zz' } },
                { context: {}, live: { character: { description: 'a completely different string' } } },
            );
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeTruthy();
        expect(caught.envelope?.error).toBe('not_found');
        expect(caught.envelope?.match_diagnosis).toBeTruthy();
        expect(caught.envelope?.next_step).toContain('cea_read_card_fields');
    });

    it('cea_str_replace_lorebook_entry_field throws multiple_matches when oldString is ambiguous without replaceAll', async () => {
        await expect(tools.normalizeToolCallToEdit(
            { id: 'a2', name: 'cea_str_replace_lorebook_entry_field', args: { book_name: 'BookA', uid: 3, field: 'content', oldString: 'x', newString: 'y' } },
            { context: {}, live: { lorebooks: { BookA: { entries: { 3: { content: 'xxx' } } } } } },
        )).rejects.toThrow(/multiple_matches/);
    });

    it('cea_str_replace_lorebook_entry_field throws invalid_args when field or oldString is empty', async () => {
        await expect(tools.normalizeToolCallToEdit(
            { id: 'a3', name: 'cea_str_replace_lorebook_entry_field', args: { book_name: 'BookA', uid: 3, field: '', oldString: 'x', newString: 'y' } },
            { context: {}, live: { lorebooks: { BookA: { entries: { 3: { content: 'x' } } } } } },
        )).rejects.toThrow(/invalid_args/);
        await expect(tools.normalizeToolCallToEdit(
            { id: 'a4', name: 'cea_str_replace_lorebook_entry_field', args: { book_name: 'BookA', uid: 3, field: 'content', oldString: '', newString: 'y' } },
            { context: {}, live: { lorebooks: { BookA: { entries: { 3: { content: 'x' } } } } } },
        )).rejects.toThrow(/invalid_args/);
    });

    describe('runCeaEditorReadTool routing', () => {
        const HARBOR_BOOK = {
            entries: {
                3: {
                    uid: 3,
                    comment: 'Bryn harbor',
                    key: ['harbor', 'breakwater'],
                    keysecondary: [],
                    content: 'The Bryn harbor wall was raised after the great surge.',
                    order: 100,
                },
            },
        };
        function makeLoreContext() {
            return {
                characters: [],
                getWorldInfoNames: () => ['bryn-headland'],
                loadWorldInfo: async (name) => (name === 'bryn-headland' ? structuredClone(HARBOR_BOOK) : null),
            };
        }

        it('dispatches lorebook_query to the shared executor and returns its envelope', async () => {
            const out = await tools.runCeaEditorReadTool(
                { id: 'r1', name: 'lorebook_query', args: { book_name: 'bryn-headland', text: 'harbor' } },
                { context: makeLoreContext() },
            );
            expect(out).toEqual({
                ok: true,
                result: {
                    book_name: 'bryn-headland',
                    total_hits: 1,
                    entries: [{
                        uid: 3,
                        comment: 'Bryn harbor',
                        key: ['harbor', 'breakwater'],
                        keysecondary: [],
                        selective_logic: 'AND_ANY',
                        constant: false,
                        enabled: true,
                        match_fields: ['comment', 'key', 'content'],
                        matched_excerpt: 'The Bryn harbor wall was raised after the great surge.',
                    }],
                },
            });
        });

        it('surfaces shared-executor validation failures with their reason code', async () => {
            const out = await tools.runCeaEditorReadTool(
                { id: 'r2', name: 'lorebook_query', args: { book_name: 'bryn-headland' } },
                { context: makeLoreContext() },
            );
            expect(out.ok).toBe(false);
            expect(out.reason).toBe(STATE_ERROR_REASONS.VALIDATION_ARGS);
            expect(typeof out.error).toBe('string');
        });

        describe('web_search', () => {
            let browserEnv = null;
            afterEach(() => {
                browserEnv?.restore();
                browserEnv = null;
            });
            function installSearchTools(invoke) {
                browserEnv?.restore();
                browserEnv = installBrowserModuleContext({}, {
                    hostProperties: {
                        searchTools: {
                            toolNames: { SEARCH: 'luker_web_search', VISIT: 'luker_web_visit' },
                            getToolDefs: () => [],
                            isToolName: () => true,
                            invoke,
                        },
                    },
                });
            }

            it('maps limit to max_results and forwards the abort signal', async () => {
                const invoke = jest.fn(async (call) => ({ provider: 'searxng', query: call.args.query, result_count: 0, results: [] }));
                installSearchTools(invoke);
                const ac = new AbortController();
                const out = await tools.runCeaEditorReadTool(
                    { id: 'w1', name: 'web_search', args: { query: 'Bryn reef tide tables', limit: 3 } },
                    { context: {}, abortSignal: ac.signal },
                );
                expect(invoke).toHaveBeenCalledTimes(1);
                const [sentCall, sentOpts] = invoke.mock.calls[0];
                expect(sentCall).toEqual({ name: 'luker_web_search', args: { query: 'Bryn reef tide tables', limit: 3, max_results: 3 } });
                expect(sentOpts.abortSignal).toBe(ac.signal);
                expect(out).toEqual({ ok: true, result: { provider: 'searxng', query: 'Bryn reef tide tables', result_count: 0, results: [] } });
            });

            it('keeps an explicit max_results', async () => {
                const invoke = jest.fn(async () => ({ results: [] }));
                installSearchTools(invoke);
                await tools.runCeaEditorReadTool(
                    { id: 'w2', name: 'web_search', args: { query: 'salt-mark drifters', limit: 3, max_results: 5 } },
                    { context: {} },
                );
                expect(invoke.mock.calls[0][0].args.max_results).toBe(5);
            });

            it('reports the tool as unavailable without the search-tools API', async () => {
                browserEnv?.restore();
                browserEnv = null;
                expect(tools.hasCeaSearchTools()).toBe(false);
                const out = await tools.runCeaEditorReadTool({ id: 'w3', name: 'web_search', args: { query: 'x' } }, { context: {} });
                expect(out.ok).toBe(false);
                installSearchTools(jest.fn(async () => ({ results: [] })));
                expect(tools.hasCeaSearchTools()).toBe(true);
            });
        });
    });

    it('runCeaEditorReadTool surfaces errors via { ok: false, error }', async () => {
        // Pass a non-read tool name; the wrapper should refuse or surface an error.
        const out = await tools.runCeaEditorReadTool(
            { id: 'bad', name: 'cea_set_card_field', args: {} },
            { context: {} },
        );
        expect(out.ok).toBe(false);
        expect(typeof out.error).toBe('string');
        expect(out.error.length).toBeGreaterThan(0);
    });

    it('buildCeaEditorToolSet returns edit + read tools (no control tools)', () => {
        const set = tools.buildCeaEditorToolSet({}, {}, { live: { character: {}, lorebooks: {} } });
        expect(Array.isArray(set)).toBe(true);
        expect(set.length).toBeGreaterThanOrEqual(2);
        const names = set.map(t => t.function?.name);
        // No control tools anymore — multi-round loop is program-driven.
        expect(names).not.toContain('luker_cea_editor_continue_iteration');
        // Finalize is gone — assert NOT present so a regression that
        // re-adds it would fail loud.
        expect(names).not.toContain('luker_cea_editor_finalize_iteration');
        // At least one of the edit tools should be in the set.
        const ceaEdits = ['cea_set_card_field', 'cea_str_replace_card_field', 'cea_add_lorebook_entry'];
        expect(ceaEdits.some(n => names.includes(n))).toBe(true);
    });

    it('buildCeaEditorToolSet contains the 6 short-name read tools', () => {
        const set = tools.buildCeaEditorToolSet({}, {}, { live: {}, hasSearchTools: true });
        const names = set.map(t => t.function?.name);
        for (const n of ['lorebook_query', 'lorebook_list', 'lorebook_get', 'world_book_list', 'simulate_prompt']) {
            expect(names).toContain(n);
        }
        // web_search is gated on hasSearchTools
        expect(names).toContain('web_search');
    });

    it('simulate_prompt schema takes a single required text argument', () => {
        const set = tools.buildCeaEditorToolSet({}, {}, {});
        const def = set.find(t => t.function?.name === 'simulate_prompt');
        expect(Object.keys(def.function.parameters.properties)).toEqual(['text']);
        expect(def.function.parameters.required).toEqual(['text']);
    });

    it('buildCeaEditorToolSet omits web_search when hasSearchTools is false', () => {
        const set = tools.buildCeaEditorToolSet({}, {}, { live: {}, hasSearchTools: false });
        const names = set.map(t => t.function?.name);
        expect(names).not.toContain('web_search');
    });
});
