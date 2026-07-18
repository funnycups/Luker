// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

// Pins the read-first refactor's rebuild-time message filter for CEA
// card iter-studio. Same discriminator contract as
// `iteration-library/iter-message-filter.js` (shared with orchestrator
// iter-studio and MG schema iter-studio):
//
//   role == 'user' + auto == true + kind !== DRAIN_SUMMARY_KIND  → DROP
//   role == 'user' + auto == true + kind == DRAIN_SUMMARY_KIND   → KEEP
//   role == 'user' + auto missing/false                          → KEEP
//   role == 'assistant'                                          → KEEP
//   role == 'system'                                             → KEEP
//   any other role                                               → DROP
//
// Legacy pre-refactor sessions have untagged `auto:true` user fillers
// (from drainBusOutcomes / continueAfterReviewDecision / auto-apply)
// that must be silently dropped when a session is resumed under the
// read-first pure-tool-call loop — replaying them would poison the
// model with stale "[User reviewed …]" scaffolding whose context the
// current round no longer matches.

import { jest } from '@jest/globals';

jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    Popup: class { constructor() {} show() { return Promise.resolve('ok'); } completeAffirmative() {} dlg = { close: () => {} }; },
    POPUP_TYPE: { DISPLAY: 'display' },
    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 2, CANCELLED: 0 },
}));

const realEdits = await import('../../public/scripts/lib/edits/index.js');

jest.unstable_mockModule('../../public/scripts/iteration-library/index.js', () => ({
    proposalBus: {},
    applyEdits: realEdits.applyEdits,
    inverseEdit: realEdits.inverseEdit,
    registerOp: realEdits.registerOp,
    BUILT_IN_OPS: realEdits.BUILT_IN_OPS,
    showConflictResolution: async () => ({}),
    render: {
        ensureMarkdownDeps: async () => true,
        renderMessageMarkdown: (s) => String(s ?? ''),
    },
    runner: {
        requestToolCallsWithRetry: jest.fn(),
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
let filterModule;
beforeAll(async () => {
    studio = await import('../../public/scripts/extensions/character-editor-assistant/editor-iteration/studio.js');
    filterModule = await import('../../public/scripts/iteration-library/iter-message-filter.js');
});

describe('buildSeedTaskMessages — read-first legacy filler filter', () => {
    test('legacy untagged auto:true user filler is dropped on replay', () => {
        // A session created before the read-first refactor might carry
        // `{role:'user', auto:true, content:'[User reviewed 3 proposals …]'}`
        // pushed by the pre-refactor drainBusOutcomes. Replaying that
        // filler would prime the current round with stale scaffolding.
        const state = {
            session: {
                messages: [
                    { role: 'user', content: 'iterate the personality' },
                    { role: 'assistant', content: 'proposed', toolCalls: [], toolResults: [] },
                    // Legacy filler — no `kind` tag.
                    { role: 'user', content: '[Legacy filler from pre-refactor drainBusOutcomes]', auto: true },
                    { role: 'assistant', content: 'ok', toolCalls: [], toolResults: [] },
                ],
            },
        };
        const out = studio._internalBuildSeedTaskMessages(state, 'SYSTEM');
        // [0] system, [1] user (real), [2] assistant, [3] assistant.
        // Legacy filler at index 2 of session.messages must be dropped.
        expect(out).toHaveLength(4);
        expect(out[0]).toEqual({ role: 'system', content: 'SYSTEM' });
        expect(out[1].content).toBe('iterate the personality');
        expect(out[2].role).toBe('assistant');
        expect(out[3].role).toBe('assistant');
        expect(out.some(m => String(m?.content || '').includes('Legacy filler'))).toBe(false);
    });

    test('drain-summary-tagged auto:true user message is KEPT (post-approval outcomes are real signal)', () => {
        // Post-refactor drainBusOutcomes / auto-apply /
        // continueAfterReviewDecision tag their summary message with
        // `kind: DRAIN_SUMMARY_KIND`. These carry real user-decision
        // signal (which proposals were committed, which conflicted)
        // and MUST replay so the model knows what state it moved.
        const state = {
            session: {
                messages: [
                    { role: 'user', content: 'draft an entry' },
                    { role: 'assistant', content: 'proposed', toolCalls: [], toolResults: [] },
                    {
                        role: 'user',
                        content: '[User reviewed 1 proposal(s): Committed (1): cea-character-edits]',
                        auto: true,
                        kind: filterModule.DRAIN_SUMMARY_KIND,
                    },
                ],
            },
        };
        const out = studio._internalBuildSeedTaskMessages(state, 'SYSTEM');
        expect(out).toHaveLength(4);
        // The drain-summary content survives at the tail.
        expect(out[3].role).toBe('user');
        expect(String(out[3].content)).toContain('User reviewed');
    });

    test('non-auto user messages always survive (regular human turns)', () => {
        const state = {
            session: {
                messages: [
                    { role: 'user', content: 'first message' },
                    { role: 'user', content: 'follow-up' },
                ],
            },
        };
        const out = studio._internalBuildSeedTaskMessages(state, 'SYSTEM');
        expect(out).toHaveLength(3);
        expect(out[1].content).toBe('first message');
        expect(out[2].content).toBe('follow-up');
    });

    test('assistant + system messages replay regardless of any `auto` flag on them', () => {
        // The filter only inspects role==='user'. An assistant message
        // that (bizarrely) carries auto:true still replays because
        // dropping it would break tool_call/tool_result linkage.
        const state = {
            session: {
                messages: [
                    { role: 'system', content: 'prime' },
                    { role: 'assistant', content: 'ok', auto: true, toolCalls: [], toolResults: [] },
                ],
            },
        };
        const out = studio._internalBuildSeedTaskMessages(state, 'SYSTEM');
        expect(out).toHaveLength(3);
        expect(out[1]).toEqual({ role: 'system', content: 'prime' });
        expect(out[2].role).toBe('assistant');
    });
});
