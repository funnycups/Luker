// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

// Integration coverage for the CEA helper-tool API that surfaces the
// shared `inspect_bound_preset` read tool. Boots the real
// `character-editor-assistant/main.js` (via the same mock-heavy scaffold
// the sibling `lorebook-approval-flow.test.js` uses) and verifies:
//
//   1. `buildCharacterEditorHelperApis` includes a helper API whose
//      `isToolName('inspect_bound_preset')` returns true.
//   2. `runCharacterEditorHelperToolCall` dispatches an
//      `inspect_bound_preset` call through that helper API, unwraps the
//      shared executor's `{ok, result}` envelope, and returns the raw
//      preset payload.
//   3. Errors from the shared executor bubble up as thrown exceptions
//      (matches the contract sibling helper APIs use).

import { describe, expect, jest, test } from '@jest/globals';

// jQuery / DOM / toastr stubs so CEA main.js's module-level jQuery(() => …)
// registration doesn't crash. Same pattern used by
// tests/cea-editor-unified/lorebook-approval-flow.test.js.
globalThis.jQuery = (cb) => {
    if (typeof cb === 'function') { /* swallow init handlers */ }
    return { ready: () => {}, on: () => {}, off: () => {} };
};
globalThis.$ = globalThis.jQuery;
globalThis.window = globalThis.window || globalThis;
globalThis.document = globalThis.document || {
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
};
globalThis.toastr = globalThis.toastr || {
    error: () => {}, warning: () => {}, success: () => {}, info: () => {},
};

// popup.js first, then real edits engine, then heavier mocks — same order
// lorebook-approval-flow.test.js uses to avoid pulling the SillyTavern
// DOM shell.
jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    POPUP_TYPE: { DISPLAY: 'display' },
    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 2, CANCELLED: 0 },
    Popup: class { constructor() {} show() { return Promise.resolve(''); } },
}));

const realEdits = await import('../../public/scripts/lib/edits/index.js');

jest.unstable_mockModule('../../public/script.js', () => ({
    converter: { makeHtml: (s) => s },
    generateQuietPrompt: async () => '',
    getCharacterDescription: () => '',
    getCharacterFirstMessage: () => '',
    getCharacterMesExample: () => '',
    getCharacterName: () => '',
    getCharacterPersonality: () => '',
    getCharacterScenario: () => '',
    saveSettingsDebounced: () => {},
}));
jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    extension_settings: { character_editor_assistant: {} },
    getContext: () => ({}),
    getCharacterState: () => ({}),
    setCharacterState: () => {},
}));
jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    addLocaleData: () => {},
    translate: (s) => s,
}));
jest.unstable_mockModule('../../public/scripts/world-info.js', () => ({
    newWorldInfoEntryTemplate: {},
    setWorldInfoButtonClass: () => {},
    updateWorldInfoList: () => {},
    getCharaAuxWorlds: () => [],
    getChatWorldInfoNames: () => [],
    selected_world_info: [],
}));
jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
    getCharaFilename: () => '',
}));
jest.unstable_mockModule('../../public/scripts/extensions/connection-manager/profile-resolver.js', () => ({
    getChatCompletionConnectionProfiles: () => [],
}));
jest.unstable_mockModule('../../public/scripts/extensions/function-call-runtime.js', () => ({
    TOOL_PROTOCOL_STYLE: { OPENAI: 'openai' },
    validateParsedToolCalls: () => ({ ok: true, errors: [] }),
}));
jest.unstable_mockModule('../../public/scripts/extensions/character-editor-assistant/diff-ui.js', () => ({
    createCharacterEditorDiffUi: () => ({}),
}));
jest.unstable_mockModule('../../public/scripts/extensions/character-editor-assistant/editor-ui.js', () => ({
    createCharacterEditorUi: () => ({}),
}));
jest.unstable_mockModule('../../public/scripts/extensions/character-editor-assistant/editor-iteration/studio.js', () => ({
    openUnifiedCharacterEditorPopup: async () => {},
    DEFAULT_SYSTEM_PROMPT: '',
}));
jest.unstable_mockModule('../../public/scripts/extensions/character-editor-assistant/studio/ai-chat.js', () => ({
    DEFAULT_SYSTEM_PROMPT: '',
}));
jest.unstable_mockModule('../../public/scripts/iteration-library/index.js', () => ({
    applyEdits: realEdits.applyEdits,
}));
jest.unstable_mockModule('../../public/scripts/iteration-library/simulation-review/index.js', () => ({
    openSimulationReview: () => {},
}));
jest.unstable_mockModule('../../public/scripts/iteration-library/simulation-review/i18n/index.js', () => ({
    ensureSimulationReviewLocaleData: () => {},
}));
jest.unstable_mockModule('../../public/scripts/iteration-library/simulation-review/wi-hits.js', () => ({
    extractWorldInfoHitsFromRuntime: () => [],
}));
jest.unstable_mockModule('../../public/scripts/iteration-library/simulation-review/dry-run-capture.js', () => ({
    extractSystemFromCapturedPrompt: () => '',
    extractNonSystemFromCapturedPrompt: () => '',
}));
jest.unstable_mockModule('../../public/scripts/iteration-library/markdown-escape.js', () => ({
    mdLiteral: (s) => String(s ?? ''),
}));

// Layer 1 (`character/presets.js`) is real — we hand a real preset payload
// through `context.character.presets.list/get` since the CEA helper API
// dispatches through the shared executor which asks the ctx surface, not
// Layer 1 directly. Nothing to mock on the presets side.

// Luker global — main.js runs `Luker.getContext()` at module load. Wire up
// the exact surface main.js expects at boot time (`lib`, `extensionSettings`,
// worldInfoEntry, chatWorldInfo, popup constants, i18n, etc.).
const bootLuker = {
    lib: {
        DOMPurify: { sanitize: (s) => s },
        lodash: { get: () => undefined, set: () => {}, cloneDeep: (x) => JSON.parse(JSON.stringify(x)) },
    },
    extensionSettings: { character_editor_assistant: {} },
    getCharacterState: () => ({}),
    updateCharacterState: () => {},
    addLocaleData: () => {},
    translate: (s) => s,
    POPUP_TYPE: { DISPLAY: 'display' },
    Popup: class {},
    worldInfoEntry: {
        template: {},
        setButtonClass: () => {},
    },
    updateWorldInfoList: () => {},
    getCharaAuxWorlds: () => [],
    chatWorldInfo: { getNames: () => [] },
    getCharaFilename: () => '',
    generateQuietPrompt: async () => '',
    saveSettingsDebounced: () => {},
};
globalThis.Luker = { getContext: () => bootLuker };

const CEA = await import('../../public/scripts/extensions/character-editor-assistant/main.js');

// -- fixture: a character with two card-bound presets --

const presetsBody = {
    A: { temperature: 0.4, char_name: 'Inspect' },
    B: { temperature: 0.9 },
};

function makeContext() {
    const character = {
        avatar: 'Inspect.png',
        data: { extensions: { luker: { chat_completion_preset: { presets: [
            { name: 'A', preset: presetsBody.A },
            { name: 'B', preset: presetsBody.B },
        ], defaultPresetName: 'A' } } } },
    };
    return {
        characters: [character],
        characterId: 0,
        character: {
            presets: {
                list: (_c) => [
                    { name: 'A', preset: presetsBody.A, isDefault: true },
                    { name: 'B', preset: presetsBody.B, isDefault: false },
                ],
                get: (_c, name) => (presetsBody[name] ? { name, preset: presetsBody[name] } : null),
            },
        },
    };
}

describe('CEA helper-tool API — inspect_bound_preset', () => {
    test('buildCharacterEditorHelperApis surfaces the preset helper API', () => {
        const ctx = makeContext();
        const apis = CEA.buildCharacterEditorHelperApis(ctx, { avatar: 'Inspect.png' });
        const presetApi = apis.find(a => typeof a?.isToolName === 'function' && a.isToolName('inspect_bound_preset'));
        expect(presetApi).toBeDefined();
        expect(typeof presetApi.invoke).toBe('function');
        expect(typeof presetApi.getToolDefs).toBe('function');
        const defs = presetApi.getToolDefs();
        expect(defs[0]?.function?.name).toBe('inspect_bound_preset');
    });

    test('runCharacterEditorHelperToolCall dispatches inspect_bound_preset action=list', async () => {
        const ctx = makeContext();
        const apis = CEA.buildCharacterEditorHelperApis(ctx, { avatar: 'Inspect.png' });
        const result = await CEA.runCharacterEditorHelperToolCall(
            { id: 'c1', name: 'inspect_bound_preset', args: { action: 'list' } },
            apis,
        );
        expect(result).toEqual([
            { name: 'A', isDefault: true, hasBody: true },
            { name: 'B', isDefault: false, hasBody: true },
        ]);
    });

    test('runCharacterEditorHelperToolCall dispatches inspect_bound_preset action=get', async () => {
        const ctx = makeContext();
        const apis = CEA.buildCharacterEditorHelperApis(ctx, { avatar: 'Inspect.png' });
        const result = await CEA.runCharacterEditorHelperToolCall(
            { name: 'inspect_bound_preset', args: { action: 'get', name: 'B' } },
            apis,
        );
        expect(result).toEqual({ name: 'B', preset: presetsBody.B });
    });

    test('runCharacterEditorHelperToolCall throws when the shared executor reports an error', async () => {
        const ctx = makeContext();
        const apis = CEA.buildCharacterEditorHelperApis(ctx, { avatar: 'Missing.png' });
        // Wrapper propagates shared-executor failures as thrown Errors —
        // asserting bare .toThrow() (not a message regex) keeps the test
        // structural: the wrapper's job is to convert `{ok:false, ...}`
        // envelopes into rejections, independent of the underlying error
        // wording. Semantic reason-code coverage lives in the executor's
        // own unit tests (character-presets/inspect-bound-preset-tool).
        await expect(CEA.runCharacterEditorHelperToolCall(
            { name: 'inspect_bound_preset', args: { action: 'list' } },
            apis,
        )).rejects.toThrow();
    });
});
