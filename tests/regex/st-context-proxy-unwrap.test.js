/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import {
    getCharacterArrayApiProxy,
    unwrapCharacterApiProxy,
} from '../../public/scripts/lib/character-api-proxy.js';
import { createRegexEngine } from '../../public/scripts/extensions/regex/engine-core.js';

if (typeof globalThis.structuredClone !== 'function') {
    globalThis.structuredClone = (v) => JSON.parse(JSON.stringify(v));
}

describe('real CharacterApiProxy unwrapping with real regex engine', () => {
    let aliceRaw;
    let bobRaw;
    let charactersArray;
    let currentCharacterId;
    let extensionSettings;
    let engine;

    beforeEach(() => {
        aliceRaw = {
            name: 'Alice',
            avatar: 'alice.png',
            data: {
                extensions: {
                    regex_scripts: [{ id: 'a-1', scriptName: 'Alice Rule', findRegex: '/a/g', replaceString: 'b', placement: [1], trimStrings: [] }],
                },
            },
        };
        bobRaw = {
            name: 'Bob',
            avatar: 'bob.png',
            data: {
                extensions: {
                    regex_scripts: [{ id: 'b-1', scriptName: 'Bob Rule', findRegex: '/c/g', replaceString: 'd', placement: [2], trimStrings: [] }],
                },
            },
        };
        charactersArray = [aliceRaw, bobRaw];
        currentCharacterId = 1; // Bob is active; we target Alice's proxy
        extensionSettings = {
            disabledExtensions: [],
            regex: [],
            character_allowed_regex: ['alice.png', 'bob.png'],
            preset_allowed_regex: {},
        };

        engine = createRegexEngine({
            getCharacters: () => charactersArray,
            getThisChid: () => currentCharacterId,
            getExtensionSettings: () => extensionSettings,
            saveSettingsDebounced: () => {},
            substituteParams: (s) => String(s ?? ''),
            substituteParamsExtended: (s) => String(s ?? ''),
            writeExtensionField: jest.fn(async (id, ns, value) => {
                const c = charactersArray[id];
                if (!c) return false;
                c.data ??= {};
                c.data.extensions ??= {};
                c.data.extensions[ns] = typeof value === 'function'
                    ? await value(structuredClone(c.data.extensions[ns]))
                    : structuredClone(value);
                return true;
            }),
            getPresetManager: () => null,
            regexFromString: (s) => new RegExp(s),
            isRegexScriptPaused: () => false,
            recordRegexExecution: () => {},
            resetRegexScriptState: () => {},
        });
    });

    test('real CharacterApiProxy unwraps to raw character and works in regex engine scoped reads & writes', async () => {
        const charactersProxy = getCharacterArrayApiProxy(charactersArray);
        const aliceProxy = charactersProxy[0];

        expect(aliceProxy).not.toBe(aliceRaw);
        expect(unwrapCharacterApiProxy(aliceProxy)).toBe(aliceRaw);
        expect(unwrapCharacterApiProxy(charactersProxy)).toBe(charactersArray);

        const readScripts = engine.getScriptsByType(engine.SCRIPT_TYPES.SCOPED, {
            target: { scriptType: engine.SCRIPT_TYPES.SCOPED, character: aliceProxy },
        });
        expect(readScripts.map(s => s.id)).toEqual(['a-1']);

        const nextScripts = [
            ...readScripts,
            { id: 'a-2', scriptName: 'Alice Added', findRegex: '/x/g', replaceString: 'y', placement: [2], trimStrings: [] },
        ];
        await engine.saveScriptsByType(nextScripts, engine.SCRIPT_TYPES.SCOPED, {
            target: { scriptType: engine.SCRIPT_TYPES.SCOPED, character: aliceProxy },
        });

        expect(aliceRaw.data.extensions.regex_scripts.map(s => s.id)).toEqual(['a-1', 'a-2']);
        expect(bobRaw.data.extensions.regex_scripts.map(s => s.id)).toEqual(['b-1']);
    });
});
