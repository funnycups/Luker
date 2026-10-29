/**
 * CardApp ctx regex helpers — plugin lane write shape.
 *
 * The engine is mocked because its lane normalization is covered by
 * tests/regex-engine. These tests drive the real context helpers and assert
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

jest.unstable_mockModule('../public/scripts/extensions/regex/engine.js', () => ({
    SCRIPT_TYPES: { SCOPED: 'scoped', GLOBAL: 'global', PRESET: 'preset' },
    getScriptsByType: () => store,
    saveScriptsByType: async (scripts) => {
        store.splice(0, store.length, ...scripts);
    },
    getPluginLanes,
    omitLegacyPluginScope,
    normalizePluginScriptRecord,
}));

let buildContext;

beforeAll(async () => {
    globalThis.Luker = {
        getContext: () => ({
            characters: {},
            uuidv4: () => 'generated-id',
            extensionSettings: { regex: [] },
            swipe: { right: () => {} },
            worldInfoEntry: { create: () => ({}), delete: () => {} },
            chatWorldInfo: { getNames: () => [], setSelection: () => {} },
        }),
    };
    ({ buildContext } = await import('../public/scripts/extensions/card-app/context.js'));
});

beforeEach(() => {
    store.length = 0;
});

describe('CardApp regex helpers plugin lanes', () => {
    test('getRegexScripts normalizes legacy records and omits the old field', () => {
        store.push({ id: 'legacy', scriptName: 'Legacy rule', pluginOnly: true, placement: [1] });
        const ctx = buildContext({}, 'char-1', {});

        const scripts = ctx.getRegexScripts('character');

        expect(scripts[0]).toEqual({
            id: 'legacy',
            scriptName: 'Legacy rule',
            placement: [1],
            pluginLanes: ['request', 'reply'],
        });
        expect(scripts[0]).not.toHaveProperty('pluginOnly');
    });

    test('createRegexScript drops a caller-supplied old field and writes pluginLanes', async () => {
        const ctx = buildContext({}, 'char-1', {});

        await ctx.createRegexScript({ scriptName: 'New rule', placement: [1], pluginOnly: true });

        expect(store).toHaveLength(1);
        expect(store[0]).toMatchObject({ scriptName: 'New rule', placement: [1], pluginLanes: [] });
        expect(store[0]).not.toHaveProperty('pluginOnly');
    });

    test('updateRegexScript migrates a legacy record and drops the old field', async () => {
        store.push({ id: 'legacy', scriptName: 'Old name', pluginOnly: true, placement: [1] });
        const ctx = buildContext({}, 'char-1', {});

        await ctx.updateRegexScript('legacy', { scriptName: 'Renamed', pluginOnly: true });

        expect(store[0]).toMatchObject({
            id: 'legacy',
            scriptName: 'Renamed',
            placement: [1],
            pluginLanes: ['request', 'reply'],
        });
        expect(store[0]).not.toHaveProperty('pluginOnly');
    });
});
