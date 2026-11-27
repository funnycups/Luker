/**
 * Shared mock stack for tests that import
 * `public/scripts/extensions/memory-graph/main.js` under jest.
 *
 * main.js transitively pulls script.js / lib.js / popup.js etc. at module
 * load. Each consumer test would otherwise duplicate ~75 lines of identical
 * `jest.unstable_mockModule` setup; this module centralises it.
 *
 * Usage (note the side-effect import — `jest.unstable_mockModule` MUST run
 * before any import of the mocked targets in the same file):
 *
 *     import { jest } from '@jest/globals';
 *     import './_mocks/main-module-stack.js';
 *     // ...then dynamic imports of the SUT modules inside beforeAll:
 *     //   const main = await import('.../memory-graph/main.js');
 *
 * The module evaluates its mocks at import time, so static `import` of this
 * file is sufficient — no helper call required.
 */

import { jest } from '@jest/globals';
import { installBrowserModuleContext, installDomReadyJQuery } from '../../util/browser-module-context.js';

// ---- Browser / jQuery shims ----
// Explicit non-Proxy jQuery adapter for module-load DOM-ready registration and
// luker-tabs's delegated `jQuery(document).off(...).on(...)` listener.
installDomReadyJQuery();
globalThis.window = globalThis.window || globalThis;
globalThis.document = globalThis.document || {
    addEventListener: () => {}, removeEventListener: () => {},
    querySelector: () => null, querySelectorAll: () => [],
};

// ---- Module mocks ----
const extensionSettingsMock = { memory_graph: {} };

const mockLukerContext = {
    extensionSettings: extensionSettingsMock,
    constants: {
        promptRoles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
        promptTypes: { NONE: 0, IN_PROMPT: 1, IN_CHAT: 2 },
        wiPosition: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 },
        unset: Symbol('UNSET_VALUE'),
    },
    resolveChatStateTarget: () => ({ is_group: false, avatar_url: 'avatar.png', file_name: 'chat' }),
    saveSettings: () => Promise.resolve({ ok: true, status: 'saved' }),
    saveSettingsDebounced: () => {},
    download: () => {},
    getFileText: () => Promise.resolve(''),
    getStringHash: () => '',
    escapeHtml: (s) => String(s || ''),
    worldInfoEntry: {
        template: () => ({}),
        setGlobalSelection: async () => false,
    },
    addLocaleData: () => {},
    translate: (k) => String(k ?? ''),
    getCurrentLocale: () => 'en-US',
    registerExtensionApi: () => {},
    getExtensionApi: () => null,
    eventSource: { on: () => {}, off: () => {}, emit: () => {} },
    eventTypes: {},
    lib: {
        showdown: { Converter: class { makeHtml(t) { return String(t || ''); } } },
        DOMPurify: { sanitize: (h) => h },
    },
};
installBrowserModuleContext(mockLukerContext);
globalThis.lukerContext = mockLukerContext;

// NOTE on relative paths: `jest.unstable_mockModule` resolves the specifier
// relative to the consuming test file (the import-graph root), NOT this
// helper's directory. Confirmed empirically: with the helper at
// tests/memory-graph/_mocks/ and tests at tests/memory-graph/, the mocks
// still use `../../public/...` — the same path each test file would use
// inline. Don't add extra `../` segments to "account for" the helper's
// deeper location.
jest.unstable_mockModule('../../public/lib.js', async () => {
    const { default: lodash } = await import('lodash');
    return {
        lodash,
        showdown: { Converter: class { makeHtml(t) { return String(t || ''); } } },
        DOMPurify: { sanitize: (h) => h },
    };
});
jest.unstable_mockModule('../../public/scripts/request-compression.js', () => ({
    compressRequest: async (r) => r,
}));
jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    Popup: class { constructor() {} show() { return Promise.resolve(); } },
    POPUP_TYPE: { DISPLAY: 0, INPUT: 1, CONFIRM: 2 },
    POPUP_RESULT: { CANCELLED: 0, AFFIRMATIVE: 1 },
}));
jest.unstable_mockModule('../../public/scripts/st-context.js', () => ({
    getContext: () => ({}),
}));
jest.unstable_mockModule('../../public/script.js', () => ({
    event_types: {},
    eventSource: { on: () => {}, off: () => {}, emit: () => {} },
    extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
    extension_prompt_types: { NONE: 0, IN_PROMPT: 1, IN_CHAT: 2 },
    resolveChatStateTarget: () => ({
        is_group: false, avatar_url: 'avatar.png', file_name: 'chat',
    }),
    saveSettings: () => Promise.resolve(),
    saveSettingsDebounced: () => {},
}));
jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    extension_settings: extensionSettingsMock,
    getContext: () => ({}),
    registerExtensionApi: () => {},
    UNSET_VALUE: Symbol('UNSET_VALUE'),
}));
jest.unstable_mockModule('../../public/scripts/power-user.js', () => ({
    performFuzzySearch: () => [],
}));
jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
    download: () => {}, getFileText: () => Promise.resolve(''),
    getStringHash: () => '', escapeHtml: (s) => String(s || ''),
}));
jest.unstable_mockModule('../../public/scripts/world-info.js', () => ({
    newWorldInfoEntryTemplate: () => ({}),
    setGlobalWorldInfoSelection: () => {},
    world_info_position: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 },
}));
jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    addLocaleData: () => {}, translate: (k) => k,
    getCurrentLocale: () => 'en-US', t: (k) => k,
}));
jest.unstable_mockModule(
    '../../public/scripts/extensions/connection-manager/profile-resolver.js',
    () => ({ getChatCompletionConnectionProfiles: () => [] }),
);
jest.unstable_mockModule(
    '../../public/scripts/extensions/connection-manager/embed-rerank.js',
    () => ({
        renderProfileSelect: () => '',
        upsertEmbeddingProfile: () => {}, upsertRerankProfile: () => {},
        getEmbeddingProfileById: () => null, getRerankProfileById: () => null,
    }),
);
jest.unstable_mockModule('../../public/scripts/embedding-service.js', () => ({
    EmbeddingService: class {},
}));

export { extensionSettingsMock };
