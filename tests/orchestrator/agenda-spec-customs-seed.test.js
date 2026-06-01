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
import { describe, test, expect } from '@jest/globals';
import { sanitizeAgendaWorkingProfile } from '../../public/scripts/extensions/orchestrator/agenda-profile.js';
import { sanitizeSpec } from '../../public/scripts/extensions/orchestrator/spec-schema.js';

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
        expect(out.defaultTools).toBeTypeOf('object');
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
