// tests/orchestrator/custom-tool-portable-roundtrip.test.js
//
// `customTools` arrays must round-trip cleanly through every mode's
// sanitizer when re-loaded from JSON storage — the same code path users
// hit when a portable profile is shipped on a character card (saved as
// JSON, loaded from JSON, then re-sanitized into the live profile). The
// `profile.tools.custom` flag namespace round-trips via the same
// `sanitizeAgentToolFlags` helper used by every mode.

import { describe, test, expect, jest, beforeAll } from '@jest/globals';

// defaults.js (transitively imported by the sanitizers) reads
// `Luker.getContext().constants.{promptRoles,wiPosition}` at module
// load time after upstream commit 571c529c2. Provide a minimal shim so
// module evaluation succeeds.
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

// The real agent-resolution.js loads if we sever the connection-manager
// gate that pulls textgen-models.js → document.addEventListener under Node.
jest.unstable_mockModule('../../public/scripts/extensions/connection-manager/profile-resolver.js', () => ({
    getChatCompletionConnectionProfiles: () => [],
}));

let sanitizeLoopProfile;
let sanitizeAgentToolFlags;
let sanitizeSpec;
let sanitizeAgendaWorkingProfile;
let sanitizeDirectorProfile;

beforeAll(async () => {
    ({ sanitizeLoopProfile, sanitizeAgentToolFlags } = await import('../../public/scripts/extensions/orchestrator/persistence.js'));
    ({ sanitizeSpec } = await import('../../public/scripts/extensions/orchestrator/spec-schema.js'));
    ({ sanitizeAgendaWorkingProfile } = await import('../../public/scripts/extensions/orchestrator/agenda-profile.js'));
    ({ sanitizeDirectorProfile } = await import('../../public/scripts/extensions/orchestrator/director-defaults.js'));
});

const sampleTool = {
    name: 'demo',
    displayName: 'Demo',
    description: 'A demo tool',
    parameters: { type: 'object', properties: { x: { type: 'integer' } } },
    mode: 'read',
    body: 'return { x: args.x };',
    simulateBody: '',
};

describe('customTools survive sanitize -> JSON -> sanitize round-trip', () => {
    const cases = [
        ['loop', () => sanitizeLoopProfile, { customTools: [sampleTool] }],
        ['spec', () => sanitizeSpec, { spec: { stages: [] }, presets: {}, customTools: [sampleTool] }],
        ['agenda', () => sanitizeAgendaWorkingProfile, { customTools: [sampleTool] }],
        ['director', () => sanitizeDirectorProfile, { customTools: [sampleTool] }],
    ];
    test.each(cases)('%s mode', (_label, sanitizeAccessor, input) => {
        const sanitize = sanitizeAccessor();
        const first = sanitize(input);
        const json = JSON.parse(JSON.stringify(first));
        const second = sanitize(json);
        expect(second.customTools).toHaveLength(1);
        expect(second.customTools[0].name).toBe('demo');
        expect(second.customTools[0].body).toBe('return { x: args.x };');
        expect(second.customTools[0].parameters.properties.x.type).toBe('integer');
    });

    test('profile.tools.custom flag survives via sanitizeAgentToolFlags round-trip', () => {
        const first = sanitizeAgentToolFlags({ custom: { demo: false, other: true } });
        const json = JSON.parse(JSON.stringify(first));
        const second = sanitizeAgentToolFlags(json);
        expect(second.custom.demo).toBe(false);
        expect(second.custom.other).toBe(true);
    });
});
