/**
 * CardApp Context - builds the ctx object passed to CardApp's init() function.
 */

import { eventSource, event_types, chat, chat_metadata, this_chid, characters, getRequestHeaders, openCharacterChat, doNewChat, closeCurrentChat, getPastCharacterChats, deleteMessage as lukerDeleteMessage, deleteLastMessage, swipe_right, saveMetadata, messageFormatting, getChatState as lukerGetChatState, updateChatState as lukerUpdateChatState, patchChatState as lukerPatchChatState, deleteChatState as lukerDeleteChatState, deleteCharacterChatByName, renameChat as lukerRenameChat, setVariable as lukerSetVariable } from '../../../script.js';
import { getContext, extension_settings, getCharacterState as lukerGetCharacterState, setCharacterState as lukerSetCharacterState } from '../../extensions.js';
import { executeSlashCommandsWithOptions } from '../../slash-commands.js';
import { removeReasoningFromString } from '../../reasoning.js';
import { loadWorldInfo, createWorldInfoEntry, deleteWorldInfoEntry, saveWorldInfo, createNewWorldInfo, world_names, selected_world_info, getChatWorldInfoNames, setChatWorldInfoSelection, getCharaAuxWorlds } from '../../world-info.js';
import { getScriptsByType, saveScriptsByType, SCRIPT_TYPES } from '../regex/engine.js';
import { uuidv4, getCharaFilename } from '../../utils.js';
import {
    getCharacterOverrideByAvatar as orchGetCharacterOverrideByAvatar,
    getCharacterIndexByAvatar as orchGetCharacterIndexByAvatar,
    getCharacterExtensionDataByAvatar as orchGetCharacterExtensionDataByAvatar,
    normalizeCharacterOverrideMode as orchNormalizeCharacterOverrideMode,
    applyCharacterExecutionModeForAvatar as orchApplyCharacterExecutionModeForAvatar,
} from '../orchestrator/character-overrides.js';
import { persistOrchestratorCharacterExtension } from '../orchestrator/editor-persist.js';
import {
    getSchemaScopeInfo as mgGetSchemaScopeInfo,
    getAdvancedScopeInfo as mgGetAdvancedScopeInfo,
    persistCharacterSchemaOverride as mgPersistCharacterSchemaOverride,
    removeCharacterSchemaOverride as mgRemoveCharacterSchemaOverride,
    persistCharacterAdvancedOverride as mgPersistCharacterAdvancedOverride,
    removeCharacterAdvancedOverride as mgRemoveCharacterAdvancedOverride,
} from '../memory-graph/character-overrides.js';

/**
 * Map a friendly regex scope label to the engine's SCRIPT_TYPES enum.
 * Card-level lives at character.data.extensions.regex_scripts; global at
 * extension_settings.regex. Throws on unknown scope rather than silently
 * defaulting — callers should be explicit about which storage they touch.
 * @param {'character'|'global'} scope
 * @returns {number}
 */
function regexScopeToScriptType(scope) {
    if (scope === 'character') return SCRIPT_TYPES.SCOPED;
    if (scope === 'global') return SCRIPT_TYPES.GLOBAL;
    throw new Error(`[CardApp] Unknown regex scope "${scope}" — use 'character' or 'global'`);
}

/**
 * Build the context object for a CardApp.
 * @param {HTMLElement} container - The CardApp container element
 * @param {string} charId - Character ID
 * @param {object} config - The card_app config from character data
 * @returns {object} The context object
 */
export function buildContext(container, charId, config) {
    // Tracked resources for automatic cleanup
    const intervals = [];
    const timeouts = [];
    const eventListeners = [];
    const disposeCallbacks = [];

    // Renderer registered by the CardApp
    let renderer = null;

    const ctx = {
        /** @type {HTMLElement} The CardApp container element */
        container,

        /** @type {string} The character ID */
        charId,

        /** @type {import('../../extensions.js').SillyTavernContext} Luker event bus (direct reference) */
        eventSource,

        /**
         * Escape hatch: the full Luker/SillyTavern extension API (same object every other
         * extension gets via getContext()). Use this when ctx doesn't expose what you need.
         * Re-evaluated on each access so it always reflects current state.
         *
         * Examples: ctx.lukerContext.generate(), ctx.lukerContext.SlashCommandParser,
         * ctx.lukerContext.eventTypes, ctx.lukerContext.callGenericPopup, ...
         *
         * Prefer ctx.* methods when one exists - they handle lifecycle/cleanup correctly.
         */
        get lukerContext() { return getContext(); },

        // ==================== Renderer ====================

        /**
         * Register a renderer for message display.
         * @param {{renderMessage: Function, removeMessage: Function}} rendererObj
         */
        registerRenderer(rendererObj) {
            if (!rendererObj || typeof rendererObj.renderMessage !== 'function') {
                throw new Error('[CardApp] registerRenderer requires an object with renderMessage function');
            }
            renderer = rendererObj;
        },

        /**
         * Get the registered renderer (used internally by the bridge).
         * @returns {{renderMessage: Function, removeMessage: Function}|null}
         */
        getRenderer() {
            return renderer;
        },

        // ==================== Messages ====================

        /**
         * Send a message through Luker's message pipeline.
         * @param {string} text - Message text
         * @param {object} [options] - Options
         * @param {boolean} [options.silent=false] - If true, don't save to chat history
         * @returns {Promise<void>}
         */
        async sendMessage(text, options = {}) {
            if (options.silent) {
                // TODO: implement silent mode (send to LLM without saving to chat)
                console.warn('[CardApp] Silent mode not yet implemented, sending normally');
            }
            // Write text to the hidden send_textarea and trigger the send flow
            const textarea = document.getElementById('send_textarea');
            if (textarea) {
                textarea.value = text;
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
            }
            const { sendTextareaMessage } = await import('../../../script.js');
            await sendTextareaMessage();
        },

        /**
         * Get chat history.
         * @param {number} [limit] - Maximum number of messages to return
         * @param {number} [offset=0] - Offset from the end
         * @returns {Array} Chat messages
         */
        getHistory(limit, offset = 0) {
            const messages = chat || [];
            if (limit) {
                const start = Math.max(0, messages.length - offset - limit);
                const end = messages.length - offset;
                return messages.slice(start, end);
            }
            return [...messages];
        },

        /**
         * Edit a message.
         * @param {number} messageId - Message index
         * @param {string} newText - New message text
         * @returns {Promise<void>}
         */
        async editMessage(messageId, newText) {
            const context = getContext();
            if (messageId >= 0 && messageId < chat.length) {
                chat[messageId].mes = newText;
                await context.saveChat();
            }
        },

        /**
         * Delete a message.
         * @param {number} messageId - Message index
         * @returns {Promise<void>}
         */
        async deleteMessage(messageId) {
            if (messageId >= 0 && messageId < chat.length) {
                await lukerDeleteMessage(messageId);
            }
        },

        /**
         * Delete the last message in the chat.
         * @returns {Promise<void>}
         */
        async deleteLastMessage() {
            await deleteLastMessage();
        },

        /**
         * Trigger a swipe (regenerate last message).
         * @returns {Promise<void>}
         */
        async swipe() {
            await swipe_right();
        },

        /**
         * Regenerate the last AI message (delete and re-generate).
         * @returns {Promise<void>}
         */
        async regenerate() {
            const { Generate } = await import('../../../script.js');
            await Generate('regenerate');
        },

        /**
         * Stop the current generation.
         */
        stopGeneration() {
            const context = getContext();
            if (typeof context.abortController?.abort === 'function') {
                context.abortController.abort();
            }
        },

        /**
         * Continue generation (append to last message).
         * @returns {Promise<void>}
         */
        async continueGeneration() {
            const { Generate } = await import('../../../script.js');
            await Generate('continue');
        },

        // ==================== Data ====================

        /**
         * Get current character data.
         * @returns {object|null}
         */
        getCharacterData() {
            const context = getContext();
            if (context.characterId === undefined || context.characterId === null) return null;
            return context.characters[context.characterId] || null;
        },

        /**
         * Update character fields and save. Follows the same path as the popup editor:
         * write to DOM form elements → trigger debounced save.
         *
         * Supported keys: name, description, personality, scenario, first_mes,
         * mes_example, system_prompt, post_history_instructions, creator_notes,
         * creator, character_version, tags (comma-separated string),
         * talkativeness (number), depth_prompt_prompt, depth_prompt_depth, depth_prompt_role
         *
         * @param {Object} fields - Key-value pairs of fields to update
         * @returns {Promise<void>}
         * @throws {Error} If no active character
         */
        async updateCharacterFields(fields) {
            if (this_chid === undefined || this_chid === null) {
                throw new Error('[CardApp] No active character to update');
            }

            // Tool field name → character.data dot-path. Same shape as the
            // Studio `character_update_fields` tool: top-level fields use
            // bare names; nested fields use dotted notation. `tags` is
            // exposed as a comma-string for caller convenience but stored
            // as an array in data.
            const FIELD_TO_PATH = {
                name: 'name',
                description: 'description',
                personality: 'personality',
                scenario: 'scenario',
                first_mes: 'first_mes',
                mes_example: 'mes_example',
                system_prompt: 'system_prompt',
                post_history_instructions: 'post_history_instructions',
                creator_notes: 'creator_notes',
                creator: 'creator',
                character_version: 'character_version',
                talkativeness: 'extensions.talkativeness',
                depth_prompt_prompt: 'extensions.depth_prompt.prompt',
                depth_prompt_depth: 'extensions.depth_prompt.depth',
                depth_prompt_role: 'extensions.depth_prompt.role',
            };

            const patch = {};
            for (const [key, value] of Object.entries(fields)) {
                if (key === 'tags') {
                    patch.tags = typeof value === 'string'
                        ? value.split(',').map(x => x.trim()).filter(Boolean)
                        : (Array.isArray(value) ? value : []);
                    continue;
                }
                const path = FIELD_TO_PATH[key];
                if (!path) {
                    console.warn(`[CardApp] updateCharacterFields: unknown field "${key}", skipping`);
                    continue;
                }
                patch[path] = value;
            }

            if (Object.keys(patch).length > 0) {
                await getContext().updateCharacterData(this_chid, patch);
            }
        },

        /**
         * Get a chat variable.
         * @param {string} key
         * @returns {*}
         */
        getVariable(key) {
            return chat_metadata?.variables?.[key];
        },

        /**
         * Set a chat variable, optionally binding the write to a specific floor.
         *
         * Without `options.floor`: writes to `chat_metadata.variables[key]` —
         * the same bucket `{{getvar::key}}` reads. Chat-scoped, sticks until
         * something else overwrites it.
         *
         * With `options.floor`: appends a synthetic `setvar` op to that
         * floor's `extra.var_ops`, mirrored to its current swipe. swipe-out /
         * swipe-back / delete / branch all reconcile through the
         * variable-op-log rebuilder, so the value rolls back the same way an
         * AI-written `{{setvar}}` literal would. The value is coerced to a
         * string because var_ops only carry strings (which is what
         * `{{getvar}}` returns).
         *
         * For per-floor structured state with its own commit log / namespace,
         * use `ctx.lukerContext.createFloorState({ namespace })` instead.
         *
         * @param {string} key
         * @param {*} value
         * @param {{floor?: number}} [options]
         * @returns {Promise<*>} the value written
         */
        async setVariable(key, value, options = {}) {
            return await lukerSetVariable(key, value, options);
        },

        /**
         * Read chat-bound sidecar state for a namespace. Same data the rest
         * of Luker reads via `getContext().getChatState` — chat-state is
         * persisted server-side under `/api/chats/state/`, NOT in
         * `chat_metadata`. Use `updateChatState` / `patchChatState` to write.
         *
         * For per-chat scalar state (HP, gold, affinity, inventory, quest
         * flags) prefer `setVariable` instead — chat variables are the right
         * surface for AI-mutable scalars and are exposed to macros via
         * `{{getvar::name}}`. Reach for chat-state when you need a
         * structured namespace not driven by macros (e.g. CardApp UI panels
         * that own their own settled object).
         *
         * @param {string} namespace
         * @param {object} [options] Optional `target` for cross-chat reads
         *   (e.g. branching scenarios). See script.js#getChatState.
         * @returns {Promise<object|null>}
         */
        async getChatState(namespace, options = {}) {
            return await lukerGetChatState(namespace, options);
        },

        /**
         * Update chat-bound sidecar state via reducer. The reducer receives
         * the current namespace value and returns the next one; the diff is
         * computed and patched server-side.
         *
         * @param {string} namespace
         * @param {(current: object, meta?: { attempt: number, target: object, namespace: string }) => (object|null|undefined|Promise<object|null|undefined>)} updater
         *   Return `null`/`undefined` from the reducer to leave state
         *   unchanged.
         * @param {object} [options] Optional `target` / `maxOperations` /
         *   `maxRetries`. See script.js#updateChatState.
         * @returns {Promise<{ ok: boolean, state: object|null, updated: boolean }>}
         */
        async updateChatState(namespace, updater, options = {}) {
            return await lukerUpdateChatState(namespace, updater, options);
        },

        /**
         * Apply incremental JSON patch operations to chat-bound sidecar
         * state. Use `updateChatState` for the common read-modify-write
         * case — `patchChatState` is here for when you've already computed
         * patch ops yourself.
         *
         * @param {string} namespace
         * @param {object[]} operations JSON-Patch-style ops (with optional
         *   tests; see script.js#patchChatState).
         * @param {object} [options]
         * @returns {Promise<boolean>}
         */
        async patchChatState(namespace, operations, options = {}) {
            return await lukerPatchChatState(namespace, operations, options);
        },

        /**
         * Delete the entire chat-bound sidecar namespace.
         * @param {string} namespace
         * @param {object} [options]
         * @returns {Promise<boolean>}
         */
        async deleteChatState(namespace, options = {}) {
            return await lukerDeleteChatState(namespace, options);
        },

        /**
         * Read character-bound sidecar state for the active character.
         * Avatar is resolved automatically from `this_chid`; CardApp code
         * never has to pass it. Same storage as `getContext().getCharacterState(avatar, ns)`.
         *
         * Character-state survives across every chat with this character —
         * use it for plugin config that should follow the card, not the
         * conversation.
         *
         * @param {string} namespace
         * @returns {Promise<any>}
         */
        async getCharacterState(namespace) {
            const character = characters[this_chid];
            const avatar = String(character?.avatar || '').trim();
            if (!avatar) throw new Error('[CardApp] No active character');
            return await lukerGetCharacterState(avatar, namespace);
        },

        /**
         * Write character-bound sidecar state for the active character.
         * Pass `null` as `data` to delete the namespace.
         * @param {string} namespace
         * @param {any} data
         * @returns {Promise<void>}
         */
        async setCharacterState(namespace, data) {
            const character = characters[this_chid];
            const avatar = String(character?.avatar || '').trim();
            if (!avatar) throw new Error('[CardApp] No active character');
            return await lukerSetCharacterState(avatar, namespace, data);
        },

        // ==================== Chat Management ====================

        /**
         * List all chats for the current character. Returned items are at
         * application-level — backend filesystem terms (`.jsonl`, raw
         * `file_name`) are stripped before they reach CardApp code so the
         * `chatId` value can flow back into `switchChat` / `deleteChat` /
         * `renameChat` without any client-side parsing.
         *
         * @returns {Promise<Array<{chatId: string, preview: string, lastUpdated: number, size: number|string}>>}
         *   `chatId` — stable identifier for this chat (no extension).
         *   `preview` — first message text snippet, suitable for a list cell.
         *   `lastUpdated` — last-modified timestamp from the server.
         *   `size` — formatted file size from the server (string like "12.3 KB").
         */
        async getChatList() {
            const context = getContext();
            if (!context.characterId && context.characterId !== 0) return [];
            const raw = await getPastCharacterChats(context.characterId);
            return (Array.isArray(raw) ? raw : []).map(item => ({
                chatId: String(item?.file_id || String(item?.file_name || '').replace(/\.jsonl$/i, '') || ''),
                preview: String(item?.mes || ''),
                lastUpdated: Number(item?.last_mes ?? 0),
                size: item?.file_size ?? 0,
            }));
        },

        /**
         * Switch to a different chat by id. Accepts both the canonical
         * `chatId` (no extension) returned by `getChatList` and a raw
         * `*.jsonl` filename — the trailing extension is stripped before
         * dispatching, matching the server's expectation.
         * @param {string} chatId
         * @returns {Promise<void>}
         */
        async switchChat(chatId) {
            const id = String(chatId || '').replace(/\.jsonl$/i, '');
            if (!id) return;
            await openCharacterChat(id);
        },

        /**
         * Create a new chat for the current character.
         * @returns {Promise<void>}
         */
        async newChat() {
            await doNewChat();
        },

        /**
         * Close the current chat (return to character list).
         * @returns {Promise<void>}
         */
        async closeChat() {
            await closeCurrentChat();
        },

        /**
         * Delete a past chat by id. Accepts both the canonical `chatId`
         * (no extension) and a raw `*.jsonl` filename. Operates on the
         * currently active character; deletion is permanent.
         * @param {string} chatId
         * @returns {Promise<void>}
         */
        async deleteChat(chatId) {
            const id = String(chatId || '').replace(/\.jsonl$/i, '');
            if (!id) return;
            const context = getContext();
            if (context.characterId === undefined || context.characterId === null) return;
            await deleteCharacterChatByName(String(context.characterId), id);
        },

        /**
         * Rename a past chat. Accepts canonical `chatId` (no extension);
         * `*.jsonl` suffix is tolerated on either argument and stripped.
         * @param {string} oldChatId
         * @param {string} newChatId
         * @returns {Promise<void>}
         */
        async renameChat(oldChatId, newChatId) {
            const oldId = String(oldChatId || '').replace(/\.jsonl$/i, '');
            const newId = String(newChatId || '').replace(/\.jsonl$/i, '');
            if (!oldId || !newId) return;
            await lukerRenameChat(oldId, newId);
        },

        // ==================== Slash Commands ====================

        /**
         * Execute a slash command.
         * @param {string} command - The slash command string (e.g. '/sys Hello')
         * @returns {Promise<*>}
         */
        async executeSlashCommand(command) {
            return await executeSlashCommandsWithOptions(command);
        },

        // ==================== Scoped Utilities ====================

        /**
         * Scoped setInterval - automatically cleared on dispose.
         * @param {Function} fn
         * @param {number} ms
         * @returns {number} Interval ID
         */
        setInterval(fn, ms) {
            const id = window.setInterval(fn, ms);
            intervals.push(id);
            return id;
        },

        /**
         * Scoped setTimeout - automatically cleared on dispose.
         * @param {Function} fn
         * @param {number} ms
         * @returns {number} Timeout ID
         */
        setTimeout(fn, ms) {
            const id = window.setTimeout(fn, ms);
            timeouts.push(id);
            return id;
        },

        /**
         * Scoped addEventListener - automatically removed on dispose.
         * @param {EventTarget} target
         * @param {string} event
         * @param {Function} handler
         * @param {object} [options]
         */
        addEventListener(target, event, handler, options) {
            target.addEventListener(event, handler, options);
            eventListeners.push({ target, event, handler, options });
        },

        // ==================== Lifecycle ====================

        /**
         * Register a callback to run when the CardApp is disposed.
         * @param {Function} fn
         */
        onDispose(fn) {
            if (typeof fn === 'function') {
                disposeCallbacks.push(fn);
            }
        },

        // ==================== World Info ====================

        /**
         * Get world book names visible to this character. By default returns
         * a flat string[] for backward compatibility (character-bound primary
         * book + character-bound auxiliary books + chat-bound books +
         * globally activated books, deduped). Pass `{ withSource: true }` to
         * get structured entries that distinguish `'character'` (the card's
         * primary book), `'character_aux'` (auxiliary books bound to this
         * character via Luker's lorebook editor), `'chat'` (chat-bound books
         * from `chat_metadata.world_info`), and `'global'` (selected world
         * info active for every chat).
         *
         * @param {{ withSource?: boolean }} [options]
         * @returns {string[] | Array<{name: string, source: 'character'|'character_aux'|'chat'|'global'}>}
         */
        getWorldBooks(options = {}) {
            const withSource = !!options?.withSource;
            const entries = [];
            const seen = new Set();
            const push = (name, source) => {
                const trimmed = String(name || '').trim();
                if (!trimmed || seen.has(trimmed)) return;
                seen.add(trimmed);
                entries.push({ name: trimmed, source });
            };
            // Character-bound primary world book
            const charData = characters[this_chid];
            push(charData?.data?.extensions?.world, 'character');
            // Character-bound auxiliary world books (world_info.charLore[].extraBooks)
            for (const name of this.getCharacterAuxWorldBooks()) {
                push(name, 'character_aux');
            }
            // Chat-bound books (chat_metadata.world_info)
            try {
                for (const name of getChatWorldInfoNames(chat_metadata)) {
                    push(name, 'chat');
                }
            } catch { /* extension or chat not ready */ }
            // Globally activated world books
            if (Array.isArray(selected_world_info)) {
                for (const name of selected_world_info) push(name, 'global');
            }
            return withSource ? entries : entries.map((e) => e.name);
        },

        /**
         * Get the list of *auxiliary* world book names bound to the current
         * character. These live alongside the primary book (the one stored at
         * `character.data.extensions.world`) and are managed via Luker's
         * lorebook editor — they participate in prompt assembly the same way
         * the primary book does, so a CardApp that needs to reason about
         * "what lore does this character pull in?" should consider both.
         *
         * Returns `[]` when no character is active, or when the character has
         * no auxiliary books configured.
         * @returns {string[]}
         */
        getCharacterAuxWorldBooks() {
            const fileName = getCharaFilename(this_chid);
            return getCharaAuxWorlds(fileName);
        },

        /**
         * Get the list of world book names bound to the *current chat*
         * (stored in `chat_metadata.world_info`). Distinct from the
         * character-bound book — chat-bound books reset when the user
         * starts a new chat, so they are the right home for per-save
         * lore/state/NPCs that should not bleed across playthroughs.
         * @returns {string[]}
         */
        getChatWorldBooks() {
            try {
                return getChatWorldInfoNames(chat_metadata);
            } catch {
                return [];
            }
        },

        /**
         * Replace the chat-bound world book list. Names that don't match an
         * existing world book are silently dropped (matches Luker's UI
         * behavior). Pass `[]` (or nothing) to clear.
         * @param {string[]} [names]
         * @returns {Promise<string[]>} the resolved list actually written
         */
        async setChatWorldBooks(names = []) {
            const list = Array.isArray(names) ? names : [names];
            const written = setChatWorldInfoSelection(list, chat_metadata);
            await saveMetadata();
            return written;
        },

        /**
         * Add a world book to the chat-bound list (no-op if already there).
         * @param {string} name
         * @returns {Promise<string[]>}
         */
        async addChatWorldBook(name) {
            const target = String(name || '').trim();
            if (!target) return this.getChatWorldBooks();
            const current = this.getChatWorldBooks();
            if (current.includes(target)) return current;
            return await this.setChatWorldBooks([...current, target]);
        },

        /**
         * Remove a world book from the chat-bound list.
         * @param {string} name
         * @returns {Promise<string[]>}
         */
        async removeChatWorldBook(name) {
            const target = String(name || '').trim();
            if (!target) return this.getChatWorldBooks();
            const next = this.getChatWorldBooks().filter((n) => n !== target);
            return await this.setChatWorldBooks(next);
        },

        /**
         * Create a world book and bind it to the current chat. Idempotent: if
         * a book of that name already exists (any scope), skip creation and
         * just bind it — a CardApp that re-inits on the same chat will hit
         * the same name and should land on the same book.
         *
         * `setChatWorldBooks` silently drops names that don't exist on disk
         * yet, so create-then-bind order matters; this convenience exists to
         * make the dynamic-entries pattern hard to get wrong.
         *
         * @param {string} name
         * @returns {Promise<string>} the resolved book name
         */
        async createChatWorldBook(name) {
            const target = String(name || '').trim();
            if (!target) throw new Error('[CardApp] createChatWorldBook: name required');
            if (!world_names.includes(target)) {
                const ok = await createNewWorldInfo(target, { interactive: false });
                if (!ok) throw new Error(`[CardApp] Failed to create world book "${target}"`);
            }
            await this.addChatWorldBook(target);
            return target;
        },

        /**
         * Get all entries from a world book.
         * @param {string} bookName - World book name
         * @returns {Promise<Object|null>} The world info data object with entries, or null
         */
        async getWorldBookEntries(bookName) {
            if (!bookName) return null;
            return await loadWorldInfo(bookName);
        },

        /**
         * Create a new entry in a world book.
         * @param {string} bookName - World book name
         * @param {Object} [fields] - Initial field values (merged onto template)
         * @returns {Promise<Object|null>} The new entry object (with uid), or null on failure
         */
        async createWorldBookEntry(bookName, fields = {}) {
            const data = await loadWorldInfo(bookName);
            if (!data) throw new Error(`[CardApp] World book "${bookName}" not found`);
            const newEntry = createWorldInfoEntry(bookName, data);
            if (!newEntry) throw new Error(`[CardApp] Failed to create entry in "${bookName}"`);
            if (fields && typeof fields === 'object') {
                Object.assign(newEntry, fields);
            }
            await saveWorldInfo(bookName, data, true);
            return newEntry;
        },

        /**
         * Update a world book entry.
         * @param {string} bookName - World book name
         * @param {number} uid - Entry UID
         * @param {Object} patch - Fields to update (shallow merge)
         * @returns {Promise<void>}
         */
        async updateWorldBookEntry(bookName, uid, patch) {
            const data = await loadWorldInfo(bookName);
            if (!data) throw new Error(`[CardApp] World book "${bookName}" not found`);
            const entry = data.entries?.[uid];
            if (!entry) throw new Error(`[CardApp] Entry UID ${uid} not found in "${bookName}"`);
            Object.assign(entry, patch);
            // Prevent uid from being overwritten
            entry.uid = uid;
            await saveWorldInfo(bookName, data, true);
        },

        /**
         * Delete a world book entry.
         * @param {string} bookName - World book name
         * @param {number} uid - Entry UID
         * @returns {Promise<void>}
         */
        async deleteWorldBookEntry(bookName, uid) {
            const data = await loadWorldInfo(bookName);
            if (!data) throw new Error(`[CardApp] World book "${bookName}" not found`);
            await deleteWorldInfoEntry(data, uid, { silent: true });
            await saveWorldInfo(bookName, data, true);
        },

        /**
         * Replace ALL entries in a world book with a fresh set. Destructive:
         * existing entries are wiped and replaced; uids are reassigned by the
         * system, so any references the caller held to old uids become invalid.
         * Top-level book metadata (`name`, `display_index`, etc.) is preserved.
         *
         * Use this for the "regenerate dynamic entries from a variable object"
         * pattern — pass the full target set on each call. Caller-supplied
         * `uid` fields are ignored on purpose (force fresh assignment to keep
         * uid space clean).
         *
         * @param {string} bookName - World book name
         * @param {Array<object>} entries - Partial entry fields (no uid). Any
         *   subset of `newWorldInfoEntryDefinition` keys; missing fields fall
         *   back to template defaults.
         * @returns {Promise<Array<object>>} the entries actually written, with
         *   their newly-assigned uids
         */
        async replaceWorldBookEntries(bookName, entries) {
            const data = await loadWorldInfo(bookName);
            if (!data) throw new Error(`[CardApp] World book "${bookName}" not found`);
            const list = Array.isArray(entries) ? entries : [];
            data.entries = {};
            const created = [];
            for (const partial of list) {
                const newEntry = createWorldInfoEntry(bookName, data);
                if (!newEntry) continue;
                if (partial && typeof partial === 'object') {
                    const { uid: _ignoredUid, ...fields } = partial;
                    Object.assign(newEntry, fields);
                }
                created.push(newEntry);
            }
            await saveWorldInfo(bookName, data, true);
            return created;
        },

        // ==================== Regex Scripts ====================

        /**
         * List regex scripts in the requested scope (read-only across both
         * scopes).
         *
         * - `'character'` reads `character.data.extensions.regex_scripts` for
         *   the active card (card-level scripts that travel with the
         *   character file).
         * - `'global'` reads `extension_settings.regex` (user-level scripts
         *   active for every chat regardless of character). Exposed read-only
         *   so a CardApp can inspect what's already in effect (e.g. avoid
         *   duplicating a rule the user already has globally) — ctx never
         *   *writes* to global state.
         *
         * Returns the raw script records — each one has at least `id`,
         * `scriptName`, `findRegex`, `replaceString`, `placement` (number[]),
         * plus the boolean gating fields (`disabled`, `markdownOnly`,
         * `promptOnly`, `pluginOnly`, `runOnEdit`). Empty array if nothing is
         * stored at that scope.
         *
         * @param {'character'|'global'} [scope='character']
         * @returns {Array<object>}
         */
        getRegexScripts(scope = 'character') {
            const scriptType = regexScopeToScriptType(scope);
            return getScriptsByType(scriptType);
        },

        /**
         * Create a new card-level regex script.
         *
         * Always writes to `character.data.extensions.regex_scripts` (via
         * Luker's `writeExtensionField`) — ctx intentionally has no path to
         * mutate the user's global regex list (`extension_settings.regex`),
         * matching the same character-scoped boundary applied to the
         * orchestrator and memory-graph overrides. To create a global
         * regex script, the user goes through the Regex extension's own UI
         * (or any tool the user explicitly invokes outside CardApp init).
         *
         * Pass any subset of script fields in `fields` — anything omitted
         * falls back to safe defaults.
         *
         * Field defaults:
         * - `id`: auto-generated UUID (any caller-supplied id is ignored)
         * - `scriptName`/`findRegex`/`replaceString`: empty string
         * - `trimStrings`: []
         * - `placement`: [] (script will not fire until at least one
         *   placement is set — see Luker's `regex_placement` enum:
         *   1=USER_INPUT, 2=AI_OUTPUT, 3=SLASH_COMMAND, 5=WORLD_INFO,
         *   6=REASONING)
         * - `disabled`/`markdownOnly`/`promptOnly`/`pluginOnly`/`runOnEdit`: false
         * - `substituteRegex`: 0 (NONE; 1=RAW macro substitution, 2=ESCAPED)
         * - `minDepth`/`maxDepth`: null (no depth gate)
         *
         * @param {object} [fields] - Field overrides merged on top of defaults
         * @returns {Promise<object>} The created script (with assigned id)
         */
        async createRegexScript(fields = {}) {
            const scriptType = SCRIPT_TYPES.SCOPED;
            const current = getScriptsByType(scriptType);
            const { id: _ignoredId, ...userFields } = (fields && typeof fields === 'object') ? fields : {};
            const newScript = {
                scriptName: '',
                findRegex: '',
                replaceString: '',
                trimStrings: [],
                placement: [],
                disabled: false,
                markdownOnly: false,
                promptOnly: false,
                pluginOnly: false,
                runOnEdit: false,
                substituteRegex: 0,
                minDepth: null,
                maxDepth: null,
                ...userFields,
                id: uuidv4(),
            };
            const next = [...current, newScript];
            await saveScriptsByType(next, scriptType);
            return newScript;
        },

        /**
         * Patch an existing card-level regex script by id. The patch is
         * shallow-merged onto the stored record; the id is preserved even
         * if the patch tries to overwrite it. Throws if no script with
         * that id exists on this character. Always character-scoped — see
         * {@link createRegexScript} for why ctx never writes global regex.
         *
         * @param {string} id - Script id (UUID)
         * @param {object} patch - Fields to merge
         * @returns {Promise<object>} The updated script
         */
        async updateRegexScript(id, patch) {
            const scriptType = SCRIPT_TYPES.SCOPED;
            const idStr = String(id || '').trim();
            if (!idStr) throw new Error('[CardApp] updateRegexScript requires a script id');
            const current = getScriptsByType(scriptType);
            const idx = current.findIndex((s) => String(s?.id || '') === idStr);
            if (idx < 0) throw new Error(`[CardApp] Regex script "${idStr}" not found on this character`);
            const updated = { ...current[idx], ...(patch || {}), id: idStr };
            const next = current.slice();
            next[idx] = updated;
            await saveScriptsByType(next, scriptType);
            return updated;
        },

        /**
         * Remove a card-level regex script by id. Throws if no script with
         * that id exists on this character (so typos don't silently
         * no-op). Always character-scoped.
         *
         * @param {string} id
         * @returns {Promise<void>}
         */
        async deleteRegexScript(id) {
            const scriptType = SCRIPT_TYPES.SCOPED;
            const idStr = String(id || '').trim();
            if (!idStr) throw new Error('[CardApp] deleteRegexScript requires a script id');
            const current = getScriptsByType(scriptType);
            const next = current.filter((s) => String(s?.id || '') !== idStr);
            if (next.length === current.length) {
                throw new Error(`[CardApp] Regex script "${idStr}" not found on this character`);
            }
            await saveScriptsByType(next, scriptType);
        },

        // ==================== Orchestrator (per-character override) ====================

        /**
         * Get the orchestrator override stored on the active character card.
         * Returns the raw payload from `character.data.extensions.orchestrator.override`
         * (or `null` if none). Always character-scoped — this never reads the
         * global `extension_settings.orchestrator`.
         *
         * Shape: `{ mode: 'spec'|'agenda'|'loop', enabled, spec?, agenda?, loop?, presets?, name?, notes?, updatedAt }`.
         *
         * @returns {object|null}
         */
        getOrchestratorOverride() {
            const lukerCtx = getContext();
            const charData = characters[this_chid];
            const avatar = String(charData?.avatar || '').trim();
            if (!avatar) return null;
            return orchGetCharacterOverrideByAvatar(lukerCtx, avatar);
        },

        /**
         * Replace the orchestrator override on the active character card.
         * The override is sanitized through `normalizeCharacterOverrideMode`
         * (which pins `mode` based on which sub-payload is present + freshest
         * `updatedAt`) and persisted via the existing character-extension
         * write path. Always character-scoped — global orchestrator settings
         * are never touched.
         *
         * Pass the full override object you want stored. Mode-specific
         * sub-payloads (`spec`, `agenda`, `loop`) should already match the
         * orchestrator's internal schemas; if you're starting from an
         * existing override, fetch it via {@link getOrchestratorOverride}
         * and mutate.
         *
         * @param {object} override - The override payload to persist
         * @returns {Promise<boolean>} true on success
         */
        async setOrchestratorOverride(override) {
            if (!override || typeof override !== 'object') {
                throw new Error('[CardApp] setOrchestratorOverride requires an override object');
            }
            const lukerCtx = getContext();
            const charData = characters[this_chid];
            const avatar = String(charData?.avatar || '').trim();
            if (!avatar) throw new Error('[CardApp] No active character');
            const characterIndex = orchGetCharacterIndexByAvatar(lukerCtx, avatar);
            if (characterIndex < 0) throw new Error('[CardApp] Character not found in context');
            const previous = orchGetCharacterExtensionDataByAvatar(lukerCtx, avatar);
            const nextOverride = orchNormalizeCharacterOverrideMode({ ...override });
            const nextPayload = { ...previous, override: nextOverride };
            const ok = await persistOrchestratorCharacterExtension(lukerCtx, characterIndex, nextPayload);
            if (ok) {
                // The orchestrator dispatcher reads the active mode from
                // extension_settings.orchestrator.executionMode, NOT from the
                // override directly. Without realigning that flag, an override
                // that switches modes (e.g. spec → agenda) is silently ignored
                // by the runtime. This mirrors what the in-app editor does at
                // orchestrator/main.js:6684.
                orchApplyCharacterExecutionModeForAvatar(lukerCtx, extension_settings?.orchestrator, avatar);
            }
            return ok;
        },

        /**
         * Remove the orchestrator override from the active character card,
         * letting it fall back to global orchestrator settings. Always
         * character-scoped.
         * @returns {Promise<boolean>} true on success
         */
        async clearOrchestratorOverride() {
            const lukerCtx = getContext();
            const charData = characters[this_chid];
            const avatar = String(charData?.avatar || '').trim();
            if (!avatar) throw new Error('[CardApp] No active character');
            const characterIndex = orchGetCharacterIndexByAvatar(lukerCtx, avatar);
            if (characterIndex < 0) throw new Error('[CardApp] Character not found in context');
            const previous = orchGetCharacterExtensionDataByAvatar(lukerCtx, avatar);
            const nextPayload = { ...previous };
            delete nextPayload.override;
            // If the override was the only key on extensions.orchestrator,
            // pass null so persistOrchestratorCharacterExtension removes the
            // whole blob server-side instead of leaving an empty {} behind.
            const finalPayload = Object.keys(nextPayload).length === 0 ? null : nextPayload;
            const ok = await persistOrchestratorCharacterExtension(lukerCtx, characterIndex, finalPayload);
            if (ok) {
                // After clearing, also realign the dispatcher mode — without
                // this the runtime keeps using whatever mode the prior
                // override pinned, even though the override is gone.
                orchApplyCharacterExecutionModeForAvatar(lukerCtx, extension_settings?.orchestrator, avatar);
            }
            return ok;
        },

        // ==================== Memory Graph (per-character override) ====================

        /**
         * Get the memory-graph configuration that will be in effect for this
         * character: the node-type schema (with character override applied
         * if present) and the advanced settings (global merged with the
         * character override). The `scope` field on each block reports
         * whether the value originated from a character-bound override
         * (`'character'`) or fell back to the global config (`'global'`).
         *
         * Always character-scoped — this returns the EFFECTIVE config for
         * the active card, never mutates the global memory-graph settings.
         *
         * @returns {{
         *   schema: { scope: 'global'|'character', hasOverride: boolean, schema: any[] },
         *   advanced: { scope: 'global'|'character', hasOverride: boolean, settings: object }
         * }}
         */
        getMemoryGraphSchema() {
            const lukerCtx = getContext();
            const schemaInfo = mgGetSchemaScopeInfo(lukerCtx);
            const advancedInfo = mgGetAdvancedScopeInfo(lukerCtx);
            return {
                schema: {
                    scope: schemaInfo.scope,
                    hasOverride: !!schemaInfo.hasOverride,
                    schema: schemaInfo.schema,
                },
                advanced: {
                    scope: advancedInfo.scope,
                    hasOverride: !!advancedInfo.hasOverride,
                    settings: advancedInfo.settings,
                },
            };
        },

        /**
         * Set or clear the memory-graph node-type schema override on the
         * active character card. Pass `null` to remove the override and
         * fall back to the global schema. The schema is sanitized through
         * memory-graph's `normalizeNodeTypeSchema` before write.
         * Always character-scoped — never touches the global schema.
         *
         * @param {Array|null} schema - Node-type descriptor array, or null to clear
         * @returns {Promise<boolean>}
         */
        async setMemoryGraphSchema(schema) {
            const lukerCtx = getContext();
            const charData = characters[this_chid];
            const avatar = String(charData?.avatar || '').trim();
            if (!avatar) throw new Error('[CardApp] No active character');
            if (schema === null || schema === undefined) {
                return await mgRemoveCharacterSchemaOverride(lukerCtx, avatar);
            }
            return await mgPersistCharacterSchemaOverride(lukerCtx, avatar, schema);
        },

        /**
         * Set or clear the memory-graph advanced-settings override on the
         * active character card. Pass `null` to remove the override and
         * fall back to global advanced settings. The patch is normalized
         * through memory-graph's `normalizeAdvancedSettings` before write.
         * Always character-scoped — never touches the global advanced
         * settings.
         *
         * @param {object|null} advanced - Advanced settings patch, or null to clear
         * @returns {Promise<boolean>}
         */
        async setMemoryGraphAdvanced(advanced) {
            const lukerCtx = getContext();
            const charData = characters[this_chid];
            const avatar = String(charData?.avatar || '').trim();
            if (!avatar) throw new Error('[CardApp] No active character');
            if (advanced === null || advanced === undefined) {
                return await mgRemoveCharacterAdvancedOverride(lukerCtx, avatar);
            }
            return await mgPersistCharacterAdvancedOverride(lukerCtx, avatar, advanced);
        },

        // ==================== Rendering ====================

        /**
         * Render raw text through SillyTavern's formatting pipeline (markdown,
         * macro substitution, sanitization). Returns the html string
         * directly so callers can `el.innerHTML = ctx.renderText(...)`
         * without awaiting. (Previously this was async and returned
         * `{html}` — both forms are kept for backward compatibility: the
         * returned string has an `.html` getter that resolves to itself,
         * so `(await ctx.renderText(x)).html` still works for any old code
         * that expected the previous shape.)
         * @param {string} rawText
         * @param {number} [messageId=-1]
         * @returns {string} html
         */
        renderText(rawText, messageId = -1) {
            // Strip reasoning prefix/suffix (auto-parse mode) so CardApp messages
            // mirror what the main chat shows — otherwise <thought>…</thought>
            // and similar reasoning blocks leak into the rendered body.
            const cleaned = removeReasoningFromString(String(rawText ?? ''));
            const html = messageFormatting(cleaned, '', false, false, messageId, {}, false);
            // Wrap in a String subclass that exposes `.html` and is thenable.
            // The thenable resolves to the html string itself (NOT `{ html }`)
            // so `${await ctx.renderText(...)}` interpolates the html, instead of
            // stringifying a wrapper object as "[object Object]".
            const result = new String(html);
            Object.defineProperty(result, 'html', { value: html, enumerable: false });
            Object.defineProperty(result, 'then', {
                value: (resolve) => resolve(html),
                enumerable: false,
            });
            return result;
        },

        /**
         * Synchronous alias for renderText that returns a plain html string.
         * Use this when you want to avoid the String-wrapper compatibility
         * shim above (e.g. when the `.html` and thenable properties confuse
         * type checkers or downstream consumers).
         * @param {string} rawText
         * @param {number} [messageId=-1]
         * @returns {string} html
         */
        renderTextSync(rawText, messageId = -1) {
            const cleaned = removeReasoningFromString(String(rawText ?? ''));
            return messageFormatting(cleaned, '', false, false, messageId, {}, false);
        },
    };

    /**
     * Dispose all tracked resources.
     * Called internally when the CardApp is deactivated.
     */
    ctx._dispose = function () {
        // Run user-registered dispose callbacks
        for (const fn of disposeCallbacks) {
            try {
                fn();
            } catch (err) {
                console.error('[CardApp] Dispose callback error:', err);
            }
        }

        // Clear all tracked intervals
        for (const id of intervals) {
            window.clearInterval(id);
        }

        // Clear all tracked timeouts
        for (const id of timeouts) {
            window.clearTimeout(id);
        }

        // Remove all tracked event listeners
        for (const { target, event, handler, options } of eventListeners) {
            try {
                target.removeEventListener(event, handler, options);
            } catch (err) {
                console.error('[CardApp] Failed to remove event listener:', err);
            }
        }

        // Clear arrays
        intervals.length = 0;
        timeouts.length = 0;
        eventListeners.length = 0;
        disposeCallbacks.length = 0;
        renderer = null;
    };

    return ctx;
}
