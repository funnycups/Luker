import { jest } from '@jest/globals';

// Stub the lib.js boundary the iteration-library helpers reach for lodash through.
jest.unstable_mockModule('../../public/lib.js', async () => {
    const { default: lodash } = await import('lodash');
    return { lodash };
});

// Mock the iteration-library runner so we can script LLM responses per round.
// The studio's multi-round loop calls ITER_RUNNER.requestToolCallsWithRetry once
// per round; each mock invocation simulates one round of the model emitting
// tool calls + control flags via onAssistantText / onToolCall / onControlCall.
// We mock the iteration-library/index umbrella so we don't drag the full
// dep chain (lib/edits, lib.js core bundle, popup.js shell) into a unit test
// that only exercises the runner-driven multi-round loop.
const requestToolCallsWithRetryMock = jest.fn();
const ensureUiStylesheetInjectedMock = jest.fn();
const ensureMarkdownDepsMock = jest.fn().mockResolvedValue(true);
jest.unstable_mockModule('../../public/scripts/iteration-library/index.js', () => ({
    applyEdits: (edits, live) => ({ newLive: live, clean: edits, conflicts: [], alreadyDone: [] }),
    inverseEdit: (edit) => edit,
    registerOp: () => {},
    BUILT_IN_OPS: {},
    showConflictResolution: async () => ({}),
    render: {
        ensureMarkdownDeps: ensureMarkdownDepsMock,
        renderMessageMarkdown: (s) => String(s ?? ''),
    },
    runner: {
        requestToolCallsWithRetry: requestToolCallsWithRetryMock,
    },
    storage: {},
    textDiff: {},
    zoomOverlay: {
        attachZoomOverlay: () => () => {},
    },
    ui: {
        toolcall: { renderToolCallChip: () => '' },
        message: { renderMessageCard: () => '' },
        diff: { renderDiffCard: () => '' },
        apply: { renderApplyControls: () => '' },
        ensureUiStylesheetInjected: ensureUiStylesheetInjectedMock,
    },
    bindIterWorkspaceResizer: () => () => {},
}));

// Mock the legacy CEA editor helper-tool runner so read-tool dispatch returns
// a deterministic stub instead of touching the SillyTavern shell.
jest.unstable_mockModule('../../public/scripts/extensions/character-editor-assistant/main.js', () => ({
    runCharacterEditorHelperToolCall: async (call) => ({
        result: { stub: true, name: call?.name || '', args: call?.args || {} },
    }),
    // studio.js imports these for the multi-target Apply commit.
    // The runner suite doesn't exercise Apply, so plain noop spies are
    // enough — without them the import chain throws at load time.
    commitCharacterEditorOperations: async () => ({ ok: true }),
    commitLorebookOperations: async () => ({ ok: true }),
    // studio.js imports these for the entry-point bootstrap. The
    // runner suite drives _testOnly_runIterationTurn directly and never
    // mounts the popup, so neither bootstrap helper actually fires; the
    // exports just need to be resolvable at module load.
    buildCharacterEditorHelperApis: () => [],
    buildUnifiedCharacterEditorLiveSnapshot: async () => ({ character: {}, lorebooks: {} }),
    readLegacyCeaEditorSessions: async () => [],
    readLegacyCharIterPopupSessions: async () => [],
}));

// Mock popup.js to dodge DOM-mount imports — runner test doesn't open the popup.
jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    Popup: class { constructor() {} show() { return Promise.resolve('ok'); } completeAffirmative() {} dlg = { close: () => {} }; },
    POPUP_TYPE: { DISPLAY: 'display' },
}));

let studio;
beforeAll(async () => {
    studio = await import('../../public/scripts/extensions/character-editor-assistant/editor-iteration/studio.js');
});

beforeEach(() => {
    requestToolCallsWithRetryMock.mockReset();
});

/**
 * Build a fake `requestToolCallsWithRetry` implementation that fires the
 * runner's per-event callbacks (onAssistantText / onToolCall / onControlCall)
 * the same way the real implementation does, then returns the matching
 * `{ toolCalls, assistantText }` payload.
 *
 * `script` is an array of round descriptors; each descriptor has:
 *   - assistantText:  string
 *   - toolCalls:      Array<{ id, name, args }>     (control + non-control)
 *
 * The mock walks the script in order, advancing one entry per call.
 */
function scriptRounds(script) {
    let idx = 0;
    requestToolCallsWithRetryMock.mockImplementation(async (_context, _settings, opts) => {
        const entry = script[idx] ?? script[script.length - 1];
        idx++;
        const calls = Array.isArray(entry?.toolCalls) ? entry.toolCalls : [];
        const isControl = typeof opts?.isControlCall === 'function' ? opts.isControlCall : (() => false);
        if (typeof opts?.onAssistantText === 'function' && entry?.assistantText) {
            opts.onAssistantText(String(entry.assistantText));
        }
        if (typeof opts?.onToolCall === 'function' || typeof opts?.onControlCall === 'function') {
            for (const call of calls) {
                const cb = isControl(call) ? opts.onControlCall : opts.onToolCall;
                if (typeof cb === 'function') {
                    cb(call);
                }
            }
        }
        return {
            toolCalls: calls,
            assistantText: String(entry?.assistantText || ''),
            rawAssistantText: String(entry?.assistantText || ''),
        };
    });
}

describe('unified CEA editor multi-round read+edit flow', () => {
    it('exports a test-only handle for the iteration turn loop', () => {
        expect(typeof studio._testOnly_runIterationTurn).toBe('function');
    });

    it('runs read tool → tool_result → next round, then edits, then finalize', async () => {
        scriptRounds([
            // Round 1: a read tool. No control call → auto-continues because
            // every call this round was a read (per spec auto-continue logic).
            {
                assistantText: 'reading…',
                toolCalls: [
                    { id: 'r1', name: 'lorebook_query', args: { book_name: 'BookA', query: 'x' } },
                ],
            },
            // Round 2: an edit tool plus an explicit continue control. The
            // edit lands in pendingEdits; continue routes the loop forward.
            {
                assistantText: 'editing…',
                toolCalls: [
                    { id: 'e1', name: 'cea_update_lorebook_entry', args: { book_name: 'BookA', uid: 0, patch: { content: 'new' } } },
                    { id: 'k1', name: 'luker_cea_editor_continue_iteration', args: {} },
                ],
            },
            // Round 3: finalize control → loop exits, surfaceState.isFinalized
            // becomes true and no further requestToolCallsWithRetry fires.
            {
                assistantText: 'finalizing…',
                toolCalls: [
                    { id: 'f1', name: 'luker_cea_editor_finalize_iteration', args: { summary: 'done' } },
                ],
            },
        ]);

        const state = {
            session: {
                id: 's1',
                title: 't',
                avatar: 'a.png',
                messages: [],
                surfaceState: {},
                pendingEdits: [],
            },
            live: {
                character: { description: 'old' },
                lorebooks: { 'BookA': { entries: [{ uid: 0, content: 'a' }], meta: {} } },
            },
            pendingEdits: [],
            isBusy: false,
            abortController: null,
        };

        await studio._testOnly_runIterationTurn(state, {
            userText: 'please update BookA entry 0',
            context: { generateTask: async () => ({}) },
            settings: {},
        });

        // The runner was driven through 3 rounds (one mock call per round).
        expect(requestToolCallsWithRetryMock.mock.calls.length).toBeGreaterThanOrEqual(3);

        // The edit tool produced at least one entry in pendingEdits, tagged
        // with a lorebook target so the apply step can route correctly.
        expect(state.pendingEdits.length).toBeGreaterThanOrEqual(1);
        const editTargets = state.pendingEdits.map(e => e?.target?.kind);
        expect(editTargets).toContain('lorebook');

        // Finalize is sticky on surfaceState.
        expect(state.session.surfaceState?.isFinalized).toBe(true);

        // The session messages should record an assistant message per round
        // so the user can see what happened in each step.
        const assistants = state.session.messages.filter(m => m.role === 'assistant');
        expect(assistants.length).toBeGreaterThanOrEqual(3);

        // At least one assistant message carries a toolResults entry that
        // references the read tool's id — proves the loop threaded the
        // read result back into the conversation history.
        const hasReadResult = assistants.some(m => Array.isArray(m.toolResults)
            && m.toolResults.some(r => r.tool_call_id === 'r1'));
        expect(hasReadResult).toBe(true);
    });

    it('exits the loop without auto-continuing when a non-read round emits edits but no continue', async () => {
        scriptRounds([
            // Round 1: a single edit tool, NO control call. The loop should
            // pause here so the user can review pendingEdits before any
            // further AI activity (matches spec auto-continue gating).
            {
                assistantText: 'one-shot edit',
                toolCalls: [
                    { id: 'e1', name: 'cea_set_card_field', args: { field: 'description', value: 'updated' } },
                ],
            },
            // Round 2 should never fire — this entry exists only as a guard
            // to surface a bug if the loop incorrectly auto-continues.
            {
                assistantText: 'should not run',
                toolCalls: [
                    { id: 'f1', name: 'luker_cea_editor_finalize_iteration', args: {} },
                ],
            },
        ]);

        const state = {
            session: { id: 's2', title: '', avatar: 'a.png', messages: [], surfaceState: {}, pendingEdits: [] },
            live: { character: { description: 'old' }, lorebooks: {} },
            pendingEdits: [],
            isBusy: false,
            abortController: null,
        };

        await studio._testOnly_runIterationTurn(state, {
            userText: 'tighten description',
            context: { generateTask: async () => ({}) },
            settings: {},
        });

        expect(requestToolCallsWithRetryMock.mock.calls.length).toBe(1);
        expect(state.pendingEdits.length).toBeGreaterThanOrEqual(1);
        expect(state.pendingEdits[0]?.target?.kind).toBe('character');
        // Not finalized — the user controls the next move via Apply / Discard.
        expect(state.session.surfaceState?.isFinalized).toBeFalsy();
    });

    it('finalize is sticky even when continue is also emitted in the same round', async () => {
        scriptRounds([
            {
                assistantText: 'both flags',
                toolCalls: [
                    { id: 'k1', name: 'luker_cea_editor_continue_iteration', args: {} },
                    { id: 'f1', name: 'luker_cea_editor_finalize_iteration', args: { summary: 'really done' } },
                ],
            },
            {
                assistantText: 'must not run',
                toolCalls: [{ id: 'x', name: 'cea_set_card_field', args: { field: 'name', value: 'X' } }],
            },
        ]);

        const state = {
            session: { id: 's3', title: '', avatar: 'a.png', messages: [], surfaceState: {}, pendingEdits: [] },
            live: { character: {}, lorebooks: {} },
            pendingEdits: [],
            isBusy: false,
            abortController: null,
        };

        await studio._testOnly_runIterationTurn(state, {
            userText: 'go',
            context: { generateTask: async () => ({}) },
            settings: {},
        });

        expect(requestToolCallsWithRetryMock.mock.calls.length).toBe(1);
        expect(state.session.surfaceState?.isFinalized).toBe(true);
        expect(state.pendingEdits.length).toBe(0);
    });

    it('auto-continues past the historic 10-round cap when the model keeps reading', async () => {
        // Pure-read rounds auto-continue (the model needs another turn to
        // act on the result). Earlier builds capped this at 10 rounds, which
        // silently truncated long sessions; the cap is gone. Drive 15 read
        // rounds + a finalize and verify all 16 calls fire — i.e. the loop
        // is NOT short-circuited at round 10.
        const script = Array.from({ length: 15 }, (_, i) => ({
            assistantText: `read round ${i}`,
            toolCalls: [{ id: `r${i}`, name: 'lorebook_list', args: { book_name: 'BookA' } }],
        }));
        script.push({
            assistantText: 'all done',
            toolCalls: [{ id: 'fin', name: 'luker_cea_editor_finalize_iteration', args: { summary: 'wrapped' } }],
        });
        scriptRounds(script);

        const state = {
            session: { id: 's4', title: '', avatar: 'a.png', messages: [], surfaceState: {}, pendingEdits: [] },
            live: { character: {}, lorebooks: { BookA: { entries: [], meta: {} } } },
            pendingEdits: [],
            isBusy: false,
            abortController: null,
        };

        await studio._testOnly_runIterationTurn(state, {
            userText: 'go',
            context: { generateTask: async () => ({}) },
            settings: {},
        });

        expect(requestToolCallsWithRetryMock.mock.calls.length).toBe(16);
        expect(state.session.surfaceState?.isFinalized).toBe(true);
    });

    it('aborting mid-loop exits cleanly without throwing', async () => {
        // Round 1 fires, then we trip the abort signal so the loop exits
        // before round 2 even though the script still has entries.
        scriptRounds([
            {
                assistantText: 'first round',
                toolCalls: [{ id: 'r1', name: 'lorebook_list', args: { book_name: 'BookA' } }],
            },
            {
                assistantText: 'should be aborted',
                toolCalls: [{ id: 'f1', name: 'luker_cea_editor_finalize_iteration', args: {} }],
            },
        ]);

        const ac = new AbortController();
        // Abort *after* the first round runs by hooking the mock to trip it.
        requestToolCallsWithRetryMock.mockImplementationOnce(async (_ctx, _s, opts) => {
            if (typeof opts?.onAssistantText === 'function') opts.onAssistantText('first');
            if (typeof opts?.onToolCall === 'function') {
                opts.onToolCall({ id: 'r1', name: 'lorebook_list', args: { book_name: 'BookA' } });
            }
            ac.abort();   // user clicked Stop after round 1 dispatched
            return {
                toolCalls: [{ id: 'r1', name: 'lorebook_list', args: { book_name: 'BookA' } }],
                assistantText: 'first',
                rawAssistantText: 'first',
            };
        });

        const state = {
            session: { id: 's5', title: '', avatar: 'a.png', messages: [], surfaceState: {}, pendingEdits: [] },
            live: { character: {}, lorebooks: { BookA: { entries: [], meta: {} } } },
            pendingEdits: [],
            isBusy: false,
            abortController: ac,
        };

        // Must not throw.
        await expect(studio._testOnly_runIterationTurn(state, {
            userText: 'go',
            context: { generateTask: async () => ({}) },
            settings: {},
            abortSignal: ac.signal,
        })).resolves.not.toThrow();

        // The loop exited after round 1 — no second round even though the
        // script had one teed up.
        expect(requestToolCallsWithRetryMock.mock.calls.length).toBe(1);
    });
});
