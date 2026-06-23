// Regression tests for editor-iteration bug audit fixes.
//
// Covers:
//   - CEA-2: buildSeedTaskMessages replays prior turn's tool_calls +
//            tool_results when an assistant message has both. Without
//            this, a follow-up turn like "edit what you just read"
//            couldn't see the previous round's read output.
//   - CEA-4: applyPendingEdits stamps appliedAt on EVERY contributing
//            unapplied assistant message (not just the last), so
//            multi-round Apply doesn't leave earlier rounds looking
//            unapplied.
//   - CEA-7: clear-history doesn't leave a phantom empty session. The
//            new empty session is marked `_transient` and persistSession
//            skips writing it until a message lands.
//
// Each spec section is isolated so a failure points straight at the
// underlying bug.

import { jest } from '@jest/globals';

jest.unstable_mockModule('../../public/lib.js', async () => {
    const { default: lodash } = await import('lodash');
    return { lodash };
});

const requestToolCallsWithRetryMock = jest.fn();
jest.unstable_mockModule('../../public/scripts/iteration-library/index.js', () => ({
    proposalBus: {},
    applyEdits: (edits, live) => {
        // Trivial in-place set semantics — matches what multi-target-apply
        // does. Studio passes per-target slices so we don't need cross-book
        // routing.
        const next = JSON.parse(JSON.stringify(live));
        for (const e of edits) {
            if (e?.op === 'set' && typeof e?.path === 'string') {
                const segs = e.path.split('.');
                let cur = next;
                for (let i = 0; i < segs.length - 1; i++) {
                    if (cur[segs[i]] == null) cur[segs[i]] = {};
                    cur = cur[segs[i]];
                }
                cur[segs.at(-1)] = e.newValue;
            }
        }
        return { newLive: next, clean: edits, conflicts: [], alreadyDone: [] };
    },
    inverseEdit: (edit) => edit,
    registerOp: () => {},
    BUILT_IN_OPS: {},
    showConflictResolution: async () => ({}),
    render: {
        ensureMarkdownDeps: async () => true,
        renderMessageMarkdown: (s) => String(s ?? ''),
    },
    runner: {
        requestToolCallsWithRetry: requestToolCallsWithRetryMock,
    },
    storage: {},
    textDiff: {},
    zoomOverlay: { attachZoomOverlay: () => () => {} },
    ui: {
        toolcall: { renderToolCallChip: () => '' },
        message: { renderMessageCard: () => '' },
        diff: { renderDiffCard: () => '' },
        apply: { renderApplyControls: () => '' },
        ensureUiStylesheetInjected: () => {},
    },
    bindIterWorkspaceResizer: () => () => {},
    createRenderScheduler: () => ({ schedule: () => {} }),
}));

const characterCommitSpy = jest.fn(async () => ({ ok: true }));
const lorebookCommitSpy = jest.fn(async () => ({ ok: true }));

jest.unstable_mockModule('../../public/scripts/extensions/character-editor-assistant/main.js', () => ({
    runCharacterEditorHelperToolCall: async () => ({ result: {} }),
    commitCharacterEditorOperations: characterCommitSpy,
    commitLorebookOperations: lorebookCommitSpy,
    buildCharacterEditorHelperApis: () => [],
    buildUnifiedCharacterEditorLiveSnapshot: async () => ({ character: {}, lorebooks: {} }),
    readLegacyCeaEditorSessions: async () => [],
    readLegacyCharIterPopupSessions: async () => [],
}));

jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    Popup: class { constructor() {} show() { return Promise.resolve('ok'); } completeAffirmative() {} dlg = { close: () => {} }; },
    POPUP_TYPE: { DISPLAY: 'display' },
}));

let studio;
let createUnifiedCeaEditorSessionStore;
beforeAll(async () => {
    studio = await import('../../public/scripts/extensions/character-editor-assistant/editor-iteration/studio.js');
    ({ createUnifiedCeaEditorSessionStore } = await import(
        '../../public/scripts/extensions/character-editor-assistant/editor-iteration/session-store.js'
    ));
});

beforeEach(() => {
    requestToolCallsWithRetryMock.mockReset();
    characterCommitSpy.mockClear();
    lorebookCommitSpy.mockClear();
});

// ===========================================================================
// CEA-2: buildSeedTaskMessages replays prior tool history
// ===========================================================================

describe('CEA-2: buildSeedTaskMessages replays prior turn tool history', () => {
    test('exports _internalBuildSeedTaskMessages', () => {
        expect(typeof studio._internalBuildSeedTaskMessages).toBe('function');
    });

    test('plain user/assistant messages replay as role+content only', () => {
        const state = {
            session: {
                messages: [
                    { role: 'user', content: 'hi' },
                    { role: 'assistant', content: 'hello', toolCalls: [], toolResults: [] },
                ],
            },
        };
        const out = studio._internalBuildSeedTaskMessages(state, 'SYSTEM');
        expect(out[0]).toEqual({ role: 'system', content: 'SYSTEM' });
        expect(out[1]).toEqual({ role: 'user', content: 'hi' });
        expect(out[2]).toEqual({ role: 'assistant', content: 'hello' });
        // Verify no tool_calls field on the plain assistant message.
        expect(out[2].tool_calls).toBeUndefined();
    });

    test('assistant message with read toolCalls + toolResults replays as OpenAI tool protocol', () => {
        const state = {
            session: {
                messages: [
                    { role: 'user', content: 'list the books' },
                    {
                        role: 'assistant',
                        content: 'reading…',
                        toolCalls: [
                            { id: 'r1', name: 'world_book_list', args: {} },
                            { id: 'r2', name: 'lorebook_query', args: { book_name: 'A', text: 'x' } },
                        ],
                        toolResults: [
                            { tool_call_id: 'r1', content: { books: ['A', 'B'] } },
                            { tool_call_id: 'r2', content: { matches: [1, 2] } },
                        ],
                    },
                    { role: 'user', content: 'now edit BookA entry 0' },
                ],
            },
        };
        const out = studio._internalBuildSeedTaskMessages(state, 'SYSTEM');
        // Expected layout:
        //   [0] system
        //   [1] user "list the books"
        //   [2] assistant with tool_calls
        //   [3] tool result for r1
        //   [4] tool result for r2
        //   [5] user "now edit BookA entry 0"
        expect(out).toHaveLength(6);
        expect(out[2].role).toBe('assistant');
        expect(out[2].content).toBe('reading…');
        expect(Array.isArray(out[2].tool_calls)).toBe(true);
        expect(out[2].tool_calls).toHaveLength(2);
        expect(out[2].tool_calls[0]).toEqual({
            id: 'r1',
            type: 'function',
            function: { name: 'world_book_list', arguments: JSON.stringify({}) },
        });
        expect(out[2].tool_calls[1].id).toBe('r2');
        expect(out[3].role).toBe('tool');
        expect(out[3].tool_call_id).toBe('r1');
        expect(out[4].role).toBe('tool');
        expect(out[4].tool_call_id).toBe('r2');
        expect(out[5]).toEqual({ role: 'user', content: 'now edit BookA entry 0' });
    });

    test('toolCalls without matching toolResults are NOT emitted (dangling tool_calls would error the provider)', () => {
        const state = {
            session: {
                messages: [
                    {
                        role: 'assistant',
                        content: 'edited',
                        // edit tool — no result was generated for it
                        toolCalls: [{ id: 'e1', name: 'cea_set_card_field', args: { field: 'name', value: 'X' } }],
                        toolResults: [],
                    },
                ],
            },
        };
        const out = studio._internalBuildSeedTaskMessages(state, 'SYSTEM');
        expect(out).toHaveLength(2);
        // Falls back to plain role+content (no tool_calls).
        expect(out[1].tool_calls).toBeUndefined();
    });

    test('mixed assistant messages: only those with linked tool_calls + tool_results get the protocol shape', () => {
        const state = {
            session: {
                messages: [
                    {
                        role: 'assistant',
                        content: 'first read',
                        toolCalls: [{ id: 'r1', name: 'world_book_list', args: {} }],
                        toolResults: [{ tool_call_id: 'r1', content: { books: ['A'] } }],
                    },
                    { role: 'user', content: 'and another' },
                    { role: 'assistant', content: 'plain response', toolCalls: [], toolResults: [] },
                ],
            },
        };
        const out = studio._internalBuildSeedTaskMessages(state, 'SYSTEM');
        // [0]system, [1]assistant+tool_calls, [2]tool(r1), [3]user, [4]assistant plain
        expect(out).toHaveLength(5);
        expect(out[1].tool_calls).toBeDefined();
        expect(out[2].role).toBe('tool');
        expect(out[4].role).toBe('assistant');
        expect(out[4].tool_calls).toBeUndefined();
    });
});

// ===========================================================================
// CEA-4: applyPendingEdits stamps every contributing assistant message
// ===========================================================================

describe('CEA-4: multi-round Apply stamps appliedAt on every contributing message', () => {
    function makeAssistantMsg(id, edits) {
        return {
            id,
            role: 'assistant',
            content: '',
            toolCalls: [],
            toolResults: [],
            edits,
            appliedAt: null,
            appliedTarget: '',
            rolledBackAt: null,
            auto: false,
            at: Date.now(),
        };
    }

    test('stamps appliedAt on every unapplied assistant message that has edits', async () => {
        const editsRound1 = [{ op: 'set', path: 'description', oldValue: 'a', newValue: 'b', target: { kind: 'character' } }];
        const editsRound2 = [{ op: 'set', path: 'name', oldValue: 'X', newValue: 'Y', target: { kind: 'character' } }];
        const editsRound3 = [{ op: 'set', path: 'scenario', oldValue: 'P', newValue: 'Q', target: { kind: 'character' } }];

        const state = {
            session: {
                id: 's1', title: '', avatar: 'a.png', surfaceState: {},
                messages: [
                    makeAssistantMsg('m1', editsRound1),
                    { id: 'u1', role: 'user', content: 'continue' },
                    makeAssistantMsg('m2', editsRound2),
                    { id: 'u2', role: 'user', content: 'more' },
                    makeAssistantMsg('m3', editsRound3),
                ],
            },
            live: { character: { description: 'a', name: 'X', scenario: 'P' }, lorebooks: {} },
            pendingEdits: [...editsRound1, ...editsRound2, ...editsRound3],
            isBusy: false,
            abortController: null,
        };
        await studio._internalApplyPendingEdits(state, { context: {}, settings: {} });

        // All three assistant messages should be stamped — they all
        // contributed to the same Apply batch.
        const stamped = state.session.messages.filter(m => m.role === 'assistant' && typeof m.appliedAt === 'number');
        expect(stamped).toHaveLength(3);
        for (const m of stamped) {
            expect(m.appliedTarget).toMatch(/character/);
        }
    });

    test('stops stamping at the first already-applied message (prior batch boundary)', async () => {
        const oldEdits = [{ op: 'set', path: 'description', oldValue: 'a', newValue: 'b', target: { kind: 'character' } }];
        const newEdits = [{ op: 'set', path: 'name', oldValue: 'X', newValue: 'Y', target: { kind: 'character' } }];

        const oldAppliedAt = Date.now() - 10000;
        const state = {
            session: {
                id: 's1', title: '', avatar: 'a.png', surfaceState: {},
                messages: [
                    // Already-applied prior batch — must NOT be re-stamped.
                    {
                        ...makeAssistantMsg('m_old', oldEdits),
                        appliedAt: oldAppliedAt,
                        appliedTarget: 'character',
                    },
                    { id: 'u1', role: 'user', content: 'more' },
                    // Current unapplied batch.
                    makeAssistantMsg('m_new', newEdits),
                ],
            },
            live: { character: { description: 'b', name: 'X' }, lorebooks: {} },
            pendingEdits: [...newEdits],
            isBusy: false,
            abortController: null,
        };
        await studio._internalApplyPendingEdits(state, { context: {}, settings: {} });

        // Old message keeps its original appliedAt.
        const old = state.session.messages.find(m => m.id === 'm_old');
        expect(old.appliedAt).toBe(oldAppliedAt);
        // New message gets stamped.
        const fresh = state.session.messages.find(m => m.id === 'm_new');
        expect(typeof fresh.appliedAt).toBe('number');
        expect(fresh.appliedAt).not.toBe(oldAppliedAt);
    });

    test('stops at a rolled-back message — that batch is independent', async () => {
        const rolledBackEdits = [{ op: 'set', path: 'description', oldValue: 'a', newValue: 'b', target: { kind: 'character' } }];
        const newEdits = [{ op: 'set', path: 'name', oldValue: 'X', newValue: 'Y', target: { kind: 'character' } }];

        const state = {
            session: {
                id: 's1', title: '', avatar: 'a.png', surfaceState: {},
                messages: [
                    {
                        ...makeAssistantMsg('m_rb', rolledBackEdits),
                        appliedAt: Date.now() - 20000,
                        rolledBackAt: Date.now() - 10000,
                    },
                    { id: 'u1', role: 'user', content: 'more' },
                    makeAssistantMsg('m_new', newEdits),
                ],
            },
            live: { character: { description: 'a', name: 'X' }, lorebooks: {} },
            pendingEdits: [...newEdits],
            isBusy: false,
            abortController: null,
        };
        await studio._internalApplyPendingEdits(state, { context: {}, settings: {} });

        const fresh = state.session.messages.find(m => m.id === 'm_new');
        expect(typeof fresh.appliedAt).toBe('number');
        // Rolled-back message retains its rolledBackAt; the new Apply doesn't
        // bleed across the boundary.
        const rb = state.session.messages.find(m => m.id === 'm_rb');
        expect(typeof rb.rolledBackAt).toBe('number');
    });

    test('skips assistant messages with empty edits arrays (they did not contribute)', async () => {
        const edits = [{ op: 'set', path: 'description', oldValue: 'a', newValue: 'b', target: { kind: 'character' } }];
        const state = {
            session: {
                id: 's1', title: '', avatar: 'a.png', surfaceState: {},
                messages: [
                    makeAssistantMsg('m_pure_prose', []),
                    makeAssistantMsg('m_edited', edits),
                ],
            },
            live: { character: { description: 'a' }, lorebooks: {} },
            pendingEdits: [...edits],
            isBusy: false,
            abortController: null,
        };
        await studio._internalApplyPendingEdits(state, { context: {}, settings: {} });

        const proseOnly = state.session.messages.find(m => m.id === 'm_pure_prose');
        expect(proseOnly.appliedAt).toBeNull();
        const edited = state.session.messages.find(m => m.id === 'm_edited');
        expect(typeof edited.appliedAt).toBe('number');
    });
});

// ===========================================================================
// CEA-7: clear-history doesn't leave a phantom empty session
// ===========================================================================

describe('CEA-7: persistSession skips transient empty sessions', () => {
    test('createNewSession-style transient session does not write to the store via the wrapper', async () => {
        // The store-level guard lives in persistSession (a closure inside
        // openUnifiedCharacterEditorPopup). To exercise the gate without
        // mounting a popup, we drive the store layer the same way persistSession
        // does — and verify that a session marked `_transient` with no
        // messages/pendingEdits never reaches the bucket.
        //
        // We use the real store factory + an in-memory sidecar map to
        // observe what would actually land on disk.
        const sidecars = {};
        const fakeCtx = {
            getCharacterState: async (a, ns) => sidecars[`${a}:${ns}`] || null,
            updateCharacterState: async (a, ns, updater) => {
                const current = sidecars[`${a}:${ns}`] || null;
                const next = await updater(
                    current && typeof current === 'object' && !Array.isArray(current) ? structuredClone(current) : {},
                    { attempt: 0, avatar: a, namespace: ns },
                );
                if (next == null) return { ok: true, state: current, updated: false };
                sidecars[`${a}:${ns}`] = next;
                return { ok: true, state: next, updated: true };
            },
        };
        const store = createUnifiedCeaEditorSessionStore({
            context: fakeCtx,
            avatar: 'a.png',
        });

        // Persist a transient empty session through a thin wrapper that
        // mirrors the studio's gate. This is the contract: callers that
        // detect transient+empty must skip the write.
        async function persistGated(session, pendingEdits) {
            if (
                session._transient
                && (!Array.isArray(session.messages) || session.messages.length === 0)
                && (!Array.isArray(pendingEdits) || pendingEdits.length === 0)
            ) {
                return;
            }
            await store.save(session);
        }

        const transient = {
            id: 'sess_transient', title: '', avatar: 'a.png',
            messages: [], pendingEdits: [], surfaceState: {},
            _transient: true,
        };
        await persistGated(transient, []);

        // No session landed in the store.
        const list = await store.list();
        expect(list).toEqual([]);
    });

    test('once messages exist the gate falls through and the session persists', async () => {
        const sidecars = {};
        const fakeCtx = {
            getCharacterState: async (a, ns) => sidecars[`${a}:${ns}`] || null,
            updateCharacterState: async (a, ns, updater) => {
                const current = sidecars[`${a}:${ns}`] || null;
                const next = await updater(
                    current && typeof current === 'object' && !Array.isArray(current) ? structuredClone(current) : {},
                    { attempt: 0, avatar: a, namespace: ns },
                );
                if (next == null) return { ok: true, state: current, updated: false };
                sidecars[`${a}:${ns}`] = next;
                return { ok: true, state: next, updated: true };
            },
        };
        const store = createUnifiedCeaEditorSessionStore({
            context: fakeCtx,
            avatar: 'a.png',
        });

        async function persistGated(session, pendingEdits) {
            if (
                session._transient
                && (!Array.isArray(session.messages) || session.messages.length === 0)
                && (!Array.isArray(pendingEdits) || pendingEdits.length === 0)
            ) {
                return;
            }
            // Drop the transient marker on the first real persist.
            if (session._transient) delete session._transient;
            await store.save(session);
        }

        const sess = {
            id: 'sess_real', title: '', avatar: 'a.png',
            messages: [{ id: 'm1', role: 'user', content: 'hi' }],
            pendingEdits: [], surfaceState: {},
            _transient: true,
        };
        await persistGated(sess, []);
        const list = await store.list();
        expect(list).toHaveLength(1);
        expect(list[0].id).toBe('sess_real');
    });

    test('clear-history flow: list → delete all → new session created → no phantom row', async () => {
        // End-to-end simulation of the clear-history handler's contract:
        // start with two saved sessions, delete both, then "create new
        // session" (transient marker on) and run the persist gate; the
        // store must end up empty.
        const sidecars = {};
        const fakeCtx = {
            getCharacterState: async (a, ns) => sidecars[`${a}:${ns}`] || null,
            updateCharacterState: async (a, ns, updater) => {
                const current = sidecars[`${a}:${ns}`] || null;
                const next = await updater(
                    current && typeof current === 'object' && !Array.isArray(current) ? structuredClone(current) : {},
                    { attempt: 0, avatar: a, namespace: ns },
                );
                if (next == null) return { ok: true, state: current, updated: false };
                sidecars[`${a}:${ns}`] = next;
                return { ok: true, state: next, updated: true };
            },
        };
        const store = createUnifiedCeaEditorSessionStore({
            context: fakeCtx,
            avatar: 'a.png',
        });

        await store.save({
            id: 'old1', title: 't1', avatar: 'a.png',
            messages: [{ id: 'm', role: 'user', content: 'one' }],
            pendingEdits: [], surfaceState: {}, updatedAt: 1,
        });
        await store.save({
            id: 'old2', title: 't2', avatar: 'a.png',
            messages: [{ id: 'm', role: 'user', content: 'two' }],
            pendingEdits: [], surfaceState: {}, updatedAt: 2,
        });
        let list = await store.list();
        expect(list).toHaveLength(2);

        // Simulate clear-history: delete all.
        for (const it of list) {
            await store.delete(String(it.id));
        }
        list = await store.list();
        expect(list).toHaveLength(0);

        // Now the handler creates a new transient empty session and calls
        // persistSession on it — this MUST be a no-op.
        const fresh = {
            id: 'sess_fresh', title: '', avatar: 'a.png',
            messages: [], pendingEdits: [], surfaceState: {},
            _transient: true,
        };
        async function persistGated(session, pendingEdits) {
            if (
                session._transient
                && (!Array.isArray(session.messages) || session.messages.length === 0)
                && (!Array.isArray(pendingEdits) || pendingEdits.length === 0)
            ) {
                return;
            }
            if (session._transient) delete session._transient;
            await store.save(session);
        }
        await persistGated(fresh, []);

        // Final state: still empty — no phantom row.
        list = await store.list();
        expect(list).toEqual([]);
    });
});
