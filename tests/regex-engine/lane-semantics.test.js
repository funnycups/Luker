/**
 * Lane-semantics matrix for getRegexedString.
 *
 * Contract:
 *   - `isPrompt` lane applies promptOnly scripts without pluginOnly
 *     (main generation pipeline).
 *   - `isPluginInput` lane applies dual-scope scripts (pluginOnly AND
 *     promptOnly): text going INTO a plugin request.
 *   - `isPluginOutput` lane applies pluginOnly scripts WITHOUT
 *     promptOnly: the assistant text a plugin request returns.
 *   - The plugin channel is directional, so a dual-scope script hits the
 *     plugin input lane only — never the main lane, never the output lane.
 *   - Depth filtering only runs when a numeric depth is passed.
 *   - A script with no scope flags matches only the unscoped lane
 *     (!isMarkdown && !isPrompt && !isPluginInput && !isPluginOutput).
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
    test('isPrompt lane applies promptOnly-only but not pluginOnly or dual-scope', () => {
        const out = getRegexedString('x MAINONLY y PLUGINONLY z DUAL w UNSCOPED', PLACEMENT, { isPrompt: true, depth: 9 });
        expect(out).toBe('x main y PLUGINONLY z DUAL w UNSCOPED');
    });

    test('isPluginInput lane applies dual-scope (pluginOnly+promptOnly) but not pluginOnly-only', () => {
        const out = getRegexedString('x MAINONLY y PLUGINONLY z DUAL w UNSCOPED', PLACEMENT, { isPluginInput: true, depth: 9 });
        expect(out).toBe('x MAINONLY y PLUGINONLY z both w UNSCOPED');
    });

    test('isPluginOutput lane applies pluginOnly-only but not dual-scope', () => {
        const out = getRegexedString('x MAINONLY y PLUGINONLY z DUAL w UNSCOPED', PLACEMENT, { isPluginOutput: true, depth: 9 });
        expect(out).toBe('x MAINONLY y plugin z DUAL w UNSCOPED');
    });

    test('dual-scope script hits the plugin input lane only', () => {
        expect(getRegexedString('DUAL', PLACEMENT, { isPrompt: true, depth: 0 })).toBe('DUAL');
        expect(getRegexedString('DUAL', PLACEMENT, { isPluginInput: true, depth: 0 })).toBe('both');
        expect(getRegexedString('DUAL', PLACEMENT, { isPluginOutput: true, depth: 0 })).toBe('DUAL');
    });

    test('depth=undefined skips minDepth/maxDepth filtering (undepthed plugin output message still matches)', () => {
        // pluginOnly script has minDepth:5; with numeric depth 0 it must NOT match...
        expect(getRegexedString('PLUGINONLY', PLACEMENT, { isPluginOutput: true, depth: 0 })).toBe('PLUGINONLY');
        // ...but with no depth the filter is skipped entirely.
        expect(getRegexedString('PLUGINONLY', PLACEMENT, { isPluginOutput: true })).toBe('plugin');
    });

    test('unscoped script only matches the default lane', () => {
        expect(getRegexedString('UNSCOPED', PLACEMENT, {})).toBe('raw');
        expect(getRegexedString('UNSCOPED', PLACEMENT, { isPrompt: true, depth: 0 })).toBe('UNSCOPED');
        expect(getRegexedString('UNSCOPED', PLACEMENT, { isPluginInput: true, depth: 0 })).toBe('UNSCOPED');
        expect(getRegexedString('UNSCOPED', PLACEMENT, { isPluginOutput: true, depth: 0 })).toBe('UNSCOPED');
        expect(getRegexedString('UNSCOPED', PLACEMENT, { isMarkdown: true })).toBe('UNSCOPED');
    });
});
