import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import { EventEmitter } from '../../public/lib/eventemitter.js';
import {
    cancelChatSwitchActivities,
    getActiveActivities,
    hasActiveSource,
} from '../../public/scripts/activity-guard.js';

const noop = () => {};
const asyncNoop = async () => {};

function stubExports(names, overrides = {}) {
    const out = { ...overrides };
    for (const name of names) {
        if (!(name in out)) out[name] = noop;
    }
    return out;
}

class StubClass {
    constructor() {
        this.onSearchInput = noop;
    }
    applyFilters(list) {
        return list;
    }
    clearFuzzySearchCaches() {}
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

let generateGroupWrapper;
let groupChatsMod;
let groups;
let openGroupById;
let openGroupChat;
let resetSelectedGroup;
let eventSource;
let GenerateMock;
let stopGenerationMock;
let confirmChatSwitchGuardMock;
let sendMessageAsUserMock;
let saveChatConditionalMock;
let shouldAutoContinueMock;
let powerUserMock;
let setCharacterIdMock;
let setCharacterNameMock;
let activateSendButtonsMock;
let showSwipeButtonsMock;
let popupConfirmMock;
let mockEpoch = 0;
let mockCharacters;
let sendTextareaVal = '';
const trackedIntervals = new Set();

const EVENT_TYPES = {
    GENERATION_STOPPED: 'generation_stopped',
    GROUP_WRAPPER_STARTED: 'group_wrapper_started',
    GROUP_WRAPPER_FINISHED: 'group_wrapper_finished',
    GROUP_MEMBER_DRAFTED: 'group_member_drafted',
    CHAT_CHANGED: 'chat_id_changed',
};

beforeAll(async () => {
    eventSource = new EventEmitter();
    GenerateMock = jest.fn(async () => Object.assign(new String('reply'), { messageChunk: 'reply' }));
    stopGenerationMock = jest.fn();
    confirmChatSwitchGuardMock = jest.fn(async () => true);
    sendMessageAsUserMock = jest.fn(async () => {});
    saveChatConditionalMock = jest.fn(async () => true);
    shouldAutoContinueMock = jest.fn(() => false);
    powerUserMock = { show_group_chat_queue: false, disable_group_trimming: true };
    setCharacterIdMock = jest.fn();
    setCharacterNameMock = jest.fn();
    activateSendButtonsMock = jest.fn();
    showSwipeButtonsMock = jest.fn();
    popupConfirmMock = jest.fn(async () => true);
    mockCharacters = [
        { avatar: 'alice.png', name: 'Alice', shallow: false },
        { avatar: 'bob.png', name: 'Bob', shallow: false },
    ];

    const chatElementStub = { length: 0 };
    for (const method of ['on', 'off', 'one', 'val', 'text', 'html', 'attr', 'prop', 'css', 'addClass', 'removeClass', 'toggleClass', 'show', 'hide', 'toggle', 'append', 'prepend', 'empty', 'remove', 'find', 'closest', 'children', 'parent', 'filter', 'first', 'last', 'eq', 'each', 'trigger', 'focus', 'blur', 'click', 'data', 'scrollTop']) {
        chatElementStub[method] = () => chatElementStub;
    }
    chatElementStub.is = () => false;
    chatElementStub.hasClass = () => false;

    jest.unstable_mockModule('../../public/scripts/RossAscends-mods.js', () => stubExports([
        'RA_CountCharTokens', 'humanizedDateTime', 'dragElement', 'favsToHotswap', 'getMessageTimeStamp',
    ]));
    jest.unstable_mockModule('../../public/scripts/power-user.js', () => ({
        power_user: powerUserMock,
        loadMovingUIState: noop,
        sortEntitiesList: (arr) => arr,
    }));
    jest.unstable_mockModule('../../public/scripts/constants.js', () => ({
        debounce_timeout: { quick: 0, relaxed: 0 },
    }));
    jest.unstable_mockModule('../../public/scripts/utils.js', () => stubExports([
        'shuffle', 'isDataURL', 'createThumbnail', 'extractAllWords',
        'saveBase64AsFile', 'getBase64Async', 'resetScrollHeight', 'initScrollHeight',
        'localizePagination', 'renderPaginationDropdown', 'paginationDropdownChangeHandler',
    ], {
        onlyUnique: (value, index, self) => self.indexOf(value) === index,
        debounce: (fn) => fn,
        delay: asyncNoop,
        PAGINATION_TEMPLATE: '',
        uuidv4: () => 'uuid-test',
    }));
    jest.unstable_mockModule('../../public/scripts/floor-state.js', () => ({
        settleChatChanged: asyncNoop,
    }));
    jest.unstable_mockModule('../../public/scripts/tags.js', () => stubExports([
        'printTagList', 'createTagMapFromList', 'applyTagsOnCharacterSelect', 'applyTagsOnGroupSelect', 'printTagFilters',
    ], { tag_map: {}, tag_filter_type: {} }));
    jest.unstable_mockModule('../../public/scripts/filters.js', () => ({
        FILTER_TYPES: {},
        FilterHelper: StubClass,
    }));
    jest.unstable_mockModule('../../public/scripts/chats.js', () => ({
        isExternalMediaAllowed: () => true,
    }));
    jest.unstable_mockModule('../../public/scripts/popup.js', () => {
        class PopupStub extends StubClass {}
        PopupStub.show = { confirm: (...args) => popupConfirmMock(...args) };
        return {
            POPUP_TYPE: {},
            Popup: PopupStub,
            callGenericPopup: asyncNoop,
        };
    });
    jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
        t: (s, ...v) => (Array.isArray(s) ? String.raw(s, ...v) : String(s)),
        translate: (s) => String(s ?? ''),
    }));
    jest.unstable_mockModule('../../public/scripts/util/AccountStorage.js', () => ({
        accountStorage: { getItem: () => null, setItem: noop },
    }));
    jest.unstable_mockModule('../../public/scripts/undo-toast.js', () => ({
        showUndoToast: noop,
    }));
    jest.unstable_mockModule('../../public/scripts/request-compression.js', () => ({
        compressRequest: (body) => ({ body, compressed: false }),
    }));
    jest.unstable_mockModule('../../public/scripts/media-deletion-dialog.js', () => stubExports([
        'fetchMediaDeletionCandidates', 'deleteMediaFiles', 'promptMediaDeletion', 'notifyMediaDeleteResult',
    ]));
    jest.unstable_mockModule('../../public/script.js', () => ({
        ...stubExports([
            'sendSystemMessage', 'printMessages', 'addOneMessage', 'clearChat',
            'select_rm_info', 'setEditedMessageId',
            'resetChatState', 'setSendButtonState', 'getCharacters', 'selectRightMenuWithAnimation',
            'deleteLastMessage', 'hideSwipeButtons', 'updateChatMetadata',
            'getThumbnailUrl', 'setMenuType', 'cancelTtsPlay', 'displayPastChats',
            'sendMessageAsUser', 'saveChatConditional', 'deactivateSendButtons',
            'setCharacterSettingsOverrides', 'setExternalAbortController', 'baseChatReplace',
            'createLazyFields', 'loadItemizedPrompts', 'unshallowCharacter',
            'ensureMessageMediaIsArray', 'seedChatMetadataSnapshot', 'seedChatMessageSnapshot',
            'buildChatMessagePatchOperations', 'applyIntegrityFromWritePayloadToTarget',
            'invalidateChatWriteSnapshot', 'maybeApplyCharacterBoundPreset',
        ], {
            sendMessageAsUser: (...args) => sendMessageAsUserMock(...args),
            saveChatConditional: (...args) => saveChatConditionalMock(...args),
            setCharacterId: setCharacterIdMock,
            setCharacterName: setCharacterNameMock,
            activateSendButtons: activateSendButtonsMock,
            showSwipeButtons: showSwipeButtonsMock,
            chat: [],
            substituteParams: (s) => s,
            characters: mockCharacters,
            default_avatar: 'default.png',
            is_send_press: false,
            system_message_types: { EMPTY: 'empty' },
            online_status: 'connected',
            talkativeness_default: 0.5,
            chat_metadata: {},
            getRequestHeaders: () => ({}),
            menu_type: 'group_edit',
            select_selected_character: () => '',
            getBiasStrings: () => ({ messageBias: '' }),
            eventSource,
            event_types: EVENT_TYPES,
            getCurrentChatId: () => 'grp-chat-1',
            system_avatar: 'system.png',
            shouldBlockChatSwitchWhileSaving: () => false,
            waitForChatSwitchAvailability: async () => true,
            confirmChatSwitchGuard: confirmChatSwitchGuardMock,
            getChatTransitionEpoch: () => mockEpoch,
            bumpChatTransitionEpoch: () => {
                mockEpoch += 1;
                return mockEpoch;
            },
            depth_prompt_depth_default: 4,
            animation_duration: 0,
            depth_prompt_role_default: 'system',
            shouldAutoContinue: (...args) => shouldAutoContinueMock(...args),
            chatElement: chatElementStub,
            getChatMetadataSnapshot: () => ({}),
            getChatMessageSnapshot: () => [],
            buildChatMetadataPatchOperationsAsync: async () => [],
            consumePendingForceOverwrite: () => false,
            refreshSnapshotIntegrityFromActiveLive: noop,
            resolveChatWriteConflictForTarget: async () => {},
            runSerializedChatWrite: async (fn) => await fn(),
            getLastLukerGenerationIdForApi: () => '',
            getCharacterAlternateGreetings: () => [],
            getCharacterDescription: () => '',
            getCharacterFirstMessage: () => '',
            isCharacterFavorite: () => false,
            getCharacterMesExample: () => '',
            getCharacterName: (c) => c?.name || '',
            getCharacterPersonality: () => '',
            getCharacterScenario: () => '',
            getCharacterTalkativeness: () => 0.5,
            cloneAsJsonWire: (x) => JSON.parse(JSON.stringify(x)),
            isChatTransitionInProgress: () => false,
            Generate: GenerateMock,
            stopGeneration: stopGenerationMock,
        }),
    }));

    globalThis.CSS = { supports: () => true };
    globalThis.toastr = { error: jest.fn(), warning: jest.fn(), info: jest.fn(), success: jest.fn() };
    const origSetInterval = globalThis.setInterval;
    jest.spyOn(globalThis, 'setInterval').mockImplementation((...args) => {
        const id = origSetInterval(...args);
        trackedIntervals.add(id);
        return id;
    });
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: { getItem: () => null, setItem: noop, removeItem: noop },
    });
    globalThis.fetch = jest.fn(async () => ({
        ok: true,
        json: async () => ([{ chat_metadata: { tainted: true } }]),
    }));

    const makeChain = (overrides = {}) => {
        const chain = { length: 0, is: () => false, hasClass: () => false };
        for (const method of ['on', 'off', 'one', 'val', 'text', 'html', 'attr', 'prop', 'css', 'addClass', 'removeClass', 'toggleClass', 'show', 'hide', 'toggle', 'append', 'prepend', 'empty', 'remove', 'detach', 'clone', 'after', 'before', 'replaceWith', 'find', 'closest', 'children', 'parent', 'parents', 'siblings', 'next', 'prev', 'filter', 'not', 'first', 'last', 'eq', 'each', 'trigger', 'focus', 'blur', 'click', 'data', 'removeAttr', 'scrollTop', 'fadeIn', 'fadeOut', 'slideUp', 'slideDown', 'animate', 'pagination', 'sortable', 'select2', 'draggable', 'resizable', 'autocomplete', 'tooltip']) {
            chain[method] = () => chain;
        }
        return Object.assign(chain, overrides);
    };
    const fallbackChain = makeChain();
    const baseJQuery = globalThis.jQuery || Object.assign(
        (selectorOrFn) => (typeof selectorOrFn === 'function' ? undefined : fallbackChain),
        { __chain: fallbackChain, escapeSelector: (s) => String(s ?? '') },
    );
    const customJQuery = Object.assign(
        function (selectorOrFn) {
            if (typeof selectorOrFn === 'string' && selectorOrFn === '#send_textarea') {
                const chain = makeChain({
                    val: (v) => {
                        if (v !== undefined) {
                            sendTextareaVal = v;
                            return chain;
                        }
                        return sendTextareaVal;
                    },
                    0: { dispatchEvent: noop },
                });
                return chain;
            }
            return baseJQuery(selectorOrFn);
        },
        baseJQuery,
    );
    globalThis.jQuery = customJQuery;
    globalThis.$ = customJQuery;

    groupChatsMod = await import('../../public/scripts/group-chats.js');
    ({
        generateGroupWrapper,
        groups,
        openGroupById,
        openGroupChat,
        resetSelectedGroup,
    } = groupChatsMod);
});

describe('public/scripts/group-chats.js generateGroupWrapper activity lease & abort', () => {
    beforeEach(async () => {
        GenerateMock.mockReset();
        stopGenerationMock.mockReset();
        confirmChatSwitchGuardMock.mockReset();
        confirmChatSwitchGuardMock.mockResolvedValue(true);
        sendMessageAsUserMock.mockReset();
        sendMessageAsUserMock.mockImplementation(async () => {});
        saveChatConditionalMock.mockReset();
        saveChatConditionalMock.mockResolvedValue(true);
        shouldAutoContinueMock.mockReset();
        shouldAutoContinueMock.mockReturnValue(false);
        powerUserMock.show_group_chat_queue = false;
        powerUserMock.disable_group_trimming = true;
        setCharacterIdMock.mockReset();
        setCharacterNameMock.mockReset();
        activateSendButtonsMock.mockReset();
        showSwipeButtonsMock.mockReset();
        mockEpoch = 0;
        sendTextareaVal = '';
        eventSource.events[EVENT_TYPES.GENERATION_STOPPED] = [];
        groups.splice(0, groups.length, {
            id: 'grp-1',
            name: 'Test Group',
            chat_id: 'grp-chat-1',
            chats: ['grp-chat-1', 'grp-chat-2'],
            members: ['alice.png', 'bob.png'],
            disabled_members: [],
            activation_strategy: 1, // LIST
        });
        resetSelectedGroup();
        await openGroupById('grp-1');
        setCharacterIdMock.mockClear();
        setCharacterNameMock.mockClear();
        activateSendButtonsMock.mockClear();
        showSwipeButtonsMock.mockClear();
        confirmChatSwitchGuardMock.mockClear();
        if (getActiveActivities().length > 0) {
            throw new Error(`Expected empty activity guard before test, got: ${JSON.stringify(getActiveActivities())}`);
        }
    });

    afterEach(() => {
        for (const id of trackedIntervals) {
            clearInterval(id);
        }
        trackedIntervals.clear();
        resetSelectedGroup();
        eventSource.events[EVENT_TYPES.GENERATION_STOPPED] = [];
        if (getActiveActivities().length > 0) {
            throw new Error(`Leaked activity leases after test: ${JSON.stringify(getActiveActivities())}`);
        }
    });

    test('holds core:group-generation lease across member generation and releases on completion', async () => {
        const firstGate = deferred();
        let observedActivities = null;
        let receivedSignals = [];

        GenerateMock.mockImplementationOnce(async (_type, params) => {
            observedActivities = getActiveActivities();
            receivedSignals.push(params?.signal);
            await firstGate.promise;
            return Object.assign(new String('Alice reply'), { messageChunk: 'Alice reply' });
        }).mockImplementationOnce(async (_type, params) => {
            receivedSignals.push(params?.signal);
            return Object.assign(new String('Bob reply'), { messageChunk: 'Bob reply' });
        });

        const promise = generateGroupWrapper(false, 'normal');
        await new Promise((r) => setTimeout(r, 10));

        expect(observedActivities).toHaveLength(1);
        expect(observedActivities[0]).toMatchObject({
            source: 'core:group-generation',
            label: 'Group chat generation',
            scope: 'chat',
            guardUnload: true,
            guardChatSwitch: true,
            keepAlive: true,
        });
        expect(hasActiveSource('core:group-generation')).toBe(true);

        firstGate.resolve();
        const result = await promise;
        expect(String(result)).toBe('Bob reply');
        expect(GenerateMock).toHaveBeenCalledTimes(2);
        expect(receivedSignals[0]).toBeInstanceOf(AbortSignal);
        expect(receivedSignals[0].aborted).toBe(false);
        expect(getActiveActivities()).toEqual([]);
        expect(eventSource.events[EVENT_TYPES.GENERATION_STOPPED]).toEqual([]);
    });

    test('GENERATION_STOPPED aborts internal groupAbortController mid-turn, skips remaining members, and cleans listeners', async () => {
        let member1Signal = null;
        GenerateMock.mockImplementationOnce(async (_type, params) => {
            member1Signal = params?.signal;
            await eventSource.emit(EVENT_TYPES.GENERATION_STOPPED);
            return Object.assign(new String('partial'), { messageChunk: 'partial' });
        });

        await expect(generateGroupWrapper(false, 'normal')).rejects.toThrow('AbortSignal was fired. Group generation stopped');

        expect(GenerateMock).toHaveBeenCalledTimes(1);
        expect(member1Signal).toBeInstanceOf(AbortSignal);
        expect(member1Signal.aborted).toBe(true);
        expect(getActiveActivities()).toEqual([]);
        expect(eventSource.events[EVENT_TYPES.GENERATION_STOPPED]).toEqual([]);
    });

    test('onCancel aborts groupAbortController and invokes stopGeneration, and external signal listener cleans up', async () => {
        const externalController = new AbortController();
        const removeListenerSpy = jest.spyOn(externalController.signal, 'removeEventListener');
        const gate = deferred();
        let passedSignal = null;

        GenerateMock.mockImplementationOnce(async (_type, params) => {
            passedSignal = params?.signal;
            await gate.promise;
            return Object.assign(new String('partial'), { messageChunk: 'partial' });
        });

        const promise = generateGroupWrapper(false, 'normal', { signal: externalController.signal });
        await new Promise((r) => setTimeout(r, 10));

        expect(hasActiveSource('core:group-generation')).toBe(true);
        cancelChatSwitchActivities();

        expect(stopGenerationMock).toHaveBeenCalledTimes(1);
        expect(passedSignal?.aborted).toBe(true);

        gate.resolve();
        await expect(promise).rejects.toThrow('AbortSignal was fired. Group generation stopped');
        expect(removeListenerSpy).toHaveBeenCalledTimes(1);
        expect(getActiveActivities()).toEqual([]);
    });

    test('epoch mismatch in generateGroupWrapper finally always clears is_group_generating and lease without resetting new chat state', async () => {
        const gate = deferred();
        GenerateMock.mockImplementationOnce(async () => {
            await gate.promise;
            return Object.assign(new String('partial'), { messageChunk: 'partial' });
        });

        const promise = generateGroupWrapper(false, 'normal');
        await new Promise((r) => setTimeout(r, 10));
        expect(groupChatsMod.is_group_generating).toBe(true);

        setCharacterIdMock.mockClear();
        setCharacterNameMock.mockClear();
        activateSendButtonsMock.mockClear();
        showSwipeButtonsMock.mockClear();

        // Simulate user confirming a switch to another chat, advancing epoch.
        mockEpoch += 1;
        gate.resolve();

        await expect(promise).rejects.toThrow('AbortSignal was fired. Group generation stopped');
        expect(groupChatsMod.is_group_generating).toBe(false);
        expect(getActiveActivities()).toEqual([]);
        expect(setCharacterIdMock).not.toHaveBeenCalled();
        expect(setCharacterNameMock).not.toHaveBeenCalled();
        expect(activateSendButtonsMock).not.toHaveBeenCalled();
        expect(showSwipeButtonsMock).not.toHaveBeenCalled();
    });

    test('openGroupById and openGroupChat honor confirmChatSwitchGuard boolean result and skip guard on same group', async () => {
        // Clicking the already-open group skips confirmChatSwitchGuard and returns true.
        await expect(openGroupById('grp-1')).resolves.toBe(true);
        expect(confirmChatSwitchGuardMock).not.toHaveBeenCalled();

        // Switching to another group cancels cleanly when guard returns false.
        groups.push({
            id: 'grp-2',
            name: 'Second Group',
            chat_id: 'grp2-chat-1',
            chats: ['grp2-chat-1'],
            members: ['alice.png'],
            disabled_members: [],
            activation_strategy: 1,
        });
        confirmChatSwitchGuardMock.mockResolvedValueOnce(false);
        await expect(openGroupById('grp-2')).resolves.toBe(false);
        expect(confirmChatSwitchGuardMock).toHaveBeenCalledWith({ skipConfirmation: false });
        expect(groupChatsMod.selected_group).toBe('grp-1');

        // Switching group chats cancels cleanly when guard returns false, and forwards skipSwitchGuard.
        confirmChatSwitchGuardMock.mockResolvedValueOnce(false);
        await expect(openGroupChat('grp-1', 'grp-chat-2')).resolves.toBe(false);
        expect(groups[0].chat_id).toBe('grp-chat-1');

        confirmChatSwitchGuardMock.mockResolvedValueOnce(true);
        await expect(openGroupChat('grp-1', 'grp-chat-2', { skipSwitchGuard: true })).resolves.toBe(true);
        expect(confirmChatSwitchGuardMock).toHaveBeenLastCalledWith({ skipConfirmation: true });
        expect(groups[0].chat_id).toBe('grp-chat-2');
    });

    test('epoch bump during single/last member Generate and auto-continue aborts before mutating active groupChatQueueOrder', async () => {
        powerUserMock.show_group_chat_queue = true;
        groups[0].members = ['alice.png'];
        groups.push({
            id: 'grp-2',
            name: 'Second Group',
            chat_id: 'grp2-chat-1',
            chats: ['grp2-chat-1'],
            members: ['alice.png', 'bob.png'],
            disabled_members: [],
            activation_strategy: 1, // LIST
        });

        const staleGate = deferred();
        const freshGate = deferred();
        GenerateMock
            .mockImplementationOnce(async () => {
                await staleGate.promise;
                return Object.assign(new String('stale alice'), { messageChunk: 'stale alice' });
            })
            .mockImplementationOnce(async () => {
                await freshGate.promise;
                return Object.assign(new String('fresh alice'), { messageChunk: 'fresh alice' });
            })
            .mockImplementationOnce(async () => Object.assign(new String('fresh bob'), { messageChunk: 'fresh bob' }));

        const stalePromise = generateGroupWrapper(false, 'normal');
        await new Promise((r) => setTimeout(r, 10));
        expect(GenerateMock).toHaveBeenCalledTimes(1);

        // Switch to grp-2 (advances epoch) and immediately start grp-2 generation.
        await expect(openGroupById('grp-2')).resolves.toBe(true);
        const freshPromise = generateGroupWrapper(false, 'normal');
        await new Promise((r) => setTimeout(r, 10));
        expect(GenerateMock).toHaveBeenCalledTimes(2);

        const deleteSpy = jest.spyOn(Map.prototype, 'delete');
        const setSpy = jest.spyOn(Map.prototype, 'set');
        try {
            staleGate.resolve();
            await expect(stalePromise).rejects.toThrow('AbortSignal was fired. Group generation stopped');
            expect(deleteSpy.mock.calls.filter(([k]) => typeof k === 'string')).toEqual([]);
            expect(setSpy.mock.calls.filter(([k]) => typeof k === 'string')).toEqual([]);
        } finally {
            deleteSpy.mockRestore();
            setSpy.mockRestore();
            staleGate.resolve();
            freshGate.resolve();
            await Promise.allSettled([stalePromise, freshPromise]);
        }

        const freshResult = await freshPromise;
        expect(String(freshResult)).toBe('fresh bob');
        expect(GenerateMock).toHaveBeenCalledTimes(3);

        // Also cover auto-continue loop settling on a stale epoch before queue mutation.
        const continueGate = deferred();
        shouldAutoContinueMock.mockReturnValueOnce(true);
        GenerateMock
            .mockImplementationOnce(async () => Object.assign(new String('part1'), { messageChunk: 'part1' }))
            .mockImplementationOnce(async () => {
                await continueGate.promise;
                return Object.assign(new String('part2'), { messageChunk: 'part2' });
            });

        const continuePromise = generateGroupWrapper(false, 'normal');
        await new Promise((r) => setTimeout(r, 10));
        mockEpoch += 1;
        const continueDeleteSpy = jest.spyOn(Map.prototype, 'delete');
        try {
            continueGate.resolve();
            await expect(continuePromise).rejects.toThrow('AbortSignal was fired. Group generation stopped');
            expect(continueDeleteSpy.mock.calls.filter(([k]) => typeof k === 'string')).toEqual([]);
        } finally {
            continueDeleteSpy.mockRestore();
            continueGate.resolve();
            await Promise.allSettled([continuePromise]);
        }
    });

    test('epoch bump during empty-member sendMessageAsUser aborts before saving chat, clearing textarea, or emitting GROUP_WRAPPER_STARTED', async () => {
        groups[0].members = ['alice.png'];
        groups[0].disabled_members = ['alice.png'];
        sendTextareaVal = 'unsent draft';

        const sendGate = deferred();
        sendMessageAsUserMock.mockImplementationOnce(async () => {
            await sendGate.promise;
        });

        const startedSpy = jest.fn();
        const finishedSpy = jest.fn();
        eventSource.on(EVENT_TYPES.GROUP_WRAPPER_STARTED, startedSpy);
        eventSource.on(EVENT_TYPES.GROUP_WRAPPER_FINISHED, finishedSpy);

        try {
            const promise = generateGroupWrapper(false, 'normal');
            await new Promise((r) => setTimeout(r, 10));
            expect(sendMessageAsUserMock).toHaveBeenCalledTimes(1);

            mockEpoch += 1;
            sendGate.resolve();

            await expect(promise).rejects.toThrow('AbortSignal was fired. Group generation stopped');
            expect(saveChatConditionalMock).not.toHaveBeenCalled();
            expect(sendTextareaVal).toBe('unsent draft');
            expect(startedSpy).not.toHaveBeenCalled();
            expect(finishedSpy).not.toHaveBeenCalled();
            expect(groupChatsMod.is_group_generating).toBe(false);
            expect(getActiveActivities()).toEqual([]);
        } finally {
            eventSource.removeListener(EVENT_TYPES.GROUP_WRAPPER_STARTED, startedSpy);
            eventSource.removeListener(EVENT_TYPES.GROUP_WRAPPER_FINISHED, finishedSpy);
        }
    });

    test('onDeleteGroupClick confirms group deletion BEFORE running confirmChatSwitchGuard', async () => {
        await openGroupById('grp-1');
        expect(groupChatsMod.openGroupId).toBe('grp-1');
        expect(groupChatsMod.selected_group).toBe('grp-1');

        confirmChatSwitchGuardMock.mockClear();
        popupConfirmMock.mockReset().mockResolvedValueOnce(false);
        const origFetch = globalThis.fetch;
        const fetchSpy = jest.fn(async () => ({ ok: true, json: async () => ({}) }));
        globalThis.fetch = fetchSpy;

        try {
            // Cancelling "Delete the group?" must not call confirmChatSwitchGuard or deleteGroup.
            await groupChatsMod._onDeleteGroupClickForTest();
            expect(popupConfirmMock).toHaveBeenCalledTimes(1);
            expect(confirmChatSwitchGuardMock).not.toHaveBeenCalled();
            expect(fetchSpy).not.toHaveBeenCalled();

            // Confirming "Delete the group?" invokes confirmChatSwitchGuard afterwards; cancelling switch aborts delete.
            const order = [];
            popupConfirmMock.mockImplementationOnce(async () => {
                order.push('delete-confirm');
                return true;
            });
            confirmChatSwitchGuardMock.mockImplementationOnce(async () => {
                order.push('switch-guard');
                return false;
            });
            await groupChatsMod._onDeleteGroupClickForTest();
            expect(order).toEqual(['delete-confirm', 'switch-guard']);
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
            globalThis.fetch = origFetch;
        }
    });
});
