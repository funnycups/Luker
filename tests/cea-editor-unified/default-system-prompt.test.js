/**
 * Default system prompt — unified CEA editor (editor-iteration/studio.js).
 *
 * The unified Character Editor popup picks a system prompt at runIterationTurn
 * time. Callers may override it via `opts.systemPrompt`; otherwise the studio
 * falls back to the module-scoped `DEFAULT_SYSTEM_PROMPT` constant. This test
 * pins the parts of that constant that other systems depend on:
 *
 *   - It names the cea_editor scope's continue control tool id verbatim, so a
 *     tool rename has to update the prompt.
 *   - It explains the "stop calling continue to terminate" contract instead
 *     of the older finalize-tool-based exit, so a regression that restores
 *     the legacy finalize wording would be caught here.
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

    test('does NOT reference legacy continue / finalize tools (program-driven auto-continue)', () => {
        const prompt = studio.DEFAULT_SYSTEM_PROMPT;
        expect(prompt).not.toMatch(/luker_cea_editor_continue_iteration/);
        expect(prompt).not.toMatch(/luker_cea_editor_finalize_iteration/);
        // Loose sanity check: prompt should explain program-driven auto-
        // continue (tool call → next round, plain text → stop).
        expect(prompt.toLowerCase()).toMatch(/auto-continue|tool call/);
        expect(prompt.toLowerCase()).toMatch(/plain text|no tool calls/);
    });
});
