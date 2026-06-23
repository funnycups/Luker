// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
/**
 * Verifies that newly-created agenda + spec profiles seed default-on
 * customs for the dogfood Layer-2 tools (memory_* + search_*). Loop +
 * director already shipped that seed; this test pins the parity.
 *
 * Bug history: agenda + spec sanitizers initialized `defaultTools` to
 * null when input was missing. With memory + search living in Layer-2
 * now, a null defaultTools meant fresh profiles had memory + search
 * silently OFF — users had to flip 17 checkboxes after every fresh
 * setup, and they couldn't even tell where the toggles lived.
 *
 * The seed must NOT override explicit null (caller meaning "no tools at
 * all"), only fill in the missing-defaults case.
 */
import { describe, test, expect, jest, beforeAll } from '@jest/globals';

// defaults.js (transitively imported by the sanitizers) reads
// `Luker.getContext().constants.{promptRoles,wiPosition}` at module
// load time after upstream commit 571c529c2. Provide a minimal shim so
// module evaluation succeeds. public/lib.js is a build-time bundle that
// jest cannot resolve — short-circuit it as well.
globalThis.Luker = {
    getContext: () => ({
        constants: {
            promptRoles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
            wiPosition: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 },
        },
        lib: {
            yaml: { dump: (v) => JSON.stringify(v), load: (s) => JSON.parse(s) },
        },
    }),
};

jest.unstable_mockModule('../../public/lib.js', () => ({
    Popper: {},
    lodash: {},
    yaml: { dump: (v) => JSON.stringify(v), load: (s) => JSON.parse(s) },
    default: {},
}));
jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    extension_settings: { orchestrator: {} },
    getContext: () => ({}),
    writeExtensionField: () => {},
    UNSET_VALUE: Symbol('unset'),
}));
jest.unstable_mockModule('../../public/script.js', () => ({
    saveSettingsDebounced: () => {},
    saveSettings: async () => {},
    extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
    extension_prompt_types: { IN_PROMPT: 0, IN_CHAT: 1 },
    substituteParams: (s) => s,
    chat_metadata: {},
    this_chid: 0,
    characters: [],
    getRequestHeaders: () => ({}),
}));
jest.unstable_mockModule('../../public/scripts/world-info.js', () => ({
    world_info_position: { before: 0, after: 1 },
    wi_anchor_position: {},
}));
// Stub the connection-manager gate so the real agent-resolution.js can load
// without pulling textgen-models.js → document.addEventListener under Node.
jest.unstable_mockModule('../../public/scripts/extensions/connection-manager/profile-resolver.js', () => ({
    getChatCompletionConnectionProfiles: () => [],
}));

let sanitizeAgendaWorkingProfile;
let sanitizeSpec;
beforeAll(async () => {
    ({ sanitizeAgendaWorkingProfile } = await import('../../public/scripts/extensions/orchestrator/agenda-profile.js'));
    ({ sanitizeSpec } = await import('../../public/scripts/extensions/orchestrator/spec-schema.js'));
});

const EXPECTED_CUSTOM_KEYS = [
    'memory_schema', 'memory_list_candidates', 'memory_edge_summary',
    'memory_node_brief', 'memory_expand_seeds', 'memory_keyword_search',
    'memory_vector_search', 'memory_find_by_name', 'memory_compaction_candidates',
    'memory_node_create', 'memory_node_edit', 'memory_node_delete',
    'memory_link_upsert', 'memory_link_delete', 'memory_compact_nodes',
    'search_search', 'search_visit',
];

describe('agenda profile defaults seed memory + search customs', () => {
    test('missing defaultTools seeds the 17 custom flags on', () => {
        const out = sanitizeAgendaWorkingProfile({});
        expect(out.defaultTools).not.toBeNull();
        expect(typeof out.defaultTools).toBe('object');
        for (const key of EXPECTED_CUSTOM_KEYS) {
            expect(out.defaultTools.custom[key]).toBe(true);
        }
    });

    test('explicit defaultTools=null is preserved (caller wants no tools)', () => {
        const out = sanitizeAgendaWorkingProfile({ defaultTools: null });
        expect(out.defaultTools).toBeNull();
    });

    test('partial defaultTools merges seed without clobbering explicit choices', () => {
        const out = sanitizeAgendaWorkingProfile({
            defaultTools: {
                chat: { read_range: true, search: false },
                custom: { memory_node_create: false, my_user_tool: true },
            },
        });
        // User's explicit settings wins:
        expect(out.defaultTools.chat.read_range).toBe(true);
        expect(out.defaultTools.chat.search).toBe(false);
        expect(out.defaultTools.custom.memory_node_create).toBe(false);
        expect(out.defaultTools.custom.my_user_tool).toBe(true);
        // Seed fills the unaddressed ones:
        expect(out.defaultTools.custom.memory_schema).toBe(true);
        expect(out.defaultTools.custom.search_search).toBe(true);
    });

    test('legacy tools.memory.<verb> still translates as before', () => {
        // The legacy translator (sanitizeAgentToolFlags) maps memory.node_create
        // → custom.memory_node_create. Seeding happens BEFORE that translation;
        // user's explicit legacy false should still win.
        const out = sanitizeAgendaWorkingProfile({
            defaultTools: {
                memory: { node_create: false },
            },
        });
        expect(out.defaultTools.custom.memory_node_create).toBe(false);
        // Other seeded ones still on:
        expect(out.defaultTools.custom.memory_schema).toBe(true);
    });
});

describe('spec profile defaults seed memory + search customs', () => {
    test('missing defaultTools seeds the 17 custom flags on', () => {
        const out = sanitizeSpec({ spec: { stages: [] } });
        expect(out.defaultTools).not.toBeNull();
        for (const key of EXPECTED_CUSTOM_KEYS) {
            expect(out.defaultTools.custom[key]).toBe(true);
        }
    });

    test('explicit defaultTools=null is preserved', () => {
        const out = sanitizeSpec({ spec: { stages: [] }, defaultTools: null });
        expect(out.defaultTools).toBeNull();
    });

    test('partial defaultTools merges seed without clobbering', () => {
        const out = sanitizeSpec({
            spec: { stages: [] },
            defaultTools: {
                custom: { memory_node_create: false },
            },
        });
        expect(out.defaultTools.custom.memory_node_create).toBe(false);
        expect(out.defaultTools.custom.memory_schema).toBe(true);
        expect(out.defaultTools.custom.search_search).toBe(true);
    });
});
