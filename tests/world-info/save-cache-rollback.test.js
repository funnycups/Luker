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

let deleteWorldInfo;
let loadWorldInfo;
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
        remove: () => jqChain,
        attr: () => jqChain,
        children: () => jqChain,
        text: () => jqChain,
        data: () => null,
        each: () => jqChain,
        trigger: () => jqChain,
        length: 0,
    };
    globalThis.$ = () => jqChain;
    globalThis.jQuery = globalThis.$;
    globalThis.document = { addEventListener: noop, querySelector: () => null, querySelectorAll: () => [] };
    globalThis.window = globalThis;
    ({ deleteWorldInfo, loadWorldInfo, saveWorldInfo, worldInfoCache } = await import('../../public/scripts/world-info.js'));
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

    test('restores unmutated persisted state when caller mutates previously cached object in place before a failed save', async () => {
        const book = { entries: { 0: { uid: 0, content: 'persisted-clean' } } };
        globalThis.fetch = jest.fn(async () => ({ ok: true, status: 200 }));
        await saveWorldInfo('BookInPlace', book, true);

        // Mutate the exact object reference previously passed to saveWorldInfo in place.
        book.entries[0].content = 'poisoned-in-place';
        globalThis.fetch = jest.fn(async () => ({ ok: false, status: 500 }));
        await expect(saveWorldInfo('BookInPlace', book, true)).rejects.toThrow(/Failed to save world info: 500/);

        expect(worldInfoCache.get('BookInPlace')).toEqual({
            entries: { 0: { uid: 0, content: 'persisted-clean' } },
        });
    });

    test('does not poison worldInfoSnapshotCache when loadWorldInfo reads an unpersisted queued save', async () => {
        let releaseBlocker;
        const blockerGate = new Promise((res) => { releaseBlocker = res; });
        const savedRequests = [];

        globalThis.fetch = jest.fn(async (url, init) => {
            const body = init?.body ? JSON.parse(init.body) : {};
            savedRequests.push({ url, body });
            if (body.name === 'BlockerBook') {
                await blockerGate;
            }
            return { ok: true, status: 200 };
        });

        const blockerSave = saveWorldInfo('BlockerBook', { entries: { 0: { uid: 0, content: 'block' } } }, true);
        const queuedNewBook = { entries: { 1: { uid: 1, content: 'must-persist' } } };
        const newBookSave = saveWorldInfo('QueuedNewBook', queuedNewBook, true);

        // Read before QueuedNewBook's save executes on worldInfoSaveChain.
        const loaded = await loadWorldInfo('QueuedNewBook');
        expect(loaded).toEqual(queuedNewBook);

        releaseBlocker();
        await blockerSave;
        await newBookSave;

        const persistedNewBook = savedRequests.find((req) => req.body.name === 'QueuedNewBook');
        expect(persistedNewBook).toBeDefined();
        expect(persistedNewBook.url).toBe('/api/worldinfo/edit');
        expect(persistedNewBook.body.data).toEqual(queuedNewBook);
    });

    test('does not regress newer optimistic cache write when an earlier overlapping save succeeds, and rolls back to that persisted save if the newer save fails', async () => {
        let releaseFirst;
        const firstGate = new Promise((res) => { releaseFirst = res; });
        let releaseSecond;
        const secondGate = new Promise((res) => { releaseSecond = res; });
        let callIndex = 0;

        globalThis.fetch = jest.fn(async () => {
            callIndex += 1;
            if (callIndex === 1) {
                await firstGate;
                return { ok: true, status: 200 };
            }
            await secondGate;
            return { ok: false, status: 500 };
        });

        const v1 = { entries: { 0: { uid: 0, content: 'v1-persisted' } } };
        const v2 = { entries: { 0: { uid: 0, content: 'v2-fails' } } };
        const firstSave = saveWorldInfo('BookOverlapKeepNewer', v1, true);
        const secondSave = saveWorldInfo('BookOverlapKeepNewer', v2, true);

        releaseFirst();
        await firstSave;
        // While secondSave is still in flight, cache must keep v2 (not regress to v1).
        expect(worldInfoCache.get('BookOverlapKeepNewer')).toEqual(v2);

        releaseSecond();
        await expect(secondSave).rejects.toThrow(/Failed to save world info: 500/);
        // Once secondSave fails, cache must roll back to the acknowledged v1.
        expect(worldInfoCache.get('BookOverlapKeepNewer')).toEqual(v1);
    });

    test('in-flight save completing after deleteWorldInfo does not re-seed snapshot cache and block recreating with identical content', async () => {
        let releaseInitialSave;
        const initialSaveGate = new Promise((res) => { releaseInitialSave = res; });
        const editCalls = [];

        globalThis.fetch = jest.fn(async (url, init) => {
            const body = init?.body ? JSON.parse(init.body) : {};
            if (url === '/api/worldinfo/edit') {
                editCalls.push(body);
                if (editCalls.length === 1) {
                    await initialSaveGate;
                }
                return { ok: true, status: 200 };
            }
            if (url === '/api/worldinfo/delete') {
                return { ok: true, status: 200 };
            }
            return { ok: true, status: 200, json: async () => ({ world_names: [] }) };
        });

        const v1 = { entries: { 0: { uid: 0, content: 'recreated-content' } } };
        const initialSave = saveWorldInfo('BookDeletedMidSave', v1, true);
        // Delete completes before the earlier in-flight save resolves.
        await deleteWorldInfo('BookDeletedMidSave');

        releaseInitialSave();
        await initialSave;

        // Recreating/undoing with the exact same content must send /api/worldinfo/edit.
        await saveWorldInfo('BookDeletedMidSave', v1, true);
        expect(editCalls).toHaveLength(2);
        expect(editCalls[1]).toEqual({ name: 'BookDeletedMidSave', data: v1 });
    });

    test('pre-delete in-flight save does not poison snapshot cache or rollback baseline when a post-delete recreate queues before it settles', async () => {
        let releaseInitialSave;
        const initialSaveGate = new Promise((res) => { releaseInitialSave = res; });
        const editCalls = [];

        globalThis.fetch = jest.fn(async (url, init) => {
            const body = init?.body ? JSON.parse(init.body) : {};
            if (url === '/api/worldinfo/edit') {
                editCalls.push(body);
                if (editCalls.length === 1) {
                    await initialSaveGate;
                }
                return { ok: true, status: 200 };
            }
            if (url === '/api/worldinfo/delete') {
                return { ok: true, status: 200 };
            }
            return { ok: true, status: 200, json: async () => ({ world_names: [] }) };
        });

        const v1 = { entries: { 0: { uid: 0, content: 'undo-same-content' } } };
        const initialSave = saveWorldInfo('BookDeletedBeforeRecreate', v1, true);
        await deleteWorldInfo('BookDeletedBeforeRecreate');

        // Start recreate BEFORE releasing the pre-delete in-flight save.
        const recreateSave = saveWorldInfo('BookDeletedBeforeRecreate', v1, true);
        releaseInitialSave();
        await Promise.all([initialSave, recreateSave]);

        expect(editCalls).toHaveLength(2);
        expect(editCalls[1]).toEqual({ name: 'BookDeletedBeforeRecreate', data: v1 });

        // Also verify a failed post-delete recreate evicts cache rather than restoring pre-delete v1.
        let releasePreDelete2;
        const preDelete2Gate = new Promise((res) => { releasePreDelete2 = res; });
        let editCount2 = 0;
        globalThis.fetch = jest.fn(async (url) => {
            if (url === '/api/worldinfo/edit') {
                editCount2 += 1;
                if (editCount2 === 1) {
                    await preDelete2Gate;
                    return { ok: true, status: 200 };
                }
                return { ok: false, status: 500 };
            }
            if (url === '/api/worldinfo/delete') {
                return { ok: true, status: 200 };
            }
            return { ok: true, status: 200, json: async () => ({ world_names: [] }) };
        });

        const preSave2 = saveWorldInfo('BookDeletedFailRecreate', v1, true);
        await deleteWorldInfo('BookDeletedFailRecreate');
        const failedRecreate = saveWorldInfo('BookDeletedFailRecreate', { entries: { 0: { uid: 0, content: 'v2-fails' } } }, true);
        releasePreDelete2();
        await preSave2;
        await expect(failedRecreate).rejects.toThrow(/Failed to save world info: 500/);
        expect(worldInfoCache.has('BookDeletedFailRecreate')).toBe(false);
    });

    test('queued pre-delete save on worldInfoSaveChain aborts without calling /api/worldinfo/edit after deleteWorldInfo', async () => {
        let releaseBlocker;
        const blockerGate = new Promise((res) => { releaseBlocker = res; });
        const editNames = [];

        globalThis.fetch = jest.fn(async (url, init) => {
            const body = init?.body ? JSON.parse(init.body) : {};
            if (url === '/api/worldinfo/edit') {
                editNames.push(body.name);
                if (body.name === 'QueueBlockerBook') {
                    await blockerGate;
                }
                return { ok: true, status: 200 };
            }
            if (url === '/api/worldinfo/delete') {
                return { ok: true, status: 200 };
            }
            return { ok: true, status: 200, json: async () => ({ world_names: [] }) };
        });

        const blocker = saveWorldInfo('QueueBlockerBook', { entries: { 0: { uid: 0, content: 'hold' } } }, true);
        const queuedPreDelete = saveWorldInfo('BookDeletedWhileQueued', { entries: { 0: { uid: 0, content: 'stale' } } }, true);

        await deleteWorldInfo('BookDeletedWhileQueued');
        releaseBlocker();
        await Promise.all([blocker, queuedPreDelete]);

        expect(editNames).toEqual(['QueueBlockerBook']);
        expect(worldInfoCache.has('BookDeletedWhileQueued')).toBe(false);
    });
});
