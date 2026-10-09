// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest } from '@jest/globals';

globalThis.Luker = {
    getContext: () => ({
        eventSource: { on() {} },
        eventTypes: {},
        constants: { promptRoles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 }, wiPosition: {} },
        getRequestHeaders: () => ({}),
        saveSettings: () => {},
        saveSettingsDebounced: () => {},
        extensionSettings: { search_tools: {} },
        secrets: { KEYS: {}, state: {} },
        escapeHtml: (s) => String(s ?? ''),
        getStringHash: (s) => String(s).length,
        worldInfoEntry: { template: {}, setGlobalSelection: async () => false },
        POPUP_TYPE: {},
        Popup: class {},
        translate: (s) => String(s ?? ''),
        addLocaleData: () => {},
    }),
};

// main.js transitively imports browser-only modules that touch `document`
// at load time; stub those edges so the module graph loads under node.
jest.unstable_mockModule('../../public/scripts/extensions/connection-manager/profile-resolver.js', () => ({
    getChatCompletionConnectionProfiles: async () => [],
}));
jest.unstable_mockModule('../../public/scripts/extensions/preset-help.js', () => ({
    renderPresetHelpButton: () => '',
}));

let mod;
beforeAll(async () => {
    mod = await import('../../public/scripts/extensions/search-tools/main.js');
});

describe('settings cleanup', () => {
    test('DEFAULT_SETTINGS drops agentMaxRounds and agentFinalStagePrompt', () => {
        expect(mod.DEFAULT_SETTINGS).not.toHaveProperty('agentMaxRounds');
        expect(mod.DEFAULT_SETTINGS).not.toHaveProperty('agentFinalStagePrompt');
        expect(mod.DEFAULT_SETTINGS).toHaveProperty('agentSystemPrompt');
    });
});
