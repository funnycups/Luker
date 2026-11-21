// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Regression coverage: the shared `__SEARCH_TOOLS__` lorebook is only a
 * projection of the stored managed-entry set, so a structural chat change
 * that drops the owning turn's commit (delete / swipe of that turn) has to
 * re-project it. floor-state settles its commit log before core emits the
 * structural event, so the projection listener always reads the state the
 * chat has rolled back to.
 *
 * Editing a message is deliberately NOT a data change: the stored set is
 * never invalidated by text edits, and reuse of a previous run is decided in
 * memory by comparing the owning turn's text hash.
 *
 * The chat-state + event-source harness mirrors
 * `tests/search-tools/entries-store.test.js`.
 */

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';

import { createFloorStateWithDeps } from '../../public/scripts/floor-state.js';
import {
    commitManagedEntries,
    resetFloorStateInstanceForTesting,
} from '../../public/scripts/extensions/search-tools/persistence.js';

// main.js transitively imports browser-only modules that touch `document` at
// load time. Stub those edges so the module graph loads under node.
jest.unstable_mockModule('../../public/scripts/extensions/connection-manager/profile-resolver.js', () => ({
    getChatCompletionConnectionProfiles: async () => [],
}));

const event_types = {
    CHAT_CHANGED: 'chat_id_changed',
    MESSAGE_SWIPED: 'message_swiped',
    MESSAGE_DELETED: 'message_deleted',
    MESSAGE_SWIPE_DELETED: 'message_swipe_deleted',
    MESSAGE_EDITED: 'message_edited',
};

function makeStore() {
    const partitions = new Map();
    function targetKey(target) {
        if (!target || typeof target !== 'object') return '';
        if (target.is_group) return `g:${String(target.id ?? '')}`;
        return `c:${String(target.avatar_url ?? '')}/${String(target.file_name ?? '')}`;
    }
    function partitionFor(target) {
        const key = targetKey(target);
        if (!partitions.has(key)) partitions.set(key, new Map());
        return partitions.get(key);
    }
    return {
        async getChatState(ns, options) {
            const k = String(ns ?? '').trim().toLowerCase();
            const part = partitionFor(options?.target);
            const v = part.get(k);
            return { ok: true, state: v == null ? null : structuredClone(v) };
        },
        async patchChatState(ns, ops, options) {
            const k = String(ns ?? '').trim().toLowerCase();
            const part = partitionFor(options?.target);
            const current = part.get(k) ?? {};
            const { applyPatch } = await import('../../public/scripts/util/fast-json-patch.js');
            const next = structuredClone(current);
            applyPatch(next, ops, false, true);
            part.set(k, next);
            return true;
        },
        async updateChatState(ns, updater, options) {
            const k = String(ns ?? '').trim().toLowerCase();
            const part = partitionFor(options?.target);
            const current = part.get(k) ?? null;
            const next = await updater(current == null ? null : structuredClone(current));
            if (next === null || next === undefined) {
                part.delete(k);
            } else {
                part.set(k, structuredClone(next));
            }
            return { ok: true, state: part.get(k) ?? null, updated: true };
        },
        _clear() { partitions.clear(); },
        get _raw() { return partitionFor(undefined); },
    };
}

function makeEventSource() {
    const listeners = new Map();
    const boundInstances = new Set();
    return {
        on(name, fn) {
            if (!listeners.has(name)) listeners.set(name, new Set());
            listeners.get(name).add(fn);
        },
        removeListener(name, fn) {
            listeners.get(name)?.delete(fn);
        },
        async emit(name, ...args) {
            for (const inst of boundInstances) {
                switch (name) {
                    case event_types.MESSAGE_DELETED:
                        await inst.__handleMessageDeleted(args[0]);
                        break;
                    case event_types.MESSAGE_SWIPED:
                        await inst.__handleMessageSwiped();
                        break;
                    case event_types.MESSAGE_SWIPE_DELETED:
                        await inst.__handleSwipeDeleted(args[0]);
                        break;
                    case event_types.CHAT_CHANGED:
                        await inst.__handleChatChanged();
                        break;
                }
            }
            const set = listeners.get(name);
            if (!set) return;
            for (const fn of Array.from(set)) {
                await fn(...args);
            }
        },
        _bindInstance(inst) { boundInstances.add(inst); },
        _unbindInstance(inst) { boundInstances.delete(inst); },
    };
}

async function buildObjectPatchOperationsAsync(prev, next) {
    const { compare } = await import('../../public/scripts/util/fast-json-patch.js');
    return compare(prev ?? {}, next ?? {});
}

function makeMainContext(chatRef) {
    const store = makeStore();
    const eventSource = makeEventSource();
    const books = {};
    const fsDeps = {
        getChatState: store.getChatState.bind(store),
        patchChatState: store.patchChatState.bind(store),
        updateChatState: store.updateChatState.bind(store),
        buildObjectPatchOperationsAsync,
        eventSource,
        event_types,
        getChat: () => chatRef.value,
    };
    const context = {
        eventSource,
        eventTypes: event_types,
        constants: { promptRoles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 }, wiPosition: {} },
        getRequestHeaders: () => ({}),
        saveSettings: () => {},
        saveSettingsDebounced: () => {},
        extensionSettings: { search_tools: { enabled: true, preRequestEnabled: false } },
        stateErrors: globalThis.Luker?.getContext?.()?.stateErrors,
        secrets: { KEYS: {}, state: {} },
        escapeHtml: (s) => String(s ?? ''),
        getStringHash: (s) => String(s).length,
        worldInfoEntry: { template: {}, setGlobalSelection: async () => false },
        POPUP_TYPE: {},
        Popup: class {},
        translate: (s) => String(s ?? ''),
        addLocaleData: () => {},
        loadWorldInfo: async (name) => (books[name] ? structuredClone(books[name]) : null),
        saveWorldInfo: async (name, data) => { books[name] = structuredClone(data); },
        getChatState: fsDeps.getChatState,
        patchChatState: fsDeps.patchChatState,
        updateChatState: fsDeps.updateChatState,
        deleteChatState: async (ns) => {
            store._raw.delete(String(ns ?? '').trim().toLowerCase());
            return { ok: true };
        },
        buildObjectPatchOperationsAsync,
        async createFloorState({ namespace }) {
            return createFloorStateWithDeps({ namespace }, fsDeps);
        },
        chatId: 'chat1',
        characterId: 0,
        characters: [{ avatar: 'a.png' }],
        chatMetadata: {},
    };
    Object.defineProperty(context, 'chat', { get() { return chatRef.value; } });
    return {
        context,
        eventSource,
        books,
        store,
        reset() {
            store._clear();
            for (const key of Object.keys(books)) delete books[key];
            context.chatMetadata = {};
            context.extensionSettings.search_tools = { enabled: true, preRequestEnabled: false };
        },
    };
}

function userMsg(text, { swipe_id = 0 } = {}) {
    return { is_user: true, is_system: false, mes: String(text), swipe_id };
}
function asstMsg(text, { swipe_id = 0 } = {}) {
    return { is_user: false, is_system: false, mes: String(text), swipe_id };
}

function entrySpec(entryId, content) {
    return { entryId, title: entryId, keywords: [], content, alwaysInject: false };
}

function managedEntryIds(books) {
    const book = books['__SEARCH_TOOLS__'];
    const entries = book && book.entries && typeof book.entries === 'object' ? Object.values(book.entries) : [];
    return entries
        .map((entry) => String(entry?.comment || ''))
        .filter((comment) => comment.startsWith('SEARCH_TOOLS::'))
        .map((comment) => comment.split('::')[1])
        .sort();
}

async function flush() {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
}

const chatRef = { value: [] };
const harness = makeMainContext(chatRef);
globalThis.Luker = { getContext: () => harness.context };

let mod;
beforeAll(async () => {
    mod = await import('../../public/scripts/extensions/search-tools/main.js');
});

beforeEach(() => {
    resetFloorStateInstanceForTesting();
    harness.reset();
});

/** Prime the lorebook from the stored set through the real chat-change path. */
async function primeLorebook() {
    mod.registerSearchToolsChatChangedSync(harness.context);
    mod.registerSearchToolsStructuralSync(harness.context);
    await harness.eventSource.emit(event_types.CHAT_CHANGED);
    await flush();
}

describe('shared lorebook follows the stored entry set', () => {
    test('deleting the owning user turn rolls the lorebook back to the earlier set', async () => {
        chatRef.value = [userMsg('u1'), asstMsg('a1'), userMsg('u2'), asstMsg('a2')];
        await commitManagedEntries(harness.context, { playableFloor: 1 }, [entrySpec('first', 'first body')]);
        await commitManagedEntries(harness.context, { playableFloor: 3 }, [entrySpec('second', 'second body')]);

        await primeLorebook();
        expect(managedEntryIds(harness.books)).toEqual(['second']);

        // Roll the chat back past the second user turn.
        chatRef.value = chatRef.value.slice(0, 2);
        await harness.eventSource.emit(event_types.MESSAGE_DELETED, chatRef.value.length, {});
        await flush();

        expect(managedEntryIds(harness.books)).toEqual(['first']);
    });

    test('clears the managed entries when the only owning turn is deleted', async () => {
        chatRef.value = [userMsg('u1'), asstMsg('a1')];
        await commitManagedEntries(harness.context, { playableFloor: 1 }, [entrySpec('only', 'only body')]);

        await primeLorebook();
        expect(managedEntryIds(harness.books)).toEqual(['only']);

        chatRef.value = [];
        await harness.eventSource.emit(event_types.MESSAGE_DELETED, 0, {});
        await flush();

        expect(managedEntryIds(harness.books)).toEqual([]);
    });

    test('editing a message leaves the lorebook untouched', async () => {
        chatRef.value = [userMsg('u1'), asstMsg('a1'), userMsg('u2'), asstMsg('a2')];
        await commitManagedEntries(harness.context, { playableFloor: 1 }, [entrySpec('first', 'first body')]);
        await commitManagedEntries(harness.context, { playableFloor: 3 }, [entrySpec('second', 'second body')]);

        await primeLorebook();
        expect(managedEntryIds(harness.books)).toEqual(['second']);

        // Editing the owning turn and an earlier one — neither is a data change.
        chatRef.value[2] = userMsg('u2 edited');
        await harness.eventSource.emit(event_types.MESSAGE_EDITED, 2, { playableSeq: 3, isUser: true });
        await flush();
        chatRef.value[0] = userMsg('u1 edited');
        await harness.eventSource.emit(event_types.MESSAGE_EDITED, 0, { playableSeq: 1, isUser: true });
        await flush();

        expect(managedEntryIds(harness.books)).toEqual(['second']);
    });

    test('swiping an assistant reply leaves the lorebook untouched', async () => {
        chatRef.value = [userMsg('u1'), asstMsg('a1'), userMsg('u2'), asstMsg('a2')];
        await commitManagedEntries(harness.context, { playableFloor: 3 }, [entrySpec('second', 'second body')]);

        await primeLorebook();
        expect(managedEntryIds(harness.books)).toEqual(['second']);

        chatRef.value[3] = asstMsg('a2-alt', { swipe_id: 1 });
        await harness.eventSource.emit(event_types.MESSAGE_SWIPED, 3);
        await flush();

        expect(managedEntryIds(harness.books)).toEqual(['second']);
    });
});
