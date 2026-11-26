/**
 * Scoped regex persistence, record isolation, target ownership, and serialized cleanup contracts.
 */

import { describe, test, expect, beforeAll, beforeEach, jest } from '@jest/globals';

const characters = [];
const extension_settings = {
    disabledExtensions: [],
    regex: [],
    character_allowed_regex: [],
    preset_allowed_regex: {},
};
let presetManager = null;

let writeExtensionFieldImpl = async () => true;
const saveSettingsDebouncedMock = jest.fn();

jest.unstable_mockModule('../../public/script.js', () => ({
    characters,
    this_chid: 0,
    saveSettingsDebounced: (...args) => saveSettingsDebouncedMock(...args),
    substituteParams: (s) => s,
    substituteParamsExtended: (s) => s,
}));

jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    extension_settings,
    writeExtensionField: (...args) => writeExtensionFieldImpl(...args),
}));

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((acc, str, idx) => acc + str + (values[idx] ?? ''), ''),
}));

jest.unstable_mockModule('../../public/scripts/preset-manager.js', () => ({
    getPresetManager: () => presetManager,
}));

jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
    regexFromString: (input) => {
        if (typeof input !== 'string') return null;
        const m = input.match(/\/(.+)\/([gimsuy]*)/s);
        return m ? new RegExp(m[1], m[2]) : new RegExp(input);
    },
}));

jest.unstable_mockModule('../../public/scripts/extensions/regex/redos-reporter.js', () => ({
    isRegexScriptPaused: () => false,
    recordRegexExecution: () => {},
    resetRegexScriptState: () => {},
}));

let engine;

beforeAll(async () => {
    engine = await import('../../public/scripts/extensions/regex/engine.js');
});

function makeScript(id, name, extra = {}) {
    return {
        id,
        scriptName: name,
        findRegex: '/lantern/g',
        replaceString: 'beacon',
        trimStrings: [],
        placement: [1],
        disabled: false,
        markdownOnly: false,
        promptOnly: false,
        pluginLanes: [],
        runOnEdit: false,
        substituteRegex: 0,
        minDepth: null,
        maxDepth: null,
        ...extra,
    };
}

function flushMicrotasks() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
    saveSettingsDebouncedMock.mockClear();
    globalThis.toastr = {
        error: jest.fn(),
        warning: jest.fn(),
        success: jest.fn(),
        info: jest.fn(),
    };
    characters.splice(0, characters.length,
        {
            avatar: 'watchpost-a.png',
            data: {
                extensions: {
                    regex_scripts: [makeScript('script-a', 'Beacon A')],
                    retained: { sibling: 'keep-a' },
                },
            },
        },
        {
            avatar: 'watchpost-b.png',
            data: {
                extensions: {
                    regex_scripts: [makeScript('script-b', 'Beacon B')],
                    retained: { sibling: 'keep-b' },
                },
            },
        },
    );
    extension_settings.disabledExtensions = [];
    extension_settings.regex = [makeScript('global-1', 'Global Rule')];
    extension_settings.character_allowed_regex = ['watchpost-a.png'];
    extension_settings.preset_allowed_regex = {};
    presetManager = null;
    writeExtensionFieldImpl = async (characterId, key, value) => {
        const character = characters[characterId];
        if (!character) return false;
        const resolved = typeof value === 'function'
            ? await value(structuredClone(character.data.extensions[key]))
            : structuredClone(value);
        character.data.extensions[key] = resolved;
        return true;
    };
});

describe('regex engine scoped save outcomes and isolation', () => {
    test('getScriptsByType returns isolated clones so caller edits never mutate live character records', () => {
        const scripts = engine.getScriptsByType(engine.SCRIPT_TYPES.SCOPED);
        expect(scripts).toHaveLength(1);
        scripts[0].disabled = true;
        scripts[0].scriptName = 'Mutated Locally';
        scripts.push(makeScript('script-unpersisted', 'Unpersisted'));

        expect(characters[0].data.extensions.regex_scripts).toHaveLength(1);
        expect(characters[0].data.extensions.regex_scripts[0].disabled).toBe(false);
        expect(characters[0].data.extensions.regex_scripts[0].scriptName).toBe('Beacon A');
    });

    test('saveScriptsByType throws when writeExtensionField returns false for scoped scripts', async () => {
        writeExtensionFieldImpl = async () => false;

        await expect(
            engine.saveScriptsByType([makeScript('script-a', 'Updated A')], engine.SCRIPT_TYPES.SCOPED),
        ).rejects.toThrow(/scoped/i);

        expect(characters[0].data.extensions.regex_scripts[0].scriptName).toBe('Beacon A');
    });

    test('saveScriptsByType throws when writeExtensionField rejects with transport failure', async () => {
        writeExtensionFieldImpl = async () => {
            throw new TypeError('Failed to fetch');
        };

        await expect(
            engine.saveScriptsByType([makeScript('script-a', 'Updated A')], engine.SCRIPT_TYPES.SCOPED),
        ).rejects.toThrow('Failed to fetch');

        expect(characters[0].data.extensions.regex_scripts[0].scriptName).toBe('Beacon A');
    });

    test('saveScriptsByType respects captured scoped target even when characters reindex before persistence', async () => {
        const capturedTarget = engine.captureRegexTarget(engine.SCRIPT_TYPES.SCOPED);
        const calls = [];
        writeExtensionFieldImpl = async (characterId, key, value) => {
            calls.push({ characterId, key, value: structuredClone(value) });
            characters[characterId].data.extensions[key] = structuredClone(value);
            return true;
        };

        // Reindex: move character B to slot 0 (this_chid) and original character A to slot 1.
        const [charA, charB] = characters;
        characters.splice(0, characters.length, charB, charA);
        await engine.saveScriptsByType([makeScript('script-a', 'Saved on A')], engine.SCRIPT_TYPES.SCOPED, { target: capturedTarget });

        expect(calls).toHaveLength(1);
        expect(calls[0].characterId).toBe(1);
        expect(charA.data.extensions.regex_scripts[0].scriptName).toBe('Saved on A');
        expect(charB.data.extensions.regex_scripts[0].scriptName).toBe('Beacon B');
    });

    test('getScriptsByType skips invalid persisted entries read-only without triggering background writes', async () => {
        characters[0].data.extensions.regex_scripts = [makeScript('script-a', 'Beacon A'), null];
        const writeSpy = jest.fn(async () => true);
        writeExtensionFieldImpl = writeSpy;

        const visible = engine.getScriptsByType(engine.SCRIPT_TYPES.SCOPED);
        expect(visible).toHaveLength(1);
        expect(visible[0].id).toBe('script-a');

        await flushMicrotasks();

        // Reading never mutates live data or schedules unprompted background persistence.
        expect(writeSpy).not.toHaveBeenCalled();
        expect(characters[0].data.extensions.regex_scripts).toHaveLength(2);
        expect(characters[0].data.extensions.regex_scripts[1]).toBeNull();
    });

    test('explicit saveScriptsByType drops invalid entries and persists the new sibling cleanly', async () => {
        characters[0].data.extensions.regex_scripts = [makeScript('script-a', 'Beacon A'), null];
        let persistCount = 0;
        writeExtensionFieldImpl = async (characterId, key, value) => {
            persistCount += 1;
            characters[characterId].data.extensions[key] = structuredClone(value);
            return true;
        };

        const initialVisible = engine.getScriptsByType(engine.SCRIPT_TYPES.SCOPED);
        expect(initialVisible.map(s => s.id)).toEqual(['script-a']);

        const newSibling = makeScript('script-sibling', 'Lantern Sibling');
        await engine.saveScriptsByType([...initialVisible, newSibling], engine.SCRIPT_TYPES.SCOPED);
        await flushMicrotasks();

        expect(persistCount).toBe(1);
        expect(characters[0].data.extensions.regex_scripts.map(s => s.id)).toEqual(['script-a', 'script-sibling']);
    });

    test('getScriptsByType supports zero-clone hot-path reads while defaulting to isolated clones', () => {
        const liveRef = characters[0].data.extensions.regex_scripts[0];
        const cloned = engine.getScriptsByType(engine.SCRIPT_TYPES.SCOPED);
        const nonCloned = engine.getScriptsByType(engine.SCRIPT_TYPES.SCOPED, { clone: false });

        expect(cloned[0]).not.toBe(liveRef);
        expect(nonCloned[0]).toBe(liveRef);

        const replaced = engine.getRegexedString('a lantern glows', 1);
        expect(replaced).toBe('a beacon glows');
        expect(characters[0].data.extensions.regex_scripts[0]).toBe(liveRef);
    });
});
