import { jest } from '@jest/globals';

// Guards the unified CEA editor's defensive fallback path in studio.js where
// the multi-round loop reaches for `result.toolCalls.filter(!isControlCall)`
// when the runner's per-event `onToolCall`/`onControlCall` callbacks didn't
// fire. Without this filter (e.g. if a runner version drift silently stops
// invoking the per-call callbacks), control tools like
// `luker_cea_editor_continue_iteration` and `luker_cea_editor_finalize_iteration`
// would leak into the persisted assistant message's `toolCalls` and get
// re-displayed as user-facing actions on subsequent renders.
//
// Regression target: editor-iteration/studio.js, the fallback at
//   const editAndReadCalls = collectedToolCalls.length > 0
//       ? collectedToolCalls
//       : (Array.isArray(result?.toolCalls)
//           ? result.toolCalls.filter(c => !isCeaEditorControlCall(c))
//           : []);

// Stub the lib.js boundary the iteration-library helpers reach for lodash through.
jest.unstable_mockModule('../../public/lib.js', async () => {
    const { default: lodash } = await import('lodash');
    return { lodash };
});

// Mock the iteration-library runner so we can script the fallback shape.
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

jest.unstable_mockModule('../../public/scripts/extensions/character-editor-assistant/main.js', () => ({
    runCharacterEditorHelperToolCall: async (call) => ({
        result: { stub: true, name: call?.name || '', args: call?.args || {} },
    }),
    commitCharacterEditorOperations: async () => ({ ok: true }),
    commitLorebookOperations: async () => ({ ok: true }),
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
beforeAll(async () => {
    studio = await import('../../public/scripts/extensions/character-editor-assistant/editor-iteration/studio.js');
});

beforeEach(() => {
    requestToolCallsWithRetryMock.mockReset();
});

describe('unified CEA editor — control-tool fallback filter', () => {
    it('does NOT leak control tools into the persisted assistant message when the runner skips onControlCall', async () => {
        // Simulate a runner-version-drift bug: the runner returns
        // result.toolCalls but never invokes onToolCall / onControlCall.
        // The studio's fallback should pick up result.toolCalls and filter
        // out control calls so they never reach the persisted message.
        requestToolCallsWithRetryMock.mockImplementationOnce(async () => ({
            toolCalls: [
                { id: 'e1', name: 'cea_set_card_field', args: { field: 'description', value: 'updated' } },
                { id: 'k1', name: 'luker_cea_editor_continue_iteration', args: {} },
                { id: 'f1', name: 'luker_cea_editor_finalize_iteration', args: { summary: 'done' } },
            ],
            assistantText: 'fallback path',
            rawAssistantText: 'fallback path',
        }));
        // Second round (in case the loop somehow auto-continues despite the
        // missing callbacks) — emit nothing so the loop quietly exits.
        requestToolCallsWithRetryMock.mockImplementation(async () => ({
            toolCalls: [],
            assistantText: '',
            rawAssistantText: '',
        }));

        const state = {
            session: {
                id: 's1',
                title: '',
                avatar: 'a.png',
                messages: [],
                surfaceState: {},
                pendingEdits: [],
            },
            live: { character: { description: 'old' }, lorebooks: {} },
            pendingEdits: [],
            isBusy: false,
            abortController: null,
        };

        await studio._testOnly_runIterationTurn(state, {
            userText: 'update description',
            context: { generateTask: async () => ({}) },
            settings: {},
        });

        // Find the assistant message persisted for this round.
        const assistants = state.session.messages.filter(m => m.role === 'assistant');
        expect(assistants.length).toBeGreaterThanOrEqual(1);
        const firstAssistant = assistants[0];

        const persistedNames = (firstAssistant.toolCalls || []).map(c => c?.name);
        // Edit tool must survive the fallback partition.
        expect(persistedNames).toContain('cea_set_card_field');
        // Control tools must NOT leak through — this is the load-bearing
        // assertion that catches a missing fallback filter.
        expect(persistedNames).not.toContain('luker_cea_editor_continue_iteration');
        expect(persistedNames).not.toContain('luker_cea_editor_finalize_iteration');
    });

    it('still routes control tools properly when the per-event callbacks DO fire (regression sanity)', async () => {
        // The happy path: callbacks fire, collectedToolCalls is non-empty,
        // so the fallback branch never runs. Even so, control tools must
        // not appear in the persisted toolCalls — the per-event split
        // already prevents that. This guards against accidentally moving
        // control tools into collectedToolCalls via onToolCall.
        requestToolCallsWithRetryMock.mockImplementationOnce(async (_ctx, _settings, opts) => {
            const calls = [
                { id: 'e1', name: 'cea_set_card_field', args: { field: 'description', value: 'v2' } },
                { id: 'k1', name: 'luker_cea_editor_continue_iteration', args: {} },
            ];
            const isControl = typeof opts?.isControlCall === 'function' ? opts.isControlCall : (() => false);
            if (typeof opts?.onAssistantText === 'function') opts.onAssistantText('happy path');
            for (const call of calls) {
                if (isControl(call)) {
                    opts.onControlCall?.(call);
                } else {
                    opts.onToolCall?.(call);
                }
            }
            return { toolCalls: calls, assistantText: 'happy path', rawAssistantText: 'happy path' };
        });
        // Second round to satisfy the continue: emit a finalize so the
        // loop exits cleanly without a 10-round cap.
        requestToolCallsWithRetryMock.mockImplementationOnce(async (_ctx, _settings, opts) => {
            const calls = [{ id: 'f1', name: 'luker_cea_editor_finalize_iteration', args: { summary: 'ok' } }];
            if (typeof opts?.onAssistantText === 'function') opts.onAssistantText('done');
            for (const call of calls) opts.onControlCall?.(call);
            return { toolCalls: calls, assistantText: 'done', rawAssistantText: 'done' };
        });

        const state = {
            session: {
                id: 's2',
                title: '',
                avatar: 'a.png',
                messages: [],
                surfaceState: {},
                pendingEdits: [],
            },
            live: { character: { description: 'old' }, lorebooks: {} },
            pendingEdits: [],
            isBusy: false,
            abortController: null,
        };

        await studio._testOnly_runIterationTurn(state, {
            userText: 'go',
            context: { generateTask: async () => ({}) },
            settings: {},
        });

        const assistants = state.session.messages.filter(m => m.role === 'assistant');
        // Two rounds → two assistant messages.
        expect(assistants.length).toBeGreaterThanOrEqual(2);
        for (const m of assistants) {
            const names = (m.toolCalls || []).map(c => c?.name);
            expect(names).not.toContain('luker_cea_editor_continue_iteration');
            expect(names).not.toContain('luker_cea_editor_finalize_iteration');
        }
    });
});
