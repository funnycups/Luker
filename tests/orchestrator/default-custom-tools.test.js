/**
 * Default-customTools seed + import-defaults helper tests.
 *
 * Covers:
 *   - seedDefaultCustomToolsIfNeeded:
 *       - empty + !seededDefaultCustomTools → seeds DEFAULT_CUSTOM_TOOLS,
 *         flag flipped to true
 *       - non-empty + !seededDefaultCustomTools → passthrough +
 *         flag flipped to true (respect user's existing work)
 *       - any state + seededDefaultCustomTools=true → never re-seed
 *   - importDefaultCustomTools:
 *       - empty profile → all defaults added
 *       - existing matching name + overwrite=false (default) → skipped
 *       - existing matching name + overwrite=true → overwritten
 *       - mixed: unique defaults added, colliding ones honor overwrite flag
 *       - sets seededDefaultCustomTools to true regardless
 *   - sanitize integration:
 *       - sanitizeLoopProfile on fresh ({}) → loop profile has
 *         DEFAULT_CUSTOM_TOOLS + seededDefaultCustomTools = true
 *       - sanitizeLoopProfile on already-seeded ({seededDefaultCustomTools:true, customTools:[]}) → empty + flag stays true (no re-seed)
 *       - same for spec + agenda
 *       - director skips seeding (would inject a tool that can't work
 *         in director's takeover-handler timing)
 */

import { describe, test, expect, jest, beforeAll } from '@jest/globals';

// Match the scaffolding in custom-tool-sanitize.test.js — the sibling
// sanitizers we need to drive (sanitizeSpec / Agenda / Director) pull
// the browser-only `public/lib.js` chain at module-eval time. Mock the
// hot loaders so module init succeeds in the Node test runner.
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
    Popper: {}, lodash: {}, yaml: { dump: (v) => JSON.stringify(v), load: (s) => JSON.parse(s) }, default: {},
}));
jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    extension_settings: { orchestrator: {} }, getContext: () => ({}), writeExtensionField: () => {}, UNSET_VALUE: Symbol('unset'),
}));
jest.unstable_mockModule('../../public/script.js', () => ({
    saveSettingsDebounced: () => {}, saveSettings: async () => {},
    extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
    extension_prompt_types: { IN_PROMPT: 0, IN_CHAT: 1 },
    substituteParams: (s) => s, chat_metadata: {}, this_chid: 0, characters: [],
    getRequestHeaders: () => ({}), saveCharacterDebounced: () => {}, menu_type: '',
    eventSource: { on: () => {}, off: () => {}, emit: () => {} }, event_types: {},
    getExtensionPromptByName: () => '', saveMetadata: async () => {},
    getCurrentChatId: () => '', create_save: {}, name1: '',
}));
jest.unstable_mockModule('../../public/scripts/world-info.js', () => ({
    world_info_position: { before: 0, after: 1 }, wi_anchor_position: {},
}));
jest.unstable_mockModule('../../public/scripts/extensions/connection-manager/profile-resolver.js', () => ({
    getChatCompletionConnectionProfiles: () => [],
}));

let DEFAULT_CUSTOM_TOOLS;
let seedDefaultCustomToolsIfNeeded;
let importDefaultCustomTools;
let sanitizeLoopProfile;
let sanitizeSpec;
let sanitizeAgendaWorkingProfile;
let sanitizeDirectorProfile;
beforeAll(async () => {
    ({ DEFAULT_CUSTOM_TOOLS } = await import('../../public/scripts/extensions/orchestrator/default-custom-tools.js'));
    ({ seedDefaultCustomToolsIfNeeded, importDefaultCustomTools } = await import('../../public/scripts/extensions/orchestrator/seed-default-custom-tools.js'));
    ({ sanitizeLoopProfile } = await import('../../public/scripts/extensions/orchestrator/persistence.js'));
    ({ sanitizeSpec } = await import('../../public/scripts/extensions/orchestrator/spec-schema.js'));
    ({ sanitizeAgendaWorkingProfile } = await import('../../public/scripts/extensions/orchestrator/agenda-profile.js'));
    ({ sanitizeDirectorProfile } = await import('../../public/scripts/extensions/orchestrator/director-defaults.js'));
});

describe('DEFAULT_CUSTOM_TOOLS shape', () => {
    test('has at least one entry, all entries have required fields', () => {
        expect(DEFAULT_CUSTOM_TOOLS.length).toBeGreaterThanOrEqual(1);
        for (const t of DEFAULT_CUSTOM_TOOLS) {
            expect(typeof t.name).toBe('string');
            expect(t.name).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/);
            expect(['read', 'write']).toContain(t.mode);
            expect(typeof t.description).toBe('string');
            expect(t.description.length).toBeGreaterThan(0);
            expect(typeof t.body).toBe('string');
            expect(t.body.length).toBeGreaterThan(0);
            expect(typeof t.parameters).toBe('object');
        }
    });

    test('select_lore_for_turn is shipped', () => {
        const t = DEFAULT_CUSTOM_TOOLS.find(x => x.name === 'select_lore_for_turn');
        expect(t).toBeTruthy();
        expect(t.mode).toBe('write');
        // Body should delegate via the __invokeLoopTool seam.
        expect(t.body).toContain('__invokeLoopTool');
        expect(t.body).toContain('lorebook_force_activate');
    });
});

describe('seedDefaultCustomToolsIfNeeded', () => {
    test('empty + never seeded → seeds defaults, flips flag', () => {
        const out = seedDefaultCustomToolsIfNeeded({ seededDefaultCustomTools: false }, []);
        expect(out.seededDefaultCustomTools).toBe(true);
        expect(out.customTools.map(t => t.name)).toEqual(DEFAULT_CUSTOM_TOOLS.map(t => t.name));
    });

    test('empty + flag absent → still seeds (treat undefined as never seeded)', () => {
        const out = seedDefaultCustomToolsIfNeeded({}, []);
        expect(out.seededDefaultCustomTools).toBe(true);
        expect(out.customTools.length).toBe(DEFAULT_CUSTOM_TOOLS.length);
    });

    test('non-empty + never seeded → passes through user tools, flips flag to prevent later seeding', () => {
        const userTool = { name: 'user_thing', description: 'a', mode: 'read', parameters: { type: 'object' }, body: 'return 1;' };
        const out = seedDefaultCustomToolsIfNeeded({}, [userTool]);
        expect(out.seededDefaultCustomTools).toBe(true);
        expect(out.customTools).toEqual([userTool]);
    });

    test('already seeded + empty → respects user deletion, no re-seed', () => {
        const out = seedDefaultCustomToolsIfNeeded({ seededDefaultCustomTools: true }, []);
        expect(out.seededDefaultCustomTools).toBe(true);
        expect(out.customTools).toEqual([]);
    });

    test('already seeded + has tools → passthrough', () => {
        const userTool = { name: 'kept', description: 'a', mode: 'read', parameters: { type: 'object' }, body: 'return 1;' };
        const out = seedDefaultCustomToolsIfNeeded({ seededDefaultCustomTools: true }, [userTool]);
        expect(out.customTools).toEqual([userTool]);
        expect(out.seededDefaultCustomTools).toBe(true);
    });
});

describe('importDefaultCustomTools', () => {
    test('empty profile → all defaults added, flag flipped', () => {
        const profile = { customTools: [] };
        const result = importDefaultCustomTools(profile);
        expect(result.added).toEqual(DEFAULT_CUSTOM_TOOLS.map(t => t.name));
        expect(result.overwritten).toEqual([]);
        expect(result.skipped).toEqual([]);
        expect(profile.seededDefaultCustomTools).toBe(true);
    });

    test('matching name + overwrite=false → skipped (user tool preserved)', () => {
        const profile = {
            customTools: [{ name: 'select_lore_for_turn', description: 'mine', mode: 'read', parameters: { type: 'object' }, body: 'return "mine";' }],
        };
        const result = importDefaultCustomTools(profile);
        expect(result.skipped).toContain('select_lore_for_turn');
        expect(result.overwritten).toEqual([]);
        const kept = profile.customTools.find(t => t.name === 'select_lore_for_turn');
        expect(kept.description).toBe('mine');
    });

    test('matching name + overwrite=true → replaced with default', () => {
        const profile = {
            customTools: [{ name: 'select_lore_for_turn', description: 'mine', mode: 'read', parameters: { type: 'object' }, body: 'return "mine";' }],
        };
        const result = importDefaultCustomTools(profile, { overwrite: true });
        expect(result.overwritten).toContain('select_lore_for_turn');
        const replaced = profile.customTools.find(t => t.name === 'select_lore_for_turn');
        expect(replaced.description).not.toBe('mine');
    });

    test('throws on non-object profile', () => {
        expect(() => importDefaultCustomTools(null)).toThrow(TypeError);
        expect(() => importDefaultCustomTools('nope')).toThrow(TypeError);
    });
});

describe('sanitize integration — seeding on fresh profiles', () => {
    test('sanitizeLoopProfile seeds defaults on fresh profile', () => {
        const loop = sanitizeLoopProfile({});
        expect(loop.seededDefaultCustomTools).toBe(true);
        expect(loop.customTools.map(t => t.name)).toEqual(DEFAULT_CUSTOM_TOOLS.map(t => t.name));
    });

    test('sanitizeLoopProfile respects already-seeded profile (no re-seed on empty)', () => {
        const loop = sanitizeLoopProfile({ seededDefaultCustomTools: true, customTools: [] });
        expect(loop.seededDefaultCustomTools).toBe(true);
        expect(loop.customTools).toEqual([]);
    });

    test('sanitizeSpec seeds defaults on fresh profile', () => {
        const spec = sanitizeSpec({});
        expect(spec.seededDefaultCustomTools).toBe(true);
        expect(spec.customTools.length).toBeGreaterThan(0);
        expect(spec.customTools[0].name).toBe('select_lore_for_turn');
    });

    test('sanitizeAgendaWorkingProfile seeds defaults on fresh profile', () => {
        const agenda = sanitizeAgendaWorkingProfile({});
        expect(agenda.seededDefaultCustomTools).toBe(true);
        expect(agenda.customTools.length).toBeGreaterThan(0);
    });

    test('sanitizeDirectorProfile does NOT seed (intentional — force_activate would always fail in director)', () => {
        const director = sanitizeDirectorProfile({});
        // Either the flag is absent or false, and customTools stays empty.
        expect(director.seededDefaultCustomTools).not.toBe(true);
        expect(director.customTools).toEqual([]);
    });
});
