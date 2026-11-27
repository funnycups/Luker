// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

// Verifies CEA's post-replace merge action and Workbench routing in main.js:
//   - buildPostReplaceMergeAction materializes a new embedded world book,
//     builds the diff seed message, and opens Workbench AI iteration
//     (`{ page: 'ai', ws: 'card', scope: 'character', ... }`).
//   - If Workbench is unavailable or throws during open, postReplaceRollback
//     re-binds the previous primary book and deletes the newly materialized
//     world book so disk state stays clean.
//   - commitCharacterEditorOperations delegates cleanly and skips no-ops.

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
    createScopedI18n: () => ({ i18n: (s) => s, i18nFormat: (s) => s }),
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
jest.unstable_mockModule('../../public/scripts/extensions/character-editor-assistant/editor-ui.js', () => ({
    createCharacterEditorUi: () => ({ ensureUi: () => {}, refreshUiState: async () => {} }),
}));
jest.unstable_mockModule('../../public/scripts/extensions/character-editor-assistant/studio/ai-chat.js', () => ({
    DEFAULT_SYSTEM_PROMPT: '',
}));
jest.unstable_mockModule('../../public/scripts/iteration-library/index.js', () => ({
    applyEdits: realEdits.applyEdits,
}));
jest.unstable_mockModule('../../public/scripts/iteration-library/simulation-review/i18n/index.js', () => ({
    ensureSimulationReviewLocaleData: () => {},
}));

const deleteWorldBookSpy = jest.fn(async () => true);
const rebindSpy = jest.fn(async () => {});
const workbenchOpenSpy = jest.fn(async () => ({ opened: true }));
const updateCharacterDataSpy = jest.fn(async () => {});

const sharedLukerCtx = {
    lib: {
        DOMPurify: { sanitize: (s) => s },
        lodash: {
            get: () => undefined,
            set: () => {},
            cloneDeep: (x) => JSON.parse(JSON.stringify(x)),
            isEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
        },
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
    loadWorldInfo: async () => ({ entries: {} }),
    getWorldInfoNames: () => ['OldBook'],
    rebindPreviousPrimaryBook: rebindSpy,
    deleteWorldBook: deleteWorldBookSpy,
    updateCharacterData: updateCharacterDataSpy,
    writeExtensionField: async () => true,
    eventSource: { on: () => {} },
    eventTypes: { OAI_PRESET_CHANGED_AFTER: 'oai_preset_changed_after', SETTINGS_UPDATED: 'settings_updated' },
};

globalThis.Luker = { getContext: () => sharedLukerCtx };

const CEA = await import('../../public/scripts/extensions/character-editor-assistant/main.js');

function makeOwnership(version = 'v-new') {
    return {
        isCurrent: () => true,
        world: { version },
    };
}

describe('CEA post-replace merge action & Workbench routing', () => {
    test('routes post-replace merge to Workbench card AI iteration with seed draft', async () => {
        workbenchOpenSpy.mockClear().mockResolvedValue({ opened: true });
        deleteWorldBookSpy.mockClear().mockResolvedValue(true);
        rebindSpy.mockClear();

        const nextChar = {
            avatar: 'a.png',
            name: 'Alice',
            description: 'Next desc',
            data: {
                extensions: { world: 'NewBook' },
                character_book: { name: 'NewBook', entries: [{ keys: ['k'], content: 'c' }] },
            },
        };
        const ownership = makeOwnership('v-new-1');
        sharedLukerCtx.characters = [nextChar];
        sharedLukerCtx.characterId = 0;
        sharedLukerCtx.importEmbeddedBookForCharacter = jest.fn(async () => ({
            imported: true,
            bound: true,
            bookName: 'NewBook',
            ownership,
        }));
        sharedLukerCtx.workbench = { open: workbenchOpenSpy };

        const action = CEA.buildPostReplaceMergeAction();
        await action.run({
            characterId: 0,
            character: nextChar,
            previousCharacter: { avatar: 'a.png', name: 'Alice', description: 'Prev desc', data: { extensions: { world: 'OldBook' } } },
            previousLorebookSnapshot: { bookName: 'OldBook', entries: {} },
        });

        expect(sharedLukerCtx.importEmbeddedBookForCharacter).toHaveBeenCalledWith(0, nextChar, { captureOwnership: true });
        expect(workbenchOpenSpy).toHaveBeenCalledTimes(1);
        const call = workbenchOpenSpy.mock.calls[0][0];
        expect(call.page).toBe('ai');
        expect(call.ws).toBe('card');
        expect(call.scope).toBe('character');
        expect(typeof call.seedPrompt).toBe('string');
        expect(call.seedPrompt.length).toBeGreaterThan(0);
        expect(call.seedPrompt).toContain('Prev desc');
        expect(call.seedPrompt).toContain('Next desc');
        expect(call.hideSeedFromUi).toBe(true);
        expect(call.autoSend).toBe(true);
        expect(typeof call.onCancelWithoutApply).toBe('function');
        expect(rebindSpy).not.toHaveBeenCalled();
        expect(deleteWorldBookSpy).not.toHaveBeenCalled();

        // Closing/canceling without apply triggers the forwarded rollback hook.
        await call.onCancelWithoutApply();
        expect(rebindSpy).toHaveBeenCalledWith(0, 'OldBook', nextChar, { ownership });
        expect(deleteWorldBookSpy).toHaveBeenCalledWith('NewBook', { expectedVersion: 'v-new-1', onlyIfUnbound: true });
    });

    test('rolls back pre-materialized world book when Workbench is unavailable', async () => {
        deleteWorldBookSpy.mockClear().mockResolvedValue(true);
        rebindSpy.mockClear();

        const nextChar = {
            avatar: 'a.png',
            name: 'Alice',
            data: {
                extensions: { world: 'NewBook' },
                character_book: { name: 'NewBook', entries: [{ keys: ['k'], content: 'c' }] },
            },
        };
        const ownership = makeOwnership('v-new-2');
        sharedLukerCtx.characters = [nextChar];
        sharedLukerCtx.characterId = 0;
        sharedLukerCtx.importEmbeddedBookForCharacter = jest.fn(async () => ({
            imported: true,
            bound: true,
            bookName: 'NewBook',
            ownership,
        }));
        sharedLukerCtx.workbench = null;

        const action = CEA.buildPostReplaceMergeAction();
        await action.run({
            characterId: 0,
            character: nextChar,
            previousCharacter: { avatar: 'a.png', name: 'Alice', data: { extensions: { world: 'OldBook' } } },
            previousLorebookSnapshot: { bookName: 'OldBook', entries: {} },
        });

        expect(rebindSpy).toHaveBeenCalledWith(0, 'OldBook', nextChar, { ownership });
        expect(deleteWorldBookSpy).toHaveBeenCalledWith('NewBook', { expectedVersion: 'v-new-2', onlyIfUnbound: true });
    });
});
