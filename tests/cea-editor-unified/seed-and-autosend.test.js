import { jest } from '@jest/globals';

jest.unstable_mockModule('../../public/lib.js', async () => {
    const { default: lodash } = await import('lodash');
    return { lodash };
});

const requestToolCallsWithRetryMock = jest.fn();
jest.unstable_mockModule('../../public/scripts/iteration-library/index.js', () => ({
    applyEdits: (edits, live) => ({ newLive: live, journal: [] }),
    inverseEdit: () => null,
    bindIterWorkspaceResizer: () => () => {},
    render: { ensureMarkdownDeps: async () => true, renderMessageMarkdown: (s) => `<p>${s}</p>` },
    runner: { requestToolCallsWithRetry: requestToolCallsWithRetryMock },
    zoomOverlay: { attachZoomOverlay: () => () => {} },
    ui: {
        toolcall: { renderToolCallChip: () => '' },
        message: { renderMessageCard: () => '' },
        diff: { renderDiffCard: () => '' },
        apply: { renderApplyControls: () => '' },
        ensureUiStylesheetInjected: () => {},
    },
}));

jest.unstable_mockModule('../../public/scripts/extensions/character-editor-assistant/main.js', () => ({
    runCharacterEditorHelperToolCall: async () => ({ result: {} }),
    commitCharacterEditorOperations: async () => ({ ok: true }),
    commitLorebookOperations: async () => ({ ok: true }),
    buildCharacterEditorHelperApis: () => [],
    buildUnifiedCharacterEditorLiveSnapshot: async () => ({ character: {}, lorebooks: {} }),
    readLegacyCeaEditorSessions: async () => [],
    readLegacyCharIterPopupSessions: async () => [],
}));

jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    Popup: class { constructor() {} show() {} completeAffirmative() {} dlg = { close: () => {} }; },
    POPUP_TYPE: { DISPLAY: 'display' },
}));

let studio;
beforeAll(async () => {
    studio = await import('../../public/scripts/extensions/character-editor-assistant/editor-iteration/studio.js');
});

beforeEach(() => {
    requestToolCallsWithRetryMock.mockReset();
});

describe('unified CEA editor seed + autoSend', () => {
    it('exports an internal helper to seed a session system message', () => {
        // Either a dedicated _internalSeedSystemMessage or it threads through openUnifiedCharacterEditorPopup.
        expect(typeof studio._internalSeedSystemMessage === 'function' ||
               typeof studio._testOnly_applyOpenOpts === 'function').toBe(true);
    });

    it('pushes a system message into state.session.messages when seedSystemMessage is provided', () => {
        const state = {
            session: { id: 's1', title: '', avatar: 'a.png', messages: [], surfaceState: {} },
            live: { character: {}, lorebooks: {} },
            pendingEdits: [],
            isBusy: false,
        };
        // Call the seed helper directly. Adjust to the real export name if different.
        const seed = studio._internalSeedSystemMessage || studio._testOnly_applyOpenOpts;
        seed(state, { seedSystemMessage: 'Just imported this card.' });
        expect(state.session.messages.length).toBe(1);
        expect(state.session.messages[0].role).toBe('system');
        expect(state.session.messages[0].content).toBe('Just imported this card.');
    });

    it('does nothing when seedSystemMessage is missing/empty', () => {
        const state = {
            session: { id: 's2', title: '', avatar: 'a.png', messages: [], surfaceState: {} },
            live: { character: {}, lorebooks: {} },
            pendingEdits: [],
            isBusy: false,
        };
        const seed = studio._internalSeedSystemMessage || studio._testOnly_applyOpenOpts;
        seed(state, {});
        seed(state, { seedSystemMessage: '' });
        seed(state, { seedSystemMessage: '   ' });
        expect(state.session.messages.length).toBe(0);
    });

    it('autoSend triggers a runIterationTurn when invoked via the open opts threader', async () => {
        // Script the runner to return an immediate finalize so the test exits cleanly.
        requestToolCallsWithRetryMock.mockResolvedValue({
            toolCalls: [{ id: 'f1', name: 'luker_cea_editor_finalize_iteration', args: { summary: 'ok' } }],
            assistantText: 'done',
        });

        const state = {
            session: { id: 's3', title: '', avatar: 'a.png', messages: [], surfaceState: {} },
            live: { character: {}, lorebooks: {} },
            pendingEdits: [],
            isBusy: false,
            abortController: null,
            helperApis: [],
        };

        // Seed first, then autoSend via the internal turn entry point.
        const seed = studio._internalSeedSystemMessage || studio._testOnly_applyOpenOpts;
        seed(state, { seedSystemMessage: 'Review this card.' });

        await studio._testOnly_runIterationTurn(state, {
            userText: '',  // autoSend kicks off with empty user text (the seed system message frames the request).
            isAutoContinue: false,
            context: { generateTask: async () => ({}) },
            settings: {},
        });

        expect(requestToolCallsWithRetryMock).toHaveBeenCalled();
        // Session should now have the seeded system + an assistant message.
        expect(state.session.messages.some(m => m.role === 'system' && m.content === 'Review this card.')).toBe(true);
        expect(state.session.messages.some(m => m.role === 'assistant')).toBe(true);
    });
});
