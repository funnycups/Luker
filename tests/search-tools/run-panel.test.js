// SPDX-License-Identifier: AGPL-3.0-or-later

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

let mod;
beforeAll(async () => {
    mod = await import('../../public/scripts/extensions/search-tools/run-panel.js');
});

test('createSearchRunPanel returns an isolated store with the shared surface', () => {
    const { store } = mod.createSearchRunPanel({ t: (s) => String(s) });
    expect(typeof store.startRun).toBe('function');
    expect(typeof store.appendRound).toBe('function');
    expect(typeof store.finishRun).toBe('function');
});
