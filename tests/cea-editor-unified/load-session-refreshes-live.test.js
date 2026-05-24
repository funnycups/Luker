// Verifies that loading a saved session refreshes state.live from disk
// via buildUnifiedCharacterEditorLiveSnapshot — pending edits in the
// loaded session anchor to the CURRENT character state, not the snapshot
// captured when the session was last open. Without that refresh, edits
// applied outside the popup (e.g. via a regular SillyTavern field edit)
// would be silently clobbered when the user pressed Apply on a stale
// session.
//
// Backfills spec §8.1 Gap 5: "loadSession reloads state.live".

import { jest } from '@jest/globals';

jest.unstable_mockModule('../../public/lib.js', async () => {
    const { default: lodash } = await import('lodash');
    return { lodash };
});

jest.unstable_mockModule('../../public/scripts/iteration-library/index.js', () => ({
    applyEdits: (edits, live) => ({ newLive: live, clean: edits, conflicts: [], alreadyDone: [] }),
    inverseEdit: (edit) => edit,
    registerOp: () => {},
    BUILT_IN_OPS: {},
    showConflictResolution: async () => ({}),
    render: {
        ensureMarkdownDeps: jest.fn().mockResolvedValue(true),
        renderMessageMarkdown: (s) => String(s ?? ''),
    },
    runner: { requestToolCallsWithRetry: jest.fn() },
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

jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    Popup: class { constructor() {} show() { return Promise.resolve('ok'); } completeAffirmative() {} dlg = { close: () => {} }; },
    POPUP_TYPE: { DISPLAY: 'display' },
}));

let _internalLoadSessionIntoState;
beforeAll(async () => {
    const mod = await import('../../public/scripts/extensions/character-editor-assistant/editor-iteration/studio.js');
    _internalLoadSessionIntoState = mod._internalLoadSessionIntoState;
});

describe('unified CEA editor loadSession refreshes state.live', () => {
    test('exports _internalLoadSessionIntoState', () => {
        expect(typeof _internalLoadSessionIntoState).toBe('function');
    });

    test('replaces state.session + state.pendingEdits with the loaded bucket', async () => {
        const sessionB = {
            id: 'B',
            avatar: 'alice.png',
            messages: [{ id: 'm1', role: 'user', content: 'edit B' }],
            pendingEdits: [{ op: 'set', path: 'card.name', oldValue: 'A', newValue: 'B', target: { kind: 'character' } }],
            surfaceState: {},
            updatedAt: 2,
        };
        const sessionStore = { load: jest.fn().mockResolvedValue(sessionB) };
        const buildLiveSnapshot = jest.fn().mockResolvedValue({ character: { name: 'live' }, lorebooks: {} });
        const state = {
            session: { id: 'A', avatar: 'alice.png', messages: [], pendingEdits: [], surfaceState: {} },
            pendingEdits: [],
            live: { character: { name: 'stale' }, lorebooks: {} },
            isBusy: false,
            abortController: null,
        };

        const ok = await _internalLoadSessionIntoState(state, 'B', {
            sessionStore,
            buildLiveSnapshot,
            context: { _kind: 'ctx' },
            avatar: 'alice.png',
        });

        expect(ok).toBe(true);
        expect(sessionStore.load).toHaveBeenCalledWith('B');
        expect(state.session).toBe(sessionB);
        expect(state.pendingEdits).toHaveLength(1);
        expect(state.pendingEdits[0].path).toBe('card.name');
    });

    test('refreshes state.live by calling buildUnifiedCharacterEditorLiveSnapshot, not by re-using session.live', async () => {
        // The whole point of Gap 5: loading session B must hit the
        // bootstrap helper so a card field that was edited outside the
        // popup since session B was saved is reflected in state.live,
        // and apply doesn't clobber it with stale values.
        const sessionB = {
            id: 'B',
            avatar: 'alice.png',
            messages: [],
            pendingEdits: [],
            surfaceState: {},
            // A stale `live` block stored on the session — must NOT be
            // used. The fresh snapshot is what governs apply.
            live: { character: { name: 'baked-in-stale' }, lorebooks: {} },
        };
        const sessionStore = { load: jest.fn().mockResolvedValue(sessionB) };
        const buildLiveSnapshot = jest.fn().mockResolvedValue({
            character: { name: 'fresh-from-disk' },
            lorebooks: { Lore: { entries: {} } },
        });
        const state = {
            session: { id: 'A', avatar: 'alice.png' },
            pendingEdits: [],
            live: { character: {}, lorebooks: {} },
            isBusy: false,
            abortController: null,
        };

        await _internalLoadSessionIntoState(state, 'B', {
            sessionStore,
            buildLiveSnapshot,
            context: { _kind: 'ctx' },
            avatar: 'alice.png',
        });

        expect(buildLiveSnapshot).toHaveBeenCalledTimes(1);
        expect(buildLiveSnapshot).toHaveBeenCalledWith({ _kind: 'ctx' }, 'alice.png');
        expect(state.live.character.name).toBe('fresh-from-disk');
        expect(state.live.lorebooks).toHaveProperty('Lore');
    });

    test('aborts an in-flight LLM call before swapping state', async () => {
        const sessionB = { id: 'B', avatar: 'alice.png', messages: [], pendingEdits: [], surfaceState: {} };
        const sessionStore = { load: jest.fn().mockResolvedValue(sessionB) };
        const buildLiveSnapshot = jest.fn().mockResolvedValue({ character: {}, lorebooks: {} });
        const abort = jest.fn();
        const state = {
            session: { id: 'A', avatar: 'alice.png' },
            pendingEdits: [],
            live: { character: {}, lorebooks: {} },
            isBusy: true,
            abortController: { abort },
        };

        await _internalLoadSessionIntoState(state, 'B', {
            sessionStore,
            buildLiveSnapshot,
            context: {},
            avatar: 'alice.png',
        });

        expect(abort).toHaveBeenCalledTimes(1);
        expect(state.session).toBe(sessionB);
    });

    test('returns false (no-op) when id is empty', async () => {
        const sessionStore = { load: jest.fn() };
        const buildLiveSnapshot = jest.fn();
        const state = {
            session: { id: 'A' },
            pendingEdits: [{ op: 'set', path: 'x', oldValue: 1, newValue: 2 }],
            live: { character: { kept: true }, lorebooks: {} },
            isBusy: false,
            abortController: null,
        };

        const ok = await _internalLoadSessionIntoState(state, '', {
            sessionStore, buildLiveSnapshot, context: {}, avatar: 'a.png',
        });

        expect(ok).toBe(false);
        expect(sessionStore.load).not.toHaveBeenCalled();
        expect(buildLiveSnapshot).not.toHaveBeenCalled();
        expect(state.session.id).toBe('A');
    });

    test('returns false (no-op) when target is already current session', async () => {
        const sessionStore = { load: jest.fn() };
        const buildLiveSnapshot = jest.fn();
        const state = {
            session: { id: 'A' },
            pendingEdits: [],
            live: { character: {}, lorebooks: {} },
            isBusy: false,
            abortController: null,
        };

        const ok = await _internalLoadSessionIntoState(state, 'A', {
            sessionStore, buildLiveSnapshot, context: {}, avatar: 'a.png',
        });

        expect(ok).toBe(false);
        expect(sessionStore.load).not.toHaveBeenCalled();
    });

    test('returns false when sessionStore.load resolves null (id unknown)', async () => {
        const sessionStore = { load: jest.fn().mockResolvedValue(null) };
        const buildLiveSnapshot = jest.fn();
        const state = {
            session: { id: 'A' },
            pendingEdits: [],
            live: { character: { kept: true }, lorebooks: {} },
            isBusy: false,
            abortController: null,
        };

        const ok = await _internalLoadSessionIntoState(state, 'B', {
            sessionStore, buildLiveSnapshot, context: {}, avatar: 'a.png',
        });

        expect(ok).toBe(false);
        // state.live untouched when load fails.
        expect(state.live.character.kept).toBe(true);
        expect(buildLiveSnapshot).not.toHaveBeenCalled();
    });
});
