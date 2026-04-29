import { describe, test, beforeEach } from '@jest/globals';
import assert from 'node:assert/strict';

// ============================================================
// Mock setup — replicate the dependencies messages.js imports
// ============================================================

let chat;
let chat_metadata;
let emittedEvents;
let appendedMessages;
let deletedSwipes;
let viewIdsUpdated;
let swipeRefreshed;
let itemizedDeleted;
let savedFallback;
let patchCalled;
let patchReturnValue;
let appendReturnValue;

function resetState() {
    chat = [];
    chat_metadata = { tainted: false };
    emittedEvents = [];
    appendedMessages = [];
    deletedSwipes = [];
    viewIdsUpdated = [];
    swipeRefreshed = 0;
    itemizedDeleted = [];
    savedFallback = 0;
    patchCalled = [];
    patchReturnValue = true;
    appendReturnValue = true;
}

const eventSource = {
    async emit(type, ...args) {
        emittedEvents.push({ type, args });
    },
};

const event_types = {
    MESSAGE_SENT: 'MESSAGE_SENT',
    MESSAGE_RECEIVED: 'MESSAGE_RECEIVED',
    USER_MESSAGE_RENDERED: 'USER_MESSAGE_RENDERED',
    CHARACTER_MESSAGE_RENDERED: 'CHARACTER_MESSAGE_RENDERED',
    MESSAGE_DELETED: 'MESSAGE_DELETED',
};

let addOneMessageCalls = [];
const addOneMessage = (msg, opts) => addOneMessageCalls.push({ msg, opts });
let updateMessageBlockCalls = [];
const updateMessageBlock = (idx, msg) => updateMessageBlockCalls.push({ idx, msg });
const updateViewMessageIds = (s) => viewIdsUpdated.push(s);
const refreshSwipeButtons = () => swipeRefreshed++;
const deleteSwipe = async (swipeId, msgId) => deletedSwipes.push({ swipeId, msgId });
const saveChatDebounced = () => savedFallback++;
const deleteItemizedPromptForMessage = (id) => itemizedDeleted.push(id);
const patchChatMessages = async (ops) => { patchCalled.push(ops); return patchReturnValue; };
const appendChatMessages = async (msgs) => { appendedMessages.push(...msgs); return appendReturnValue; };
const saveChatConditional = async () => {};

// ============================================================
// Inline the module logic with our mocks
// ============================================================

async function addMessages(messages, options = {}) {
    const { scroll = true, silent = false } = options;
    const isBatch = Array.isArray(messages);
    const messageList = isBatch ? messages : [messages];
    if (messageList.length === 0) return isBatch ? [] : undefined;
    const indices = [];
    for (const message of messageList) {
        chat.push(message);
        const index = chat.length - 1;
        indices.push(index);
        chat_metadata.tainted = true;
        if (!silent) {
            const eventType = message.is_user ? event_types.MESSAGE_SENT : event_types.MESSAGE_RECEIVED;
            await eventSource.emit(eventType, index);
        }
        addOneMessage(message, { scroll });
        if (!silent) {
            const renderEventType = message.is_user ? event_types.USER_MESSAGE_RENDERED : event_types.CHARACTER_MESSAGE_RENDERED;
            await eventSource.emit(renderEventType, index);
        }
    }
    const appended = await appendChatMessages(messageList);
    if (!appended) await saveChatConditional();
    return isBatch ? indices : indices[0];
}

async function updateMessages(updates, options = {}) {
    const { rerender = true } = options;
    const isBatch = Array.isArray(updates);
    const updateList = isBatch ? updates : [updates];
    if (updateList.length === 0) return;
    const operations = [];
    for (const { index, patch } of updateList) {
        if (index < 0 || index >= chat.length || !chat[index]) continue;
        Object.assign(chat[index], patch);
        chat_metadata.tainted = true;
        if (rerender) updateMessageBlock(index, chat[index]);
        operations.push({ op: 'replace', path: `/${index}`, value: chat[index] });
    }
    if (operations.length > 0) {
        const patched = await patchChatMessages(operations);
        if (!patched) saveChatDebounced();
    }
}

async function deleteMessages(index, options = {}) {
    const { swipe, silent = false } = options;
    const isBatch = Array.isArray(index);
    const indices = isBatch ? [...index] : [index];
    if (swipe !== undefined) {
        if (isBatch && indices.length > 1) throw new Error('Swipe deletion is only supported for a single message index');
        const msgIndex = indices[0];
        const message = chat[msgIndex];
        if (!message) throw new Error(`No message at index ${msgIndex}`);
        await deleteSwipe(swipe, msgIndex);
        return isBatch ? [message] : message;
    }
    const snapshotByIndex = new Map();
    for (const idx of indices) {
        if (idx >= 0 && idx < chat.length && chat[idx]) snapshotByIndex.set(idx, chat[idx]);
    }
    indices.sort((a, b) => b - a);
    const deletedMessages = [];
    const operations = [];
    for (const idx of indices) {
        if (!snapshotByIndex.has(idx)) continue;
        deletedMessages.push(snapshotByIndex.get(idx));
        chat.splice(idx, 1);
        chat_metadata.tainted = true;
        deleteItemizedPromptForMessage(idx);
        operations.push({ op: 'remove', path: `/${idx}` });
    }
    if (deletedMessages.length > 0) {
        const smallestIndex = indices[indices.length - 1];
        updateViewMessageIds([0, 0].includes(smallestIndex) ? smallestIndex : null);
    }
    if (operations.length > 0) {
        const patched = await patchChatMessages(operations);
        if (!patched) saveChatDebounced();
    }
    refreshSwipeButtons();
    if (!silent && deletedMessages.length > 0) {
        await eventSource.emit(event_types.MESSAGE_DELETED, chat.length, { kind: 'delete' });
    }
    if (isBatch) { deletedMessages.reverse(); return deletedMessages; }
    return deletedMessages[0];
}

function getMessage(index) {
    if (index < 0 || index >= chat.length || !chat[index]) return null;
    return new Proxy(chat[index], {
        set() { throw new Error('Message is readonly. Use updateMessages() to modify.'); },
        deleteProperty() { throw new Error('Message is readonly. Use updateMessages() to modify.'); },
    });
}

function getMessageCount() {
    return chat.length;
}

// ============================================================
// Tests
// ============================================================

beforeEach(() => {
    resetState();
    addOneMessageCalls = [];
    updateMessageBlockCalls = [];
});

// --- addMessages ---

describe('addMessages', () => {
    test('single message returns index number', async () => {
        const msg = { name: 'User', mes: 'hello', is_user: true };
        const idx = await addMessages(msg);
        assert.equal(idx, 0);
        assert.equal(chat.length, 1);
        assert.equal(chat[0], msg);
    });

    test('batch messages returns array of indices', async () => {
        const msgs = [
            { name: 'User', mes: 'hi', is_user: true },
            { name: 'Bot', mes: 'hey', is_user: false },
        ];
        const indices = await addMessages(msgs);
        assert.deepEqual(indices, [0, 1]);
        assert.equal(chat.length, 2);
    });

    test('empty array returns empty array', async () => {
        const result = await addMessages([]);
        assert.deepEqual(result, []);
        assert.equal(chat.length, 0);
    });

    test('emits correct events for user message', async () => {
        await addMessages({ name: 'User', mes: 'test', is_user: true });
        const types = emittedEvents.map(e => e.type);
        assert.ok(types.includes('MESSAGE_SENT'));
        assert.ok(types.includes('USER_MESSAGE_RENDERED'));
        assert.ok(!types.includes('MESSAGE_RECEIVED'));
    });

    test('emits correct events for assistant message', async () => {
        await addMessages({ name: 'Bot', mes: 'test', is_user: false });
        const types = emittedEvents.map(e => e.type);
        assert.ok(types.includes('MESSAGE_RECEIVED'));
        assert.ok(types.includes('CHARACTER_MESSAGE_RENDERED'));
        assert.ok(!types.includes('MESSAGE_SENT'));
    });

    test('silent mode skips events', async () => {
        await addMessages({ name: 'User', mes: 'test', is_user: true }, { silent: true });
        assert.equal(emittedEvents.length, 0);
    });

    test('calls addOneMessage for DOM rendering', async () => {
        const msg = { name: 'User', mes: 'test', is_user: true };
        await addMessages(msg);
        assert.equal(addOneMessageCalls.length, 1);
        assert.equal(addOneMessageCalls[0].msg, msg);
        assert.deepEqual(addOneMessageCalls[0].opts, { scroll: true });
    });

    test('scroll option is passed through', async () => {
        await addMessages({ name: 'User', mes: 'test', is_user: true }, { scroll: false });
        assert.deepEqual(addOneMessageCalls[0].opts, { scroll: false });
    });

    test('persists via appendChatMessages', async () => {
        await addMessages([
            { name: 'A', mes: '1', is_user: true },
            { name: 'B', mes: '2', is_user: false },
        ]);
        assert.equal(appendedMessages.length, 2);
    });

    test('sets chat_metadata.tainted', async () => {
        assert.equal(chat_metadata.tainted, false);
        await addMessages({ name: 'User', mes: 'test', is_user: true });
        assert.equal(chat_metadata.tainted, true);
    });

    test('batch add indices are sequential with existing messages', async () => {
        chat.push({ name: 'Existing', mes: 'pre', is_user: false });
        const indices = await addMessages([
            { name: 'A', mes: '1', is_user: true },
            { name: 'B', mes: '2', is_user: false },
        ]);
        assert.deepEqual(indices, [1, 2]);
        assert.equal(chat.length, 3);
    });
});

// --- updateMessages ---

describe('updateMessages', () => {
    test('single update merges patch into message', async () => {
        chat.push({ name: 'Bot', mes: 'old', is_user: false, extra: {} });
        await updateMessages({ index: 0, patch: { mes: 'new' } });
        assert.equal(chat[0].mes, 'new');
        assert.equal(chat[0].name, 'Bot');
    });

    test('batch update modifies multiple messages', async () => {
        chat.push({ name: 'A', mes: '1', is_user: true });
        chat.push({ name: 'B', mes: '2', is_user: false });
        await updateMessages([
            { index: 0, patch: { mes: 'updated-1' } },
            { index: 1, patch: { mes: 'updated-2' } },
        ]);
        assert.equal(chat[0].mes, 'updated-1');
        assert.equal(chat[1].mes, 'updated-2');
    });

    test('calls updateMessageBlock for DOM rerender', async () => {
        chat.push({ name: 'Bot', mes: 'old', is_user: false });
        await updateMessages({ index: 0, patch: { mes: 'new' } });
        assert.equal(updateMessageBlockCalls.length, 1);
        assert.equal(updateMessageBlockCalls[0].idx, 0);
    });

    test('rerender=false skips DOM update', async () => {
        chat.push({ name: 'Bot', mes: 'old', is_user: false });
        await updateMessages({ index: 0, patch: { mes: 'new' } }, { rerender: false });
        assert.equal(updateMessageBlockCalls.length, 0);
    });

    test('generates RFC 6902 replace operations', async () => {
        chat.push({ name: 'Bot', mes: 'old', is_user: false });
        await updateMessages({ index: 0, patch: { mes: 'new' } });
        assert.equal(patchCalled.length, 1);
        const ops = patchCalled[0];
        assert.equal(ops.length, 1);
        assert.equal(ops[0].op, 'replace');
        assert.equal(ops[0].path, '/0');
    });

    test('batch update sends all ops in one call', async () => {
        chat.push({ name: 'A', mes: '1', is_user: true });
        chat.push({ name: 'B', mes: '2', is_user: false });
        await updateMessages([
            { index: 0, patch: { mes: 'x' } },
            { index: 1, patch: { mes: 'y' } },
        ]);
        assert.equal(patchCalled.length, 1);
        assert.equal(patchCalled[0].length, 2);
    });

    test('skips invalid indices silently', async () => {
        chat.push({ name: 'Bot', mes: 'ok', is_user: false });
        await updateMessages([
            { index: 0, patch: { mes: 'good' } },
            { index: 99, patch: { mes: 'bad' } },
            { index: -1, patch: { mes: 'bad' } },
        ]);
        assert.equal(chat[0].mes, 'good');
        assert.equal(patchCalled[0].length, 1);
    });

    test('empty update list does nothing', async () => {
        await updateMessages([]);
        assert.equal(patchCalled.length, 0);
    });

    test('sets chat_metadata.tainted', async () => {
        chat.push({ name: 'Bot', mes: 'old', is_user: false });
        assert.equal(chat_metadata.tainted, false);
        await updateMessages({ index: 0, patch: { mes: 'new' } });
        assert.equal(chat_metadata.tainted, true);
    });

    test('falls back to saveChatDebounced when patch fails', async () => {
        chat.push({ name: 'Bot', mes: 'old', is_user: false });
        patchReturnValue = false;
        await updateMessages({ index: 0, patch: { mes: 'new' } });
        assert.equal(savedFallback, 1);
        patchReturnValue = true;
    });

    test('deep patch merges nested fields', async () => {
        chat.push({ name: 'Bot', mes: 'old', is_user: false, extra: { model: 'gpt-4' } });
        await updateMessages({ index: 0, patch: { extra: { model: 'gpt-5' } } });
        assert.equal(chat[0].extra.model, 'gpt-5');
    });
});

// --- deleteMessages ---

describe('deleteMessages', () => {
    test('single delete removes message and returns it', async () => {
        const msg = { name: 'Bot', mes: 'bye', is_user: false };
        chat.push(msg);
        const deleted = await deleteMessages(0);
        assert.equal(deleted, msg);
        assert.equal(chat.length, 0);
    });

    test('batch delete removes multiple messages', async () => {
        chat.push({ name: 'A', mes: '1', is_user: true });
        chat.push({ name: 'B', mes: '2', is_user: false });
        chat.push({ name: 'C', mes: '3', is_user: true });
        const deleted = await deleteMessages([0, 2]);
        assert.equal(deleted.length, 2);
        assert.equal(chat.length, 1);
        assert.equal(chat[0].name, 'B');
    });

    test('batch delete returns messages in ascending order', async () => {
        chat.push({ name: 'A', mes: '1', is_user: true });
        chat.push({ name: 'B', mes: '2', is_user: false });
        chat.push({ name: 'C', mes: '3', is_user: true });
        const deleted = await deleteMessages([2, 0]);
        assert.equal(deleted[0].name, 'A');
        assert.equal(deleted[1].name, 'C');
    });

    test('handles descending index sort to avoid shift', async () => {
        chat.push({ name: 'A', mes: '1', is_user: true });
        chat.push({ name: 'B', mes: '2', is_user: false });
        chat.push({ name: 'C', mes: '3', is_user: true });
        chat.push({ name: 'D', mes: '4', is_user: false });
        await deleteMessages([1, 3]);
        assert.equal(chat.length, 2);
        assert.equal(chat[0].name, 'A');
        assert.equal(chat[1].name, 'C');
    });

    test('generates RFC 6902 remove operations', async () => {
        chat.push({ name: 'A', mes: '1', is_user: true });
        await deleteMessages(0);
        assert.equal(patchCalled.length, 1);
        assert.equal(patchCalled[0].length, 1);
        assert.equal(patchCalled[0][0].op, 'remove');
        assert.equal(patchCalled[0][0].path, '/0');
    });

    test('emits MESSAGE_DELETED event', async () => {
        chat.push({ name: 'Bot', mes: 'bye', is_user: false });
        await deleteMessages(0);
        const types = emittedEvents.map(e => e.type);
        assert.ok(types.includes('MESSAGE_DELETED'));
    });

    test('silent mode skips events', async () => {
        chat.push({ name: 'Bot', mes: 'bye', is_user: false });
        await deleteMessages(0, { silent: true });
        assert.equal(emittedEvents.length, 0);
    });

    test('calls refreshSwipeButtons', async () => {
        chat.push({ name: 'Bot', mes: 'bye', is_user: false });
        swipeRefreshed = 0;
        await deleteMessages(0);
        assert.equal(swipeRefreshed, 1);
    });

    test('calls deleteItemizedPromptForMessage', async () => {
        chat.push({ name: 'Bot', mes: 'bye', is_user: false });
        await deleteMessages(0);
        assert.deepEqual(itemizedDeleted, [0]);
    });

    test('calls updateViewMessageIds', async () => {
        chat.push({ name: 'Bot', mes: 'bye', is_user: false });
        await deleteMessages(0);
        assert.equal(viewIdsUpdated.length, 1);
    });

    test('skips invalid indices', async () => {
        chat.push({ name: 'Bot', mes: 'ok', is_user: false });
        const deleted = await deleteMessages([0, 99, -1]);
        assert.equal(deleted.length, 1);
        assert.equal(chat.length, 0);
    });

    test('swipe deletion delegates to deleteSwipe', async () => {
        chat.push({ name: 'Bot', mes: 'hi', is_user: false, swipes: ['a', 'b', 'c'] });
        await deleteMessages(0, { swipe: 1 });
        assert.deepEqual(deletedSwipes, [{ swipeId: 1, msgId: 0 }]);
        assert.equal(chat.length, 1);
    });

    test('swipe deletion throws for batch', async () => {
        chat.push({ name: 'A', mes: '1', is_user: true });
        chat.push({ name: 'B', mes: '2', is_user: false });
        await assert.rejects(
            () => deleteMessages([0, 1], { swipe: 0 }),
            { message: 'Swipe deletion is only supported for a single message index' },
        );
    });

    test('swipe deletion throws for invalid index', async () => {
        await assert.rejects(
            () => deleteMessages(99, { swipe: 0 }),
            { message: 'No message at index 99' },
        );
    });

    test('sets chat_metadata.tainted', async () => {
        chat.push({ name: 'Bot', mes: 'bye', is_user: false });
        assert.equal(chat_metadata.tainted, false);
        await deleteMessages(0);
        assert.equal(chat_metadata.tainted, true);
    });

    test('falls back to saveChatDebounced when patch fails', async () => {
        chat.push({ name: 'Bot', mes: 'bye', is_user: false });
        patchReturnValue = false;
        await deleteMessages(0);
        assert.equal(savedFallback, 1);
        patchReturnValue = true;
    });

    test('batch persistence sends all ops in one call', async () => {
        chat.push({ name: 'A', mes: '1', is_user: true });
        chat.push({ name: 'B', mes: '2', is_user: false });
        chat.push({ name: 'C', mes: '3', is_user: true });
        await deleteMessages([0, 1, 2]);
        assert.equal(patchCalled.length, 1);
        assert.equal(patchCalled[0].length, 3);
    });
});

// --- getMessage ---

describe('getMessage', () => {
    test('returns readonly proxy of message', () => {
        chat.push({ name: 'Bot', mes: 'hello', is_user: false });
        const msg = getMessage(0);
        assert.equal(msg.name, 'Bot');
        assert.equal(msg.mes, 'hello');
    });

    test('throws on write attempt', () => {
        chat.push({ name: 'Bot', mes: 'hello', is_user: false });
        const msg = getMessage(0);
        assert.throws(() => { msg.mes = 'changed'; }, /Message is readonly/);
    });

    test('throws on delete attempt', () => {
        chat.push({ name: 'Bot', mes: 'hello', is_user: false });
        const msg = getMessage(0);
        assert.throws(() => { delete msg.mes; }, /Message is readonly/);
    });

    test('returns null for invalid index', () => {
        assert.equal(getMessage(0), null);
        assert.equal(getMessage(-1), null);
        assert.equal(getMessage(999), null);
    });

    test('reads nested properties', () => {
        chat.push({ name: 'Bot', mes: 'hi', is_user: false, extra: { model: 'gpt-4' } });
        const msg = getMessage(0);
        assert.equal(msg.extra.model, 'gpt-4');
    });

    test('shallow proxy allows nested mutation (by design)', () => {
        chat.push({ name: 'Bot', mes: 'hi', is_user: false, extra: { model: 'gpt-4' } });
        const msg = getMessage(0);
        msg.extra.model = 'gpt-5';
        assert.equal(chat[0].extra.model, 'gpt-5');
    });
});

// --- getMessageCount ---

describe('getMessageCount', () => {
    test('returns 0 for empty chat', () => {
        assert.equal(getMessageCount(), 0);
    });

    test('returns correct count', () => {
        chat.push({ name: 'A', mes: '1', is_user: true });
        chat.push({ name: 'B', mes: '2', is_user: false });
        assert.equal(getMessageCount(), 2);
    });

    test('updates after add', async () => {
        assert.equal(getMessageCount(), 0);
        await addMessages({ name: 'User', mes: 'hi', is_user: true });
        assert.equal(getMessageCount(), 1);
    });

    test('updates after delete', async () => {
        chat.push({ name: 'A', mes: '1', is_user: true });
        chat.push({ name: 'B', mes: '2', is_user: false });
        await deleteMessages(0);
        assert.equal(getMessageCount(), 1);
    });
});
