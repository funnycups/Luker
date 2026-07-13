// tests/orchestrator/lorebook-filter-persistence.test.js
//
// Verify `lorebookFilter` round-trips through all four mode sanitizers.
// The four sanitizers (loop/spec/agenda/director) each transitively import
// browser-only modules; the fixture below is copied from
// custom-tool-portable-roundtrip.test.js which resolves the same imports.

import { describe, test, expect, jest, beforeAll } from '@jest/globals';

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

jest.unstable_mockModule('../../public/scripts/extensions/connection-manager/profile-resolver.js', () => ({
    getChatCompletionConnectionProfiles: () => [],
}));

let sanitizeLoopProfile;
let sanitizeSpec;
let sanitizeAgendaWorkingProfile;
let sanitizeDirectorProfile;

beforeAll(async () => {
    ({ sanitizeLoopProfile } = await import('../../public/scripts/extensions/orchestrator/persistence.js'));
    ({ sanitizeSpec } = await import('../../public/scripts/extensions/orchestrator/spec-schema.js'));
    ({ sanitizeAgendaWorkingProfile } = await import('../../public/scripts/extensions/orchestrator/agenda-profile.js'));
    ({ sanitizeDirectorProfile } = await import('../../public/scripts/extensions/orchestrator/director-defaults.js'));
});

const SAMPLE = { bookPattern: '^private$\n^secret_.*$', entryPattern: '^internal_' };

describe('lorebookFilter round-trips through all four sanitizers', () => {
    test('loop', () => {
        const out = sanitizeLoopProfile({ lorebookFilter: SAMPLE });
        expect(out.lorebookFilter).toEqual(SAMPLE);
    });
    test('spec', () => {
        const out = sanitizeSpec({ lorebookFilter: SAMPLE, stages: [] });
        expect(out.lorebookFilter).toEqual(SAMPLE);
    });
    test('agenda', () => {
        const out = sanitizeAgendaWorkingProfile({ lorebookFilter: SAMPLE });
        expect(out.lorebookFilter).toEqual(SAMPLE);
    });
    test('director', () => {
        const out = sanitizeDirectorProfile({ lorebookFilter: SAMPLE });
        expect(out.lorebookFilter).toEqual(SAMPLE);
    });
});

describe('missing lorebookFilter → empty defaults', () => {
    test.each([
        ['loop', () => sanitizeLoopProfile({})],
        ['spec', () => sanitizeSpec({ stages: [] })],
        ['agenda', () => sanitizeAgendaWorkingProfile({})],
        ['director', () => sanitizeDirectorProfile({})],
    ])('%s', (_label, sanitize) => {
        const out = sanitize();
        expect(out.lorebookFilter).toEqual({ bookPattern: '', entryPattern: '' });
    });
});

describe('non-object lorebookFilter → sanitized to empty', () => {
    test.each([
        ['loop', () => sanitizeLoopProfile({ lorebookFilter: 'bad' })],
        ['spec', () => sanitizeSpec({ lorebookFilter: 'bad', stages: [] })],
        ['agenda', () => sanitizeAgendaWorkingProfile({ lorebookFilter: 'bad' })],
        ['director', () => sanitizeDirectorProfile({ lorebookFilter: 'bad' })],
    ])('%s', (_label, sanitize) => {
        const out = sanitize();
        expect(out.lorebookFilter).toEqual({ bookPattern: '', entryPattern: '' });
    });
});
