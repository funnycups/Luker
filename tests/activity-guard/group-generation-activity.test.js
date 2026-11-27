/**
 * @jest-environment jsdom
 */
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { EventEmitter } from '../../public/lib/eventemitter.js';
import {
    cancelChatSwitchActivities,
    getActiveActivities,
    hasActiveSource,
} from '../../public/scripts/activity-guard.js';
import { createGroupGenerationController } from '../../public/scripts/lib/group-generation-controller.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

const EVENT_TYPES = {
    GENERATION_STOPPED: 'generation_stopped',
    GROUP_WRAPPER_STARTED: 'group_wrapper_started',
    GROUP_WRAPPER_FINISHED: 'group_wrapper_finished',
    GROUP_MEMBER_DRAFTED: 'group_member_drafted',
    CHAT_CHANGED: 'chat_id_changed',
};

const GROUP_ACTIVATION_STRATEGY = {
    NATURAL: 0,
    LIST: 1,
    MANUAL: 2,
    POOLED: 3,
};

describe('group generation controller activity lease, epoch fencing, and delete ordering', () => {
    let eventSource;
    let groups;
    let selectedGroup;
    let openGroupId;
    let isGroupGenerating;
    let groupChatQueueOrder;
    let groupChatLoadSequence;
    let characters;
    let chat;
    let powerUser;
    let epoch;
    let sendTextareaVal;
    let GenerateMock;
    let stopGenerationMock;
    let confirmChatSwitchGuardMock;
    let sendMessageAsUserMock;
    let saveChatConditionalMock;
    let shouldAutoContinueMock;
    let setCharacterIdMock;
    let setCharacterNameMock;
    let activateSendButtonsMock;
    let showSwipeButtonsMock;
    let deleteGroupMock;
    let popupConfirmMock;
    let controller;

    beforeEach(() => {
        eventSource = new EventEmitter();
        groups = [{
            id: 'grp-1',
            name: 'Test Group',
            chat_id: 'grp-chat-1',
            chats: ['grp-chat-1', 'grp-chat-2'],
            members: ['alice.png', 'bob.png'],
            disabled_members: [],
            activation_strategy: GROUP_ACTIVATION_STRATEGY.LIST,
        }];
        selectedGroup = 'grp-1';
        openGroupId = 'grp-1';
        isGroupGenerating = false;
        groupChatQueueOrder = new Map();
        groupChatLoadSequence = 0;
        characters = [
            { avatar: 'alice.png', name: 'Alice', shallow: false },
            { avatar: 'bob.png', name: 'Bob', shallow: false },
        ];
        chat = [];
        powerUser = { show_group_chat_queue: false, disable_group_trimming: true };
        epoch = 0;
        sendTextareaVal = '';

        GenerateMock = jest.fn(async () => Object.assign(new String('reply'), { messageChunk: 'reply' }));
        stopGenerationMock = jest.fn();
        confirmChatSwitchGuardMock = jest.fn(async () => true);
        sendMessageAsUserMock = jest.fn(async () => {});
        saveChatConditionalMock = jest.fn(async () => true);
        shouldAutoContinueMock = jest.fn(() => false);
        setCharacterIdMock = jest.fn();
        setCharacterNameMock = jest.fn();
        activateSendButtonsMock = jest.fn();
        showSwipeButtonsMock = jest.fn();
        deleteGroupMock = jest.fn(async () => {});
        popupConfirmMock = jest.fn(async () => true);

        const jq = (selector) => {
            if (selector === '#send_textarea') {
                const chain = {
                    val(v) {
                        if (v !== undefined) {
                            sendTextareaVal = v;
                            return chain;
                        }
                        return sendTextareaVal;
                    },
                    0: { dispatchEvent: () => {} },
                };
                return chain;
            }
            return { val: () => '', length: 0 };
        };

        const captureGroupChatEntryOwnership = (groupId) => {
            const group = groups.find(x => x.id === groupId);
            if (!group || selectedGroup !== groupId) return null;
            const originatingChatId = group.chat_id;
            const loadSequence = ++groupChatLoadSequence;
            return (chatId = originatingChatId) => loadSequence === groupChatLoadSequence
                && selectedGroup === groupId
                && groups.find(x => x.id === groupId)?.chat_id === chatId;
        };

        controller = createGroupGenerationController({
            getOnlineStatus: () => 'connected',
            getMenuType: () => 'group_edit',
            getGroups: () => groups,
            getSelectedGroup: () => selectedGroup,
            setSelectedGroup: (v) => { selectedGroup = v; },
            getOpenGroupId: () => openGroupId,
            getIsGroupGenerating: () => isGroupGenerating,
            setIsGroupGenerating: (v) => { isGroupGenerating = v; },
            setGroupGenerationId: () => {},
            getGroupChatQueueOrder: () => groupChatQueueOrder,
            setGroupChatQueueOrder: (v) => { groupChatQueueOrder = v; },
            getCharacters: () => characters,
            getChat: () => chat,
            getPowerUser: () => powerUser,
            getEventSource: () => eventSource,
            getEventTypes: () => EVENT_TYPES,
            getSystemMessageTypes: () => ({ EMPTY: 'empty' }),
            getGroupActivationStrategy: () => GROUP_ACTIVATION_STRATEGY,
            select_group_chats: (id) => { openGroupId = id; },
            delay: async () => {},
            sendSystemMessage: () => {},
            getChatTransitionEpoch: () => epoch,
            bumpChatTransitionEpoch: () => {
                epoch += 1;
                return epoch;
            },
            confirmChatSwitchGuard: (...args) => confirmChatSwitchGuardMock(...args),
            shouldBlockChatSwitchWhileSaving: () => false,
            waitForChatSwitchAvailability: async () => true,
            stopGeneration: (...args) => stopGenerationMock(...args),
            unshallowGroupMembers: async () => {},
            hideSwipeButtons: () => {},
            showSwipeButtons: (...args) => showSwipeButtonsMock(...args),
            setCharacterName: (...args) => setCharacterNameMock(...args),
            setCharacterId: (...args) => setCharacterIdMock(...args),
            setSendButtonState: () => {},
            deactivateSendButtons: () => {},
            activateSendButtons: (...args) => activateSendButtonsMock(...args),
            getBiasStrings: () => ({ messageBias: '' }),
            sendMessageAsUser: (...args) => sendMessageAsUserMock(...args),
            saveChatConditional: (...args) => saveChatConditionalMock(...args),
            printGroupMembers: () => {},
            getCharacterName: (c) => c?.name || '',
            Generate: (...args) => GenerateMock(...args),
            shouldAutoContinue: (...args) => shouldAutoContinueMock(...args),
            activateSwipe: () => [],
            activateListOrder: (members) => members.map(a => characters.findIndex(c => c.avatar === a)).filter(i => i !== -1),
            activateImpersonate: () => [],
            activateNaturalOrder: () => [],
            activatePooledOrder: () => [],
            shuffle: (arr) => arr,
            resetSelectedGroup: () => { selectedGroup = null; },
            clearChat: async () => {},
            cancelTtsPlay: () => {},
            setEditedMessageId: () => {},
            updateChatMetadata: () => {},
            getGroupChat: async () => {},
            editGroup: async () => {},
            deleteGroup: (...args) => deleteGroupMock(...args),
            captureGroupChatEntryOwnership,
            confirmDialog: (...args) => popupConfirmMock(...args),
            t: (s, ...v) => (Array.isArray(s) ? String.raw(s, ...v) : String(s)),
            getJQuery: () => jq,
            getToastr: () => ({ warning: jest.fn(), info: jest.fn(), error: jest.fn() }),
        });

        const before = getActiveActivities();
        if (before.length > 0) {
            throw new Error(`Expected empty activity guard before test, got: ${JSON.stringify(before)}`);
        }
    });

    afterEach(() => {
        const leftover = getActiveActivities();
        if (leftover.length > 0) {
            throw new Error(`Leaked activity leases after test: ${JSON.stringify(leftover)}`);
        }
    });

    test('holds core:group-generation lease across member generation and releases on completion', async () => {
        const firstGate = deferred();
        let observedActivities = null;
        const receivedSignals = [];

        GenerateMock.mockImplementationOnce(async (_type, params) => {
            observedActivities = getActiveActivities();
            receivedSignals.push(params?.signal);
            await firstGate.promise;
            return Object.assign(new String('Alice reply'), { messageChunk: 'Alice reply' });
        }).mockImplementationOnce(async (_type, params) => {
            receivedSignals.push(params?.signal);
            return Object.assign(new String('Bob reply'), { messageChunk: 'Bob reply' });
        });

        const promise = controller.generateGroupWrapper(false, 'normal');
        await new Promise((r) => setTimeout(r, 10));

        expect(observedActivities).toHaveLength(1);
        expect(observedActivities[0]).toMatchObject({
            source: 'core:group-generation',
            label: expect.stringMatching(/\S/),
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

        await expect(controller.generateGroupWrapper(false, 'normal')).rejects.toThrow('AbortSignal was fired. Group generation stopped');

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

        const promise = controller.generateGroupWrapper(false, 'normal', { signal: externalController.signal });
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

        const promise = controller.generateGroupWrapper(false, 'normal');
        await new Promise((r) => setTimeout(r, 10));
        expect(isGroupGenerating).toBe(true);

        setCharacterIdMock.mockClear();
        setCharacterNameMock.mockClear();
        activateSendButtonsMock.mockClear();
        showSwipeButtonsMock.mockClear();

        epoch += 1;
        gate.resolve();

        await expect(promise).rejects.toThrow('AbortSignal was fired. Group generation stopped');
        expect(isGroupGenerating).toBe(false);
        expect(getActiveActivities()).toEqual([]);
        expect(setCharacterIdMock).not.toHaveBeenCalled();
        expect(setCharacterNameMock).not.toHaveBeenCalled();
        expect(activateSendButtonsMock).not.toHaveBeenCalled();
        expect(showSwipeButtonsMock).not.toHaveBeenCalled();
    });

    test('openGroupById and openGroupChat honor confirmChatSwitchGuard boolean result and skip guard on same group', async () => {
        await expect(controller.openGroupById('grp-1')).resolves.toBe(true);
        expect(confirmChatSwitchGuardMock).not.toHaveBeenCalled();

        groups.push({
            id: 'grp-2',
            name: 'Second Group',
            chat_id: 'grp2-chat-1',
            chats: ['grp2-chat-1'],
            members: ['alice.png'],
            disabled_members: [],
            activation_strategy: GROUP_ACTIVATION_STRATEGY.LIST,
        });
        confirmChatSwitchGuardMock.mockResolvedValueOnce(false);
        await expect(controller.openGroupById('grp-2')).resolves.toBe(false);
        expect(confirmChatSwitchGuardMock).toHaveBeenCalledWith({ skipConfirmation: false });
        expect(selectedGroup).toBe('grp-1');

        confirmChatSwitchGuardMock.mockResolvedValueOnce(false);
        await expect(controller.openGroupChat('grp-1', 'grp-chat-2')).resolves.toBe(false);
        expect(groups[0].chat_id).toBe('grp-chat-1');

        confirmChatSwitchGuardMock.mockResolvedValueOnce(true);
        await expect(controller.openGroupChat('grp-1', 'grp-chat-2', { skipSwitchGuard: true })).resolves.toBe(true);
        expect(confirmChatSwitchGuardMock).toHaveBeenLastCalledWith({ skipConfirmation: true });
        expect(groups[0].chat_id).toBe('grp-chat-2');
    });

    test('epoch bump during single/last member Generate and auto-continue aborts before mutating active groupChatQueueOrder', async () => {
        powerUser.show_group_chat_queue = true;
        groups[0].members = ['alice.png'];
        groups.push({
            id: 'grp-2',
            name: 'Second Group',
            chat_id: 'grp2-chat-1',
            chats: ['grp2-chat-1'],
            members: ['alice.png', 'bob.png'],
            disabled_members: [],
            activation_strategy: GROUP_ACTIVATION_STRATEGY.LIST,
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

        const stalePromise = controller.generateGroupWrapper(false, 'normal');
        await new Promise((r) => setTimeout(r, 10));
        expect(GenerateMock).toHaveBeenCalledTimes(1);

        await expect(controller.openGroupById('grp-2')).resolves.toBe(true);
        isGroupGenerating = false;
        const freshPromise = controller.generateGroupWrapper(false, 'normal');
        await new Promise((r) => setTimeout(r, 10));
        expect(GenerateMock).toHaveBeenCalledTimes(2);

        const freshQueueRef = groupChatQueueOrder;
        expect(freshQueueRef.get('alice.png')).toBe(1);
        expect(freshQueueRef.get('bob.png')).toBe(2);

        staleGate.resolve();
        await expect(stalePromise).rejects.toThrow('AbortSignal was fired. Group generation stopped');
        expect(freshQueueRef.get('alice.png')).toBe(1);
        expect(freshQueueRef.get('bob.png')).toBe(2);

        freshGate.resolve();
        const freshResult = await freshPromise;
        expect(String(freshResult)).toBe('fresh bob');
        expect(GenerateMock).toHaveBeenCalledTimes(3);

        const continueGate = deferred();
        shouldAutoContinueMock.mockReturnValueOnce(true);
        GenerateMock
            .mockImplementationOnce(async () => Object.assign(new String('part1'), { messageChunk: 'part1' }))
            .mockImplementationOnce(async () => {
                await continueGate.promise;
                return Object.assign(new String('part2'), { messageChunk: 'part2' });
            });

        const continuePromise = controller.generateGroupWrapper(false, 'normal');
        await new Promise((r) => setTimeout(r, 10));
        const activeQueue = groupChatQueueOrder;
        epoch += 1;
        continueGate.resolve();
        await expect(continuePromise).rejects.toThrow('AbortSignal was fired. Group generation stopped');
        expect(activeQueue.has('alice.png')).toBe(true);
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
            const promise = controller.generateGroupWrapper(false, 'normal');
            await new Promise((r) => setTimeout(r, 10));
            expect(sendMessageAsUserMock).toHaveBeenCalledTimes(1);

            epoch += 1;
            sendGate.resolve();

            await expect(promise).rejects.toThrow('AbortSignal was fired. Group generation stopped');
            expect(saveChatConditionalMock).not.toHaveBeenCalled();
            expect(sendTextareaVal).toBe('unsent draft');
            expect(startedSpy).not.toHaveBeenCalled();
            expect(finishedSpy).not.toHaveBeenCalled();
            expect(isGroupGenerating).toBe(false);
            expect(getActiveActivities()).toEqual([]);
        } finally {
            eventSource.removeListener(EVENT_TYPES.GROUP_WRAPPER_STARTED, startedSpy);
            eventSource.removeListener(EVENT_TYPES.GROUP_WRAPPER_FINISHED, finishedSpy);
        }
    });

    test('onDeleteGroupClick confirms group deletion BEFORE running confirmChatSwitchGuard', async () => {
        popupConfirmMock.mockReset().mockResolvedValueOnce(false);

        await controller.onDeleteGroupClick();
        expect(popupConfirmMock).toHaveBeenCalledTimes(1);
        expect(confirmChatSwitchGuardMock).not.toHaveBeenCalled();
        expect(deleteGroupMock).not.toHaveBeenCalled();

        const order = [];
        popupConfirmMock.mockImplementationOnce(async () => {
            order.push('delete-confirm');
            return true;
        });
        confirmChatSwitchGuardMock.mockImplementationOnce(async () => {
            order.push('switch-guard');
            return false;
        });
        await controller.onDeleteGroupClick();
        expect(order).toEqual(['delete-confirm', 'switch-guard']);
        expect(deleteGroupMock).not.toHaveBeenCalled();
    });
});
