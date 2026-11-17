// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

// Verifies that loading the card target (`buildUnifiedCharacterEditorLiveSnapshot`
// and `createCardTarget().load`) always refreshes live state from disk / context
// rather than returning stale cached values when external edits occur.

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

const sharedLukerCtx = {
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
    worldInfoEntry: { template: {}, setButtonClass: () => {} },
    updateWorldInfoList: () => {},
    getCharaAuxWorlds: () => [],
    chatWorldInfo: { getNames: () => [] },
    getCharaFilename: () => '',
    generateQuietPrompt: async () => '',
    saveSettingsDebounced: () => {},
};
globalThis.Luker = { getContext: () => sharedLukerCtx };

const CEA = await import('../../public/scripts/extensions/character-editor-assistant/main.js');
const { createCardTarget } = await import('../../public/scripts/workbench/targets/card.js');

describe('CEA live snapshot refresh on load', () => {
    test('buildUnifiedCharacterEditorLiveSnapshot and cardTarget.load pick up external edits', async () => {
        let bookContent = 'initial lore';
        const ctx = {
            characterId: 0,
            characters: [{
                avatar: 'alice.png',
                name: 'Alice',
                description: 'initial desc',
                data: { name: 'Alice', description: 'initial desc', extensions: { world: 'Lore' } },
            }],
            loadWorldInfo: async (name) => (name === 'Lore' ? { entries: { 1: { uid: 1, content: bookContent } } } : null),
            getCharaAuxWorlds: () => [],
            chatWorldInfo: { getNames: () => [] },
        };

        const card = createCardTarget({ getContext: () => ctx });
        const first = await card.load('character', ctx);
        expect(first.live.character.description).toBe('initial desc');
        expect(first.live.lorebooks.Lore.entries[1].content).toBe('initial lore');

        ctx.characters[0].description = 'fresh-from-disk';
        ctx.characters[0].data.description = 'fresh-from-disk';
        bookContent = 'updated lore on disk';

        const snap = await CEA.buildUnifiedCharacterEditorLiveSnapshot(ctx, 'alice.png');
        expect(snap.character.description).toBe('fresh-from-disk');
        expect(snap.lorebooks.Lore.entries[1].content).toBe('updated lore on disk');

        const second = await card.load('character', ctx);
        expect(second.live.character.description).toBe('fresh-from-disk');
        expect(second.live.lorebooks.Lore.entries[1].content).toBe('updated lore on disk');
    });
});
