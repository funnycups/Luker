import { describe, test, expect } from '@jest/globals';
import {
    sanitizeAgentToolFlags,
    sanitizeLoopProfile,
} from '../../public/scripts/extensions/orchestrator/persistence.js';
import { getEnabledToolSchemas } from '../../public/scripts/extensions/orchestrator/loop-tools.js';

describe('legacy memory namespace migration', () => {
    test('tools.memory.<verb> migrates to tools.custom.memory_<verb> (default-all-on mode)', () => {
        const legacy = {
            chat: { read_range: true, search: true },
            memory: { node_create: true, list_candidates: true, vector_search: false },
        };
        const out = sanitizeAgentToolFlags(legacy, { defaultAllOn: true });
        // memory namespace gone:
        expect(out.memory).toBeUndefined();
        // custom flags carry the equivalent:
        expect(out.custom).toMatchObject({
            memory_node_create: true,
            memory_list_candidates: true,
            memory_vector_search: false,
        });
        // chat preserved:
        expect(out.chat).toEqual({ read_range: true, search: true });
    });

    test('no memory in input + default-all-on mode → no memory keys added (Layer-2 default-on applies)', () => {
        const out = sanitizeAgentToolFlags({ chat: { read_range: true } }, { defaultAllOn: true });
        expect(out.custom).toEqual({});
    });

    test('no memory in input + override mode → all 15 memory verbs explicit false (override narrowing)', () => {
        // See the "override-mode: ALL memory verbs default off" test for
        // the full contract — this one pins the simpler "input is just
        // chat" case.
        const out = sanitizeAgentToolFlags({ chat: { read_range: true } });  // defaultAllOn=false
        expect(out.custom.memory_keyword_search).toBe(false);
        expect(out.custom.memory_node_create).toBe(false);
        expect(out.custom.memory_compact_nodes).toBe(false);
        // exactly 15 memory verbs in custom; the only other entries are
        // the 2 search verbs from the parallel search-namespace narrowing
        // (see 'no search in input + override mode' below).
        expect(Object.keys(out.custom).filter(k => k.startsWith('memory_')).length).toBe(15);
        const nonMemory = Object.keys(out.custom).filter(k => !k.startsWith('memory_'));
        expect(nonMemory.sort()).toEqual(['search_search', 'search_visit']);
    });

    test('explicit custom flags merge with translated legacy ones (legacy loses on conflict)', () => {
        const out = sanitizeAgentToolFlags({
            memory: { node_create: false },
            custom: { memory_node_create: true },  // user's explicit choice
        });
        expect(out.custom.memory_node_create).toBe(true);
    });

    test('override-mode narrows: unspecified memory verbs default off when caller sets at least one', () => {
        // This is the pre-Layer-2 namespace contract (defaultAllOn=false ⇒
        // unspecified verbs default off). The translator preserves it by
        // emitting explicit `false` for the 14 memory verbs the caller
        // omitted — otherwise Layer-2's default-on policy (`customFlags[name]
        // !== false`) would re-expose all 15 memory tools whenever an
        // override picks just one.
        const out = sanitizeAgentToolFlags(
            { memory: { keyword_search: true } },
            { defaultAllOn: false },
        );
        expect(out.custom.memory_keyword_search).toBe(true);
        // every other memory_* verb is explicitly false (override narrowing)
        const otherMemoryNames = [
            'memory_list_candidates', 'memory_edge_summary', 'memory_node_brief',
            'memory_expand_seeds', 'memory_schema', 'memory_vector_search',
            'memory_find_by_name', 'memory_compaction_candidates',
            'memory_node_create', 'memory_node_edit', 'memory_node_delete',
            'memory_link_upsert', 'memory_link_delete', 'memory_compact_nodes',
        ];
        for (const name of otherMemoryNames) {
            expect(out.custom[name]).toBe(false);
        }
    });

    test('override-mode: ALL memory verbs default off when caller omits memory namespace entirely', () => {
        // The pre-Layer-2 contract said an override that didn't mention the
        // memory namespace got ALL memory tools off — `sanitizeAgentToolFlags
        // ({chat: {read_range: true}}, {defaultAllOn: false})` returned
        // `{memory: {all_verbs: false}}` as a namespace. Translating that to
        // Layer-2: every memory_* verb must be explicitly false in override
        // mode regardless of whether `tools.memory` was passed in. Otherwise
        // sub-agents like intent_scout (chat + lorebook only, no memory)
        // would have all 15 memory tools default-on via the Layer-2 policy.
        const out = sanitizeAgentToolFlags(
            { chat: { read_range: true }, lorebook: { search: true } },
            { defaultAllOn: false },
        );
        const allMemoryNames = [
            'memory_list_candidates', 'memory_edge_summary', 'memory_node_brief',
            'memory_expand_seeds', 'memory_schema', 'memory_keyword_search',
            'memory_vector_search', 'memory_find_by_name',
            'memory_compaction_candidates',
            'memory_node_create', 'memory_node_edit', 'memory_node_delete',
            'memory_link_upsert', 'memory_link_delete', 'memory_compact_nodes',
        ];
        for (const name of allMemoryNames) {
            expect(out.custom[name]).toBe(false);
        }
    });

    test('default-all-on mode: omitted memory verbs stay undefined (Layer-2 default-on applies)', () => {
        // Loop mode (defaultAllOn=true) keeps the Layer-2 default-on
        // ergonomics for unspecified memory verbs — those stay undefined
        // and getEnabledToolSchemas exposes them through the registry.
        // Explicit false from custom or legacy still wins.
        const out = sanitizeAgentToolFlags(
            { memory: { keyword_search: true, node_create: false } },
            { defaultAllOn: true },
        );
        expect(out.custom.memory_keyword_search).toBe(true);
        expect(out.custom.memory_node_create).toBe(false);
        // unmentioned memory verbs stay undefined → default-on policy applies
        expect(out.custom.memory_node_edit).toBeUndefined();
        expect(out.custom.memory_compact_nodes).toBeUndefined();
    });
});

describe('legacy search namespace migration', () => {
    test('tools.search.<verb> migrates to tools.custom.search_<verb> (default-all-on mode)', () => {
        const legacy = {
            chat: { read_range: true, search: true },
            search: { search: true, visit: false },
        };
        const out = sanitizeAgentToolFlags(legacy, { defaultAllOn: true });
        // search namespace gone:
        expect(out.search).toBeUndefined();
        // custom flags carry the equivalent:
        expect(out.custom).toMatchObject({
            search_search: true,
            search_visit: false,
        });
        // chat preserved:
        expect(out.chat).toEqual({ read_range: true, search: true });
    });

    test('no search in input + default-all-on mode → no search keys added (Layer-2 default-on applies)', () => {
        // Same contract as the memory equivalent above — when the caller
        // doesn't mention search and we're in default-all-on (loop) mode,
        // search_* verbs stay undefined so getEnabledToolSchemas relies
        // on the Layer-2 default-on policy to surface them.
        const out = sanitizeAgentToolFlags({ chat: { read_range: true } }, { defaultAllOn: true });
        // The translator only adds search keys if the caller named the
        // namespace (or set custom flags). Neither happened → no entries.
        expect(out.custom.search_search).toBeUndefined();
        expect(out.custom.search_visit).toBeUndefined();
    });

    test('no search in input + override mode → both search verbs explicit false (override narrowing)', () => {
        // Same contract as the "no memory" override-mode test — sub-agents
        // that don't list search must default-off, otherwise Layer-2's
        // default-on policy would expose both search tools.
        const out = sanitizeAgentToolFlags({ chat: { read_range: true } });  // defaultAllOn=false
        expect(out.custom.search_search).toBe(false);
        expect(out.custom.search_visit).toBe(false);
    });

    test('explicit custom flags merge with translated legacy ones (legacy loses on conflict)', () => {
        const out = sanitizeAgentToolFlags({
            search: { search: false },
            custom: { search_search: true },  // user's explicit choice
        });
        expect(out.custom.search_search).toBe(true);
    });

    test('override-mode narrows: unspecified search verbs default off when caller sets one', () => {
        // Pre-Layer-2 namespace contract: defaultAllOn=false ⇒ unspecified
        // verbs default off. The translator preserves it by emitting
        // explicit `false` for the search verb the caller omitted.
        const out = sanitizeAgentToolFlags(
            { search: { search: true } },
            { defaultAllOn: false },
        );
        expect(out.custom.search_search).toBe(true);
        expect(out.custom.search_visit).toBe(false);
    });

    test('default-all-on mode: omitted search verbs stay undefined (Layer-2 default-on applies)', () => {
        // Loop mode (defaultAllOn=true) keeps the Layer-2 default-on
        // ergonomics — unmentioned search verbs stay undefined so the
        // registry's schema is exposed. Explicit false still wins.
        const out = sanitizeAgentToolFlags(
            { search: { search: true } },
            { defaultAllOn: true },
        );
        expect(out.custom.search_search).toBe(true);
        // unmentioned search verb stays undefined → default-on policy applies
        expect(out.custom.search_visit).toBeUndefined();
    });

    test('default loop profile pre-enables search_search and search_visit via tools.custom', () => {
        const profile = sanitizeLoopProfile({});
        // The custom flags now carry both search_* entries (Layer-2).
        expect(profile.tools.custom.search_search).toBe(true);
        expect(profile.tools.custom.search_visit).toBe(true);
        // The legacy `tools.search` namespace is gone from the sanitized shape.
        expect(profile.tools.search).toBeUndefined();
    });

    test('disabling tools.search.search via legacy input drops only that entry', () => {
        const profile = sanitizeLoopProfile({
            tools: { search: { search: false } },
        });
        // Legacy `tools.search.search: false` translates to a custom flag.
        expect(profile.tools.custom.search_search).toBe(false);
        // The visit verb stays on (LOOP_PROFILE_DEFAULTS pre-enables it,
        // and no caller override flipped it off).
        expect(profile.tools.custom.search_visit).toBe(true);
        // No legacy namespace in the output.
        expect(profile.tools.search).toBeUndefined();
    });
});
