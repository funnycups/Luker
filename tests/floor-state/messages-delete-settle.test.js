/**
 * Integration tests verifying that `deleteMessages()` in `public/scripts/messages.js`
 * settles live `floor-state` instances from the earliest deleted floor index
 * (not `chat.length`), so mid-chat deletions keep earlier floors intact and
 * drop shifted commits cleanly — including when `silent: true`.
 */

import { describe, test, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { compare } from '../../public/scripts/util/fast-json-patch.js';

const chat = [];
const chat_metadata = { tainted: false };
const emittedEvents = [];
const event_types = {
    MESSAGE_SENT: 'message_sent',
    MESSAGE_RECEIVED: 'message_received',
    USER_MESSAGE_RENDERED: 'user_message_rendered',
    CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
    MESSAGE_DELETED: 'message_deleted',
};

const eventSource = {
    async emit(name, ...args) {
        emittedEvents.push({ name, args });
    },
};

const chatElement = {
    find() {
        return { length: 0, remove() {} };
    },
};

jest.unstable_mockModule('../../public/script.js', () => ({
    chat,
    chat_metadata,
    addOneMessage: jest.fn(),
    updateMessageBlock: jest.fn(),
    patchChatMessages: jest.fn(async () => true),
    appendChatMessages: jest.fn(async () => true),
    saveChatConditional: jest.fn(async () => {}),
    eventSource,
    event_types,
    chatElement,
    getFirstDisplayedMessageId: jest.fn(() => 0),
    updateViewMessageIds: jest.fn(),
    refreshSwipeButtons: jest.fn(),
    deleteSwipe: jest.fn(async () => 0),
}));

jest.unstable_mockModule('../../public/scripts/itemized-prompts.js', () => ({
    deleteItemizedPromptForMessage: jest.fn(),
}));

let deleteMessages;
let createFloorStateWithDeps;

beforeAll(async () => {
    const messagesMod = await import('../../public/scripts/messages.js');
    const floorStateMod = await import('../../public/scripts/floor-state.js');
    deleteMessages = messagesMod.deleteMessages;
    createFloorStateWithDeps = floorStateMod.createFloorStateWithDeps;
});

function makeDeps() {
    const raw = new Map();
    const deps = {
        async getChatState(ns) {
            const key = String(ns ?? '').trim().toLowerCase();
            const val = raw.get(key);
            return { ok: true, state: val == null ? null : structuredClone(val) };
        },
        async updateChatState(ns, updater) {
            const key = String(ns ?? '').trim().toLowerCase();
            const cur = raw.get(key) ?? null;
            const next = await updater(cur == null ? null : structuredClone(cur));
            if (next == null) raw.delete(key);
            else raw.set(key, structuredClone(next));
            return { ok: true, state: raw.get(key) ?? null, updated: true };
        },
        async deleteChatState(ns) {
            raw.delete(String(ns ?? '').trim().toLowerCase());
            return { ok: true };
        },
        async buildObjectPatchOperationsAsync(prev, next) {
            return compare(prev ?? {}, next ?? {});
        },
        getChat: () => chat,
    };
    return { raw, deps };
}

function makeMsg(mes, { is_user = false, swipe_id = 0 } = {}) {
    return { mes, is_user, is_system: false, swipe_id };
}

describe('deleteMessages → floor-state settlement', () => {
    let fs;
    let raw;

    beforeEach(() => {
        chat.length = 0;
        emittedEvents.length = 0;
        chat_metadata.tainted = false;
        const created = makeDeps();
        raw = created.raw;
        fs = createFloorStateWithDeps({ namespace: 'test_mid_delete' }, created.deps);
    });

    afterEach(async () => {
        if (fs) {
            await fs.destroy();
            fs = null;
        }
    });

    test('mid-chat single delete truncates from the deleted floor while emitting new chat.length', async () => {
        chat.push(
            makeMsg('greeting', { swipe_id: 0 }),
            makeMsg('u1', { is_user: true, swipe_id: 0 }),
            makeMsg('a1', { swipe_id: 1 }),
            makeMsg('u2', { is_user: true, swipe_id: 0 }),
            makeMsg('a2', { swipe_id: 2 }),
        );

        await fs.update(() => ({ turns: ['g'] }), { floor: 0 });
        await fs.update((s) => ({ turns: [...s.turns, 'a1'] }), { floor: 2 });
        await fs.update((s) => ({ turns: [...s.turns, 'a2'] }), { floor: 4 });

        // Delete middle message at floor 2 (new chat.length becomes 4).
        await deleteMessages(2);
        await fs.ready();

        // Commits at floor >= 2 truncated immediately; floor 0 preserved.
        expect(raw.get('test_mid_delete__floor_log').commits.map((c) => c.floor)).toEqual([0]);
        expect((await fs.get()).state).toEqual({ turns: ['g'] });
        expect(raw.get('test_mid_delete__orphans')).toBeUndefined();

        // External MESSAGE_DELETED event still passes new chat.length (4).
        expect(emittedEvents).toHaveLength(1);
        expect(emittedEvents[0].name).toBe(event_types.MESSAGE_DELETED);
        expect(emittedEvents[0].args[0]).toBe(4);

        // Subsequent write at floor 2 succeeds without VALIDATION_COMMIT.
        const writeRes = await fs.update((s) => ({ turns: [...s.turns, 're-extracted'] }), { floor: 2 });
        expect(writeRes.ok).toBe(true);
        expect((await fs.get()).state).toEqual({ turns: ['g', 're-extracted'] });
    });

    test('unsorted batch mid-chat delete truncates from the minimum deleted floor', async () => {
        chat.push(
            makeMsg('m0'),
            makeMsg('m1'),
            makeMsg('m2'),
            makeMsg('m3'),
            makeMsg('m4'),
            makeMsg('m5'),
        );

        await fs.update(() => ({ floors: [0] }), { floor: 0 });
        await fs.update((s) => ({ floors: [...s.floors, 1] }), { floor: 1 });
        await fs.update((s) => ({ floors: [...s.floors, 3] }), { floor: 3 });
        await fs.update((s) => ({ floors: [...s.floors, 5] }), { floor: 5 });

        await deleteMessages([4, 2]);
        await fs.ready();

        expect(raw.get('test_mid_delete__floor_log').commits.map((c) => c.floor)).toEqual([0, 1]);
        expect((await fs.get()).state).toEqual({ floors: [0, 1] });
    });

    test('silent mid-chat delete still truncates floor-state without emitting MESSAGE_DELETED', async () => {
        chat.push(makeMsg('m0'), makeMsg('m1'), makeMsg('m2'), makeMsg('m3'));

        await fs.update(() => ({ step: 0 }), { floor: 0 });
        await fs.update(() => ({ step: 1 }), { floor: 1 });
        await fs.update(() => ({ step: 3 }), { floor: 3 });

        await deleteMessages(1, { silent: true });
        await fs.ready();

        expect(emittedEvents).toHaveLength(0);
        expect(raw.get('test_mid_delete__floor_log').commits.map((c) => c.floor)).toEqual([0]);
        expect((await fs.get()).state).toEqual({ step: 0 });
    });
});
