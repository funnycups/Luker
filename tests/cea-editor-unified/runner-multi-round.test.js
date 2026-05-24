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

    it('runs read tool → tool_result → next round, then edits, then exits on plain text', async () => {
        scriptRounds([
            // Round 1: a read tool. hadAnyToolCall=true → auto-continues.
            {
                assistantText: 'reading…',
                toolCalls: [
                    { id: 'r1', name: 'lorebook_query', args: { book_name: 'BookA', query: 'x' } },
                ],
            },
            // Round 2: an edit tool. hadAnyToolCall=true → auto-continues.
            // (The legacy `luker_cea_editor_continue_iteration` is no longer
            // a control tool; emitting it here would just be another tool
            // call. We omit it because it's now noise.)
            {
                assistantText: 'editing…',
                toolCalls: [
                    { id: 'e1', name: 'cea_update_lorebook_entry', args: { book_name: 'BookA', uid: 0, patch: { content: 'new' } } },
                ],
            },
            // Round 3: plain text, no tool calls → loop exits because
            // hadAnyToolCall is false.
            {
                assistantText: 'all done',
                toolCalls: [],
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

        // The runner was driven through 2 rounds (read → edit). Round 2
        // emits an edit, which lands in pendingEdits — the loop pauses
        // for human review (Apply / Discard) per the IDE-style approval
        // gate. Round 3 (the plain-text scripted entry) doesn't fire here.
        expect(requestToolCallsWithRetryMock.mock.calls.length).toBe(2);

        // The edit tool produced at least one entry in pendingEdits, tagged
        // with a lorebook target so the apply step can route correctly.
        expect(state.pendingEdits.length).toBeGreaterThanOrEqual(1);
        const editTargets = state.pendingEdits.map(e => e?.target?.kind);
        expect(editTargets).toContain('lorebook');

        // The loop exited because round 3 emitted no tool calls — there is
        // no separate "isFinalized" surface state in the program-driven
        // model; a plain-text response just ends the loop.
        expect(state.session.surfaceState?.isFinalized).toBeFalsy();

        // The session messages should record an assistant message per round
        // so the user can see what happened in each step.
        const assistants = state.session.messages.filter(m => m.role === 'assistant');
        expect(assistants.length).toBeGreaterThanOrEqual(2);

        // At least one assistant message carries a toolResults entry that
        // references the read tool's id — proves the loop threaded the
        // read result back into the conversation history.
        const hasReadResult = assistants.some(m => Array.isArray(m.toolResults)
            && m.toolResults.some(r => r.tool_call_id === 'r1'));
        expect(hasReadResult).toBe(true);
    });

    it('pauses the loop when an edit-emitting round lands pending edits awaiting human approval', async () => {
        scriptRounds([
            // Round 1: a single edit tool → pendingEdits gate triggers,
            // loop pauses for human review (Apply / Discard).
            {
                assistantText: 'first edit',
                toolCalls: [
                    { id: 'e1', name: 'cea_set_card_field', args: { field: 'description', value: 'updated' } },
                ],
            },
            // Round 2 (scripted but should never fire) — loop pauses after
            // round 1 because pendingEdits has entries awaiting approval.
            {
                assistantText: 'should not run',
                toolCalls: [],
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

        // Only 1 round fires — the pendingEdits gate halts the loop so
        // the user can Apply / Discard before another auto-round mutates
        // state on top of unreviewed edits.
        expect(requestToolCallsWithRetryMock.mock.calls.length).toBe(1);
        expect(state.pendingEdits.length).toBeGreaterThanOrEqual(1);
        expect(state.pendingEdits[0]?.target?.kind).toBe('character');
        // Not finalized — the user controls the next move via Apply / Discard.
        expect(state.session.surfaceState?.isFinalized).toBeFalsy();
    });

    it('legacy continue + finalize calls flow through as regular tool calls and the loop continues until a no-tool round', async () => {
        scriptRounds([
            // Round 1: the legacy continue + finalize tools both fire. They
            // are no longer control tools — they pass through onToolCall as
            // unknown tool names that normalizeToolCallToEdit silently no-
            // ops. hadAnyToolCall is true → loop continues.
            {
                assistantText: 'legacy emissions',
                toolCalls: [
                    { id: 'k1', name: 'luker_cea_editor_continue_iteration', args: {} },
                    { id: 'f1', name: 'luker_cea_editor_finalize_iteration', args: { summary: 'really done' } },
                ],
            },
            // Round 2: a real edit lands.
            {
                assistantText: 'follow-up',
                toolCalls: [{ id: 'x', name: 'cea_set_card_field', args: { field: 'name', value: 'X' } }],
            },
            // Round 3: plain text → loop exits.
            {
                assistantText: 'all set',
                toolCalls: [],
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

        // Round 1: legacy continue+finalize names are not control tools
        // (no pendingEdits produced) → loop continues. Round 2: a real
        // edit lands → pendingEdits gate halts the loop for human review.
        // Round 3 (scripted) never fires.
        expect(requestToolCallsWithRetryMock.mock.calls.length).toBe(2);
        expect(state.session.surfaceState?.isFinalized).toBeFalsy();
        // The card-field edit from round 2 lands in pendingEdits.
        expect(state.pendingEdits.length).toBeGreaterThanOrEqual(1);
    });

    it('auto-continues past the historic 10-round cap when the model keeps emitting tool calls', async () => {
        // Long sessions where the model keeps emitting tools must NOT be
        // short-circuited at any cap. Drive 15 read rounds + a plain-text
        // exit round and verify all 16 calls fire — i.e. the loop runs
        // exactly as long as tool calls are emitted, no hidden ceiling.
        const script = Array.from({ length: 15 }, (_, i) => ({
            assistantText: `read round ${i}`,
            toolCalls: [{ id: `r${i}`, name: 'lorebook_list', args: { book_name: 'BookA' } }],
        }));
        script.push({
            assistantText: 'all done',
            toolCalls: [],
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
        // Loop exited because the final round emitted no tool calls.
        expect(state.session.surfaceState?.isFinalized).toBeFalsy();
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
