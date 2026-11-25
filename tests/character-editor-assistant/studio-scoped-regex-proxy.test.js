// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeAll, beforeEach, jest } from '@jest/globals';

const CHARACTER_API_PROXY_TARGET = Symbol.for('luker.characterApiProxyTarget');

const rawCharacters = [];
let activeChid = 0;
const extensionSettings = {
    disabledExtensions: [],
    regex: [],
    character_allowed_regex: [],
    preset_allowed_regex: {},
};

const characterWrapperCache = new WeakMap();

function wrapCharacterProxy(raw) {
    if (!raw || typeof raw !== 'object') return raw;
    if (!characterWrapperCache.has(raw)) {
        characterWrapperCache.set(raw, Object.defineProperty(Object.create(raw), CHARACTER_API_PROXY_TARGET, {
            value: raw,
            enumerable: false,
        }));
    }
    return characterWrapperCache.get(raw);
}

function wrapCharacterListProxy(list) {
    const unwrap = (v) => (v && typeof v === 'object' && v[CHARACTER_API_PROXY_TARGET]) ? v[CHARACTER_API_PROXY_TARGET] : v;
    const wrapped = list.map(wrapCharacterProxy);
    Object.defineProperty(wrapped, CHARACTER_API_PROXY_TARGET, {
        value: list,
        enumerable: false,
    });
    wrapped.indexOf = (...args) => list.indexOf(unwrap(args[0]), ...args.slice(1));
    wrapped.includes = (...args) => list.includes(unwrap(args[0]), ...args.slice(1));
    return wrapped;
}

jest.unstable_mockModule('../../public/script.js', () => ({
    characters: rawCharacters,
    get this_chid() { return activeChid; },
    saveSettingsDebounced: jest.fn(),
    substituteParams: (s) => s,
    substituteParamsExtended: (s) => s,
}));

jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    extension_settings: extensionSettings,
    writeExtensionField: async (characterId, key, value) => {
        const card = rawCharacters[characterId];
        if (!card) return false;
        card.data ??= {};
        card.data.extensions ??= {};
        card.data.extensions[key] = typeof value === 'function'
            ? await value(structuredClone(card.data.extensions[key]))
            : structuredClone(value);
        return true;
    },
}));

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((acc, s, i) => acc + s + (values[i] ?? ''), ''),
    translate: (s) => String(s ?? ''),
    createScopedI18n: () => ({ i18n: (s) => String(s ?? ''), i18nFormat: (s) => String(s ?? '') }),
}));

jest.unstable_mockModule('../../public/scripts/preset-manager.js', () => ({
    getPresetManager: () => null,
}));

jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
    regexFromString: (input) => new RegExp(input),
}));

jest.unstable_mockModule('../../public/scripts/extensions/regex/redos-reporter.js', () => ({
    isRegexScriptPaused: () => false,
    recordRegexExecution: () => {},
    resetRegexScriptState: () => {},
}));

jest.unstable_mockModule('../../public/scripts/extensions/character-editor-assistant/studio/file-api.js', () => ({
    fetchFileList: async () => [],
    fetchFileContent: async () => '',
    saveFileContent: async () => {},
    deleteFile: async () => {},
    renameFile: async () => {},
}));

jest.unstable_mockModule('../../public/scripts/lib/edits/conflict-ui.js', () => ({
    showConflictResolution: async () => null,
}));

jest.unstable_mockModule('../../public/scripts/iteration-library/tools/ctx-and-docs-discovery.js', () => ({
    listCtxKeys: () => [],
    describeCtxPath: () => '',
    listLukerDocs: () => [],
    readLukerDoc: () => '',
}));

let regexEngine;
let executeTool;
let TOOL_NAMES;
let nextUuid = 1;

const updateCharacterDataSpy = jest.fn(async (id, patch) => {
    Object.assign(rawCharacters[id].data, patch);
});
const charUpdatePrimaryWorldSpy = jest.fn(async () => true);
const importEmbeddedWorldInfoSpy = jest.fn(async (_skip, char) => ({
    imported: true,
    bound: true,
    bookName: char?.data?.character_book?.name || 'Imported',
}));

function buildContext() {
    return {
        characters: wrapCharacterListProxy(rawCharacters),
        characterId: activeChid,
        uuidv4: () => `uuid-${nextUuid++}`,
        extensionSettings,
        worldInfoEntry: { create: () => ({}), delete: () => {} },
        chatWorldInfo: { getNames: () => [] },
        getWorldInfoNames: () => [],
        loadWorldInfo: async () => ({ entries: {} }),
        saveWorldInfo: async () => {},
        createWorldBook: async () => true,
        charUpdatePrimaryWorld: charUpdatePrimaryWorldSpy,
        getCharaAuxWorlds: () => [],
        importEmbeddedWorldInfo: importEmbeddedWorldInfoSpy,
        getCharacterEmbeddedWorld: () => null,
        getCharaFilename: (_chid, opts) => String(opts?.manualAvatarKey || '').replace(/\.png$/i, ''),
        SlashCommandParser: { commands: {} },
        updateCharacterData: updateCharacterDataSpy,
        writeExtensionField: async (characterId, key, value) => {
            const card = rawCharacters[characterId];
            if (!card) return false;
            card.data ??= {};
            card.data.extensions ??= {};
            card.data.extensions[key] = typeof value === 'function'
                ? await value(structuredClone(card.data.extensions[key]))
                : structuredClone(value);
            return true;
        },
        getExtensionApi: () => null,
        lib: {},
        regex: {
            SCRIPT_TYPES: regexEngine.SCRIPT_TYPES,
            getScriptsByType: regexEngine.getScriptsByType,
            saveScriptsByType: regexEngine.saveScriptsByType,
            getPluginLanes: regexEngine.getPluginLanes,
            omitLegacyPluginScope: regexEngine.omitLegacyPluginScope,
            normalizePluginScriptRecord: regexEngine.normalizePluginScriptRecord,
        },
    };
}

beforeAll(async () => {
    regexEngine = await import('../../public/scripts/extensions/regex/engine.js');
    globalThis.Luker = { getContext: () => buildContext() };
    ({ executeTool, TOOL_NAMES } = await import('../../public/scripts/extensions/character-editor-assistant/studio/ai-chat.js'));
});

beforeEach(() => {
    nextUuid = 1;
    activeChid = 1;
    updateCharacterDataSpy.mockClear();
    charUpdatePrimaryWorldSpy.mockClear();
    importEmbeddedWorldInfoSpy.mockClear();
    rawCharacters.splice(0, rawCharacters.length,
        {
            name: 'Alice',
            avatar: 'alice.png',
            data: {
                description: 'Alice desc',
                character_book: { name: 'AliceBook', entries: [{ keys: ['k'], content: 'v' }] },
                extensions: {
                    regex_scripts: [{
                        id: 'alice-r1',
                        scriptName: 'Alice Rule 1',
                        findRegex: '/foo/g',
                        replaceString: 'bar',
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
                    }],
                },
            },
        },
        {
            name: 'Bob',
            avatar: 'bob.png',
            data: {
                description: 'Bob desc',
                extensions: {
                    regex_scripts: [{
                        id: 'bob-r1',
                        scriptName: 'Bob Rule 1',
                        findRegex: '/baz/g',
                        replaceString: 'qux',
                        trimStrings: [],
                        placement: [2],
                        disabled: false,
                        markdownOnly: false,
                        promptOnly: false,
                        pluginLanes: [],
                        runOnEdit: false,
                        substituteRegex: 0,
                        minDepth: null,
                        maxDepth: null,
                    }],
                },
            },
        },
    );
});

describe('CardApp Studio scoped regex tools with CharacterApiProxy & regex target resolution', () => {
    test('regex_list_scripts, create, update, and delete work with CharacterApiProxy from getContext().characters', async () => {
        const aliceProxy = globalThis.Luker.getContext().characters[0];
        expect(aliceProxy).not.toBe(rawCharacters[0]);

        // List (targeting Alice via proxy even while Bob is activeChid = 1)
        const listed = await executeTool('alice', TOOL_NAMES.REGEX_LIST_SCRIPTS, { scope: 'character' }, { character: aliceProxy });
        expect(listed.ok).toBe(true);
        expect(listed.scripts.map(s => s.id)).toEqual(['alice-r1']);

        // Create
        const created = await executeTool('alice', TOOL_NAMES.REGEX_CREATE_SCRIPT, {
            scope: 'character',
            scriptName: 'Alice Rule 2',
            findRegex: '/hello/g',
            replaceString: 'world',
            placement: [2],
        }, { character: aliceProxy });
        expect(created.ok).toBe(true);
        expect(rawCharacters[0].data.extensions.regex_scripts.map(s => s.scriptName)).toEqual(['Alice Rule 1', 'Alice Rule 2']);
        expect(rawCharacters[1].data.extensions.regex_scripts.map(s => s.scriptName)).toEqual(['Bob Rule 1']);

        // Update
        const updated = await executeTool('alice', TOOL_NAMES.REGEX_UPDATE_SCRIPT, {
            scope: 'character',
            id: created.script.id,
            patch: { scriptName: 'Alice Rule 2 Edited' },
        }, { character: aliceProxy });
        expect(updated.ok).toBe(true);
        expect(rawCharacters[0].data.extensions.regex_scripts[1].scriptName).toBe('Alice Rule 2 Edited');

        // Delete
        const deleted = await executeTool('alice', TOOL_NAMES.REGEX_DELETE_SCRIPT, {
            scope: 'character',
            id: created.script.id,
        }, { character: aliceProxy });
        expect(deleted.ok).toBe(true);
        expect(rawCharacters[0].data.extensions.regex_scripts.map(s => s.id)).toEqual(['alice-r1']);
    });

    test('regex engine resolves scoped targets by raw character, proxy, characterId, or avatar without falling back to activeChid', () => {
        const aliceProxy = globalThis.Luker.getContext().characters[0];

        expect(regexEngine.getScriptsByType(regexEngine.SCRIPT_TYPES.SCOPED, {
            target: { scriptType: regexEngine.SCRIPT_TYPES.SCOPED, character: rawCharacters[0], characterId: 0 },
        }).map(s => s.id)).toEqual(['alice-r1']);

        expect(regexEngine.getScriptsByType(regexEngine.SCRIPT_TYPES.SCOPED, {
            target: { scriptType: regexEngine.SCRIPT_TYPES.SCOPED, character: aliceProxy, characterId: 0 },
        }).map(s => s.id)).toEqual(['alice-r1']);

        expect(regexEngine.getScriptsByType(regexEngine.SCRIPT_TYPES.SCOPED, {
            target: { scriptType: regexEngine.SCRIPT_TYPES.SCOPED, characterId: 0 },
        }).map(s => s.id)).toEqual(['alice-r1']);

        expect(regexEngine.getScriptsByType(regexEngine.SCRIPT_TYPES.SCOPED, {
            target: { scriptType: regexEngine.SCRIPT_TYPES.SCOPED, avatar: 'alice.png' },
        }).map(s => s.id)).toEqual(['alice-r1']);

        // Unmatched explicit targets must return empty, never activeChid (Bob)
        expect(regexEngine.getScriptsByType(regexEngine.SCRIPT_TYPES.SCOPED, {
            target: { scriptType: regexEngine.SCRIPT_TYPES.SCOPED, avatar: 'missing.png' },
        })).toEqual([]);
        expect(regexEngine.getScriptsByType(regexEngine.SCRIPT_TYPES.SCOPED, {
            target: { scriptType: regexEngine.SCRIPT_TYPES.SCOPED, characterId: 99 },
        })).toEqual([]);
    });

    test('CHARACTER_UPDATE_FIELDS and CHARACTER_IMPORT_EMBEDDED_WORLD resolve via charId without options.character', async () => {
        const upd = await executeTool('alice', TOOL_NAMES.CHARACTER_UPDATE_FIELDS, {
            fields: { description: 'Updated Alice' },
        });
        expect(upd.ok).toBe(true);
        expect(updateCharacterDataSpy).toHaveBeenCalledWith(0, { description: 'Updated Alice' }, { immediate: true });

        const imp = await executeTool('alice', TOOL_NAMES.CHARACTER_IMPORT_EMBEDDED_WORLD, {});
        expect(imp.ok).toBe(true);
        expect(importEmbeddedWorldInfoSpy).toHaveBeenCalledTimes(1);
        expect(imp.world).toBe('AliceBook');
    });

    test('explicit unmatched charId fails cleanly instead of falling back to the active character', async () => {
        const getRes = await executeTool('nonexistent', TOOL_NAMES.CHARACTER_GET_FIELDS, {});
        expect(getRes.ok).toBe(false);
        expect(getRes.error).toMatch(/nonexistent/);

        const updRes = await executeTool('nonexistent', TOOL_NAMES.CHARACTER_UPDATE_FIELDS, { fields: { description: 'Hacked' } });
        expect(updRes.ok).toBe(false);
        expect(updRes.error).toMatch(/nonexistent/);
        expect(updateCharacterDataSpy).not.toHaveBeenCalled();

        const impRes = await executeTool('nonexistent', TOOL_NAMES.CHARACTER_IMPORT_EMBEDDED_WORLD, {});
        expect(impRes.ok).toBe(false);
        expect(impRes.error).toMatch(/nonexistent/);
        expect(importEmbeddedWorldInfoSpy).not.toHaveBeenCalled();

        const listRegex = await executeTool('nonexistent', TOOL_NAMES.REGEX_LIST_SCRIPTS, { scope: 'character' });
        expect(listRegex.ok).toBe(false);
        expect(listRegex.error).toMatch(/nonexistent/);

        const createRegex = await executeTool('nonexistent', TOOL_NAMES.REGEX_CREATE_SCRIPT, {
            scope: 'character',
            scriptName: 'Should Fail',
            findRegex: '/x/g',
            replaceString: 'y',
            placement: [1],
        });
        expect(createRegex.ok).toBe(false);
        expect(createRegex.error).toMatch(/nonexistent/);
        expect(rawCharacters[1].data.extensions.regex_scripts).toHaveLength(1);
    });
});
