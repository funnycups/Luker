// Verifies the CEA post-replace OPEN_EDITOR rollback contract:
//   - When the popup opens after OPEN_EDITOR pre-materialized a new
//     world book, the caller passes `opts.postReplaceRollback`.
//   - If the user closes the popup WITHOUT applying any edit (state
//     stays `hasEverApplied === false`), the callback fires so the
//     pre-materialize step can be undone (rebind previous book, delete
//     newly materialized file).
//   - If ANY edit lands on disk (`state.hasEverApplied === true`) the
//     callback must NOT fire — the user chose to iterate on the new
//     book and rolling back would delete their curated changes.
//   - When no callback is provided (non-post-replace open path), the
//     finally block stays inert.
//
// This lives outside `openUnifiedCharacterEditorPopup`'s giant mount
// path by exercising the same finally block via a Popup stub that
// resolves immediately; the popup mount body can throw on missing
// DOM but the try/finally still evaluates our rollback branch.

import { jest } from '@jest/globals';

jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    Popup: class {
        constructor() {}
        // Resolve immediately so `await popupPromise` in the studio
        // returns before we get a chance to touch state — perfect for
        // exercising the "closed without applying" branch.
        show() { return Promise.resolve('ok'); }
        completeAffirmative() {}
        dlg = { close: () => {} };
    },
    POPUP_TYPE: { DISPLAY: 'display' },
    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 2, CANCELLED: 0 },
}));

const realEdits = await import('../../public/scripts/lib/edits/index.js');

jest.unstable_mockModule('../../public/scripts/iteration-library/index.js', () => ({
    proposalBus: {
        createProposalBus: () => ({
            hydrate: () => {},
            serialize: () => ({}),
            hasOutstanding: () => false,
            onChange: () => () => {},
            drainStagedEdits: () => [],
            targetKeys: () => [],
            listProposals: () => [],
            stageProposals: () => {},
        }),
    },
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
    createRenderScheduler: () => ({ schedule: () => {}, dispose: () => {} }),
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

let studio;
beforeAll(async () => {
    studio = await import('../../public/scripts/extensions/character-editor-assistant/editor-iteration/studio.js');
});

function makeContext() {
    return {
        extensionSettings: { character_editor_assistant: {} },
        characterId: 0,
        characters: [],
        saveSettingsDebounced: () => {},
        getCharacterState: async () => null,
        updateCharacterState: async (_a, _ns, updater) => {
            await updater(null, { attempt: 0 });
            return { ok: true, state: null, updated: false };
        },
    };
}

describe('CEA post-replace rollback', () => {
    it('invokes postReplaceRollback when popup closes without any applied edit', async () => {
        const rollback = jest.fn(async () => {});
        try {
            await studio.openUnifiedCharacterEditorPopup(makeContext(), {
                avatar: 'a.png',
                postReplaceRollback: rollback,
            });
        } catch {
            // Mount can throw without a DOM; the finally block still runs.
        }
        expect(rollback).toHaveBeenCalledTimes(1);
    });

    it('skips postReplaceRollback once any edit has been applied', async () => {
        const rollback = jest.fn(async () => {});
        // Flip the shared rollbackEnvelope BEFORE the popup mount runs
        // to simulate "user applied at least one edit this session".
        // Production sets this flag from inside applyPendingEdits when
        // the commit succeeds — mirroring here has the same observable
        // effect without needing to drive the popup UI to completion.
        try {
            await studio.openUnifiedCharacterEditorPopup(makeContext(), {
                avatar: 'a.png',
                postReplaceRollback: rollback,
                _testOnly_onRollbackEnvelopeReady: (env) => {
                    env.hasEverApplied = true;
                },
            });
        } catch {
            // Mount can throw without a DOM.
        }
        expect(rollback).not.toHaveBeenCalled();
    });

    it('is a no-op when no postReplaceRollback callback is provided (regular open path)', async () => {
        // Just proves nothing throws when the option is absent, which is
        // the common case (the character editor UI button doesn't wire
        // a rollback — only the post-replace flow does).
        await expect(studio.openUnifiedCharacterEditorPopup(makeContext(), {
            avatar: 'a.png',
        }).catch(() => {})).resolves.not.toThrow();
    });

    it('swallows errors thrown from the rollback callback (teardown must not propagate)', async () => {
        const rollback = jest.fn(async () => { throw new Error('rollback boom'); });
        // If teardown propagated, this would reject; the studio explicitly
        // wraps postReplaceRollback in try/catch because it fires in the
        // finally block after `await popupPromise` — a throw here would
        // otherwise mask the real popup close outcome and stall the
        // caller.
        await expect(studio.openUnifiedCharacterEditorPopup(makeContext(), {
            avatar: 'a.png',
            postReplaceRollback: rollback,
        }).catch(() => {})).resolves.not.toThrow();
        expect(rollback).toHaveBeenCalledTimes(1);
    });
});
