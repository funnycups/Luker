// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

// Pins the read-first refactor's rebuild-time message filter for CEA
// card iter-studio. Same contract as the shared
// `iteration-library/iter-message-filter.js`:
//
//   role == 'user' + auto == true          → DROP (all legacy fillers)
//   role == 'user' + auto missing/false    → KEEP
//   role == 'assistant'                    → KEEP
//   role == 'system'                       → KEEP
//   any other role                         → DROP
//
// Legacy pre-refactor sessions carry two flavours of `auto:true` user
// filler: (a) untagged AUTO CONTINUE, (b) `[User reviewed …]` drain
// summaries tagged `kind:'drain_summary'`. Both are dropped on rebuild
// so a resumed session doesn't replay dead scaffolding to the LLM.
// Post-refactor iter-studio never emits `auto:true` user messages;
// edit outcomes flow through in-place role:'tool' result envelopes.

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
beforeAll(async () => {
    studio = await import('../../public/scripts/extensions/character-editor-assistant/editor-iteration/studio.js');
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

    test('legacy drain-summary-tagged auto:true user message is also DROPPED (channel retired)', () => {
        // Pre-refactor drainBusOutcomes / auto-apply /
        // continueAfterReviewDecision used to tag their summary message
        // with `kind: 'drain_summary'` to distinguish it from
        // AUTO CONTINUE fillers. After the 2026-07-18 edit tool_call
        // round-trip refactor, that channel is retired — edit outcomes
        // ride on in-place role:'tool' result envelopes. Legacy tagged
        // summaries on disk are now treated exactly like untagged
        // fillers: dropped on rebuild.
        const state = {
            session: {
                messages: [
                    { role: 'user', content: 'draft an entry' },
                    { role: 'assistant', content: 'proposed', toolCalls: [], toolResults: [] },
                    {
                        role: 'user',
                        content: '[User reviewed 1 proposal(s): Committed (1): cea-character-edits]',
                        auto: true,
                        kind: 'drain_summary',
                    },
                ],
            },
        };
        const out = studio._internalBuildSeedTaskMessages(state, 'SYSTEM');
        // [0] system, [1] user (real), [2] assistant. Drain summary dropped.
        expect(out).toHaveLength(3);
        expect(out.some(m => String(m?.content || '').includes('User reviewed'))).toBe(false);
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
