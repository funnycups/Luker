/**
 * Lane-semantics matrix for getRegexedString.
 *
 * Contract:
 *   - The three scope flags are independent channel switches. None of
 *     them changes the meaning of another.
 *   - `isPrompt` lane applies promptOnly scripts (main generation
 *     pipeline), whether or not a plugin lane is also set.
 *   - `isMarkdown` lane applies markdownOnly scripts (chat display),
 *     whether or not a plugin lane is also set.
 *   - `isPluginInput` lane applies scripts whose pluginLanes include
 *     'request' (a legacy pluginOnly script maps to both lanes): text
 *     going INTO a plugin request.
 *   - `isPluginOutput` lane applies scripts whose pluginLanes include
 *     'reply': the assistant text a plugin request returns. Placement
 *     does not gate this lane.
 *   - A legacy pluginOnly script therefore hits both plugin directions;
 *     the directions are disjoint text streams, so it never fires twice
 *     on the same text.
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
            id: 'script-display-and-plugin',
            scriptName: 'Display and plugin rule',
            findRegex: '/DISPLAYPLUGIN/g',
            replaceString: 'twolanes',
            placement: [1, 2],
            disabled: false,
            markdownOnly: true,
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
        {
            id: 'script-plugin-request',
            scriptName: 'Plugin request lane',
            findRegex: '/PLUGREQONLY/g',
            replaceString: 'req',
            placement: [1, 2],
            disabled: false,
            markdownOnly: false,
            pluginLanes: ['request'],
            minDepth: null,
            maxDepth: null,
        },
        {
            id: 'script-plugin-reply',
            scriptName: 'Plugin reply lane',
            findRegex: '/PLUGREPONLY/g',
            replaceString: 'rep',
            placement: [1, 2],
            disabled: false,
            markdownOnly: false,
            pluginLanes: ['reply'],
            minDepth: 5,
            maxDepth: null,
        },
        {
            id: 'script-plugin-request-no-placement',
            scriptName: 'Plugin request without placement',
            findRegex: '/PLUGREQNP/g',
            replaceString: 'reqnp',
            placement: [],
            disabled: false,
            markdownOnly: false,
            pluginLanes: ['request'],
            minDepth: null,
            maxDepth: null,
        },
        {
            id: 'script-plugin-reply-no-placement',
            scriptName: 'Plugin reply without placement',
            findRegex: '/PLUGREPNP/g',
            replaceString: 'repnp',
            placement: [],
            disabled: false,
            markdownOnly: false,
            pluginLanes: ['reply'],
            minDepth: null,
            maxDepth: null,
        },
        {
            id: 'script-plugin-reply-no-placement-field',
            scriptName: 'Plugin reply without placement property',
            findRegex: '/PLUGREPNOPLACEFIELD/g',
            replaceString: 'repnofield',
            disabled: false,
            markdownOnly: false,
            pluginLanes: ['reply'],
            minDepth: null,
            maxDepth: null,
        },
        {
            id: 'script-plugin-request-display',
            scriptName: 'Plugin request and display',
            findRegex: '/PLUGREQDISP/g',
            replaceString: 'reqdisp',
            placement: [1, 2],
            disabled: false,
            markdownOnly: true,
            pluginLanes: ['request'],
            minDepth: null,
            maxDepth: null,
        },
        {
            id: 'script-plugin-reply-prompt',
            scriptName: 'Plugin reply and prompt',
            findRegex: '/PLUGREPPROMPT/g',
            replaceString: 'repprompt',
            placement: [1, 2],
            disabled: false,
            promptOnly: true,
            pluginLanes: ['reply'],
            minDepth: null,
            maxDepth: null,
        },
        {
            id: 'script-legacy-plugin-user-only',
            scriptName: 'Legacy plugin user only',
            findRegex: '/LEGACYUSER/g',
            replaceString: 'legacyuser',
            placement: [1],
            disabled: false,
            pluginOnly: true,
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

let getRegexedString, getPluginLanes, omitLegacyPluginScope, normalizePluginScriptRecord;

beforeAll(async () => {
    ({ getRegexedString, getPluginLanes, omitLegacyPluginScope, normalizePluginScriptRecord } = await import('../../public/scripts/extensions/regex/engine.js'));
});

// placement 1 = USER_INPUT
const PLACEMENT = 1;

describe('omitLegacyPluginScope', () => {
    test('removes the legacy plugin field without mutating the record', () => {
        const script = { id: 'x', scriptName: 'x', pluginOnly: true, pluginLanes: ['request'], extra: 1 };
        const result = omitLegacyPluginScope(script);
        expect(result).toEqual({ id: 'x', scriptName: 'x', pluginLanes: ['request'], extra: 1 });
        expect(script.pluginOnly).toBe(true);
    });
});

describe('getPluginLanes', () => {
    test('filters invalid values and dedupes', () => {
        expect(getPluginLanes({ pluginLanes: ['reply', 'invalid', 'reply'] })).toEqual(['reply']);
    });

    test('an empty pluginLanes array takes precedence over the legacy field', () => {
        expect(getPluginLanes({ pluginLanes: [], pluginOnly: true })).toEqual([]);
    });
});

describe('normalizePluginScriptRecord', () => {
    test('maps a legacy-only record to both lanes and omits the old field', () => {
        const result = normalizePluginScriptRecord({ id: 'x', scriptName: 'x', pluginOnly: true, extra: 1 });
        expect(result).toEqual({ id: 'x', scriptName: 'x', extra: 1, pluginLanes: ['request', 'reply'] });
        expect(result).not.toHaveProperty('pluginOnly');
    });

    test('prefers pluginLanes when both fields are present', () => {
        const result = normalizePluginScriptRecord({ id: 'x', pluginOnly: true, pluginLanes: ['reply'] });
        expect(result).toEqual({ id: 'x', pluginLanes: ['reply'] });
    });
});

describe('getRegexedString lane semantics', () => {
    test('isPrompt lane applies promptOnly scripts, including dual-scope ones', () => {
        const out = getRegexedString('x MAINONLY y PLUGINONLY z DUAL w UNSCOPED', PLACEMENT, { isPrompt: true, depth: 9 });
        expect(out).toBe('x main y PLUGINONLY z both w UNSCOPED');
    });

    test('isPluginInput lane applies pluginOnly scripts, including dual-scope ones', () => {
        const out = getRegexedString('x MAINONLY y PLUGINONLY z DUAL w UNSCOPED', PLACEMENT, { isPluginInput: true, depth: 9 });
        expect(out).toBe('x MAINONLY y plugin z both w UNSCOPED');
    });

    test('isPluginOutput lane applies pluginOnly scripts, including dual-scope ones', () => {
        const out = getRegexedString('x MAINONLY y PLUGINONLY z DUAL w UNSCOPED', PLACEMENT, { isPluginOutput: true, depth: 9 });
        expect(out).toBe('x MAINONLY y plugin z both w UNSCOPED');
    });

    test('markdownOnly and pluginOnly on one script hit the display lane and both plugin lanes', () => {
        expect(getRegexedString('DISPLAYPLUGIN', PLACEMENT, { isMarkdown: true })).toBe('twolanes');
        expect(getRegexedString('DISPLAYPLUGIN', PLACEMENT, { isPluginInput: true, depth: 0 })).toBe('twolanes');
        expect(getRegexedString('DISPLAYPLUGIN', PLACEMENT, { isPluginOutput: true, depth: 0 })).toBe('twolanes');
        // No promptOnly flag, so the main pipeline stays untouched.
        expect(getRegexedString('DISPLAYPLUGIN', PLACEMENT, { isPrompt: true, depth: 0 })).toBe('DISPLAYPLUGIN');
    });

    test('promptOnly and pluginOnly on one script hit the main lane and both plugin lanes', () => {
        expect(getRegexedString('DUAL', PLACEMENT, { isPrompt: true, depth: 0 })).toBe('both');
        expect(getRegexedString('DUAL', PLACEMENT, { isPluginInput: true, depth: 0 })).toBe('both');
        expect(getRegexedString('DUAL', PLACEMENT, { isPluginOutput: true, depth: 0 })).toBe('both');
    });

    test('reply lane ignores depth filtering', () => {
        // The reply pass has no depth; a legacy pluginOnly script with
        // minDepth:5 still cooks the reply at depth 0.
        expect(getRegexedString('PLUGINONLY', PLACEMENT, { isPluginOutput: true, depth: 0 })).toBe('plugin');
        expect(getRegexedString('PLUGINONLY', PLACEMENT, { isPluginOutput: true })).toBe('plugin');
    });

    test('unscoped script only matches the default lane', () => {
        expect(getRegexedString('UNSCOPED', PLACEMENT, {})).toBe('raw');
        expect(getRegexedString('UNSCOPED', PLACEMENT, { isPrompt: true, depth: 0 })).toBe('UNSCOPED');
        expect(getRegexedString('UNSCOPED', PLACEMENT, { isPluginInput: true, depth: 0 })).toBe('UNSCOPED');
        expect(getRegexedString('UNSCOPED', PLACEMENT, { isPluginOutput: true, depth: 0 })).toBe('UNSCOPED');
        expect(getRegexedString('UNSCOPED', PLACEMENT, { isMarkdown: true })).toBe('UNSCOPED');
    });

    test('plugin request lane does not touch the reply lane', () => {
        expect(getRegexedString('PLUGREQONLY', PLACEMENT, { isPluginInput: true })).toBe('req');
        expect(getRegexedString('PLUGREQONLY', PLACEMENT, { isPluginOutput: true })).toBe('PLUGREQONLY');
    });

    test('plugin reply lane does not touch the request lane', () => {
        expect(getRegexedString('PLUGREPONLY', PLACEMENT, { isPluginOutput: true })).toBe('rep');
        expect(getRegexedString('PLUGREPONLY', PLACEMENT, { isPluginInput: true })).toBe('PLUGREPONLY');
    });

    test('plugin reply lane ignores placement and depth', () => {
        expect(getRegexedString('PLUGREPNP', PLACEMENT, { isPluginOutput: true })).toBe('repnp');
        expect(getRegexedString('PLUGREPONLY', PLACEMENT, { isPluginOutput: true, depth: 0 })).toBe('rep');
    });

    test('plugin reply lane runs when the placement property is absent', () => {
        expect(getRegexedString('PLUGREPNOPLACEFIELD', PLACEMENT, { isPluginOutput: true })).toBe('repnofield');
    });

    test('plugin request lane requires placement', () => {
        expect(getRegexedString('PLUGREQNP', PLACEMENT, { isPluginInput: true })).toBe('PLUGREQNP');
        expect(getRegexedString('PLUGREQONLY', PLACEMENT, { isPluginInput: true })).toBe('req');
    });

    test('plugin lanes are independent of display and prompt flags', () => {
        expect(getRegexedString('PLUGREQDISP', PLACEMENT, { isMarkdown: true })).toBe('reqdisp');
        expect(getRegexedString('PLUGREQDISP', PLACEMENT, { isPluginInput: true })).toBe('reqdisp');
        expect(getRegexedString('PLUGREQDISP', PLACEMENT, { isPluginOutput: true })).toBe('PLUGREQDISP');

        expect(getRegexedString('PLUGREPPROMPT', PLACEMENT, { isPrompt: true })).toBe('repprompt');
        expect(getRegexedString('PLUGREPPROMPT', PLACEMENT, { isPluginOutput: true })).toBe('repprompt');
        expect(getRegexedString('PLUGREPPROMPT', PLACEMENT, { isPluginInput: true })).toBe('PLUGREPPROMPT');
    });

    test('plugin-only rules do not match the stored-chat lane', () => {
        expect(getRegexedString('PLUGREQONLY', PLACEMENT, {})).toBe('PLUGREQONLY');
        expect(getRegexedString('PLUGREPONLY', PLACEMENT, {})).toBe('PLUGREPONLY');
    });

    test('legacy pluginOnly maps to both lanes without placement inspection', () => {
        expect(getRegexedString('LEGACYUSER', PLACEMENT, { isPluginInput: true, depth: 0 })).toBe('legacyuser');
        expect(getRegexedString('LEGACYUSER', PLACEMENT, { isPluginOutput: true })).toBe('legacyuser');
    });
});
