// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeAll, beforeEach, jest } from '@jest/globals';

const noop = () => {};
const asyncNoop = async () => {};
class StubClass {}

const realStructuredCloneMap = await import('../../public/scripts/util/StructuredCloneMap.js');

jest.unstable_mockModule('../../public/script.js', () => ({
    saveSettingsDebounced: noop,
    substituteParams: (s) => s,
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    chat_metadata: {},
    this_chid: 0,
    characters: [],
    saveCharacterDebounced: noop,
    menu_type: '',
    eventSource: { on: noop, emit: asyncNoop },
    event_types: { WORLDINFO_UPDATED: 'worldinfo_updated' },
    getExtensionPromptByName: () => '',
    saveMetadata: asyncNoop,
    getCurrentChatId: () => '',
    extension_prompt_roles: {},
    create_save: {},
    name1: '',
    buildObjectPatchOperationsAsync: async () => [{ op: 'replace', path: '/entries', value: {} }],
    requestAsyncDiffForNextSettingsSave: noop,
    getOneCharacter: asyncNoop,
    select_selected_character: asyncNoop,
}));
jest.unstable_mockModule('../../public/scripts/named-resource-read.js', () => ({
    readWorldInfoDocument: async () => null,
}));
jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
    areLookupNamesEqual: (a, b) => a === b,
    download: noop,
    debounce: (fn) => {
        const wrapped = (...args) => fn(...args);
        wrapped.cancel = noop;
        return wrapped;
    },
    findCanonicalIndexInList: () => -1,
    findCanonicalNameInList: () => null,
    initScrollHeight: noop,
    resetScrollHeight: noop,
    parseJsonFile: async () => ({}),
    extractDataFromPng: async () => null,
    getFileBuffer: async () => new ArrayBuffer(0),
    getCharaFilename: () => '',
    escapeRegex: (s) => s,
    PAGINATION_TEMPLATE: '',
    navigation_option: {},
    waitUntilCondition: asyncNoop,
    isTrueBoolean: () => false,
    setValueByPath: noop,
    flashHighlight: noop,
    select2ModifyOptions: noop,
    getSelect2OptionId: () => '',
    dynamicSelect2DataViaAjax: noop,
    highlightRegex: (s) => s,
    select2ChoiceClickSubscribe: noop,
    isFalseBoolean: () => false,
    getSanitizedFilename: (s) => s,
    checkOverwriteExistingData: async () => true,
    getStringHash: () => 0,
    parseStringArray: () => [],
    cancelDebounce: noop,
    findChar: () => null,
    onlyUnique: () => true,
    equalsIgnoreCaseAndAccents: (a, b) => a === b,
    uuidv4: () => 'uuid-1',
    normalizeArray: (a) => a,
    getUniqueName: (s) => s,
    logSlashCommandWarn: noop,
    addLongPressEvent: noop,
    escapeHtml: (s) => String(s ?? ''),
    setInfoBlock: noop,
    clearInfoBlock: noop,
}));
jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    extension_settings: {},
    getContext: () => ({ characters: [] }),
    writeExtensionField: async () => true,
}));
jest.unstable_mockModule('../../public/scripts/authors-note.js', () => ({
    NOTE_MODULE_NAME: '',
    metadata_keys: {},
    shouldWIAddPrompt: () => false,
}));
jest.unstable_mockModule('../../public/scripts/RossAscends-mods.js', () => ({ isMobile: () => false }));
jest.unstable_mockModule('../../public/scripts/filters.js', () => ({
    FILTER_TYPES: {},
    FilterHelper: StubClass,
    WORLD_INFO_SEARCH_MODES: {},
    keywordSearchWorldInfo: () => [],
}));
jest.unstable_mockModule('../../public/scripts/tokenizers.js', () => ({ getTokenCountAsync: async () => 0 }));
jest.unstable_mockModule('../../public/scripts/power-user.js', () => ({ power_user: {} }));
jest.unstable_mockModule('../../public/scripts/tags.js', () => ({ getTagKeyForEntity: () => '' }));
jest.unstable_mockModule('../../public/scripts/constants.js', () => ({
    debounce_timeout: { relaxed: 10 },
    GENERATION_TYPE_TRIGGERS: [],
}));
jest.unstable_mockModule('../../public/scripts/extensions/regex/engine.js', () => ({
    getRegexedString: (s) => s,
    regex_placement: {},
}));
jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandParser.js', () => ({
    SlashCommandParser: { addCommandObject: noop },
}));
jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommand.js', () => ({
    SlashCommand: { fromProps: () => ({}) },
}));
jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandArgument.js', () => ({
    ARGUMENT_TYPE: {},
    SlashCommandArgument: { fromProps: () => ({}) },
    SlashCommandNamedArgument: { fromProps: () => ({}) },
}));
jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandEnumValue.js', () => ({
    SlashCommandEnumValue: StubClass,
    enumTypes: {},
}));
jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandCommonEnumsProvider.js', () => ({
    commonEnumProviders: {},
    enumIcons: {},
}));
jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandClosure.js', () => ({
    SlashCommandClosure: StubClass,
}));
jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    callGenericPopup: asyncNoop,
    Popup: StubClass,
    POPUP_RESULT: {},
    POPUP_TYPE: {},
}));
jest.unstable_mockModule('../../public/scripts/util/StructuredCloneMap.js', () => realStructuredCloneMap);
jest.unstable_mockModule('../../public/scripts/templates.js', () => ({ renderTemplateAsync: async () => '' }));
jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (s, ...v) => (Array.isArray(s) ? String.raw(s, ...v) : String(s)),
    translate: (s) => String(s ?? ''),
}));
jest.unstable_mockModule('../../public/scripts/world-info-bulk-edit.js', () => ({
    BULK_PATCH_KEEP_SENTINEL: Symbol('keep'),
    inferCommonValue: noop,
    buildBulkFieldPatchSnapshot: noop,
    applyPatchToEntries: noop,
    restoreEntriesFromSnapshot: noop,
}));
jest.unstable_mockModule('../../public/scripts/util/AccountStorage.js', () => ({
    accountStorage: { getItem: () => null, setItem: noop, removeItem: noop },
}));
jest.unstable_mockModule('../../public/scripts/personas.js', () => ({
    getOrCreatePersonaDescriptor: () => ({}),
    setPersonaDescription: noop,
    user_avatar: '',
}));
jest.unstable_mockModule('../../public/scripts/select2-actionable-single.js', () => ({
    initActionableSingleSelect: noop,
    refreshOpenDropdown: noop,
}));
jest.unstable_mockModule('../../public/scripts/select2-multiselect.js', () => ({
    buildBulkDeleteConfirmBody: () => '',
}));
jest.unstable_mockModule('../../public/scripts/zip-export.js', () => ({
    downloadTextFilesAsZip: asyncNoop,
}));
jest.unstable_mockModule('../../public/scripts/undo-toast.js', () => ({
    showUndoToast: noop,
}));

let saveWorldInfo;
let worldInfoCache;

beforeAll(async () => {
    const jqChain = {
        on: () => jqChain,
        off: () => jqChain,
        find: () => jqChain,
        val: () => '',
        prop: () => false,
        toggleClass: () => jqChain,
        addClass: () => jqChain,
        removeClass: () => jqChain,
        empty: () => jqChain,
        append: () => jqChain,
        trigger: () => jqChain,
        length: 0,
    };
    globalThis.$ = () => jqChain;
    globalThis.jQuery = globalThis.$;
    globalThis.document = { addEventListener: noop, querySelector: () => null, querySelectorAll: () => [] };
    globalThis.window = globalThis;
    ({ saveWorldInfo, worldInfoCache } = await import('../../public/scripts/world-info.js'));
});

beforeEach(() => {
    worldInfoCache.clear();
});

describe('world-info.js saveWorldInfo cache rollback on failed _save', () => {
    test('restores previous worldInfoCache entry when immediate save fails (HTTP 500)', async () => {
        const previous = { entries: { 0: { uid: 0, content: 'persisted' } } };
        worldInfoCache.set('BookA', previous);

        globalThis.fetch = jest.fn(async () => ({ ok: false, status: 500 }));

        const unpersisted = { entries: { 0: { uid: 0, content: 'poisoned' } } };
        await expect(saveWorldInfo('BookA', unpersisted, true)).rejects.toThrow(/Failed to save world info: 500/);

        expect(worldInfoCache.get('BookA')).toEqual(previous);
    });

    test('evicts worldInfoCache entry when immediate save fails for an uncached book', async () => {
        globalThis.fetch = jest.fn(async () => {
            throw new TypeError('network down');
        });

        await expect(saveWorldInfo('UncachedBook', { entries: { 1: { uid: 1, content: 'draft' } } }, true))
            .rejects.toThrow('network down');

        expect(worldInfoCache.has('UncachedBook')).toBe(false);
    });

    test('does not clobber a newer successful save when an earlier save fails', async () => {
        let releaseFirst;
        const firstGate = new Promise((res) => { releaseFirst = res; });
        let callIndex = 0;

        globalThis.fetch = jest.fn(async () => {
            callIndex += 1;
            if (callIndex === 1) {
                await firstGate;
                return { ok: false, status: 500 };
            }
            return { ok: true, status: 200 };
        });

        worldInfoCache.set('BookRace', { entries: { 0: { uid: 0, content: 'v0' } } });

        const firstSave = saveWorldInfo('BookRace', { entries: { 0: { uid: 0, content: 'v1-fails' } } }, true);
        const secondSave = saveWorldInfo('BookRace', { entries: { 0: { uid: 0, content: 'v2-wins' } } }, true);

        releaseFirst();
        await expect(firstSave).rejects.toThrow(/Failed to save world info: 500/);
        await secondSave;

        expect(worldInfoCache.get('BookRace')).toEqual({ entries: { 0: { uid: 0, content: 'v2-wins' } } });
    });

    test('restores persisted v0 (never unpersisted v1) when two overlapping saves both fail', async () => {
        let releaseFirst;
        const firstGate = new Promise((res) => { releaseFirst = res; });
        let callIndex = 0;

        globalThis.fetch = jest.fn(async () => {
            callIndex += 1;
            if (callIndex === 1) {
                await firstGate;
            }
            return { ok: false, status: 500 };
        });

        const v0 = { entries: { 0: { uid: 0, content: 'v0-persisted' } } };
        worldInfoCache.set('BookOverlap', v0);

        const firstSave = saveWorldInfo('BookOverlap', { entries: { 0: { uid: 0, content: 'v1-unpersisted' } } }, true);
        const secondSave = saveWorldInfo('BookOverlap', { entries: { 0: { uid: 0, content: 'v2-unpersisted' } } }, true);

        releaseFirst();
        await expect(firstSave).rejects.toThrow(/Failed to save world info: 500/);
        await expect(secondSave).rejects.toThrow(/Failed to save world info: 500/);

        expect(worldInfoCache.get('BookOverlap')).toEqual(v0);
    });

    test('evicts cache entry (never leaves unpersisted v1) when two overlapping saves both fail for an uncached book', async () => {
        let releaseFirst;
        const firstGate = new Promise((res) => { releaseFirst = res; });
        let callIndex = 0;

        globalThis.fetch = jest.fn(async () => {
            callIndex += 1;
            if (callIndex === 1) {
                await firstGate;
            }
            return { ok: false, status: 500 };
        });

        const firstSave = saveWorldInfo('BookUncachedOverlap', { entries: { 0: { uid: 0, content: 'v1-unpersisted' } } }, true);
        const secondSave = saveWorldInfo('BookUncachedOverlap', { entries: { 0: { uid: 0, content: 'v2-unpersisted' } } }, true);

        releaseFirst();
        await expect(firstSave).rejects.toThrow(/Failed to save world info: 500/);
        await expect(secondSave).rejects.toThrow(/Failed to save world info: 500/);

        expect(worldInfoCache.has('BookUncachedOverlap')).toBe(false);
    });

    test('updates rollback baseline after a save succeeds so a later failure rolls back to the last persisted state', async () => {
        const v0 = { entries: { 0: { uid: 0, content: 'v0' } } };
        const v1 = { entries: { 0: { uid: 0, content: 'v1-persisted' } } };
        worldInfoCache.set('BookAfterSuccess', v0);

        globalThis.fetch = jest.fn(async () => ({ ok: true, status: 200 }));
        await saveWorldInfo('BookAfterSuccess', v1, true);
        expect(worldInfoCache.get('BookAfterSuccess')).toEqual(v1);

        globalThis.fetch = jest.fn(async () => ({ ok: false, status: 500 }));
        await expect(saveWorldInfo('BookAfterSuccess', { entries: { 0: { uid: 0, content: 'v2-fails' } } }, true))
            .rejects.toThrow(/Failed to save world info: 500/);

        expect(worldInfoCache.get('BookAfterSuccess')).toEqual(v1);
    });
});
