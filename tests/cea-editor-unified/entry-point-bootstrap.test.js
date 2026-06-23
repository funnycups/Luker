// Verifies that `openUnifiedCharacterEditorPopup` wires its state.live
// snapshot and helperApis bundle through the two main.js exports:
//
//   - buildUnifiedCharacterEditorLiveSnapshot(context, avatar) — bootstraps
//     state.live = { character, lorebooks } so card-field + lorebook edits
//     apply against the real character payload.
//   - buildCharacterEditorHelperApis(context, { avatar }) — bootstraps the
//     helper-tool API array the popup's read tools (lorebook_query, etc.)
//     dispatch through.
//
// Both bootstrap calls fire BEFORE popup mount so the test can assert on
// them even when the popup itself fails to mount cleanly in a jsdom-free
// Jest environment. The opts.live and opts.helperApis overrides bypass the
// bootstrap so callers / tests can supply pre-built values directly.

import { jest } from '@jest/globals';

// public/lib.js is handled by the global moduleNameMapper (→ tests/util/lib-stub.js).

// popup.js + popup-utils must be mocked BEFORE we touch lib/edits/index.js,
// since conflict-ui.js → popup.js → power-user.js → textgen-models.js
// touches `document` at module-load. Register popup mock first so the
// dynamic `import('../../public/scripts/lib/edits/index.js')` below
// (used to forward the real applyEdits into the iteration-library mock)
// doesn't pull the SillyTavern DOM shell.
jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    Popup: class {
        constructor() {}
        show() { return Promise.resolve('ok'); }
        completeAffirmative() {}
        dlg = { close: () => {} };
    },
    POPUP_TYPE: { DISPLAY: 'display' },
    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 2, CANCELLED: 0 },
}));

// Forward the REAL edits engine through the iteration-library umbrella so
// the studio's applyEdits/inverseEdit calls do real work. Other surfaces
// stay stubbed (they need DOM and are out of scope for this test).
const realEdits = await import('../../public/scripts/lib/edits/index.js');

// Mock the iteration-library/index umbrella. The bootstrap test doesn't
// exercise the runner, edits, or shared UI — it only needs these to load
// cleanly so the studio module can import.
jest.unstable_mockModule('../../public/scripts/iteration-library/index.js', () => ({
    proposalBus: {},
    applyEdits: realEdits.applyEdits,
    inverseEdit: realEdits.inverseEdit,
    registerOp: realEdits.registerOp,
    BUILT_IN_OPS: realEdits.BUILT_IN_OPS,
    showConflictResolution: async () => ({}),
    render: {
        ensureMarkdownDeps: async () => true,
        renderMessageMarkdown: (s) => `<p>${String(s ?? '')}</p>`,
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
    createRenderScheduler: () => ({ schedule: () => {} }),
}));

// Spies for the two main.js bootstrap helpers. The unified popup must call
// each one exactly once per mount when the matching opts.* override is
// absent, and must NOT call either when the override is provided.
const buildHelperApisSpy = jest.fn(() => ([
    { toolNames: { LIST: 'lorebook_list' }, isToolName: () => false, invoke: async () => ({}) },
]));
const buildSnapshotSpy = jest.fn(async () => ({
    character: { description: 'snapshot description' },
    lorebooks: {
        'BookA': { entries: { 0: { uid: 0, content: 'a' } } },
    },
}));

jest.unstable_mockModule('../../public/scripts/extensions/character-editor-assistant/main.js', () => ({
    runCharacterEditorHelperToolCall: async () => ({ result: {} }),
    commitCharacterEditorOperations: async () => ({ ok: true }),
    commitLorebookOperations: async () => ({ ok: true }),
    buildCharacterEditorHelperApis: buildHelperApisSpy,
    buildUnifiedCharacterEditorLiveSnapshot: buildSnapshotSpy,
    readLegacyCeaEditorSessions: async () => [],
    readLegacyCharIterPopupSessions: async () => [],
}));

let studio;
beforeAll(async () => {
    studio = await import('../../public/scripts/extensions/character-editor-assistant/editor-iteration/studio.js');
});

beforeEach(() => {
    buildHelperApisSpy.mockClear();
    buildSnapshotSpy.mockClear();
});

function makeContext() {
    // Minimal SillyTavern context the unified popup needs to mount. We do
    // NOT pass a `characters` array — the bootstrap helpers are mocked, so
    // they never touch the character payload directly.
    return {
        extensionSettings: { character_editor_assistant: {} },
        characterId: 0,
        characters: [],
        saveSettingsDebounced: () => {},
        // The session-store factory now requires both sidecar helpers
        // (per-character history backend). These are minimal no-ops — the
        // bootstrap path doesn't actually read or write the sidecar, only
        // the constructor sanity check needs them present.
        getCharacterState: async () => null,
        updateCharacterState: async (_a, _ns, updater) => {
            await updater(null, { attempt: 0 });
            return { ok: true, state: null, updated: false };
        },
    };
}

describe('unified CEA editor entry-point bootstrap', () => {
    it('exports openUnifiedCharacterEditorPopup', () => {
        expect(typeof studio.openUnifiedCharacterEditorPopup).toBe('function');
    });

    it('falls back to buildUnifiedCharacterEditorLiveSnapshot when opts.live is omitted', async () => {
        try {
            await studio.openUnifiedCharacterEditorPopup(makeContext(), { avatar: 'a.png' });
        } catch {
            // Mount may fail without a DOM; bootstrap fires before mount.
        }
        expect(buildSnapshotSpy).toHaveBeenCalledTimes(1);
        expect(buildSnapshotSpy).toHaveBeenCalledWith(expect.anything(), 'a.png');
    });

    it('falls back to buildCharacterEditorHelperApis when opts.helperApis is omitted', async () => {
        try {
            await studio.openUnifiedCharacterEditorPopup(makeContext(), { avatar: 'a.png' });
        } catch {
            // Mount may fail without a DOM; bootstrap fires before mount.
        }
        expect(buildHelperApisSpy).toHaveBeenCalledTimes(1);
        expect(buildHelperApisSpy).toHaveBeenCalledWith(expect.anything(), { avatar: 'a.png' });
    });

    it('passes through opts.live + opts.helperApis when provided (no bootstrap call)', async () => {
        try {
            await studio.openUnifiedCharacterEditorPopup(makeContext(), {
                avatar: 'a.png',
                live: { character: { description: 'pre-built' }, lorebooks: {} },
                helperApis: [{ toolNames: { LIST: 'x' }, isToolName: () => false, invoke: async () => ({}) }],
            });
        } catch {
            // Mount may fail without a DOM; bootstrap fires before mount.
        }
        expect(buildSnapshotSpy).not.toHaveBeenCalled();
        expect(buildHelperApisSpy).not.toHaveBeenCalled();
    });
});
