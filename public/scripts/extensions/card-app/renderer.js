/**
 * CardApp Renderer Bridge - connects Luker's message pipeline to CardApp's renderer.
 *
 * Listens to message events and pushes rendered HTML to the CardApp's registered renderer.
 * Uses messageFormatting() directly instead of a hidden container approach,
 * since the formatting pipeline is a pure function.
 */

import { eventSource, event_types, chat, messageFormatting } from '../../../script.js';

const MODULE_NAME = 'card-app/renderer';

/** @type {object|null} Current context reference */
let activeCtx = null;

/** @type {Set<Function>} Registered event handlers for cleanup */
const registeredHandlers = new Map();

/**
 * Build the data object to pass to renderMessage.
 * @param {number} messageId - Message index in chat array
 * @returns {object|null} Render data or null if message doesn't exist
 */
function buildRenderData(messageId) {
    const message = chat[messageId];
    if (!message) return null;

    const html = messageFormatting(
        message.mes,
        message.name,
        message.is_system,
        message.is_user,
        messageId,
        {},
        false,
    );

    return {
        html,
        raw: message.mes,
        isUser: !!message.is_user,
        messageId,
        extra: message.extra || {},
        swipes: {
            count: message.swipes?.length || 1,
            current: message.swipe_id || 0,
        },
        isStreaming: false,
    };
}

/**
 * Push a message to the CardApp renderer.
 * @param {number} messageId
 * @param {boolean} [isStreaming=false]
 */
function pushToRenderer(messageId, isStreaming = false) {
    if (!activeCtx) return;

    const renderer = activeCtx.getRenderer();
    if (!renderer) return;

    const data = buildRenderData(messageId);
    if (!data) return;

    data.isStreaming = isStreaming;

    try {
        renderer.renderMessage(messageId, data);
    } catch (err) {
        console.error(`[${MODULE_NAME}] renderMessage error:`, err);
    }
}

/**
 * Handle CHARACTER_MESSAGE_RENDERED event.
 * Fired when a character message is fully rendered (non-streaming) or after streaming ends.
 * Skipped for type='first_message' — that emit is a post-render notification
 * from getChat() (so op-log / regex listeners process the freshly created
 * first_mes), not a "new message arrived" signal. CardApps must seed history
 * through ctx.getHistory() on init, so forwarding this event would render
 * first_mes a second time.
 * @param {number} messageId
 * @param {string} [type]
 */
function onCharacterMessageRendered(messageId, type) {
    if (type === 'first_message') return;
    pushToRenderer(messageId, false);
}

/**
 * Handle USER_MESSAGE_RENDERED event.
 * Fired when a user message is rendered.
 * @param {number} messageId
 */
function onUserMessageRendered(messageId) {
    pushToRenderer(messageId, false);
}

/**
 * Handle MESSAGE_UPDATED event.
 * Fired when a message is edited or updated by plugins (e.g., SD inserting images).
 * @param {number} messageId
 */
function onMessageUpdated(messageId) {
    pushToRenderer(messageId, false);
}

/**
 * Handle MESSAGE_DELETED event.
 * @param {number} messageCount - New chat length after deletion
 */
function onMessageDeleted(messageCount) {
    if (!activeCtx) return;

    const renderer = activeCtx.getRenderer();
    if (!renderer || typeof renderer.removeMessage !== 'function') return;

    // MESSAGE_DELETED passes the new chat length, not the deleted message ID.
    // The deleted message was at index = messageCount (since array shrunk by 1).
    try {
        renderer.removeMessage(messageCount);
    } catch (err) {
        console.error(`[${MODULE_NAME}] removeMessage error:`, err);
    }
}

/**
 * Handle STREAM_TOKEN_RECEIVED event.
 * Fired on each streaming token. Push updated content to renderer.
 */
function onStreamToken() {
    if (!activeCtx) return;

    // During streaming, the last message in chat is being updated
    const messageId = chat.length - 1;
    if (messageId < 0) return;

    pushToRenderer(messageId, true);
}

/**
 * Handle MESSAGE_SWIPED event.
 * @param {number} messageId
 */
function onMessageSwiped(messageId) {
    pushToRenderer(messageId, false);
}

/**
 * Activate the renderer bridge for a CardApp context.
 * @param {object} ctx - The CardApp context object
 */
export function activateRendererBridge(ctx) {
    if (activeCtx) {
        deactivateRendererBridge();
    }

    activeCtx = ctx;

    // Register event handlers
    const handlers = [
        [event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered],
        [event_types.USER_MESSAGE_RENDERED, onUserMessageRendered],
        [event_types.MESSAGE_UPDATED, onMessageUpdated],
        [event_types.MESSAGE_DELETED, onMessageDeleted],
        [event_types.STREAM_TOKEN_RECEIVED, onStreamToken],
        [event_types.MESSAGE_SWIPED, onMessageSwiped],
    ];

    for (const [event, handler] of handlers) {
        eventSource.on(event, handler);
        registeredHandlers.set(handler, event);
    }

    console.log(`[${MODULE_NAME}] Renderer bridge activated`);
}

/**
 * Deactivate the renderer bridge.
 */
export function deactivateRendererBridge() {
    // Remove all registered event handlers
    for (const [handler, event] of registeredHandlers) {
        eventSource.removeListener(event, handler);
    }
    registeredHandlers.clear();

    activeCtx = null;
    console.log(`[${MODULE_NAME}] Renderer bridge deactivated`);
}
