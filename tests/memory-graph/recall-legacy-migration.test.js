/**
 * Migration test for the recall-method collapse from 4 hybrid modes to 2
 * (LLM/RAG). Verifies `normalizeLegacyRecallSettings` in main.js maps every
 * legacy `recallMethod` value to its new shape and strips dropped fields.
 *
 * Uses the same heavy-mock harness as session-commit-anchor.test.js because
 * main.js executes browser-binding code at module load. The helper itself is
 * pure — we just need to be able to import it.
 */

import { describe, test, expect, jest, beforeAll } from '@jest/globals';

// ---- Browser shims ----
globalThis.jQuery = (cb) => {
    if (typeof cb === 'function') { /* swallow */ }
    return { ready: () => {}, on: () => {}, off: () => {} };
};
globalThis.$ = globalThis.jQuery;
globalThis.window = globalThis.window || globalThis;
globalThis.document = globalThis.document || {
    addEventListener: () => {}, removeEventListener: () => {},
    querySelector: () => null, querySelectorAll: () => [],
};

// ---- Module mocks (mirrors session-commit-anchor.test.js) ----
const extensionSettingsMock = { memory_graph: {} };

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

// ---- SUT import ----
let normalizeLegacyRecallSettings;

beforeAll(async () => {
    const mod = await import('../../public/scripts/extensions/memory-graph/main.js');
    normalizeLegacyRecallSettings = mod.normalizeLegacyRecallSettings;
});

describe('normalizeLegacyRecallSettings', () => {
    test('hybrid → rag (no toggles)', () => {
        const s = { recallMethod: 'hybrid' };
        normalizeLegacyRecallSettings(s);
        expect(s.recallMethod).toBe('rag');
        expect(s.ragUseRerank).toBe(false);
        expect(s.ragUseQueryRewrite).toBe(false);
    });

    test('hybrid_rerank → rag + ragUseRerank=true', () => {
        const s = { recallMethod: 'hybrid_rerank' };
        normalizeLegacyRecallSettings(s);
        expect(s.recallMethod).toBe('rag');
        expect(s.ragUseRerank).toBe(true);
        expect(s.ragUseQueryRewrite).toBe(false);
    });

    test('hybrid_llm → rag (no toggles; second-stage LLM finalize was not query rewrite)', () => {
        const s = { recallMethod: 'hybrid_llm' };
        normalizeLegacyRecallSettings(s);
        expect(s.recallMethod).toBe('rag');
        expect(s.ragUseRerank).toBe(false);
        expect(s.ragUseQueryRewrite).toBe(false);
    });

    test('llm passes through unchanged', () => {
        const s = { recallMethod: 'llm' };
        normalizeLegacyRecallSettings(s);
        expect(s.recallMethod).toBe('llm');
    });

    test('rag passes through unchanged', () => {
        const s = { recallMethod: 'rag', ragUseRerank: true };
        normalizeLegacyRecallSettings(s);
        expect(s.recallMethod).toBe('rag');
        expect(s.ragUseRerank).toBe(true);
    });

    test('unknown / blank → llm fallback', () => {
        for (const value of ['', 'something_else', undefined, null]) {
            const s = { recallMethod: value };
            normalizeLegacyRecallSettings(s);
            expect(s.recallMethod).toBe('llm');
        }
    });

    test('strips legacy diffusion fields and the unused enableRerank stub', () => {
        const s = {
            recallMethod: 'hybrid',
            diffusionSteps: 2,
            diffusionDecay: 0.6,
            diffusionTopK: 100,
            diffusionTeleportAlpha: 0.05,
            enableRerank: true,
        };
        normalizeLegacyRecallSettings(s);
        expect(s).not.toHaveProperty('diffusionSteps');
        expect(s).not.toHaveProperty('diffusionDecay');
        expect(s).not.toHaveProperty('diffusionTopK');
        expect(s).not.toHaveProperty('diffusionTeleportAlpha');
        expect(s).not.toHaveProperty('enableRerank');
    });

    test('strips legacy mainInjectionAssistantTurnsWindow (collapsed into recentRawTurns)', () => {
        const s = {
            recallMethod: 'llm',
            mainInjectionAssistantTurnsWindow: 7,
        };
        normalizeLegacyRecallSettings(s);
        expect(s).not.toHaveProperty('mainInjectionAssistantTurnsWindow');
    });

    test('coerces rag field types', () => {
        const s = {
            recallMethod: 'rag',
            ragUseRerank: 1,
            ragUseQueryRewrite: 0,
            ragRewriteApiPresetName: 42,
            ragRewriteLlmPresetName: undefined,
        };
        normalizeLegacyRecallSettings(s);
        expect(s.ragUseRerank).toBe(true);
        expect(s.ragUseQueryRewrite).toBe(false);
        expect(typeof s.ragRewriteApiPresetName).toBe('string');
        expect(typeof s.ragRewriteLlmPresetName).toBe('string');
    });

    test('preserves a hybrid_rerank user who already had ragUseQueryRewrite=true', () => {
        const s = { recallMethod: 'hybrid_rerank', ragUseQueryRewrite: true };
        normalizeLegacyRecallSettings(s);
        expect(s.recallMethod).toBe('rag');
        expect(s.ragUseRerank).toBe(true);
        expect(s.ragUseQueryRewrite).toBe(true);
    });

    test('returns the same object reference (mutation, not clone)', () => {
        const s = { recallMethod: 'hybrid' };
        const out = normalizeLegacyRecallSettings(s);
        expect(out).toBe(s);
    });

    test('null / non-object input returns the input as-is', () => {
        expect(normalizeLegacyRecallSettings(null)).toBe(null);
        expect(normalizeLegacyRecallSettings(undefined)).toBe(undefined);
        expect(normalizeLegacyRecallSettings(42)).toBe(42);
    });
});
