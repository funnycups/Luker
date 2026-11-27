// SPDX-License-Identifier: AGPL-3.0-or-later

import { withActivityLease } from '../activity-guard.js';

/**
 * Pure controller for group chat generation leases, abort/epoch fencing,
 * group switching guards, and group deletion confirmation ordering.
 */
export function createGroupGenerationController({
    getOnlineStatus,
    getMenuType,
    getGroups,
    getSelectedGroup,
    setSelectedGroup,
    getOpenGroupId,
    getIsGroupGenerating,
    setIsGroupGenerating,
    setGroupGenerationId,
    getGroupChatQueueOrder,
    setGroupChatQueueOrder,
    getCharacters,
    getChat,
    getPowerUser,
    getEventSource,
    getEventTypes,
    getSystemMessageTypes,
    getGroupActivationStrategy,
    select_group_chats,
    delay,
    sendSystemMessage,
    getChatTransitionEpoch,
    bumpChatTransitionEpoch,
    confirmChatSwitchGuard,
    shouldBlockChatSwitchWhileSaving,
    waitForChatSwitchAvailability,
    stopGeneration,
    unshallowGroupMembers,
    hideSwipeButtons,
    showSwipeButtons,
    setCharacterName,
    setCharacterId,
    setSendButtonState,
    deactivateSendButtons,
    activateSendButtons,
    getBiasStrings,
    sendMessageAsUser,
    saveChatConditional,
    printGroupMembers,
    getCharacterName,
    Generate,
    shouldAutoContinue,
    activateSwipe,
    activateListOrder,
    activateImpersonate,
    activateNaturalOrder,
    activatePooledOrder,
    shuffle,
    resetSelectedGroup,
    clearChat,
    cancelTtsPlay,
    setEditedMessageId,
    updateChatMetadata,
    getGroupChat,
    editGroup,
    deleteGroup,
    captureGroupChatEntryOwnership,
    confirmDialog,
    t,
    getJQuery = () => globalThis.$,
    getToastr = () => globalThis.toastr,
}) {
    async function generateGroupWrapper(byAutoMode, type = null, params = {}) {
        if (getOnlineStatus() === 'no_connection') {
            setIsGroupGenerating(false);
            setSendButtonState(false);
            return Promise.resolve();
        }

        if (getIsGroupGenerating()) {
            return Promise.resolve();
        }

        const selectedGroup = getSelectedGroup();
        if (getMenuType() !== 'group_edit') {
            select_group_chats(selectedGroup, false);
            await delay(1);
        }

        const eventSource = getEventSource();
        const event_types = getEventTypes();
        const system_message_types = getSystemMessageTypes();
        const group_activation_strategy = getGroupActivationStrategy();

        let textResult = '';
        const group = getGroups().find((x) => x.id === selectedGroup);

        if (!group || !Array.isArray(group.members) || !group.members.length) {
            sendSystemMessage(system_message_types.EMPTY, '', { isSmallSys: true });
            return Promise.resolve();
        }

        const groupAbortController = new AbortController();
        const externalSignal = (params?.signal && typeof params.signal === 'object' && 'aborted' in params.signal)
            ? params.signal
            : null;
        const onExternalAbort = () => groupAbortController.abort();
        const groupEpoch = getChatTransitionEpoch();
        const isStaleEpoch = () => getChatTransitionEpoch() !== groupEpoch;

        const onStop = () => {
            eventSource.removeListener(event_types.GENERATION_STOPPED, onStop);
            groupAbortController.abort();
        };

        function throwIfAborted() {
            if (groupAbortController.signal.aborted || externalSignal?.aborted || isStaleEpoch()) {
                throw new Error('AbortSignal was fired. Group generation stopped');
            }
        }

        return await withActivityLease({
            source: 'core:group-generation',
            label: t`Group chat generation`,
            scope: 'chat',
            guardUnload: true,
            guardChatSwitch: true,
            keepAlive: true,
            onCancel: () => {
                const wasAborted = groupAbortController.signal.aborted;
                groupAbortController.abort();
                if (!wasAborted) {
                    stopGeneration();
                }
            },
        }, async () => {
            if (externalSignal) {
                if (externalSignal.aborted) {
                    groupAbortController.abort();
                } else if (typeof externalSignal.addEventListener === 'function') {
                    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
                }
            }
            eventSource.on(event_types.GENERATION_STOPPED, onStop);

            try {
                await unshallowGroupMembers(selectedGroup);
                if (isStaleEpoch()) {
                    return textResult;
                }

                throwIfAborted();
                hideSwipeButtons();
                setIsGroupGenerating(true);
                setCharacterName('');
                setCharacterId(undefined);
                const $ = getJQuery();
                const userInput = String($('#send_textarea').val());

                setGroupGenerationId(Date.now());
                const chat = getChat();
                const lastMessage = chat[chat.length - 1];
                let activationText = '';
                let isUserInput = false;

                if (userInput?.length && !byAutoMode) {
                    isUserInput = true;
                    activationText = userInput;
                } else {
                    if (lastMessage && !lastMessage.is_system) {
                        activationText = lastMessage.mes;
                    }
                }

                const characters = getCharacters();
                const power_user = getPowerUser();
                const activationStrategy = Number(group.activation_strategy ?? group_activation_strategy.NATURAL);
                const enabledMembers = group.members.filter(x => !group.disabled_members.includes(x));
                let activatedMembers = [];

                if (params && typeof params.force_chid == 'number') {
                    activatedMembers = [params.force_chid];
                } else if (type === 'quiet') {
                    activatedMembers = activateSwipe(group.members, { allowSystem: true }).slice(0, 1);

                    if (activatedMembers.length === 0) {
                        activatedMembers = activateListOrder(group.members.slice(0, 1));
                    }
                } else if (type === 'swipe' || type === 'continue') {
                    activatedMembers = activateSwipe(group.members, { allowSystem: false });

                    if (activatedMembers.length === 0) {
                        getToastr()?.warning(t`Deleted group member swiped. To get a reply, add them back to the group.`);
                        throw new Error('Deleted group member swiped');
                    }
                } else if (type === 'impersonate') {
                    activatedMembers = activateImpersonate(group.members);
                } else if (activationStrategy === group_activation_strategy.NATURAL) {
                    activatedMembers = activateNaturalOrder(enabledMembers, activationText, lastMessage, group.allow_self_responses, isUserInput);
                } else if (activationStrategy === group_activation_strategy.LIST) {
                    activatedMembers = activateListOrder(enabledMembers);
                } else if (activationStrategy === group_activation_strategy.POOLED) {
                    activatedMembers = activatePooledOrder(enabledMembers, lastMessage, isUserInput);
                } else if (activationStrategy === group_activation_strategy.MANUAL && !isUserInput) {
                    activatedMembers = shuffle(enabledMembers).slice(0, 1).map(x => characters.findIndex(y => y.avatar === x)).filter(x => x !== -1);
                }

                if (activatedMembers.length === 0) {
                    const bias = getBiasStrings(userInput, type);
                    await sendMessageAsUser(userInput, bias.messageBias);
                    throwIfAborted();
                    await saveChatConditional();
                    throwIfAborted();
                    $('#send_textarea').val('')[0]?.dispatchEvent?.(new Event('input', { bubbles: true }));
                }
                const queueOrder = new Map();
                setGroupChatQueueOrder(queueOrder);

                if (power_user.show_group_chat_queue) {
                    for (let i = 0; i < activatedMembers.length; ++i) {
                        queueOrder.set(characters[activatedMembers[i]].avatar, i + 1);
                    }
                }
                await eventSource.emit(event_types.GROUP_WRAPPER_STARTED, { selected_group: selectedGroup, type });
                throwIfAborted();

                for (const chId of activatedMembers) {
                    throwIfAborted();
                    deactivateSendButtons();
                    setCharacterId(chId);
                    setCharacterName(getCharacterName(characters[chId]));
                    if (power_user.show_group_chat_queue) {
                        printGroupMembers();
                    }
                    await eventSource.emit(event_types.GROUP_MEMBER_DRAFTED, chId);
                    throwIfAborted();

                    const generateType = ['swipe', 'impersonate', 'quiet', 'continue'].includes(type) ? type : 'normal';
                    textResult = await Generate(generateType, { automatic_trigger: byAutoMode, ...(params || {}), signal: groupAbortController.signal });
                    throwIfAborted();
                    let messageChunk = textResult?.messageChunk;

                    if (messageChunk) {
                        while (shouldAutoContinue(messageChunk, type === 'impersonate')) {
                            throwIfAborted();
                            textResult = await Generate('continue', { automatic_trigger: byAutoMode, ...(params || {}), signal: groupAbortController.signal });
                            throwIfAborted();
                            messageChunk = textResult?.messageChunk;
                        }
                    }
                    if (power_user.show_group_chat_queue) {
                        const liveQueue = getGroupChatQueueOrder();
                        liveQueue.delete(characters[chId].avatar);
                        liveQueue.forEach((value, key, map) => map.set(key, value - 1));
                    }
                }
                return textResult;
            } finally {
                eventSource.removeListener(event_types.GENERATION_STOPPED, onStop);
                if (externalSignal && typeof externalSignal.removeEventListener === 'function') {
                    externalSignal.removeEventListener('abort', onExternalAbort);
                }
                setIsGroupGenerating(false);
                if (!isStaleEpoch()) {
                    setSendButtonState(false);
                    setCharacterId(undefined);
                    if (getPowerUser().show_group_chat_queue) {
                        setGroupChatQueueOrder(new Map());
                        printGroupMembers();
                    }
                    setCharacterName('');
                    activateSendButtons();
                    showSwipeButtons();
                    await eventSource.emit(event_types.GROUP_WRAPPER_FINISHED, { selected_group: getSelectedGroup(), type });
                }
            }
        });
    }

    async function openGroupById(groupId, { skipSwitchGuard = false } = {}) {
        if (!getGroups().find(x => x.id === groupId)) {
            console.log('Group not found', groupId);
            return false;
        }

        if (shouldBlockChatSwitchWhileSaving()) {
            getToastr()?.info(t`Please wait until the chat is saved before switching characters.`, t`Your chat is still saving...`);
            return false;
        }

        if (getSelectedGroup() !== groupId) {
            if (!await confirmChatSwitchGuard({ skipConfirmation: skipSwitchGuard })) {
                return false;
            }
        }

        select_group_chats(groupId, false);

        if (getSelectedGroup() !== groupId) {
            bumpChatTransitionEpoch();
            setGroupChatQueueOrder(new Map());
            setCharacterId(undefined);
            setCharacterName('');
            resetSelectedGroup();
            await clearChat({ clearData: true });
            cancelTtsPlay();
            setSelectedGroup(groupId);
            setEditedMessageId(undefined);
            updateChatMetadata({}, true);
            await getGroupChat(groupId);
            return true;
        }

        return true;
    }

    async function openGroupChat(groupId, chatId, { skipSwitchGuard = false } = {}) {
        const group = getGroups().find(x => x.id === groupId);

        if (!group || !group.chats.includes(chatId)) {
            return false;
        }
        const ownsChat = captureGroupChatEntryOwnership(groupId);
        if (!ownsChat) return false;
        if (!await confirmChatSwitchGuard({ skipConfirmation: skipSwitchGuard }) || !ownsChat()) {
            return false;
        }
        if (!await waitForChatSwitchAvailability() || !ownsChat()) {
            return false;
        }

        bumpChatTransitionEpoch();
        await clearChat({ clearData: true, isCurrent: ownsChat });
        if (!ownsChat()) return false;
        const currentGroup = getGroups().find(x => x.id === groupId);
        currentGroup.chat_id = chatId;
        currentGroup.date_last_chat = Date.now();
        updateChatMetadata({}, true);

        await editGroup(groupId, true, false);
        if (!ownsChat(chatId)) return false;
        await getGroupChat(groupId);
        return true;
    }

    async function onDeleteGroupClick() {
        const openGroupId = getOpenGroupId();
        if (!openGroupId) {
            getToastr()?.warning(t`Currently no group selected.`);
            return;
        }

        const confirm = await confirmDialog(
            t`Delete the group?`,
            '<p>' + t`This will also delete all your chats with that group. If you want to delete a single conversation, select a "View past chats" option in the lower left menu.` + '</p>',
        );
        if (!confirm) {
            return;
        }

        if (getSelectedGroup() === openGroupId) {
            if (!await confirmChatSwitchGuard()) {
                return;
            }
        }

        deleteGroup(openGroupId);
    }

    return {
        generateGroupWrapper,
        openGroupById,
        openGroupChat,
        onDeleteGroupClick,
    };
}
