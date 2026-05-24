// Gap 6 from spec §8.1 — guards a UX gate that prevents the user from
// closing the unified CEA editor popup while an LLM call is in flight.
// Without the gate, hitting Escape mid-request silently drops the in-flight
// abort handshake on the floor: the popup tears down, but the AbortController
// keeps any tool I/O alive in the background where the user can't see it.
//
// Regression target: editor-iteration/studio.js. The `Popup` instance must
// be constructed with an `onClosing` option that returns `false` while
// `state.isBusy` is true. The fix path is to attempt an abort + return false
// so the popup stays open; once the abort lands and `isBusy` flips back, the
// user can close cleanly.

import { jest } from '@jest/globals';

jest.unstable_mockModule('../../public/lib.js', async () => {
    const { default: lodash } = await import('lodash');
    return { lodash };
});

jest.unstable_mockModule('../../public/scripts/iteration-library/index.js', () => ({
    applyEdits: (edits, live) => ({ newLive: live, clean: edits, conflicts: [], alreadyDone: [] }),
    inverseEdit: () => null,
    registerOp: () => {},
    BUILT_IN_OPS: {},
    showConflictResolution: async () => ({}),
    render: {
        ensureMarkdownDeps: async () => true,
        renderMessageMarkdown: (s) => String(s ?? ''),
    },
    runner: {
        requestToolCallsWithRetry: () => Promise.resolve({ toolCalls: [], assistantText: '' }),
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

// Capture every Popup construction so each test can pull its onClosing
// callback off the spy without depending on a real DOM.
const popupConstructorSpy = jest.fn();
class CapturingPopup {
    constructor(html, type, value, opts) {
        popupConstructorSpy({ html, type, value, opts });
        this.opts = opts || {};
    }
    show() { return new Promise(() => { /* never resolves so the entry point keeps state alive */ }); }
    completeAffirmative() {}
    dlg = { close: () => {} };
}
jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    Popup: CapturingPopup,
    POPUP_TYPE: { DISPLAY: 'display' },
}));

let studio;
beforeAll(async () => {
    studio = await import('../../public/scripts/extensions/character-editor-assistant/editor-iteration/studio.js');
});

beforeEach(() => {
    popupConstructorSpy.mockClear();
});

function makeContext() {
    return {
        extensionSettings: { character_editor_assistant: {} },
        characterId: 0,
        characters: [],
        saveSettingsDebounced: () => {},
    };
}

function captureLastPopupOpts() {
    expect(popupConstructorSpy).toHaveBeenCalled();
    const last = popupConstructorSpy.mock.calls[popupConstructorSpy.mock.calls.length - 1][0];
    return last.opts || {};
}

describe('unified CEA editor — onClosing abort gate', () => {
    it('passes an onClosing handler to the Popup constructor', async () => {
        // Mount the popup; show() never resolves so the entry point hangs
        // forever, but the Popup constructor fires synchronously and the
        // spy captures it. We swallow any thrown error from the mount path.
        studio.openUnifiedCharacterEditorPopup(makeContext(), {
            avatar: 'a.png',
            live: { character: {}, lorebooks: {} },
            helperApis: [],
        }).catch(() => {});
        // Let the bootstrap await chain settle.
        await new Promise(r => setTimeout(r, 0));

        const opts = captureLastPopupOpts();
        expect(typeof opts.onClosing).toBe('function');
    });

    it('onClosing returns false while a turn is in flight (state.isBusy)', async () => {
        let internalState = null;
        // Inject a hook to grab state — easiest path is via opts.live's
        // identity; we'll pull state through the open popup via the
        // captured onClosing handler instead. To exercise the gate we
        // simulate isBusy by patching state after mount via a sentinel.
        studio.openUnifiedCharacterEditorPopup(makeContext(), {
            avatar: 'a.png',
            live: { character: {}, lorebooks: {} },
            helperApis: [],
            // Test-only hook: the unified popup forwards opts._testOnly_onStateReady(state)
            // synchronously after constructing state so tests can capture
            // the live reference. If this hook isn't wired, the test will
            // fail loudly via the assertion on internalState below.
            _testOnly_onStateReady: (state) => { internalState = state; },
        }).catch(() => {});
        await new Promise(r => setTimeout(r, 0));

        expect(internalState).not.toBeNull();
        // Simulate an in-flight LLM call.
        internalState.isBusy = true;
        const fakeAc = { abort: jest.fn() };
        internalState.abortController = fakeAc;

        const opts = captureLastPopupOpts();
        const result = await opts.onClosing({ result: undefined });
        // false === popup stays open
        expect(result).toBe(false);
        // The gate should also attempt to abort the in-flight call so the
        // next close attempt can succeed.
        expect(fakeAc.abort).toHaveBeenCalled();
    });

    it('onClosing returns true when nothing is in flight (idle popup closes cleanly)', async () => {
        let internalState = null;
        studio.openUnifiedCharacterEditorPopup(makeContext(), {
            avatar: 'a.png',
            live: { character: {}, lorebooks: {} },
            helperApis: [],
            _testOnly_onStateReady: (state) => { internalState = state; },
        }).catch(() => {});
        await new Promise(r => setTimeout(r, 0));

        expect(internalState).not.toBeNull();
        internalState.isBusy = false;
        internalState.abortController = null;

        const opts = captureLastPopupOpts();
        const result = await opts.onClosing({ result: undefined });
        // truthy === popup closes
        expect(result).toBe(true);
    });
});
