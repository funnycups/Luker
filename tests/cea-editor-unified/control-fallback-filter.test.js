import { jest } from '@jest/globals';

// CEA editor has no popup-side control tools — the multi-round loop is
// program-driven by tool-call presence (any tool call → next round, none →
// stop). isCeaEditorControlCall returns false for every name, so the
// fallback filter in studio.js
//
//   const editAndReadCalls = collectedToolCalls.length > 0
//       ? collectedToolCalls
//       : (Array.isArray(result?.toolCalls)
//           ? result.toolCalls.filter(c => !isCeaEditorControlCall(c))
//           : []);
//
// is now a no-op partition: every call survives. This test asserts that
// legacy continue / finalize calls (which a stale session replay or an
// older AI might still emit) flow through as regular tool calls and the
// normalizer drops them silently as no-op edits.

jest.unstable_mockModule('../../public/lib.js', async () => {
    const { default: lodash } = await import('lodash');
    return { lodash };
});

const requestToolCallsWithRetryMock = jest.fn();
const ensureUiStylesheetInjectedMock = jest.fn();
const ensureMarkdownDepsMock = jest.fn().mockResolvedValue(true);
jest.unstable_mockModule('../../public/scripts/iteration-library/index.js', () => ({
    proposalBus: {},
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

describe('unified CEA editor — legacy continue / finalize fallthrough', () => {
    it('legacy control tool calls flow through onToolCall and reach the persisted message', async () => {
        // Simulate a runner-version-drift bug: the runner returns
        // result.toolCalls but never invokes onToolCall / onControlCall.
        // Since CEA editor has no control tools, the fallback filter is a
        // no-op partition — every call survives into the persisted message.
        // The normalizer drops legacy continue / finalize names as no-op
        // edits, so they appear as chips but don't mutate state.
        requestToolCallsWithRetryMock.mockImplementationOnce(async () => ({
            toolCalls: [
                { id: 'e1', name: 'cea_set_card_field', args: { field: 'description', value: 'updated' } },
                { id: 'k1', name: 'luker_cea_editor_continue_iteration', args: {} },
                { id: 'f1', name: 'luker_cea_editor_finalize_iteration', args: { summary: 'done' } },
            ],
            assistantText: 'fallback path',
            rawAssistantText: 'fallback path',
        }));
        // Subsequent rounds (continue/finalize emitted above counts as
        // tool calls, so the program-driven loop will auto-continue) —
        // emit nothing so the loop exits.
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

        const assistants = state.session.messages.filter(m => m.role === 'assistant');
        expect(assistants.length).toBeGreaterThanOrEqual(1);
        const firstAssistant = assistants[0];

        const persistedNames = (firstAssistant.toolCalls || []).map(c => c?.name);
        // Edit tool survives.
        expect(persistedNames).toContain('cea_set_card_field');
        // Legacy continue / finalize calls flow through as regular tool
        // calls (no control filter to drop them) — they show up as chips
        // in the assistant message but the normalizer silently no-ops them.
        expect(persistedNames).toContain('luker_cea_editor_continue_iteration');
        expect(persistedNames).toContain('luker_cea_editor_finalize_iteration');
    });
});
