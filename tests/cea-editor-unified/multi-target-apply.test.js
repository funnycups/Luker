import { jest } from '@jest/globals';

// Stub the lib.js boundary the iteration-library helpers reach for lodash through.
jest.unstable_mockModule('../../public/lib.js', async () => {
    const { default: lodash } = await import('lodash');
    return { lodash };
});

// Mock the iteration-library/index umbrella. We supply a trivial `applyEdits`
// that returns a deep-cloned `newLive` so studio's apply commit can hand
// per-target slices to the commit helpers. The other umbrella members are
// stubbed because the apply path doesn't touch them.
jest.unstable_mockModule('../../public/scripts/iteration-library/index.js', () => ({
    proposalBus: {},
    applyEdits: (edits, live) => {
        // Trivial in-place semantics for the test: each edit is a `set` on a
        // dot-path. Studio passes per-target slices (character-only or
        // single-book) so we don't need cross-book routing here.
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
    inverseEdit: () => null,
    registerOp: () => {},
    BUILT_IN_OPS: {},
    showConflictResolution: async () => ({}),
    render: {
        ensureMarkdownDeps: async () => true,
        renderMessageMarkdown: (s) => `<p>${s}</p>`,
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

// Spies for the character + lorebook commit helpers. studio.js imports these
// from main.js; the apply commit dispatches per target group through them.
const characterCommitSpy = jest.fn(async () => ({ ok: true }));
const lorebookCommitSpy = jest.fn(async (bookName, _liveBook, _edits) => ({ ok: true, bookName }));

jest.unstable_mockModule('../../public/scripts/extensions/character-editor-assistant/main.js', () => ({
    runCharacterEditorHelperToolCall: async () => ({ result: {} }),
    commitCharacterEditorOperations: characterCommitSpy,
    commitLorebookOperations: lorebookCommitSpy,
    // studio.js imports these for the entry-point bootstrap. The
    // multi-target-apply suite drives _internalApplyPendingEdits directly
    // against synthetic state and never mounts the popup, so the bootstrap
    // helpers never fire here — they just need to be resolvable.
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
    characterCommitSpy.mockClear();
    lorebookCommitSpy.mockClear();
});

function makeSession(messages) {
    return {
        id: 's1',
        title: 't',
        avatar: 'avatar.png',
        messages,
        surfaceState: {
            historyOpen: false,
            autoApply: false,
        },
    };
}

function makeAssistantMsg(edits = []) {
    return {
        id: 'm1',
        role: 'assistant',
        content: 'x',
        toolCalls: [],
        toolResults: [],
        // Real usage stores the round's edits on the assistant message too
        // (`processRoundOutcome` mirrors them onto both `state.pendingEdits`
        // and `assistantMsg.edits`). The Apply stamper now keys off
        // `m.edits.length`, so tests that want a message stamped must seed it
        // with the same edits its batch carries.
        edits,
        appliedAt: null,
        appliedTarget: '',
        rolledBackAt: null,
        auto: false,
        at: Date.now(),
    };
}

describe('unified CEA editor multi-target apply', () => {
    it('groups pending edits by target.kind and calls per-target commit helpers', async () => {
        const pending = [
            { op: 'set', path: 'description', oldValue: 'old', newValue: 'new', target: { kind: 'character' } },
            { op: 'set', path: 'entries.0.content', oldValue: 'a', newValue: 'a2', target: { kind: 'lorebook', bookName: 'BookA' } },
            { op: 'set', path: 'entries.0.content', oldValue: 'b', newValue: 'b2', target: { kind: 'lorebook', bookName: 'BookB' } },
        ];
        const state = {
            session: makeSession([makeAssistantMsg(pending)]),
            live: {
                character: { description: 'old' },
                lorebooks: {
                    'BookA': { entries: [{ uid: 0, content: 'a' }], meta: {} },
                    'BookB': { entries: [{ uid: 0, content: 'b' }], meta: {} },
                },
            },
            pendingEdits: pending.slice(),
            isBusy: false,
            abortController: null,
        };
        await studio._internalApplyPendingEdits(state, { context: {}, settings: {} });

        // Character commit was called once with the 1 character edit.
        expect(characterCommitSpy).toHaveBeenCalledTimes(1);
        // Lorebook commit was called twice (once per book).
        expect(lorebookCommitSpy).toHaveBeenCalledTimes(2);
        const lorebookBookNames = lorebookCommitSpy.mock.calls.map(c => c[0]).sort();
        expect(lorebookBookNames).toEqual(['BookA', 'BookB']);

        // pendingEdits cleared.
        expect(state.pendingEdits).toEqual([]);
        // Last assistant message stamped with appliedAt + appliedTarget that
        // mentions both target groups.
        const last = state.session.messages.at(-1);
        expect(typeof last.appliedAt).toBe('number');
        expect(last.appliedTarget).toMatch(/character/);
        expect(last.appliedTarget).toMatch(/BookA|lorebook/);
        expect(last.appliedTarget).toMatch(/BookB|lorebook/);
    });

    it('exposes _internalComputeApplyLabel that includes totals + per-target counts', () => {
        expect(typeof studio._internalComputeApplyLabel).toBe('function');
        const pending = [
            { op: 'set', target: { kind: 'character' } },
            { op: 'set', target: { kind: 'lorebook', bookName: 'BookA' } },
            { op: 'set', target: { kind: 'lorebook', bookName: 'BookA' } },
            { op: 'set', target: { kind: 'lorebook', bookName: 'BookB' } },
        ];
        const label = studio._internalComputeApplyLabel(pending, (s) => s);
        // Must mention totals + both target kinds.
        expect(label).toMatch(/4/);
        expect(label).toMatch(/character|1/);
        expect(label).toMatch(/BookA|BookB|lorebook|3/i);
    });

    it('handles character-only batch (no lorebook commit invoked)', async () => {
        const pending = [
            { op: 'set', path: 'description', oldValue: 'old', newValue: 'new', target: { kind: 'character' } },
        ];
        const state = {
            session: makeSession([makeAssistantMsg(pending)]),
            live: { character: { description: 'old' }, lorebooks: {} },
            pendingEdits: pending.slice(),
            isBusy: false,
            abortController: null,
        };
        await studio._internalApplyPendingEdits(state, { context: {}, settings: {} });
        expect(characterCommitSpy).toHaveBeenCalledTimes(1);
        expect(lorebookCommitSpy).not.toHaveBeenCalled();
        const last = state.session.messages.at(-1);
        expect(last.appliedTarget).toMatch(/character/);
    });

    it('handles lorebook-only batch (no character commit invoked)', async () => {
        const pending = [
            { op: 'set', path: 'entries', oldValue: [], newValue: [{ content: 'x' }], target: { kind: 'lorebook', bookName: 'X' } },
        ];
        const state = {
            session: makeSession([makeAssistantMsg(pending)]),
            live: { character: {}, lorebooks: { 'X': { entries: [], meta: {} } } },
            pendingEdits: pending.slice(),
            isBusy: false,
            abortController: null,
        };
        await studio._internalApplyPendingEdits(state, { context: {}, settings: {} });
        expect(characterCommitSpy).not.toHaveBeenCalled();
        expect(lorebookCommitSpy).toHaveBeenCalledTimes(1);
        expect(lorebookCommitSpy.mock.calls[0][0]).toBe('X');
        const last = state.session.messages.at(-1);
        expect(last.appliedTarget).toMatch(/lorebook|X/);
    });

    it('does nothing when pendingEdits is empty', async () => {
        const state = {
            session: makeSession([]),
            live: { character: {}, lorebooks: {} },
            pendingEdits: [],
            isBusy: false,
            abortController: null,
        };
        await studio._internalApplyPendingEdits(state, { context: {}, settings: {} });
        expect(characterCommitSpy).not.toHaveBeenCalled();
        expect(lorebookCommitSpy).not.toHaveBeenCalled();
    });
});
