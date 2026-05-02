/**
 * Orchestrator ↔ FloorState binding tests.
 *
 * Mirrors the test layout of `tests/memory-graph/adapter.test.js`:
 * a hand-rolled chat-state store + event source that wires through
 * `createFloorStateWithDeps`, plus a `context` shim that the binding
 * uses to obtain the floor-state instance and read / delete legacy
 * sidecars.
 */

import { describe, test, expect, beforeEach } from '@jest/globals';

import {
    createFloorStateWithDeps,
} from '../../public/scripts/floor-state.js';
import {
    commitAnchorSnapshot,
    constants as bindingConstants,
    loadAnchorMap,
    migrateLegacyAnchorsIfNeeded,
    pickLatestValidSnapshot,
    resetFloorStateInstanceForTesting,
} from '../../public/scripts/extensions/orchestrator/persistence.js';
import {
    buildLastUserAnchor,
    buildLastUserAnchorFromMessages,
    compactStageOutputs,
    normalizeNodeOutputForSnapshot,
} from '../../public/scripts/extensions/orchestrator/anchors.js';

// --- mocks (shape mirrors tests/memory-graph/adapter.test.js) ---

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
            return v == null ? null : structuredClone(v);
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
        get _raw() { return partitionFor(undefined); },
    };
}

function makeEventSource() {
    const listeners = new Map();
    return {
        on(name, fn) {
            if (!listeners.has(name)) listeners.set(name, new Set());
            listeners.get(name).add(fn);
        },
        removeListener(name, fn) {
            listeners.get(name)?.delete(fn);
        },
        async emit(name, ...args) {
            const set = listeners.get(name);
            if (!set) return;
            for (const fn of Array.from(set)) {
                await fn(...args);
            }
        },
    };
}

const event_types = {
    CHAT_CHANGED: 'chat_id_changed',
    MESSAGE_SWIPED: 'message_swiped',
    MESSAGE_DELETED: 'message_deleted',
    MESSAGE_SWIPE_DELETED: 'message_swipe_deleted',
    CHAT_BRANCH_CREATED: 'chat_branch_created',
};

async function buildObjectPatchOperationsAsync(prev, next) {
    const { compare } = await import('../../public/scripts/util/fast-json-patch.js');
    return compare(prev ?? {}, next ?? {});
}

function makeContext(chatRef) {
    const store = makeStore();
    const eventSource = makeEventSource();
    const fsDeps = {
        getChatState: store.getChatState.bind(store),
        patchChatState: store.patchChatState.bind(store),
        updateChatState: store.updateChatState.bind(store),
        buildObjectPatchOperationsAsync,
        eventSource,
        event_types,
        getChat: () => chatRef.value,
    };
    let createdInstance = null;
    const context = {
        chat: chatRef.value,
        getChatState: fsDeps.getChatState,
        patchChatState: fsDeps.patchChatState,
        updateChatState: fsDeps.updateChatState,
        deleteChatState: async (ns) => {
            const k = String(ns ?? '').trim().toLowerCase();
            return store._raw.delete(k);
        },
        buildObjectPatchOperationsAsync,
        async createFloorState({ namespace }) {
            createdInstance = createFloorStateWithDeps({ namespace }, fsDeps);
            return createdInstance;
        },
    };
    Object.defineProperty(context, 'chat', {
        get() { return chatRef.value; },
    });
    return { store, eventSource, context, getInstance: () => createdInstance };
}

function userMsg(text, { swipe_id = 0 } = {}) {
    return { is_user: true, is_system: false, mes: String(text), swipe_id };
}
function asstMsg(text, { swipe_id = 0, swipes = null } = {}) {
    const message = { is_user: false, is_system: false, mes: String(text), swipe_id };
    if (swipes) message.swipes = swipes.slice();
    return message;
}

function buildAnchorAt(messages, chatIndex) {
    const slice = messages.slice(0, chatIndex + 1);
    const anchor = buildLastUserAnchorFromMessages(slice);
    return anchor;
}

async function flush() {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
    resetFloorStateInstanceForTesting();
});

// --- commit semantics ---

describe('commitAnchorSnapshot', () => {
    test('writes a single floor-state commit at the anchor user message and lands the snapshot under its playable floor key', async () => {
        const chatRef = { value: [userMsg('hi')] };
        const { context } = makeContext(chatRef);
        const anchor = buildAnchorAt(chatRef.value, 0);
        expect(anchor).toMatchObject({ playableFloor: 1, chatIndex: 0, swipeId: 0 });

        const ok = await commitAnchorSnapshot(context, anchor, {
            anchorHash: anchor.hash,
            capsuleText: 'capsule v1',
            stageOutputs: [{ id: 's1', mode: 'serial', nodes: [] }],
        });
        expect(ok).toBe(true);

        const map = await loadAnchorMap(context);
        expect(map[1]).toMatchObject({
            anchorHash: anchor.hash,
            capsuleText: 'capsule v1',
        });
    });

    test('does nothing when the snapshot has no capsule text', async () => {
        const chatRef = { value: [userMsg('hi')] };
        const { context } = makeContext(chatRef);
        const anchor = buildAnchorAt(chatRef.value, 0);
        const ok = await commitAnchorSnapshot(context, anchor, { anchorHash: anchor.hash, capsuleText: '', stageOutputs: [] });
        expect(ok).toBe(false);
        const map = await loadAnchorMap(context);
        expect(map).toEqual({});
    });

    test('rejects anchors with missing playableFloor / chatIndex', async () => {
        const chatRef = { value: [userMsg('hi')] };
        const { context } = makeContext(chatRef);
        expect(await commitAnchorSnapshot(context, { playableFloor: 0, chatIndex: 0 }, { capsuleText: 'x' })).toBe(false);
        expect(await commitAnchorSnapshot(context, { playableFloor: 1, chatIndex: -1 }, { capsuleText: 'x' })).toBe(false);
    });

    test('a second commit at the same anchor replaces the snapshot', async () => {
        const chatRef = { value: [userMsg('hi')] };
        const { context } = makeContext(chatRef);
        const anchor = buildAnchorAt(chatRef.value, 0);

        await commitAnchorSnapshot(context, anchor, { anchorHash: anchor.hash, capsuleText: 'first', stageOutputs: [] });
        await commitAnchorSnapshot(context, anchor, { anchorHash: anchor.hash, capsuleText: 'second', stageOutputs: [] });

        const map = await loadAnchorMap(context);
        expect(map[1]).toMatchObject({ capsuleText: 'second' });
    });

    test('returns false when chatIndex is past the end of the chat', async () => {
        // Floor-state's resolveCommitTarget rejects out-of-range floors,
        // so the commit is a no-op and the data namespace stays empty.
        // This is the binding's only structural defence against bad anchors.
        const chatRef = { value: [userMsg('only message')] };
        const { context } = makeContext(chatRef);
        const ok = await commitAnchorSnapshot(
            context,
            { playableFloor: 5, chatIndex: 99, swipeId: 0, hash: 'x' },
            { anchorHash: 'x', capsuleText: 'cap', stageOutputs: [] },
        );
        expect(ok).toBe(false);
        const map = await loadAnchorMap(context);
        expect(map).toEqual({});
    });
});

// --- pure helpers (anchors.js) ---

describe('compactStageOutputs', () => {
    test('strips runtime-only fields and keeps id/mode/nodes[].{node,output}', () => {
        const stages = [
            {
                id: 's1',
                mode: 'serial',
                nodes: [
                    { node: 'distill', output: 'text', previewText: 'noise', error: null },
                    { node: 'plan', output: { plan: ['step'] }, replayResult: { extra: 1 } },
                ],
                __runtimeOnlyMeta: { foo: 'bar' },
            },
        ];
        const result = compactStageOutputs(stages);
        expect(result).toEqual([
            {
                id: 's1',
                mode: 'serial',
                nodes: [
                    { node: 'distill', output: 'text' },
                    { node: 'plan', output: { plan: ['step'] } },
                ],
            },
        ]);
        // The runtime-only stage field must not bleed through.
        expect(result[0]).not.toHaveProperty('__runtimeOnlyMeta');
    });

    test('returns [] for non-array input', () => {
        expect(compactStageOutputs(null)).toEqual([]);
        expect(compactStageOutputs(undefined)).toEqual([]);
        expect(compactStageOutputs('not-an-array')).toEqual([]);
    });

    test('tolerates stages whose nodes field is missing or non-array', () => {
        const result = compactStageOutputs([{ id: 's1', mode: 'parallel' }, { id: 's2', mode: 'serial', nodes: null }]);
        expect(result).toEqual([
            { id: 's1', mode: 'parallel', nodes: [] },
            { id: 's2', mode: 'serial', nodes: [] },
        ]);
    });
});

describe('normalizeNodeOutputForSnapshot', () => {
    test('passes strings through unchanged (immutable, no clone)', () => {
        const text = 'capsule body';
        expect(normalizeNodeOutputForSnapshot(text)).toBe(text);
    });

    test('deep-clones objects so future mutations do not bleed into snapshots', () => {
        const original = { steps: [{ name: 'a' }] };
        const cloned = normalizeNodeOutputForSnapshot(original);
        expect(cloned).toEqual(original);
        expect(cloned).not.toBe(original);
        cloned.steps[0].name = 'mutated';
        expect(original.steps[0].name).toBe('a');
    });

    test('passes primitives and null/undefined through', () => {
        expect(normalizeNodeOutputForSnapshot(42)).toBe(42);
        expect(normalizeNodeOutputForSnapshot(true)).toBe(true);
        expect(normalizeNodeOutputForSnapshot(null)).toBeNull();
        expect(normalizeNodeOutputForSnapshot(undefined)).toBeUndefined();
    });
});

describe('buildLastUserAnchor', () => {
    test('prefers context.chat over the payload messages when both have a user turn', () => {
        const context = { chat: [userMsg('from-context')] };
        const payloadMessages = [userMsg('from-payload')];
        const anchor = buildLastUserAnchor(context, payloadMessages);
        expect(anchor).not.toBeNull();
        // Hash is content-bound — easiest way to assert "context message won" is to
        // compare against the same call against just that source.
        expect(anchor.hash).toBe(buildLastUserAnchorFromMessages([userMsg('from-context')]).hash);
    });

    test('falls back to the payload when context.chat has no user message', () => {
        const context = { chat: [{ is_user: false, is_system: true, mes: 'sys' }] };
        const payloadMessages = [userMsg('from-payload')];
        const anchor = buildLastUserAnchor(context, payloadMessages);
        expect(anchor).not.toBeNull();
        expect(anchor.hash).toBe(buildLastUserAnchorFromMessages([userMsg('from-payload')]).hash);
    });

    test('returns null when neither source has a user message', () => {
        const context = { chat: [] };
        expect(buildLastUserAnchor(context, [])).toBeNull();
        expect(buildLastUserAnchor(null, null)).toBeNull();
    });
});


// --- structural events through floor-state ---

describe('floor-state events on orchestrator commits', () => {
    test('MESSAGE_DELETED truncating past the anchored user message drops its snapshot', async () => {
        const chatRef = {
            value: [
                userMsg('u1'), asstMsg('a1'),
                userMsg('u2'), asstMsg('a2'),
            ],
        };
        const { eventSource, context } = makeContext(chatRef);

        // Anchor at user 1 (chatIndex 0, playableFloor 1).
        const anchorOne = buildAnchorAt(chatRef.value, 0);
        await commitAnchorSnapshot(context, anchorOne, { anchorHash: anchorOne.hash, capsuleText: 'cap-1', stageOutputs: [] });
        // Anchor at user 2 (chatIndex 2, playableFloor 3).
        const anchorTwo = buildAnchorAt(chatRef.value, 2);
        await commitAnchorSnapshot(context, anchorTwo, { anchorHash: anchorTwo.hash, capsuleText: 'cap-2', stageOutputs: [] });

        let map = await loadAnchorMap(context);
        expect(Object.keys(map).map(Number).sort()).toEqual([1, 3]);

        // Delete the second user + its assistant; new chat length = 2.
        chatRef.value = chatRef.value.slice(0, 2);
        await eventSource.emit(event_types.MESSAGE_DELETED, chatRef.value.length, {});
        await flush();

        map = await loadAnchorMap(context);
        expect(Object.keys(map).map(Number).sort()).toEqual([1]);
        expect(map[1]).toMatchObject({ capsuleText: 'cap-1' });
    });

    test('MESSAGE_SWIPED on the anchored user message filters the commit out', async () => {
        const chatRef = {
            value: [
                userMsg('u1', { swipe_id: 0 }),
                asstMsg('a1'),
            ],
        };
        const { eventSource, context } = makeContext(chatRef);

        const anchor = buildAnchorAt(chatRef.value, 0);
        await commitAnchorSnapshot(context, anchor, { anchorHash: anchor.hash, capsuleText: 'cap-v0', stageOutputs: [] });
        expect((await loadAnchorMap(context))[1]).toMatchObject({ capsuleText: 'cap-v0' });

        // User swipes their own message → swipe_id changes; no commit at the new swipe yet.
        chatRef.value[0] = userMsg('u1-alt', { swipe_id: 1 });
        await eventSource.emit(event_types.MESSAGE_SWIPED, 0);
        await flush();

        const map = await loadAnchorMap(context);
        expect(map).toEqual({});
    });

    test('MESSAGE_SWIPED on a non-anchored message keeps the commit intact', async () => {
        const chatRef = {
            value: [
                userMsg('u1', { swipe_id: 0 }),
                asstMsg('a1', { swipe_id: 0 }),
            ],
        };
        const { eventSource, context } = makeContext(chatRef);

        const anchor = buildAnchorAt(chatRef.value, 0);
        await commitAnchorSnapshot(context, anchor, { anchorHash: anchor.hash, capsuleText: 'cap', stageOutputs: [] });

        // Assistant swipes — different floor, anchor message is unchanged.
        chatRef.value[1] = asstMsg('a1-alt', { swipe_id: 1 });
        await eventSource.emit(event_types.MESSAGE_SWIPED, 1);
        await flush();

        const map = await loadAnchorMap(context);
        expect(map[1]).toMatchObject({ capsuleText: 'cap' });
    });
});

// --- pickLatestValidSnapshot ---

describe('pickLatestValidSnapshot', () => {
    test('returns the highest-floor entry whose anchor message text still matches', async () => {
        const chatRef = {
            value: [
                userMsg('u1'), asstMsg('a1'),
                userMsg('u2'), asstMsg('a2'),
            ],
        };
        const { context } = makeContext(chatRef);
        const a1 = buildAnchorAt(chatRef.value, 0);
        const a2 = buildAnchorAt(chatRef.value, 2);
        await commitAnchorSnapshot(context, a1, { anchorHash: a1.hash, capsuleText: 'cap1', stageOutputs: [] });
        await commitAnchorSnapshot(context, a2, { anchorHash: a2.hash, capsuleText: 'cap2', stageOutputs: [] });

        const map = await loadAnchorMap(context);
        const pick = pickLatestValidSnapshot(context, map);
        expect(pick?.playableFloor).toBe(3);
        expect(pick?.snapshot.capsuleText).toBe('cap2');
    });

    test('skips entries whose anchorHash no longer matches the live message text', async () => {
        const chatRef = { value: [userMsg('original'), asstMsg('a1'), userMsg('u2')] };
        const { context } = makeContext(chatRef);
        const anchorOne = buildAnchorAt(chatRef.value, 0);
        const anchorTwo = buildAnchorAt(chatRef.value, 2);
        await commitAnchorSnapshot(context, anchorOne, { anchorHash: anchorOne.hash, capsuleText: 'cap1', stageOutputs: [] });
        await commitAnchorSnapshot(context, anchorTwo, { anchorHash: anchorTwo.hash, capsuleText: 'cap2', stageOutputs: [] });

        // Edit the second user message — its hash no longer matches the stored snapshot.
        chatRef.value[2] = userMsg('edited');
        const map = await loadAnchorMap(context);
        const pick = pickLatestValidSnapshot(context, map);
        // Falls back to the first user, whose text is unchanged.
        expect(pick?.playableFloor).toBe(1);
        expect(pick?.snapshot.capsuleText).toBe('cap1');
    });

    test('returns null when no entries match', async () => {
        const chatRef = { value: [userMsg('hi')] };
        const { context } = makeContext(chatRef);
        const pick = pickLatestValidSnapshot(context, {});
        expect(pick).toBeNull();
    });
});

// --- legacy migration ---

describe('migrateLegacyAnchorsIfNeeded', () => {
    test('migrates an index + per-anchor sidecars into floor-state commits and deletes legacy data', async () => {
        const chatRef = {
            value: [
                userMsg('u1'), asstMsg('a1'),
                userMsg('u2'), asstMsg('a2'),
            ],
        };
        const { store, context } = makeContext(chatRef);

        // Hand-write the legacy state shape into the raw store.
        const a1 = buildAnchorAt(chatRef.value, 0);
        const a2 = buildAnchorAt(chatRef.value, 2);
        store._raw.set(bindingConstants.LEGACY_INDEX_NAMESPACE, {
            version: 2,
            anchors: [a1.playableFloor, a2.playableFloor],
        });
        store._raw.set(`${bindingConstants.LEGACY_ANCHOR_NAMESPACE_PREFIX}${a1.playableFloor}`, {
            anchorHash: a1.hash,
            capsuleText: 'legacy cap 1',
            stageOutputs: [],
        });
        store._raw.set(`${bindingConstants.LEGACY_ANCHOR_NAMESPACE_PREFIX}${a2.playableFloor}`, {
            anchorHash: a2.hash,
            capsuleText: 'legacy cap 2',
            stageOutputs: [],
        });

        const result = await migrateLegacyAnchorsIfNeeded(context);
        expect(result).toMatchObject({ migrated: true, committed: 2 });

        // Legacy namespaces gone.
        expect(store._raw.has(bindingConstants.LEGACY_INDEX_NAMESPACE)).toBe(false);
        expect(store._raw.has(`${bindingConstants.LEGACY_ANCHOR_NAMESPACE_PREFIX}${a1.playableFloor}`)).toBe(false);
        expect(store._raw.has(`${bindingConstants.LEGACY_ANCHOR_NAMESPACE_PREFIX}${a2.playableFloor}`)).toBe(false);

        // Schema marker stamped.
        expect(store._raw.get(bindingConstants.SCHEMA_NAMESPACE)).toEqual({ version: bindingConstants.SCHEMA_VERSION });

        // Both snapshots reachable through the floor-state instance.
        const map = await loadAnchorMap(context);
        expect(map[a1.playableFloor]).toMatchObject({ capsuleText: 'legacy cap 1' });
        expect(map[a2.playableFloor]).toMatchObject({ capsuleText: 'legacy cap 2' });
    });

    test('a second call after migration is a no-op', async () => {
        const chatRef = { value: [userMsg('u1')] };
        const { store, context } = makeContext(chatRef);
        const a1 = buildAnchorAt(chatRef.value, 0);
        store._raw.set(bindingConstants.LEGACY_INDEX_NAMESPACE, { version: 2, anchors: [a1.playableFloor] });
        store._raw.set(`${bindingConstants.LEGACY_ANCHOR_NAMESPACE_PREFIX}${a1.playableFloor}`, {
            anchorHash: a1.hash,
            capsuleText: 'cap',
            stageOutputs: [],
        });
        const first = await migrateLegacyAnchorsIfNeeded(context);
        expect(first.migrated).toBe(true);
        const second = await migrateLegacyAnchorsIfNeeded(context);
        expect(second.migrated).toBe(false);
        expect(second.reason).toBe('already-migrated');
    });

    test('stamps the schema version on a fresh chat with no legacy data', async () => {
        const chatRef = { value: [userMsg('hi')] };
        const { store, context } = makeContext(chatRef);
        const result = await migrateLegacyAnchorsIfNeeded(context);
        expect(result.migrated).toBe(false);
        expect(result.reason).toBe('no-legacy-data');
        expect(store._raw.get(bindingConstants.SCHEMA_NAMESPACE)).toEqual({ version: bindingConstants.SCHEMA_VERSION });
    });

    test('drops legacy anchors whose user message no longer exists in the chat', async () => {
        const chatRef = { value: [userMsg('u1')] };
        const { store, context } = makeContext(chatRef);

        store._raw.set(bindingConstants.LEGACY_INDEX_NAMESPACE, {
            version: 2,
            // playableFloor 99 has no corresponding message in the current chat.
            anchors: [99],
        });
        store._raw.set(`${bindingConstants.LEGACY_ANCHOR_NAMESPACE_PREFIX}99`, {
            anchorHash: 'stale',
            capsuleText: 'stale cap',
            stageOutputs: [],
        });

        const result = await migrateLegacyAnchorsIfNeeded(context);
        expect(result.migrated).toBe(true);
        expect(result.committed).toBe(0);
        const map = await loadAnchorMap(context);
        expect(map).toEqual({});
    });

    test('promotes a legacy `snapshot` field into a floor-state commit', async () => {
        const chatRef = { value: [userMsg('u1')] };
        const { store, context } = makeContext(chatRef);

        const a1 = buildAnchorAt(chatRef.value, 0);
        store._raw.set(bindingConstants.LEGACY_INDEX_NAMESPACE, {
            version: 1,
            anchors: [],
            snapshot: {
                anchorPlayableFloor: a1.playableFloor,
                anchorHash: a1.hash,
                capsuleText: 'pre-anchor-list',
                stageOutputs: [],
            },
        });

        const result = await migrateLegacyAnchorsIfNeeded(context);
        expect(result.migrated).toBe(true);
        const map = await loadAnchorMap(context);
        expect(map[a1.playableFloor]).toMatchObject({ capsuleText: 'pre-anchor-list' });
    });
});
