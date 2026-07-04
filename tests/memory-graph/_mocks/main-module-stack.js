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

// ---- Browser / jQuery shims ----
// Return a chainable stub so top-level code like
// `jQuery(document).off('click.foo').on('click.foo', ...)` in
// public/scripts/extensions/luker-tabs.js (transitively imported via
// memory-graph/ui-templates.js) doesn't blow up at module-load time.
// Any prop access returns a callable that returns the same chain.
globalThis.jQuery = (cb) => {
    if (typeof cb === 'function') { /* swallow DOM-ready callback */ }
    const chain = new Proxy(function () {}, {
        get(_t, prop) {
            if (prop === 'then') return undefined;
            if (prop === 'length') return 0;
            return () => chain;
        },
        apply() { return chain; },
    });
    return chain;
};
globalThis.jQuery.escapeSelector = (s) => String(s);
globalThis.$ = globalThis.jQuery;
globalThis.window = globalThis.window || globalThis;
globalThis.document = globalThis.document || {
    addEventListener: () => {}, removeEventListener: () => {},
    querySelector: () => null, querySelectorAll: () => [],
};

// ---- Module mocks ----
const extensionSettingsMock = { memory_graph: {} };

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
jest.unstable_mockModule('../../public/scripts/extensions/preset-help.js', () => ({
    renderPresetHelpButton: () => '',
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
jest.unstable_mockModule('../../public/scripts/extensions/memory-graph/schema-iteration/studio.js', () => ({
    openSchemaIterationStudio: () => Promise.resolve(),
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
jest.unstable_mockModule('../../public/scripts/extensions/regex/engine.js', () => ({
    registerManagedRegexProvider: () => ({ dispose: () => {} }),
    regex_placement: {}, substitute_find_regex: () => '',
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
jest.unstable_mockModule(
    '../../public/scripts/extensions/function-call-runtime.js',
    () => ({ TOOL_PROTOCOL_STYLE: {}, validateParsedToolCalls: () => true }),
);
jest.unstable_mockModule('../../public/scripts/embedding-service.js', () => ({
    EmbeddingService: class {},
}));

export { extensionSettingsMock };
