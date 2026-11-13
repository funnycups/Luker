// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

// Verifies CEA's Workbench entry-point routing (`openCharacterEditorPopup`),
// live snapshot bootstrapping (`buildUnifiedCharacterEditorLiveSnapshot`),
// helper API wiring (`buildCharacterEditorHelperApis`), and the platform
// `card` IterateTarget bootstrap (`load` / `tools`).

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

describe('CEA Workbench entry-point & card target bootstrap', () => {
    test('openCharacterEditorPopup routes to workbench.open({ page: "ai", ws: "card", scope: "character" })', async () => {
        const openSpy = jest.fn(async () => ({ opened: true }));
        const ctx = {
            characterId: 0,
            characters: [{ avatar: 'alice.png', name: 'Alice' }],
            workbench: { open: openSpy },
        };
        await CEA.openCharacterEditorPopup(ctx);
        expect(openSpy).toHaveBeenCalledWith({ page: 'ai', ws: 'card', scope: 'character' });
    });

    test('openCharacterEditorPopup warns when no character is active and errors when Workbench is absent', async () => {
        const warnSpy = jest.spyOn(globalThis.toastr, 'warning').mockImplementation(() => {});
        const errSpy = jest.spyOn(globalThis.toastr, 'error').mockImplementation(() => {});
        try {
            expect(await CEA.openCharacterEditorPopup({ characterId: 0, characters: [] })).toBeNull();
            expect(warnSpy).toHaveBeenCalled();

            expect(await CEA.openCharacterEditorPopup({
                characterId: 0,
                characters: [{ avatar: 'alice.png', name: 'Alice' }],
                workbench: null,
            })).toBeNull();
            expect(errSpy).toHaveBeenCalled();
        } finally {
            warnSpy.mockRestore();
            errSpy.mockRestore();
        }
    });

    test('buildUnifiedCharacterEditorLiveSnapshot and createCardTarget.load bootstrap character + bound books', async () => {
        const ctx = {
            characterId: 0,
            characters: [{
                avatar: 'alice.png',
                name: 'Alice',
                description: 'snapshot description',
                data: { name: 'Alice', description: 'snapshot description', extensions: { world: 'BookA' } },
            }],
            loadWorldInfo: async (name) => (name === 'BookA' ? { entries: { 0: { uid: 0, content: 'a' } } } : null),
            getCharaAuxWorlds: () => [],
            chatWorldInfo: { getNames: () => [] },
        };
        const snap = await CEA.buildUnifiedCharacterEditorLiveSnapshot(ctx, 'alice.png');
        expect(snap.character.description).toBe('snapshot description');
        expect(snap.lorebooks.BookA.entries[0].content).toBe('a');

        const card = createCardTarget({ getContext: () => ctx });
        const loaded = await card.load('character', ctx);
        expect(loaded.live.character.description).toBe('snapshot description');
        expect(loaded.live.lorebooks.BookA.entries[0].content).toBe('a');
        expect(CEA.buildCharacterEditorHelperApis(ctx, { avatar: 'alice.png' }).length).toBeGreaterThan(0);
    });
});
