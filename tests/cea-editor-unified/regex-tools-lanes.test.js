/**
 * CEA Studio regex authoring tools — plugin lane write shape.
 *
 * The engine is mocked here because its lane normalization is covered by
 * tests/regex-engine. These tests drive the real tool handlers and assert
 * that list/create/update expose and persist `pluginLanes` only.
 */

import { describe, test, expect, beforeAll, beforeEach, jest } from '@jest/globals';

const store = [];

function getPluginLanes(script) {
    if (Array.isArray(script?.pluginLanes)) {
        return [...new Set(script.pluginLanes.filter(lane => lane === 'request' || lane === 'reply'))];
    }
    return script?.pluginOnly ? ['request', 'reply'] : [];
}

function omitLegacyPluginScope(script) {
    if (!script || typeof script !== 'object') {
        return script;
    }
    const rest = { ...script };
    delete rest.pluginOnly;
    return rest;
}

function normalizePluginScriptRecord(script) {
    if (!script || typeof script !== 'object') {
        return script;
    }
    return { ...omitLegacyPluginScope(script), pluginLanes: getPluginLanes(script) };
}

jest.unstable_mockModule('../../public/scripts/extensions/regex/engine.js', () => ({
    SCRIPT_TYPES: { SCOPED: 'scoped', GLOBAL: 'global', PRESET: 'preset' },
    getScriptsByType: () => store,
    saveScriptsByType: async (scripts) => {
        store.splice(0, store.length, ...scripts);
    },
    getPluginLanes,
    omitLegacyPluginScope,
    normalizePluginScriptRecord,
}));

jest.unstable_mockModule('../../public/scripts/extensions/character-editor-assistant/studio/studio.js', () => ({
    fetchFileList: async () => [],
    fetchFileContent: async () => '',
    saveFileContent: async () => {},
    deleteFile: async () => {},
    renameFile: async () => {},
}));

jest.unstable_mockModule('../../public/scripts/lib/edits/conflict-ui.js', () => ({
    showConflictResolution: async () => true,
}));

jest.unstable_mockModule('../../public/scripts/iteration-library/tools/ctx-and-docs-discovery.js', () => ({
    listCtxKeys: () => [],
    describeCtxPath: () => '',
    listLukerDocs: () => [],
    readLukerDoc: () => '',
}));

let executeTool;
let TOOL_NAMES;

beforeAll(async () => {
    globalThis.Luker = {
        getContext: () => ({
            characters: {},
            characterId: 'char-1',
            uuidv4: () => 'generated-id',
            extensionSettings: { regex: [] },
            worldInfoEntry: { create: () => ({}), delete: () => {} },
            chatWorldInfo: { getNames: () => [] },
            loadWorldInfo: async () => ({}),
            saveWorldInfo: async () => {},
            createWorldBook: async () => {},
            charUpdatePrimaryWorld: async () => {},
            getCharaAuxWorlds: () => [],
            importEmbeddedWorldInfo: async () => ({}),
            getCharacterEmbeddedWorld: () => ({}),
            getCharaFilename: () => '',
            SlashCommandParser: {},
            writeExtensionField: async () => {},
            getExtensionApi: () => ({}),
            getCharacterState: () => ({}),
            updateCharacterState: () => {},
            lib: {},
        }),
    };
    ({ executeTool, TOOL_NAMES } = await import('../../public/scripts/extensions/character-editor-assistant/studio/ai-chat.js'));
});

beforeEach(() => {
    store.length = 0;
});

describe('CEA regex authoring plugin lanes', () => {
    test('list normalizes a legacy record and omits the old field', async () => {
        store.push({ id: 'legacy', scriptName: 'Legacy rule', pluginOnly: true, placement: [1] });

        const result = await executeTool('char-1', TOOL_NAMES.REGEX_LIST_SCRIPTS, { scope: 'character' });

        expect(result.ok).toBe(true);
        expect(result.scripts[0]).toEqual({
            id: 'legacy',
            scriptName: 'Legacy rule',
            placement: [1],
            pluginLanes: ['request', 'reply'],
        });
        expect(result.scripts[0]).not.toHaveProperty('pluginOnly');
    });

    test('create drops a caller-supplied old field and writes pluginLanes', async () => {
        const result = await executeTool('char-1', TOOL_NAMES.REGEX_CREATE_SCRIPT, {
            scope: 'character',
            scriptName: 'New rule',
            placement: [1],
            pluginOnly: true,
        });

        expect(result.ok).toBe(true);
        expect(store).toHaveLength(1);
        expect(store[0]).toMatchObject({ scriptName: 'New rule', placement: [1], pluginLanes: [] });
        expect(store[0]).not.toHaveProperty('pluginOnly');
    });

    test('update migrates a legacy record to pluginLanes and drops the old field', async () => {
        store.push({ id: 'legacy', scriptName: 'Old name', pluginOnly: true, placement: [1] });

        const result = await executeTool('char-1', TOOL_NAMES.REGEX_UPDATE_SCRIPT, {
            scope: 'character',
            id: 'legacy',
            patch: { scriptName: 'Renamed', pluginOnly: true },
        });

        expect(result.ok).toBe(true);
        expect(store[0]).toMatchObject({
            id: 'legacy',
            scriptName: 'Renamed',
            placement: [1],
            pluginLanes: ['request', 'reply'],
        });
        expect(store[0]).not.toHaveProperty('pluginOnly');
    });
});
