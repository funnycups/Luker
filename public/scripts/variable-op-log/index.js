/**
 * @file Variable op-log feature entry point
 *
 * Wires up the extractor / rebuilder to SillyTavern's chat lifecycle.
 *
 * Hookpoints:
 *   • `extractFromActiveMessage()` — invoked from saveReply() right before
 *     each MESSAGE_RECEIVED emit, so listeners see clean text and the
 *     variables cache is up to date.
 *   • CHAT_CHANGED — rebuild against the freshly loaded chat
 *   • MESSAGE_DELETED — rebuild
 *   • MESSAGE_SWIPED — rebuild (ST already moved the right swipe_info.extra
 *     onto message.extra, so var_ops are correct for the active swipe)
 *   • MESSAGE_SWIPE_DELETED — rebuild
 *
 * The user message path is handled by `extractFromUserMessage()`, called
 * from `sendMessageAsUser()` after the message is pushed to chat.
 *
 * The first_mes path also calls `extractMessageById()` before its
 * MESSAGE_RECEIVED emit (mirrored from saveReply) so macros embedded in
 * a character's first message / alternate greeting are honored.
 */

import { eventSource, event_types, chat, chat_metadata, name1, name2 } from '../../script.js';
import { extractFromMessage } from './extractor.js';
import { rebuildVariables } from './rebuilder.js';
import { getLastMessageId } from '../macros.js';
import { getLocalVariable } from '../variables.js';

/**
 * Build a fresh display-resolve env keyed off the current ST runtime state.
 * Called once per macro resolve (so {{time}} etc. are evaluated at scan time).
 *
 * @returns {import('./resolver.js').ResolveEnv}
 */
function buildResolveEnv() {
    return {
        user: name1 ?? '',
        char: name2 ?? '',
        time: () => new Date().toLocaleTimeString(),
        date: () => new Date().toLocaleDateString(),
        random: () => String(Math.random()),
        getvar: (name) => {
            try {
                return String(getLocalVariable(name) ?? '');
            } catch {
                return '';
            }
        },
        // global vars are intentionally not exposed; they are not part of
        // chat-local op semantics. AI authors shouldn't be relying on them
        // being readable from inside an extracted op.
        lastMessage: () => {
            const idx = getLastMessageId();
            return typeof idx === 'number' ? (chat[idx]?.mes ?? '') : '';
        },
        lastUserMessage: () => {
            for (let i = chat.length - 1; i >= 0; i--) {
                if (chat[i]?.is_user) return chat[i]?.mes ?? '';
            }
            return '';
        },
        lastCharMessage: () => {
            for (let i = chat.length - 1; i >= 0; i--) {
                const m = chat[i];
                if (m && !m.is_user && !m.is_system) return m.mes ?? '';
            }
            return '';
        },
    };
}

/**
 * Extract side-effect macros from the message at the given chat index.
 * Mutates `chat[messageId].mes`, pushes ops onto `extra.var_ops`, and
 * forward-applies into `chat_metadata.variables`.
 *
 * Safe to call on user messages, AI messages, and system messages alike;
 * each scan is a no-op when no recognized macros are present.
 *
 * @param {number} messageId
 */
export function extractMessageById(messageId) {
    if (typeof messageId !== 'number') return;
    const message = chat[messageId];
    if (!message || typeof message.mes !== 'string') return;

    if (!chat_metadata.variables || typeof chat_metadata.variables !== 'object') {
        chat_metadata.variables = {};
    }

    extractFromMessage(message, chat_metadata.variables, buildResolveEnv);

    // Mirror back to swipe_info if this swipe has already been recorded.
    syncMesAndExtraToCurrentSwipe(message);
}

/**
 * After mutating `message.mes` and `message.extra.var_ops`, copy the new
 * values back into the matching `swipe_info[swipe_id]` slot so the change
 * survives the next swipe-out. ST's saveReply already does this for full
 * objects but our extraction may run before or after that step depending
 * on the path; doing it again is idempotent.
 *
 * @param {any} message
 */
function syncMesAndExtraToCurrentSwipe(message) {
    if (!message || typeof message.swipe_id !== 'number') return;
    if (!Array.isArray(message.swipes) || !Array.isArray(message.swipe_info)) return;
    if (message.swipe_id < 0 || message.swipe_id >= message.swipe_info.length) return;
    message.swipes[message.swipe_id] = message.mes;
    const slot = message.swipe_info[message.swipe_id];
    if (slot) {
        slot.extra = structuredClone(message.extra ?? {});
    }
}

/**
 * Full rebuild of `chat_metadata.variables` from the current chat's
 * surviving var_ops. Called on structural events.
 */
export function rebuildVariablesFromChat() {
    if (!chat_metadata.variables || typeof chat_metadata.variables !== 'object') {
        chat_metadata.variables = {};
    }
    rebuildVariables(chat, chat_metadata.variables);
}

/**
 * Wire up event listeners. Called once during init.
 */
export function initVariableOpLog() {
    const onStructuralChange = () => rebuildVariablesFromChat();

    eventSource.on(event_types.CHAT_CHANGED, onStructuralChange);
    eventSource.on(event_types.MESSAGE_DELETED, onStructuralChange);
    eventSource.on(event_types.MESSAGE_SWIPED, onStructuralChange);
    eventSource.on(event_types.MESSAGE_SWIPE_DELETED, onStructuralChange);
    eventSource.on(event_types.MESSAGE_EDITED, (mesId) => {
        // Editing a message does NOT re-extract (per design — editing the
        // narrative shouldn't accidentally fire setvar). But ops already
        // recorded for this message remain valid; rebuild keeps the cache
        // honest if a previous swipe's ops are now visible.
        rebuildVariablesFromChat();
    });
}
