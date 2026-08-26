// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

// Coverage for the CEA simulate tool's chat-floor source-message build:
// `buildCharacterEditorSimulationSourceMessages` must derive its
// text-mode carry messages from `readPluginFloors` + `floorRecordToTaskMessage`,
// meaning every carried message carries plugin-lane-cooked content
// (mesCooked) and the numeric `sourceFloorIndex` provenance marker.
//
// The module under test is NOT mocked — only the ctx boundary
// (globalThis.Luker.getContext → { regex, chat }) is stubbed. Same
// mock-heavy boot scaffold as inspect-bound-preset-helper-api.test.js,
// since main.js captures a wide ctx surface at module load.

import { describe, expect, jest, test } from '@jest/globals';

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

jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    POPUP_TYPE: { DISPLAY: 'display' },
    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 2, CANCELLED: 0 },
    Popup: class { constructor() {} show() { return Promise.resolve(''); } },
}));

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
    applyEdits: () => [],
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

// Probe regex rule: the plugin-lane engine stand-in. Cooked output is
// distinguishable from raw text so the assertions below prove mesCooked
// flowed through floorRecordToTaskMessage into message.content.
const probeApplyRegex = (raw, placement, params) =>
    `[cooked|p:${placement}|d:${params?.depth ?? 'none'}]${raw}`;

// Full boot surface — main.js captures `Luker.getContext()` at module load
// (lib / extensionSettings / state hooks …), while the floor reader reads
// `regex` and the builder walks `chat` off the same object we then pass as
// the explicit `context` argument.
const lukerCtx = {
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
    regex: {
        placement: { USER_INPUT: 1, AI_OUTPUT: 2 },
        applyRegex: probeApplyRegex,
    },
    chat: [
        { mes: 'user turn one', is_user: true },   // idx 0
        { mes: 'assistant reply', is_user: false }, // idx 1
        { mes: 'system note', is_system: true },    // idx 2 — excluded by default roles
        { mes: 'final user turn', is_user: true },  // idx 3
    ],
};
globalThis.Luker = { getContext: () => lukerCtx };

const pluginFloors = await import('../../public/scripts/lib/plugin-floors.js');
pluginFloors.__resetPluginFloorsCacheForTests();

const CEA = await import('../../public/scripts/extensions/character-editor-assistant/main.js');

describe('buildCharacterEditorSimulationSourceMessages — floor migration', () => {
    test('text mode carries cooked floors with numeric sourceFloorIndex before the appended turn', async () => {
        const out = CEA.buildCharacterEditorSimulationSourceMessages(lukerCtx, { text: 'next user turn' });

        expect(out.mode).toBe('text');
        // system floor excluded by default roles; +1 for the appended user turn
        expect(out.messages).toHaveLength(4);

        const carried = out.messages.slice(0, 3);
        for (const [i, message] of carried.entries()) {
            expect(Number.isFinite(message.sourceFloorIndex)).toBe(true);
            expect(message.sourceFloorIndex).toBe([0, 1, 3][i]);
        }

        expect(carried[0]).toMatchObject({ role: 'user', content: '[cooked|p:1|d:2]user turn one' });
        expect(carried[1]).toMatchObject({ role: 'assistant', content: '[cooked|p:2|d:1]assistant reply' });
        expect(carried[2]).toMatchObject({ role: 'user', content: '[cooked|p:1|d:0]final user turn' });

        const appended = out.messages[3];
        expect(appended).toEqual({ role: 'user', content: 'next user turn' });
        expect(appended.sourceFloorIndex).toBeUndefined();
    });

    test('explicit messages mode passes through untouched and skips the floor walk', () => {
        const explicit = [{ role: 'user', content: 'structured input' }];
        const out = CEA.buildCharacterEditorSimulationSourceMessages(lukerCtx, { messages: explicit });

        expect(out.mode).toBe('messages');
        expect(out.messages).toEqual(explicit);
        expect(out.messages[0].sourceFloorIndex).toBeUndefined();
    });

    test('empty input yields empty mode with no messages', () => {
        const out = CEA.buildCharacterEditorSimulationSourceMessages(lukerCtx, {});
        expect(out).toEqual({ mode: '', messages: [] });
    });
});
