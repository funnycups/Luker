// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, jest, test } from '@jest/globals';

let mockContext = { extensionSettings: {} };

jest.unstable_mockModule('../public/scripts/popup.js', () => ({
    Popup: class { constructor() {} show() { return Promise.resolve(); } },
    POPUP_TYPE: { TEXT: 0, CONFIRM: 1 },
    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: -1 },
}));

jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    translate: (s) => String(s ?? ''),
    getCurrentLocale: () => 'en',
}));

jest.unstable_mockModule('../public/scripts/st-context.js', () => ({
    getContext: () => mockContext,
}));

const { resolveAgentMode } = await import('../public/scripts/extensions/preset-help.js');

describe('preset-help resolveAgentMode', () => {
    test('returns explicit director / non-director unchanged', () => {
        expect(resolveAgentMode('director')).toBe('director');
        expect(resolveAgentMode('non-director')).toBe('non-director');
        expect(resolveAgentMode('')).toBe('');
    });

    test('dynamic mode reads extensionSettings.orchestrator.executionMode', () => {
        mockContext = {
            extensionSettings: {
                orchestrator: { executionMode: 'director' },
            },
        };
        expect(resolveAgentMode('dynamic')).toBe('director');

        mockContext = {
            extensionSettings: {
                orchestrator: { executionMode: 'spec' },
            },
        };
        expect(resolveAgentMode('dynamic')).toBe('non-director');

        mockContext = {
            extensionSettings: {},
        };
        expect(resolveAgentMode('dynamic')).toBe('non-director');

        mockContext = {};
        expect(resolveAgentMode('dynamic')).toBe('non-director');
    });
});
