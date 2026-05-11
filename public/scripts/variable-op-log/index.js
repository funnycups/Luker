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
import { mirrorMessageExtraToCurrentSwipe, pushFloorVarOp as pushFloorVarOpPure } from './floor-ops.js';
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
    mirrorMessageExtraToCurrentSwipe(message);
}

/**
 * Programmatically append a synthetic var_op to a specific floor, mirroring
 * what extractor.js does when it parses a literal `{{setvar}}` out of message
 * text. The op is pushed onto `chat[messageId].extra.var_ops`, forward-applied
 * to `chat_metadata.variables`, and mirrored into `swipe_info[swipe_id].extra`
 * so it survives swipe-out/swipe-back.
 *
 * Does NOT persist the chat itself — the caller is expected to follow up
 * with `saveChatConditional()` (or batch multiple ops then save once).
 *
 * The op is bound to the floor's CURRENT swipe by virtue of the swipe-info
 * mirror — switching swipes will replace `message.extra.var_ops` with the
 * other swipe's slot, and the rebuilder will replay accordingly.
 *
 * @param {number} messageId - Floor index into the chat array
 * @param {import('./apply.js').VarOp} op - Op record (op/key/value)
 * @returns {void}
 * @throws if no message exists at that floor, or if `op` lacks a string key
 */
export function pushFloorVarOp(messageId, op) {
    if (!chat_metadata.variables || typeof chat_metadata.variables !== 'object') {
        chat_metadata.variables = {};
    }
    pushFloorVarOpPure(chat, chat_metadata.variables, messageId, op);
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
