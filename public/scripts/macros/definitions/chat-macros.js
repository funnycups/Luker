import { MacroRegistry as activeMacroRegistry, MacroCategory, MacroValueType } from '../engine/MacroRegistry.js';
import { chat, chat_metadata } from '../../../script.js';

/**
 * Registers macros that inspect the current chat log and swipe state
 * (message texts, indices, swipes, and context boundaries).
 */
function chatFor(env) {
    return env.contextSnapshot ? env.contextSnapshot.chat : chat;
}

export function registerChatMacros(MacroRegistry = activeMacroRegistry) {
    MacroRegistry.registerMacro('lastMessage', {
        category: MacroCategory.CHAT,
        description: 'Last message in the chat.',
        returns: 'Last message in the chat.',
        handler: ({ env }) => String(getLastMessage(chatFor(env)) ?? ''),
    });

    MacroRegistry.registerMacro('lastMessageId', {
        category: MacroCategory.CHAT,
        description: 'Index of the last message in the chat.',
        returns: 'Index of the last message in the chat.',
        returnType: MacroValueType.INTEGER,
        handler: ({ env }) => String(getLastMessageId({ chatData: chatFor(env) }) ?? ''),
    });

    MacroRegistry.registerMacro('lastUserMessage', {
        category: MacroCategory.CHAT,
        description: 'Last user message in the chat.',
        returns: 'Last user message in the chat.',
        handler: ({ env }) => String(getLastUserMessage(chatFor(env)) ?? ''),
    });

    MacroRegistry.registerMacro('lastCharMessage', {
        category: MacroCategory.CHAT,
        description: 'Last character/bot message in the chat.',
        returns: 'Last character/bot message in the chat.',
        handler: ({ env }) => String(getLastCharMessage(chatFor(env)) ?? ''),
    });

    MacroRegistry.registerMacro('firstIncludedMessageId', {
        category: MacroCategory.CHAT,
        description: 'Index of the first message included in the current context.',
        returns: 'Index of the first message included in the context.',
        returnType: MacroValueType.INTEGER,
        handler: ({ env }) => String(getFirstIncludedMessageId(
            env.contextSnapshot ? env.contextSnapshot.chatMetadata : chat_metadata,
        ) ?? ''),
    });

    MacroRegistry.registerMacro('firstDisplayedMessageId', {
        category: MacroCategory.CHAT,
        description: 'Index of the first displayed message in the chat.',
        returns: 'Index of the first displayed message in the chat.',
        returnType: MacroValueType.INTEGER,
        handler: ({ env }) => String((env.contextSnapshot
            ? env.contextSnapshot.firstDisplayedMessageId
            : getFirstDisplayedMessageId()) ?? ''),
    });

    MacroRegistry.registerMacro('lastSwipeId', {
        category: MacroCategory.CHAT,
        description: '1-based index of the last swipe for the last message.',
        returns: '1-based index of the last swipe.',
        returnType: MacroValueType.INTEGER,
        handler: ({ env }) => String(getLastSwipeId(chatFor(env)) ?? ''),
    });

    MacroRegistry.registerMacro('currentSwipeId', {
        category: MacroCategory.CHAT,
        description: '1-based index of the current swipe.',
        returns: '1-based index of the current swipe.',
        returnType: MacroValueType.INTEGER,
        handler: ({ env }) => String(getCurrentSwipeId(chatFor(env)) ?? ''),
    });

    MacroRegistry.registerMacro('allChatRange', {
        category: MacroCategory.CHAT,
        description: 'Range of all message IDs in the chat (e.g. "0-10"). Empty string if the chat is empty.',
        returns: 'Range string from 0 to last message ID, or empty string.',
        handler: ({ env }) => {
            const chatData = chatFor(env);
            if (!Array.isArray(chatData) || chatData.length === 0) {
                return '';
            }
            return `0-${chatData.length - 1}`;
        },
    });
}

function getLastMessageId({ chatData = chat, exclude_swipe_in_propress = true, filter = null } = {}) {
    if (!Array.isArray(chatData) || chatData.length === 0) {
        return null;
    }

    for (let i = chatData.length - 1; i >= 0; i--) {
        const message = chatData[i];

        if (exclude_swipe_in_propress && message.swipes && message.swipe_id >= message.swipes.length) {
            continue;
        }

        if (!filter || filter(message)) {
            return i;
        }
    }

    return null;
}

function getLastMessage(chatData = chat) {
    const mid = getLastMessageId({ chatData });
    return typeof mid === 'number' ? (chatData[mid]?.mes ?? '') : '';
}

function getLastUserMessage(chatData = chat) {
    const mid = getLastMessageId({ chatData, filter: m => m.is_user && !m.is_system });
    return typeof mid === 'number' ? (chatData[mid]?.mes ?? '') : '';
}

function getLastCharMessage(chatData = chat) {
    const mid = getLastMessageId({ chatData, filter: m => !m.is_user && !m.is_system });
    return typeof mid === 'number' ? (chatData[mid]?.mes ?? '') : '';
}

function getFirstIncludedMessageId(metadata = chat_metadata) {
    const value = metadata.lastInContextMessageId;
    return typeof value === 'number' ? value : null;
}

function getFirstDisplayedMessageId() {
    const mesElement = document.querySelector('#chat .mes');
    const mesId = Number(mesElement?.getAttribute('mesid'));
    if (!Number.isNaN(mesId) && mesId >= 0) {
        return mesId;
    }
    return null;
}

function getLastSwipeId(chatData = chat) {
    const mid = getLastMessageId({ chatData, exclude_swipe_in_propress: false });
    if (typeof mid !== 'number') {
        return null;
    }
    const swipes = chatData[mid]?.swipes;
    return Array.isArray(swipes) ? swipes.length : null;
}

function getCurrentSwipeId(chatData = chat) {
    const mid = getLastMessageId({ chatData, exclude_swipe_in_propress: false });
    if (typeof mid !== 'number') {
        return null;
    }
    const swipeId = chatData[mid]?.swipe_id;
    return typeof swipeId === 'number' ? swipeId + 1 : null;
}
