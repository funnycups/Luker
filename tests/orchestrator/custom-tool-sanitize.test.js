import { describe, test, expect, jest, beforeAll } from '@jest/globals';
import { sanitizeCustomTools } from '../../public/scripts/extensions/orchestrator/custom-tools-sanitize.js';

// Sibling sanitizers (sanitizeSpec / sanitizeAgendaWorkingProfile /
// sanitizeDirectorProfile) transitively import `public/lib.js` —
// a build-time bundle that doesn't exist under jest. Mock the bundle
// (and the thin `extensions.js` / `script.js` shims that pull it in)
// so the sanitizers can load.

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
    saveCharacterDebounced: () => {},
    menu_type: '',
    eventSource: { on: () => {}, off: () => {}, emit: () => {} },
    event_types: {},
    getExtensionPromptByName: () => '',
    saveMetadata: async () => {},
    getCurrentChatId: () => '',
    create_save: {},
    name1: '',
}));

jest.unstable_mockModule('../../public/scripts/world-info.js', () => ({
    world_info_position: { before: 0, after: 1 },
    wi_anchor_position: {},
}));

jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/agent-resolution.js', () => ({
    getPresetApiPresetName: () => '',
    getPresetPromptPresetName: () => '',
    resolveAgentToolFlags: (override) => override || null,
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

describe('sanitizeCustomTools', () => {
    test('returns [] for non-array input', () => {
        expect(sanitizeCustomTools(null)).toEqual([]);
        expect(sanitizeCustomTools(undefined)).toEqual([]);
        expect(sanitizeCustomTools({})).toEqual([]);
        expect(sanitizeCustomTools('nope')).toEqual([]);
    });

    test('drops entries with invalid name', () => {
        const out = sanitizeCustomTools([
            { name: '', description: 'd', parameters: {}, mode: 'read', body: '' },
            { name: '0bad_start', description: 'd', parameters: {}, mode: 'read', body: '' },
            { name: 'has space', description: 'd', parameters: {}, mode: 'read', body: '' },
            { name: 'too_long_'.repeat(20), description: 'd', parameters: {}, mode: 'read', body: '' },
            { name: 'good_name', description: 'd', parameters: {}, mode: 'read', body: '' },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].name).toBe('good_name');
    });

    test('dedupes by name (later wins, console.warn)', () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const out = sanitizeCustomTools([
            { name: 'a', description: 'first', parameters: {}, mode: 'read', body: '' },
            { name: 'a', description: 'second', parameters: {}, mode: 'write', body: '' },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].description).toBe('second');
        expect(out[0].mode).toBe('write');
        warnSpy.mockRestore();
    });

    test('mode defaults to write when missing/invalid', () => {
        const out = sanitizeCustomTools([
            { name: 'a', description: 'd', parameters: {}, body: '' },
            { name: 'b', description: 'd', parameters: {}, mode: 'invalid', body: '' },
            { name: 'c', description: 'd', parameters: {}, mode: 'read', body: '' },
        ]);
        expect(out.map(e => `${e.name}:${e.mode}`)).toEqual(['a:write', 'b:write', 'c:read']);
    });

    test('truncates body and simulateBody at 64KB', () => {
        const huge = 'x'.repeat(70_000);
        const out = sanitizeCustomTools([
            { name: 'big', description: 'd', parameters: {}, mode: 'read', body: huge, simulateBody: huge },
        ]);
        expect(out[0].body.length).toBe(65536);
        expect(out[0].simulateBody.length).toBe(65536);
    });

    test('truncates description at 8KB and displayName at 256 bytes', () => {
        const out = sanitizeCustomTools([{
            name: 'big',
            parameters: {}, mode: 'read', body: '',
            description: 'd'.repeat(10000),
            displayName: 'n'.repeat(500),
        }]);
        expect(out[0].description.length).toBe(8192);
        expect(out[0].displayName.length).toBe(256);
    });

    test('non-string body coerces to empty string', () => {
        const out = sanitizeCustomTools([
            { name: 'a', description: 'd', parameters: {}, mode: 'read', body: 123 },
        ]);
        expect(out[0].body).toBe('');
    });

    test('non-object parameters defaults to { type: "object" }', () => {
        const out = sanitizeCustomTools([
            { name: 'a', description: 'd', parameters: 'nope', mode: 'read', body: '' },
            { name: 'b', description: 'd', parameters: null, mode: 'read', body: '' },
            { name: 'c', description: 'd', mode: 'read', body: '' },
        ]);
        expect(out[0].parameters).toEqual({ type: 'object' });
        expect(out[1].parameters).toEqual({ type: 'object' });
        expect(out[2].parameters).toEqual({ type: 'object' });
    });

    test('preserves displayName when provided', () => {
        const out = sanitizeCustomTools([
            { name: 'a', description: 'd', parameters: {}, mode: 'read', body: '', displayName: 'My Tool' },
        ]);
        expect(out[0].displayName).toBe('My Tool');
    });
});

describe('sanitizeLoopProfile customTools field', () => {
    test('round-trips a valid customTools array', () => {
        const out = sanitizeLoopProfile({
            customTools: [
                { name: 'weather', description: 'd', parameters: {}, mode: 'read', body: 'return 1;' },
            ],
        });
        expect(Array.isArray(out.customTools)).toBe(true);
        expect(out.customTools[0].name).toBe('weather');
    });

    test('missing customTools defaults to empty array', () => {
        const out = sanitizeLoopProfile({});
        expect(out.customTools).toEqual([]);
    });
});

describe('sanitizeSpec customTools field', () => {
    test('preserves customTools on the root profile', () => {
        const out = sanitizeSpec({
            spec: { stages: [] },
            presets: {},
            customTools: [
                { name: 'foo', description: 'd', parameters: {}, mode: 'read', body: '' },
            ],
        });
        expect(out.customTools).toHaveLength(1);
        expect(out.customTools[0].name).toBe('foo');
    });

    test('defaults to empty when missing', () => {
        const out = sanitizeSpec({ spec: { stages: [] }, presets: {} });
        expect(out.customTools).toEqual([]);
    });
});

describe('sanitizeAgendaWorkingProfile customTools field', () => {
    test('preserves customTools', () => {
        const out = sanitizeAgendaWorkingProfile({
            customTools: [
                { name: 'foo', description: 'd', parameters: {}, mode: 'write', body: '' },
            ],
        });
        expect(out.customTools).toHaveLength(1);
    });

    test('defaults to empty', () => {
        const out = sanitizeAgendaWorkingProfile({});
        expect(out.customTools).toEqual([]);
    });
});

describe('sanitizeDirectorProfile customTools field', () => {
    test('preserves customTools', () => {
        const out = sanitizeDirectorProfile({
            customTools: [
                { name: 'foo', description: 'd', parameters: {}, mode: 'read', body: '' },
            ],
        });
        expect(out.customTools).toHaveLength(1);
    });

    test('defaults to empty', () => {
        const out = sanitizeDirectorProfile({});
        expect(out.customTools).toEqual([]);
    });
});
