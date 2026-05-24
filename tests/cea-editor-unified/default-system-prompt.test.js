/**
 * Default system prompt — unified CEA editor (editor-iteration/studio.js).
 *
 * The unified Character Editor popup picks a system prompt at runIterationTurn
 * time. Callers may override it via `opts.systemPrompt`; otherwise the studio
 * falls back to the module-scoped `DEFAULT_SYSTEM_PROMPT` constant. This test
 * pins the parts of that constant that other systems depend on:
 *
 *   - It names the cea_editor scope's continue / finalize tool ids verbatim,
 *     so a tool rename has to update the prompt.
 *   - It documents the finalize-sticky rule (if the model emits BOTH continue
 *     and finalize in the same round, finalize wins and the loop ends). The
 *     behavior itself lives in onControlCall; this assertion guards the doc
 *     line that surfaces the rule in the prompt itself so the model can plan
 *     accordingly.
 */

import { jest } from '@jest/globals';

jest.unstable_mockModule('../../public/lib.js', async () => {
    const { default: lodash } = await import('lodash');
    return { lodash };
});

jest.unstable_mockModule('../../public/scripts/iteration-library/index.js', () => ({
    applyEdits: (edits, live) => ({ newLive: live, journal: [] }),
    inverseEdit: () => null,
    bindIterWorkspaceResizer: () => () => {},
    render: { ensureMarkdownDeps: async () => true, renderMessageMarkdown: (s) => `<p>${s}</p>` },
    runner: { requestToolCallsWithRetry: jest.fn() },
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

describe('unified CEA editor — DEFAULT_SYSTEM_PROMPT', () => {
    test('is exported as a non-empty string', () => {
        expect(typeof studio.DEFAULT_SYSTEM_PROMPT).toBe('string');
        expect(studio.DEFAULT_SYSTEM_PROMPT.length).toBeGreaterThan(100);
    });

    test('names the cea_editor-scoped continue / finalize control tools verbatim', () => {
        const prompt = studio.DEFAULT_SYSTEM_PROMPT;
        expect(prompt).toMatch(/luker_cea_editor_continue_iteration/);
        expect(prompt).toMatch(/luker_cea_editor_finalize_iteration/);
    });

    test('documents finalize-sticky ordering so the LLM knows finalize wins over continue in the same round', () => {
        const prompt = studio.DEFAULT_SYSTEM_PROMPT;
        expect(prompt.toLowerCase()).toMatch(/finalize wins/);
    });
});
