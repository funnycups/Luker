/**
 * Lane-semantics matrix for getRegexedString.
 *
 * Contract:
 *   - `isPrompt` lane applies promptOnly scripts (main generation pipeline).
 *   - `isPluginPrompt` lane applies pluginOnly scripts (plugin-built LLM
 *     messages; the request-side entry point feeding chat text to
 *     plugin-driven LLM requests is lib/plugin-floors.js).
 *   - A dual-scope script (promptOnly AND pluginOnly) matches each lane,
 *     one pass per lane.
 *   - Depth filtering only runs when a numeric depth is passed.
 *   - A script with no scope flags matches only the unscoped lane
 *     (!isMarkdown && !isPrompt && !isPluginPrompt).
 */

import { describe, test, expect, beforeAll, jest } from '@jest/globals';

jest.unstable_mockModule('../../public/script.js', () => ({
    characters: {},
    saveSettingsDebounced: () => {},
    substituteParams: (s) => s,
    substituteParamsExtended: (s) => s,
    this_chid: null,
}));

const extensionSettings = {
    disabledExtensions: [],
    regex: [
        {
            id: 'script-prompt-only',
            scriptName: 'A promptOnly',
            findRegex: '/MAINONLY/g',
            replaceString: 'main',
            placement: [1, 2],
            disabled: false,
            markdownOnly: false,
            promptOnly: true,
            minDepth: null,
            maxDepth: null,
        },
        {
            id: 'script-plugin-only',
            scriptName: 'B pluginOnly',
            findRegex: '/PLUGINONLY/g',
            replaceString: 'plugin',
            placement: [1, 2],
            disabled: false,
            markdownOnly: false,
            pluginOnly: true,
            minDepth: 5,
            maxDepth: null,
        },
        {
            id: 'script-dual-scope',
            scriptName: 'Dual-scope rule',
            findRegex: '/DUAL/g',
            replaceString: 'both',
            placement: [1, 2],
            disabled: false,
            markdownOnly: false,
            promptOnly: true,
            pluginOnly: true,
            minDepth: null,
            maxDepth: null,
        },
        {
            id: 'script-unscoped',
            scriptName: 'Unscoped rule',
            findRegex: '/UNSCOPED/g',
            replaceString: 'raw',
            placement: [1, 2],
            disabled: false,
            minDepth: null,
            maxDepth: null,
        },
    ],
};

jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    extension_settings: extensionSettings,
    writeExtensionField: () => {},
}));

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({ t: (s) => s }));
jest.unstable_mockModule('../../public/scripts/preset-manager.js', () => ({ getPresetManager: () => null }));
jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
    regexFromString: (input) => {
        if (typeof input !== 'string') return null;
        const m = input.match(/\/(.+)\/([gimsuy]*)/s);
        return m ? new RegExp(m[1], m[2]) : new RegExp(input);
    },
}));
jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    callGenericPopup: () => Promise.resolve(false),
    POPUP_RESULT: { AFFIRMATIVE: 1 },
    POPUP_TYPE: { CONFIRM: 1 },
}));
jest.unstable_mockModule('../../public/scripts/extensions/regex/redos-reporter.js', () => ({
    isRegexScriptPaused: () => false,
    recordRegexExecution: () => {},
    resetRegexScriptState: () => {},
}));

let getRegexedString;

beforeAll(async () => {
    ({ getRegexedString } = await import('../../public/scripts/extensions/regex/engine.js'));
});

// placement 1 = USER_INPUT
const PLACEMENT = 1;

describe('getRegexedString lane semantics', () => {
    test('isPrompt lane applies promptOnly but not pluginOnly', () => {
        const out = getRegexedString('x MAINONLY y PLUGINONLY z DUAL w UNSCOPED', PLACEMENT, { isPrompt: true, depth: 9 });
        expect(out).toBe('x main y PLUGINONLY z both w UNSCOPED');
    });

    test('isPluginPrompt lane applies pluginOnly but not promptOnly', () => {
        const out = getRegexedString('x MAINONLY y PLUGINONLY z DUAL w UNSCOPED', PLACEMENT, { isPluginPrompt: true, depth: 9 });
        expect(out).toBe('x MAINONLY y plugin z both w UNSCOPED');
    });

    test('dual-scope script hits once on each lane, asserted separately', () => {
        expect(getRegexedString('DUAL', PLACEMENT, { isPrompt: true, depth: 0 })).toBe('both');
        expect(getRegexedString('DUAL', PLACEMENT, { isPluginPrompt: true, depth: 0 })).toBe('both');
    });

    test('depth=undefined skips minDepth/maxDepth filtering (undepthed pluginOnly message still matches)', () => {
        // pluginOnly script has minDepth:5; with numeric depth 0 it must NOT match...
        expect(getRegexedString('PLUGINONLY', PLACEMENT, { isPluginPrompt: true, depth: 0 })).toBe('PLUGINONLY');
        // ...but with no depth the filter is skipped entirely.
        expect(getRegexedString('PLUGINONLY', PLACEMENT, { isPluginPrompt: true })).toBe('plugin');
    });

    test('unscoped script only matches the default lane', () => {
        expect(getRegexedString('UNSCOPED', PLACEMENT, {})).toBe('raw');
        expect(getRegexedString('UNSCOPED', PLACEMENT, { isPrompt: true, depth: 0 })).toBe('UNSCOPED');
        expect(getRegexedString('UNSCOPED', PLACEMENT, { isPluginPrompt: true, depth: 0 })).toBe('UNSCOPED');
        expect(getRegexedString('UNSCOPED', PLACEMENT, { isMarkdown: true })).toBe('UNSCOPED');
    });
});
