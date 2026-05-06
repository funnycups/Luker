/**
 * Unified Messages API module.
 *
 * Provides high-level message operations that execute the full pipeline:
 * memory (chat[]) + DOM + events + persistence.
 *
 * @module messages
 */

import {
    chat,
    chat_metadata,
    addOneMessage,
    updateMessageBlock,
    patchChatMessages,
    appendChatMessages,
    saveChatConditional,
    eventSource,
    event_types,
    chatElement,
    getFirstDisplayedMessageId,
    updateViewMessageIds,
    refreshSwipeButtons,
    deleteSwipe,
    saveChatDebounced,
} from '../script.js';

import { deleteItemizedPromptForMessage } from './itemized-prompts.js';
import { settleMessageDeleted } from './floor-state.js';

/**
 * Adds one or more messages to the chat with full pipeline processing.
 *
 * Pushes messages to `chat[]`, emits lifecycle events, renders DOM elements
 * via `addOneMessage()`, and persists via `appendChatMessages()`.
 *
 * @param {object|object[]} messages - A single message object or an array of message objects to add.
 * @param {object} [options={}] - Options for the operation.
 * @param {boolean} [options.scroll=true] - Whether to scroll to the newly added message(s).
 * @param {boolean} [options.silent=false] - If true, skip emitting events.
 * @returns {Promise<number|number[]>} The index (or array of indices) of the added message(s) in the chat array.
 */
export async function addMessages(messages, options = {}) {
    const { scroll = true, silent = false } = options;
    const isBatch = Array.isArray(messages);
    const messageList = isBatch ? messages : [messages];

    if (messageList.length === 0) {
        return isBatch ? [] : undefined;
    }

    const indices = [];

    for (const message of messageList) {
        chat.push(message);
        const index = chat.length - 1;
        indices.push(index);

        chat_metadata.tainted = true;

        if (!silent) {
            const eventType = message.is_user
                ? event_types.MESSAGE_SENT
                : event_types.MESSAGE_RECEIVED;
            await eventSource.emit(eventType, index);
        }

        addOneMessage(message, { scroll });

        if (!silent) {
            const renderEventType = message.is_user
                ? event_types.USER_MESSAGE_RENDERED
                : event_types.CHARACTER_MESSAGE_RENDERED;
            await eventSource.emit(renderEventType, index);
        }
    }

    // Persist all added messages in one call
    const appended = await appendChatMessages(messageList);
    if (!appended) {
        await saveChatConditional();
    }

    return isBatch ? indices : indices[0];
}

/**
 * Updates one or more messages in the chat with full pipeline processing.
 *
 * Merges patch fields into `chat[index]`, re-renders the DOM via
 * `updateMessageBlock()`, and persists changes via `patchChatMessages()`
 * using RFC 6902 replace operations.
 *
 * @param {object|object[]} updates - A single `{index, patch}` object or an array of them.
 *   Each `patch` is an object of fields to merge into `chat[index]`
 *   (e.g. `{mes: 'new text', extra: {...}}`).
 * @param {object} [options={}] - Options for the operation.
 * @param {boolean} [options.rerender=true] - Whether to re-render the DOM for updated messages.
 * @param {boolean} [options.silent=false] - If true, skip emitting events.
 * @returns {Promise<void>}
 */
export async function updateMessages(updates, options = {}) {
    const { rerender = true, silent = false } = options;
    const isBatch = Array.isArray(updates);
    const updateList = isBatch ? updates : [updates];

    if (updateList.length === 0) {
        return;
    }

    const operations = [];

    for (const { index, patch } of updateList) {
        if (index < 0 || index >= chat.length || !chat[index]) {
            console.warn(`[messages] updateMessages: invalid index ${index}, skipping`);
            continue;
        }

        // Merge patch into the message
        Object.assign(chat[index], patch);

        chat_metadata.tainted = true;

        // Re-render DOM
        if (rerender) {
            updateMessageBlock(index, chat[index]);
        }

        // Build RFC 6902 replace operation
        operations.push({
            op: 'replace',
            path: `/${index}`,
            value: chat[index],
        });
    }

    // Persist all changes in one call
    if (operations.length > 0) {
        const patched = await patchChatMessages(operations);
        if (!patched) {
            saveChatDebounced();
        }
    }
}

/**
 * Deletes one or more messages from the chat with full pipeline processing.
 *
 * Removes messages from `chat[]`, removes DOM elements, updates mesid
 * attributes, emits `MESSAGE_DELETED`, and persists via `patchChatMessages()`
 * using RFC 6902 remove operations.
 *
 * When `options.swipe` is specified, only that specific swipe is deleted
 * from the message (not the whole message). If it is the active swipe,
 * the view switches to an adjacent swipe.
 *
 * For bulk deletes, indices are sorted descending before splicing to
 * avoid index-shifting issues.
 *
 * @param {number|number[]} index - A single message index or an array of indices to delete.
 * @param {object} [options={}] - Options for the operation.
 * @param {number} [options.swipe] - If specified, delete only this swipe index from the message
 *   instead of the entire message.
 * @param {boolean} [options.silent=false] - If true, skip emitting events.
 * @returns {Promise<object|object[]>} The deleted message object(s).
 */
export async function deleteMessages(index, options = {}) {
    const { swipe, silent = false } = options;
    const isBatch = Array.isArray(index);
    const indices = isBatch ? [...index] : [index];

    // Swipe deletion mode: only valid for single index
    if (swipe !== undefined) {
        if (isBatch && indices.length > 1) {
            throw new Error('Swipe deletion is only supported for a single message index');
        }

        const msgIndex = indices[0];
        const message = chat[msgIndex];
        if (!message) {
            throw new Error(`No message at index ${msgIndex}`);
        }

        await deleteSwipe(swipe, msgIndex);
        return isBatch ? [message] : message;
    }

    // Snapshot messages at their original indices before any mutation
    // so we can compute sequence metadata for events after splice
    const snapshotByIndex = new Map();
    for (const idx of indices) {
    if (idx >= 0 && idx < chat.length && chat[idx]) {
    snapshotByIndex.set(idx, chat[idx]);
    }
    }

    // Also snapshot the full chat length for sequence computation
    const originalChatLength = chat.length;
    const originalChat = chat.slice(0); // shallow copy for seq counting

    // Sort descending to avoid index shifting during splice
    indices.sort((a, b) => b - a);

    const deletedMessages = [];
    const operations = [];
    const minId = getFirstDisplayedMessageId();

    for (const idx of indices) {
    if (!snapshotByIndex.has(idx)) {
    console.warn(`[messages] deleteMessages: invalid index ${idx}, skipping`);
    continue;
    }

    deletedMessages.push(snapshotByIndex.get(idx));

    // Remove DOM element
    const messageElement = chatElement.find(`.mes[mesid="${idx}"]`);
    if (messageElement.length > 0) {
    messageElement.remove();
    }

    // Splice from chat array
    chat.splice(idx, 1);

    chat_metadata.tainted = true;

    // Clean up itemized prompts
    deleteItemizedPromptForMessage(idx);

    // Build RFC 6902 remove operation
    operations.push({
    op: 'remove',
    path: `/${idx}`,
    });
    }

    // Update mesid attributes on remaining elements
    if (deletedMessages.length > 0) {
    const smallestIndex = indices[indices.length - 1];
    const startIndex = [0, minId].includes(smallestIndex) ? smallestIndex : null;
    updateViewMessageIds(startIndex);
    }

    // Persist all removals in one call
    if (operations.length > 0) {
    const patched = await patchChatMessages(operations);
    if (!patched) {
    saveChatDebounced();
    }
    }

    refreshSwipeButtons();

    // Emit events with proper sequence metadata
    if (!silent && deletedMessages.length > 0) {
    // Get valid deleted indices in ascending order
    const ascendingIndices = [...snapshotByIndex.keys()].sort((a, b) => a - b);
    const minIdx = ascendingIndices[0];
    const maxIdx = ascendingIndices[ascendingIndices.length - 1];

    let playableSeqBefore = 0;
    let assistantSeqBefore = 0;
    let deletedPlayableCount = 0;
    let deletedAssistantCount = 0;
    const deletedSet = new Set(ascendingIndices);

    for (let i = 0; i <= maxIdx && i < originalChatLength; i++) {
    const msg = originalChat[i];
    if (!msg) continue;
    const isPlayable = !msg.is_system;
    const isAssistant = !msg.is_user && !msg.is_system;

    if (deletedSet.has(i)) {
    if (isPlayable) deletedPlayableCount++;
    if (isAssistant) deletedAssistantCount++;
    } else if (i < minIdx) {
    if (isPlayable) playableSeqBefore++;
    if (isAssistant) assistantSeqBefore++;
    }
    }

    const deletedPlayableSeqFrom = deletedPlayableCount > 0 ? (playableSeqBefore + 1) : null;
    const deletedPlayableSeqTo = deletedPlayableSeqFrom !== null ? (deletedPlayableSeqFrom + deletedPlayableCount - 1) : null;
    const deletedAssistantSeqFrom = deletedAssistantCount > 0 ? (assistantSeqBefore + 1) : null;
    const deletedAssistantSeqTo = deletedAssistantSeqFrom !== null ? (deletedAssistantSeqFrom + deletedAssistantCount - 1) : null;

    await settleMessageDeleted(chat.length);
    await eventSource.emit(event_types.MESSAGE_DELETED, chat.length, {
    kind: 'delete',
    deletedPlayableSeqFrom,
    deletedPlayableSeqTo,
    deletedAssistantSeqFrom,
    deletedAssistantSeqTo,
    });
    }

    // Restore original order (ascending) for the return value
    if (isBatch) {
    deletedMessages.reverse();
    return deletedMessages;
    }

    return deletedMessages[0];
   }

/**
 * Returns a shallow readonly proxy of the message at the given index.
 *
 * The proxy throws an Error on any attempt to set or delete properties,
 * guiding callers to use `updateMessages()` instead.
 *
 * @param {number} index - The index of the message in the chat array.
 * @returns {Readonly<object>|null} A readonly proxy of the message, or null if the index is invalid.
 */
export function getMessage(index) {
    if (index < 0 || index >= chat.length || !chat[index]) {
        return null;
    }

    return new Proxy(chat[index], {
        set() {
            throw new Error('Message is readonly. Use updateMessages() to modify.');
        },
        deleteProperty() {
            throw new Error('Message is readonly. Use updateMessages() to modify.');
        },
    });
}

/**
 * Returns the current number of messages in the chat array.
 *
 * @returns {number} The number of messages.
 */
export function getMessageCount() {
    return chat.length;
}
