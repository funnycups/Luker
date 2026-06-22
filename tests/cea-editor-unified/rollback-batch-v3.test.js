// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * CEA per-message rollback (rollbackBatch) must handle BOTH edit shapes:
 *  - legacy v2: { op, path, oldValue, newValue, target: {kind, bookName?} }
 *    inverted via `inverseEdit` and committed through the
 *    commit*EditorOperations helpers.
 *  - migrated v3: { target: {type, name?}, inverse: [<RFC6902>...] }
 *    rolled back through the target-registry handler (resolveTarget →
 *    read → decodeBackward → write).
 *
 * Before this fix, v3 edits triggered `inverseEdit(edit)` which throws on
 * a missing `edit.op`, so users who opened a migrated session and clicked
 * Rollback saw the generic "Cannot rollback edit type" toast.
 */

import { jest } from '@jest/globals';

// Lib stub for the iteration-library helpers that reach for lodash.
jest.unstable_mockModule('../../public/lib.js', async () => {
    const { default: lodash } = await import('lodash');
    return { lodash };
});

// `inverseEdit` real behaviour: invert the op (legacy path). The mock
// returns a synthetic inverse so we can spot when this path is exercised.
const inverseEditSpy = jest.fn((edit) => {
    if (!edit || !edit.op) throw new Error('inverseEdit: missing op');
    return { op: edit.op, path: edit.path, oldValue: edit.newValue, newValue: edit.oldValue };
});

jest.unstable_mockModule('../../public/scripts/iteration-library/index.js', () => ({
    proposalBus: {},
    applyEdits: () => ({ newLive: {}, clean: [], conflicts: [], alreadyDone: [] }),
    inverseEdit: inverseEditSpy,
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

const characterCommitSpy = jest.fn(async () => ({ ok: true, applied: 1, conflicts: [], alreadyDone: [] }));
const lorebookCommitSpy = jest.fn(async () => ({ ok: true, applied: 1, conflicts: [], alreadyDone: [] }));

jest.unstable_mockModule('../../public/scripts/extensions/character-editor-assistant/main.js', () => ({
    runCharacterEditorHelperToolCall: async () => ({ result: {} }),
    commitCharacterEditorOperations: characterCommitSpy,
    commitLorebookOperations: lorebookCommitSpy,
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
let registry;
beforeAll(async () => {
    studio = await import('../../public/scripts/extensions/character-editor-assistant/editor-iteration/studio.js');
    registry = await import('../../public/scripts/iteration-library/storage/target-registry.js');
    // confirm() prompt would block rollback otherwise.
    global.confirm = () => true;
    global.toastr = { error: () => {}, success: () => {}, warning: () => {} };
});

beforeEach(() => {
    characterCommitSpy.mockClear();
    lorebookCommitSpy.mockClear();
    inverseEditSpy.mockClear();
    registry.clearRegistry();
});

function makeSession(messages) {
    return {
        id: 's1', title: 't', avatar: 'avatar.png',
        messages,
        surfaceState: { historyOpen: false, autoApply: false },
    };
}

describe('CEA rollback — mixed v2/v3 edit shapes', () => {
    it('rolls back v3-shape edits via the target-registry handler', async () => {
        // Register a stub character handler that records the next-state write.
        const characterReadSpy = jest.fn(async () => ({ description: 'AFTER' }));
        const characterWriteSpy = jest.fn(async () => {});
        registry.registerTarget('character', {
            read:  characterReadSpy,
            write: characterWriteSpy,
            describe: () => 'character',
        });

        // v3-shape edit: inverse patch flips description back to BEFORE.
        const v3Edit = {
            target: { type: 'character' },
            inverse: [{ op: 'replace', path: '/description', value: 'BEFORE' }],
        };

        const msg = {
            id: 'm1', role: 'assistant', content: 'x',
            edits: [v3Edit],
            appliedAt: Date.now(), appliedTarget: 'character', rolledBackAt: null,
            at: Date.now(),
        };
        const state = {
            session: makeSession([msg]),
            live: { character: { description: 'AFTER' }, lorebooks: {} },
            isBusy: false,
        };

        await studio._internalRollbackBatch(state, 'm1', {
            persistSession: async () => {},
            render: async () => {},
            context: {}, settings: {}, avatar: 'avatar.png',
        });

        // v3 path: registry read+write, NOT inverseEdit, NOT commit helpers.
        expect(characterReadSpy).toHaveBeenCalledTimes(1);
        expect(characterWriteSpy).toHaveBeenCalledTimes(1);
        // The write payload must be the decoded BEFORE state, not AFTER.
        const writePayload = characterWriteSpy.mock.calls[0][1];
        expect(writePayload).toEqual({ description: 'BEFORE' });
        expect(inverseEditSpy).not.toHaveBeenCalled();
        expect(characterCommitSpy).not.toHaveBeenCalled();
        // Stamped.
        expect(typeof msg.rolledBackAt).toBe('number');
    });

    it('rolls back v3 lorebook-shape edits via the registered lorebook handler', async () => {
        const lorebookReadSpy = jest.fn(async () => ({ entries: { 0: { content: 'AFTER' } } }));
        const lorebookWriteSpy = jest.fn(async () => {});
        registry.registerTarget('lorebook', {
            read:  lorebookReadSpy,
            write: lorebookWriteSpy,
            describe: (t) => `lorebook:${t?.name || ''}`,
        });

        const v3Edit = {
            target: { type: 'lorebook', name: 'Aurora Lore' },
            inverse: [{ op: 'replace', path: '/entries/0/content', value: 'BEFORE' }],
        };
        const msg = {
            id: 'm1', role: 'assistant', content: 'x',
            edits: [v3Edit],
            appliedAt: Date.now(), appliedTarget: 'lorebook:Aurora Lore', rolledBackAt: null,
            at: Date.now(),
        };
        const state = {
            session: makeSession([msg]),
            live: { character: {}, lorebooks: { 'Aurora Lore': { entries: { 0: { content: 'AFTER' } } } } },
            isBusy: false,
        };

        await studio._internalRollbackBatch(state, 'm1', {
            persistSession: async () => {}, render: async () => {},
            context: {}, settings: {}, avatar: 'avatar.png',
        });

        expect(lorebookReadSpy).toHaveBeenCalledTimes(1);
        expect(lorebookWriteSpy).toHaveBeenCalledTimes(1);
        // The handler is called with the target object as the first arg.
        expect(lorebookWriteSpy.mock.calls[0][0]).toEqual({ type: 'lorebook', name: 'Aurora Lore' });
        const wholeBookNext = lorebookWriteSpy.mock.calls[0][1];
        expect(wholeBookNext).toEqual({ entries: { 0: { content: 'BEFORE' } } });
    });

    it('still rolls back legacy v2-shape edits via inverseEdit + commit helpers', async () => {
        const legacyEdit = {
            op: 'set', path: 'description', oldValue: 'BEFORE', newValue: 'AFTER',
            target: { kind: 'character' },
        };
        const msg = {
            id: 'm1', role: 'assistant', content: 'x',
            edits: [legacyEdit],
            appliedAt: Date.now(), appliedTarget: 'character', rolledBackAt: null,
            at: Date.now(),
        };
        const state = {
            session: makeSession([msg]),
            live: { character: { description: 'AFTER' }, lorebooks: {} },
            isBusy: false,
        };

        await studio._internalRollbackBatch(state, 'm1', {
            persistSession: async () => {}, render: async () => {},
            context: {}, settings: {}, avatar: 'avatar.png',
        });

        expect(inverseEditSpy).toHaveBeenCalledTimes(1);
        expect(characterCommitSpy).toHaveBeenCalledTimes(1);
        expect(typeof msg.rolledBackAt).toBe('number');
    });

    it('mixed batch: routes v3 edits to the registry and v2 edits to the commit helpers', async () => {
        const characterReadSpy = jest.fn(async () => ({ description: 'AFTER_V3' }));
        const characterWriteSpy = jest.fn(async () => {});
        registry.registerTarget('character', {
            read:  characterReadSpy,
            write: characterWriteSpy,
            describe: () => 'character',
        });

        const legacyEdit = {
            op: 'set', path: 'entries.0.content', oldValue: 'before-v2', newValue: 'after-v2',
            target: { kind: 'lorebook', bookName: 'BookA' },
        };
        const v3Edit = {
            target: { type: 'character' },
            inverse: [{ op: 'replace', path: '/description', value: 'BEFORE_V3' }],
        };
        const msg = {
            id: 'm1', role: 'assistant', content: 'x',
            edits: [legacyEdit, v3Edit],
            appliedAt: Date.now(),
            appliedTarget: 'character + lorebook:BookA',
            rolledBackAt: null,
            at: Date.now(),
        };
        const state = {
            session: makeSession([msg]),
            live: {
                character: { description: 'AFTER_V3' },
                lorebooks: { 'BookA': { entries: [{ uid: 0, content: 'after-v2' }] } },
            },
            isBusy: false,
        };

        await studio._internalRollbackBatch(state, 'm1', {
            persistSession: async () => {}, render: async () => {},
            context: {}, settings: {}, avatar: 'avatar.png',
        });

        // v3 character edit went through the registry; v2 lorebook edit
        // through the commit helpers.
        expect(characterWriteSpy).toHaveBeenCalledTimes(1);
        expect(lorebookCommitSpy).toHaveBeenCalledTimes(1);
        // inverseEdit was only called for the legacy edit, not the v3 one.
        expect(inverseEditSpy).toHaveBeenCalledTimes(1);
        expect(typeof msg.rolledBackAt).toBe('number');
    });
});
