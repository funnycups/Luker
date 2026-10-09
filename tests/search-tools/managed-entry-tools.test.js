// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest } from '@jest/globals';

// main.js captures `const __ctx = Luker.getContext()` at import time and the
// module reads extension_settings off it, so install a stub before importing.
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

// main.js transitively pulls browser-only modules (`profile-resolver.js` ->
// `script.js` / `openai.js` -> `textgen-models.js`, and `settings-ui.js` ->
// `preset-help.js`) that touch `document` at load time. Stub those two edges
// so the module graph loads under the node test environment.
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

describe('managed-entry tool surface', () => {
    test('buildAgentTools exposes the read tool', () => {
        const names = mod.buildAgentTools().map((t) => t.function.name);
        expect(names).toContain('luker_search_agent_get_lorebook_entries');
    });

    test('buildManagedEntryCatalog emits a compact index without content preview', () => {
        const catalog = mod.buildManagedEntryCatalog([
            { entryId: 'a', title: 'A', keywords: ['k'], alwaysInject: true, content: 'X'.repeat(500), disable: false },
        ]);
        const parsed = JSON.parse(catalog);
        expect(parsed).toEqual([
            { entry_id: 'a', title: 'A', keywords: ['k'], always_inject: true },
        ]);
        expect(catalog).not.toContain('preview');
    });

    test('getManagedEntriesByIds returns full content for known ids and reports missing', () => {
        const data = {
            entries: {
                0: { uid: 0, comment: 'SEARCH_TOOLS::a::A', key: ['k'], content: 'hello world', constant: true },
            },
        };
        const out = mod.getManagedEntriesByIds(data, ['a', 'nope']);
        expect(out.entries).toHaveLength(1);
        expect(out.entries[0]).toMatchObject({ entry_id: 'a', content: 'hello world', always_inject: true });
        expect(out.missing_entry_ids).toEqual(['nope']);
    });
});
