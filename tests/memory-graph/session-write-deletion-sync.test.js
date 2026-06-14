/**
 * End-to-end deletion-sync proof for session writes.
 *
 * Bug: orchestrator director's memory_curator writes nodes during turn N,
 * but pre-fix they were stamped at the previous turn's floor; deleting the
 * floor at N left them orphaned, and they would re-inject on regenerate.
 *
 * This test wires `openSession` against an in-memory chat-state IO + a real
 * FloorState instance. It pre-seeds the floor-state log with a "prior
 * extraction" commit, drives one session `createNode` while a chat tail
 * simulates an in-flight assistant turn, then asserts:
 *
 *   1. The session write appends a NEW commit at the in-flight floor while
 *      the prior commit is still in the log. This distinguishes the
 *      diff-mode commit (which appends) from the legacy replace-mode commit
 *      (which would have wiped the entire log and rewritten one big commit).
 *   2. Simulating `MESSAGE_DELETED(newChatLength)` via the instance's
 *      `__handleMessageDeleted` truncates ONLY the in-flight commit and
 *      preserves the prior commit's effects on rematerialize.
 *
 * The prior-commit survival is the load-bearing assertion: under Task 2
 * (anchor stamping only) `commitSessionMutation` still ran the replace
 * pipeline, which would clobber any pre-existing log entry — so a test
 * that didn't seed a prior commit could not tell the two states apart.
 */

import { describe, test, expect, jest, beforeAll, beforeEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Browser / jQuery shims required by main.js's module-level init.
// (Same surface as api.test.js / write-api.test.js — main.js touches the DOM
// during module load and crashes otherwise.)
// ---------------------------------------------------------------------------

globalThis.jQuery = (cb) => {
    if (typeof cb === 'function') { /* swallow init handlers */ }
    return { ready: () => {}, on: () => {}, off: () => {} };
};
globalThis.$ = globalThis.jQuery;
globalThis.window = globalThis.window || globalThis;
globalThis.document = globalThis.document || {
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
};

// ---------------------------------------------------------------------------
// Module mocks — full stack copied from api.test.js so api.js can load.
// The `resolveChatStateTarget` mock fixes the target memory-graph resolves
// to; the in-memory IO below partitions on the same target shape so writes
// for that target land in the chat partition the test inspects.
// ---------------------------------------------------------------------------

const MOCKED_TARGET = Object.freeze({
    is_group: false,
    avatar_url: 'session-test-avatar.png',
    file_name: 'session-test-chat',
});

const extensionSettingsMock = { memory_graph: {} };

// public/lib.js is redirected to tests/util/lib-stub.js via jest config's
// moduleNameMapper — no per-test mock needed.
jest.unstable_mockModule('../../public/scripts/request-compression.js', () => ({
    compressRequest: async (r) => r,
}));
jest.unstable_mockModule('../../public/scripts/extensions/preset-help.js', () => ({
    renderPresetHelpButton: () => '',
}));
jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    Popup: class { constructor() {} show() { return Promise.resolve(); } },
    POPUP_TYPE: { DISPLAY: 0, INPUT: 1, CONFIRM: 2 },
    POPUP_RESULT: { CANCELLED: 0, AFFIRMATIVE: 1 },
}));
jest.unstable_mockModule('../../public/scripts/st-context.js', () => ({
    getContext: () => ({}),
}));

jest.unstable_mockModule('../../public/script.js', () => ({
    event_types: {},
    eventSource: { on: () => {}, off: () => {}, emit: () => {} },
    extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
    extension_prompt_types: { NONE: 0, IN_PROMPT: 1, IN_CHAT: 2 },
    resolveChatStateTarget: () => ({ ...MOCKED_TARGET }),
    saveSettings: () => Promise.resolve(),
    saveSettingsDebounced: () => {},
}));

jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    extension_settings: extensionSettingsMock,
    getContext: () => ({}),
    registerExtensionApi: jest.fn(),
    UNSET_VALUE: Symbol('UNSET_VALUE'),
}));

jest.unstable_mockModule('../../public/scripts/extensions/memory-graph/schema-iteration/studio.js', () => ({
    openSchemaIterationStudio: () => Promise.resolve(),
}));

jest.unstable_mockModule('../../public/scripts/power-user.js', () => ({
    performFuzzySearch: () => [],
}));

jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
    download: () => {},
    getFileText: () => Promise.resolve(''),
    getStringHash: () => '',
    escapeHtml: (s) => String(s || ''),
}));

jest.unstable_mockModule('../../public/scripts/world-info.js', () => ({
    newWorldInfoEntryTemplate: () => ({}),
    setGlobalWorldInfoSelection: () => {},
    world_info_position: {
        before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6,
    },
}));

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    addLocaleData: () => {},
    translate: (k) => k,
    getCurrentLocale: () => 'en-US',
    t: (k) => k,
}));

jest.unstable_mockModule('../../public/scripts/extensions/regex/engine.js', () => ({
    registerManagedRegexProvider: () => ({ dispose: () => {} }),
    regex_placement: {},
    substitute_find_regex: () => '',
}));

jest.unstable_mockModule(
    '../../public/scripts/extensions/connection-manager/profile-resolver.js',
    () => ({ getChatCompletionConnectionProfiles: () => [] }),
);

jest.unstable_mockModule(
    '../../public/scripts/extensions/connection-manager/embed-rerank.js',
    () => ({
        renderProfileSelect: () => '',
        upsertEmbeddingProfile: () => {},
        upsertRerankProfile: () => {},
        getEmbeddingProfileById: () => null,
        getRerankProfileById: () => null,
    }),
);

jest.unstable_mockModule(
    '../../public/scripts/extensions/function-call-runtime.js',
    () => ({ TOOL_PROTOCOL_STYLE: {}, validateParsedToolCalls: () => true }),
);

jest.unstable_mockModule('../../public/scripts/embedding-service.js', () => ({
    EmbeddingService: class {},
}));

// ---------------------------------------------------------------------------
// Lazy SUT imports — mocks above must register before these modules load.
// ---------------------------------------------------------------------------

let openSession;
let resetFloorStateInstanceForTesting;
let createFloorStateWithDeps;
let applyPatch;
let compare;

beforeAll(async () => {
    ({ openSession } = await import('../../public/scripts/extensions/memory-graph/api.js'));
    ({ resetFloorStateInstanceForTesting } =
        await import('../../public/scripts/extensions/memory-graph/persistence.js'));
    ({ createFloorStateWithDeps } = await import('../../public/scripts/floor-state.js'));
    ({ applyPatch, compare } = await import('../../public/scripts/util/fast-json-patch.js'));
});

beforeEach(() => {
    resetFloorStateInstanceForTesting();
});

// ---------------------------------------------------------------------------
// In-memory chat-state IO. Partitions on target the way the production
// chat-state store does so writes for the mocked target land in their own
// bucket. Mirrors the shape used by tests/floor-state/instance.test.js.
// ---------------------------------------------------------------------------

function makeChatStateIO() {
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
            if (next == null) {
                part.delete(k);
            } else {
                part.set(k, structuredClone(next));
            }
            return { ok: true, state: part.get(k) ?? null, updated: true };
        },
        // Direct partition handle for assertions.
        partitionFor: (target) => partitionFor(target),
    };
}

describe('session-write deletion sync (end-to-end against in-memory floor-state)', () => {
    test('appends ONE commit at in-flight floor, preserves prior commits, tail-truncate removes the in-flight commit', async () => {
        const target = { ...MOCKED_TARGET };
        const io = makeChatStateIO();

        // Chat layout — two prior extractable assistant turns plus one
        // in-flight tail:
        //   index 0: user
        //   index 1: assistant 'a1'     (extractable, seq 1)
        //   index 2: user
        //   index 3: assistant 'a2'     (extractable, seq 2)
        //   index 4: user
        //   index 5: assistant streaming (extractable, in-flight, seq 3)
        //
        // This case covers the common path where streaming has already
        // produced text by the time the director's tool call fires; the
        // empty-placeholder variant is covered by the next test.
        const chat = [
            { is_user: true,  mes: 'u1', swipe_id: 0 },
            { is_user: false, mes: 'a1', swipe_id: 0 },
            { is_user: true,  mes: 'u2', swipe_id: 0 },
            { is_user: false, mes: 'a2', swipe_id: 0 },
            { is_user: true,  mes: 'u3', swipe_id: 0 },
            { is_user: false, mes: 'a3 streaming', swipe_id: 0 },
        ];

        // diff/patch utility memory-graph uses to compute fs.update's prev→next
        // patches. Real production wires this from script.js; the in-memory
        // path here uses the same fast-json-patch implementation.
        const buildObjectPatchOperationsAsync = async (prev, next) =>
            compare(prev ?? {}, next ?? {});

        // ---- Pre-seed a "prior extraction" commit at floor=3 ----
        //
        // The seeded payload represents what extraction would have written
        // after turn 2: one semantic node, coverage watermark at seq=2. The
        // log carries one commit at floor=3 (chat index of the 2nd extractable
        // assistant) whose patches build that payload from `{}`. The meta
        // sidecar is stamped at schemaVersion=2 so the v2 load path is taken.
        const priorNode = {
            id: 'n_pre',
            type: 'event',
            level: 'semantic',
            title: 'prior extraction',
            seqTo: 2,
            fields: { summary: 'prior' },
            parentId: '',
            childrenIds: [],
            archived: false,
            semanticRollup: false,
            semanticDepth: 0,
        };
        const priorPayload = {
            nodes: { [priorNode.id]: priorNode },
            edges: [],
            nodeSeq: 1,
            seqCounter: 2,
            appliedSeqTo: 2,
            loggedSeqTo: 2,
            coveredAssistantSeq: 2,
        };
        const priorPatches = await buildObjectPatchOperationsAsync({}, priorPayload);
        await io.updateChatState(
            'memory_graph__floor_log',
            () => ({
                version: 1,
                commits: [{ floor: 3, swipeId: 0, patches: priorPatches }],
            }),
            { target },
        );
        await io.updateChatState('memory_graph', () => priorPayload, { target });
        await io.updateChatState(
            'memory_graph__meta',
            () => ({
                schemaVersion: 2,
                sourceMessageCount: 0,
                lastRecallTrace: [],
                lastRecallProjection: null,
            }),
            { target },
        );

        let fsInstance = null;

        const context = {
            chat,
            chatId: 'session-test-chat',
            getChatState:    (...args) => io.getChatState(...args),
            updateChatState: (...args) => io.updateChatState(...args),
            patchChatState:  (...args) => io.patchChatState(...args),
            // commitMemoryStoreDiffByChatKey resolves this off context to
            // compute the incremental patch shipped into the floor-state log.
            buildObjectPatchOperationsAsync,
            // Memory-graph's persistence.getFloorStateInstance() reads this
            // off context; createFloorStateWithDeps wants the IO + chat
            // accessor as flat fields (NOT a `chatStateIO` wrapper).
            createFloorState: async ({ namespace }) => {
                fsInstance = createFloorStateWithDeps(
                    { namespace },
                    {
                        getChatState:    (ns, opts) => io.getChatState(ns, { target, ...(opts || {}) }),
                        updateChatState: (ns, u, opts) => io.updateChatState(ns, u, { target, ...(opts || {}) }),
                        patchChatState:  (ns, ops, opts) => io.patchChatState(ns, ops, { target, ...(opts || {}) }),
                        buildObjectPatchOperationsAsync,
                        getChat: () => chat,
                    },
                );
                await fsInstance.ready();
                return fsInstance;
            },
            characterId: 0,
            groupId: null,
        };

        const session = await openSession(context);
        expect(session).not.toBeNull();
        expect(typeof session.createNode).toBe('function');

        // ---- Drive one session write ----
        // Anchor: { floor: 5, turnSeq: 3 }. seqToFloor(3) walks chat counting
        // extractable assistants and lands on index 5 — the in-flight floor.
        // The diff-mode commit appends one prev→next patch there.
        const created = await session.createNode({
            type: 'event',
            title: 'director-written',
            fields: { what: 'director event in flight' },
        });
        expect(created?.id).toBeTruthy();

        // ---- Assertion 1: BOTH the prior commit (floor 3) and the new
        // commit (floor 5) are present in the log. Under the legacy
        // replace-mode path that the bug fix replaces, the prior commit
        // would have been wiped and only floor 5 would remain — this is
        // the load-bearing assertion that distinguishes the two paths.
        const partition = io.partitionFor(target);
        const log = partition.get('memory_graph__floor_log');
        expect(log).toBeTruthy();
        expect(Array.isArray(log.commits)).toBe(true);
        const floors = log.commits.map(c => c.floor);
        expect(floors).toContain(3);
        expect(floors).toContain(5);

        // Materialized state (log replay) reflects the newly-created node so a
        // fresh read surfaces it. Title is not asserted — memory-graph derives
        // display titles from `fields.summary` / schema config which is empty
        // in this fixture.
        const data = await fsInstance.get();
        expect(data?.nodes?.[created.id]).toBeTruthy();

        // ---- Simulate MESSAGE_DELETED on the in-flight floor ----
        // Production driver calls `settleMessageDeleted(newLength)` before
        // emitting the event; here we drive the instance directly via the
        // private handler the settle helper would otherwise dispatch to.
        chat.length = 5;
        await fsInstance.__handleMessageDeleted(5);

        // ---- Assertion 2: the commit at floor=5 is gone; floor=3 survives ----
        const logAfter = partition.get('memory_graph__floor_log');
        expect(logAfter).toBeTruthy();
        const floorsAfter = logAfter.commits.map(c => c.floor);
        expect(floorsAfter).not.toContain(5);
        expect(floorsAfter).toContain(3);

        // ---- Bonus: replayed state no longer carries the director-written
        // node, but the prior extraction node survives. Under the legacy
        // replace path, the truncate would have wiped the single
        // replace-commit and left an empty state — n_pre would have been
        // collateral damage. ----
        const dataAfter = await fsInstance.get();
        expect(dataAfter?.nodes?.[created.id]).toBeUndefined();
        expect(dataAfter?.nodes?.n_pre).toBeTruthy();
    });

    test('commits at the in-flight floor even when the placeholder is still empty (pre-stream director tool call)', async () => {
        // Real production trigger: orchestrator director sub-agents can fire
        // a memory_* tool call before the assistant placeholder has streamed
        // any text. Previously commitMemoryStoreDiffByChatKey reverse-looked
        // up the floor via seqToFloor(turnSeq), which requires the tail to
        // pass isExtractableAssistantMessage (non-empty mes). An empty
        // placeholder failed the lookup and the commit was dropped, leaving
        // the in-memory cache holding seq=N nodes the floor-state log never
        // backed. commitSessionMutation now passes anchor.floor explicitly so
        // the lookup is unnecessary.
        const target = { ...MOCKED_TARGET };
        const io = makeChatStateIO();

        const chat = [
            { is_user: true,  mes: 'u1', swipe_id: 0 },
            { is_user: false, mes: 'a1', swipe_id: 0 },
            { is_user: true,  mes: 'u2', swipe_id: 0 },
            // Empty placeholder — director fires its tool call here, before
            // streaming has produced any text. anchor.floor = 3, anchor.turnSeq
            // = 2 (only one extractable assistant before the tail).
            { is_user: false, mes: '', swipe_id: 0 },
        ];

        const buildObjectPatchOperationsAsync = async (prev, next) =>
            compare(prev ?? {}, next ?? {});

        let fsInstance = null;

        const context = {
            chat,
            chatId: 'session-test-chat',
            getChatState:    (...args) => io.getChatState(...args),
            updateChatState: (...args) => io.updateChatState(...args),
            patchChatState:  (...args) => io.patchChatState(...args),
            buildObjectPatchOperationsAsync,
            createFloorState: async ({ namespace }) => {
                fsInstance = createFloorStateWithDeps(
                    { namespace },
                    {
                        getChatState:    (ns, opts) => io.getChatState(ns, { target, ...(opts || {}) }),
                        updateChatState: (ns, u, opts) => io.updateChatState(ns, u, { target, ...(opts || {}) }),
                        patchChatState:  (ns, ops, opts) => io.patchChatState(ns, ops, { target, ...(opts || {}) }),
                        buildObjectPatchOperationsAsync,
                        getChat: () => chat,
                    },
                );
                await fsInstance.ready();
                return fsInstance;
            },
            characterId: 0,
            groupId: null,
        };

        const session = await openSession(context);
        expect(session).not.toBeNull();

        const created = await session.createNode({
            type: 'event',
            title: 'pre-stream-director-write',
            fields: { what: 'tool call before any streamed text' },
        });
        expect(created?.id).toBeTruthy();

        const partition = io.partitionFor(target);
        const log = partition.get('memory_graph__floor_log');
        expect(log).toBeTruthy();
        const floors = log.commits.map(c => c.floor);
        // The commit must land on the in-flight placeholder (floor 3) so a
        // subsequent MESSAGE_DELETED at chat.length=3 truncates it away.
        expect(floors).toContain(3);

        const data = await fsInstance.get();
        expect(data?.nodes?.[created.id]).toBeTruthy();

        // Tail-delete the placeholder; the commit at floor=3 must drop and
        // the replayed state must no longer carry the node.
        chat.length = 3;
        await fsInstance.__handleMessageDeleted(3);

        const logAfter = partition.get('memory_graph__floor_log');
        const floorsAfter = logAfter.commits.map(c => c.floor);
        expect(floorsAfter).not.toContain(3);

        const dataAfter = await fsInstance.get();
        expect(dataAfter?.nodes?.[created.id]).toBeUndefined();
    });
});
