// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest, beforeAll, afterAll } from '@jest/globals';
import { installBrowserModuleContext, installDomReadyJQuery } from '../util/browser-module-context.js';

// main.js captures `const __ctx = Luker.getContext()` and registers a DOM-ready
// callback via `jQuery(() => ...)` at import time.
const jqueryEnv = installDomReadyJQuery();
const browserEnv = installBrowserModuleContext({
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
});

// main.js transitively pulls browser-only modules (`profile-resolver.js` ->
// `script.js` / `openai.js` -> `textgen-models.js`) that touch `document` at
// load time. Stub that edge so the module graph loads under the node test
// environment.
jest.unstable_mockModule('../../public/scripts/extensions/connection-manager/profile-resolver.js', () => ({
    getChatCompletionConnectionProfiles: async () => [],
}));

let mod;
beforeAll(async () => {
    mod = await import('../../public/scripts/extensions/search-tools/main.js');
});

afterAll(() => {
    browserEnv.restore();
    jqueryEnv.restore();
});

describe('managed-entry tool surface', () => {
    test('returns every requested id beyond the old read boundary', () => {
        const ids = Array.from({ length: 12 }, (_, index) => `watch_${index}`);
        const data = { entries: Object.fromEntries(ids.map((id, uid) => [uid, { uid, comment: `SEARCH_TOOLS::${id}::${id}`, content: id }])) };
        const result = mod.getManagedEntriesByIds(data, [...ids, 'missing']);
        expect(result.entries.map(entry => entry.entry_id)).toEqual(ids);
        expect(result.missing_entry_ids).toEqual(['missing']);
    });
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
