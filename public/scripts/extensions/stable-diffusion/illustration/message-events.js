/**
 * Tell the rest of the app that a message body changed, matching the events
 * emitted after a manual edit so renderers and other listeners refresh.
 * @param {object} context Extension context with eventSource and eventTypes.
 * @param {number} messageId Edited message index.
 */
export async function emitMessageChanged(context, messageId) {
    await context.eventSource.emit(context.eventTypes.MESSAGE_EDITED, messageId, null);
    await context.eventSource.emit(context.eventTypes.MESSAGE_UPDATED, messageId);
}
