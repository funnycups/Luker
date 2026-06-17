// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A5: orchestrator-tools translates a node's internal assistant-seq
// `floorRange` to chat[] indices for LLM-facing output so agents can
// pass it directly to `chat_read_range`.
//
// We import orchestrator-tools.js directly because it has no static
// imports — the session lookup is gated behind a lazy `await import`
// that none of these unit cases exercise. The shared mock stack is
// still loaded for defence-in-depth in case future helpers grow
// transitive imports.

import { describe, test, expect } from '@jest/globals';
import './_mocks/main-module-stack.js';

const {
    _trimCandidatePreviewForTest: trimCandidatePreview,
    _trimRankedPreviewForTest: trimRankedPreview,
    _trimExpandPreviewForTest: trimExpandPreview,
    _assistantSeqRangeToChatRangeForTest: assistantSeqRangeToChatRange,
} = await import('../../public/scripts/extensions/memory-graph/orchestrator-tools.js');

function makeContext(messages) {
    return { chat: messages };
}

describe('assistantSeqRangeToChatRange', () => {
    test('translates {start:1, end:2} to chat[] indices for u-a-u-a-u-a chat', () => {
        // assistant ordinals count non-user, non-empty messages.
        // chat[0]=u, chat[1]=a (ord 1), chat[2]=u, chat[3]=a (ord 2),
        // chat[4]=u, chat[5]=a (ord 3).
        // Range {start:1, end:2} means assistant ords 1..2.
        // end-side: chat[3] is the assistant at ord 2.
        // start-side: walk back from chat[1] (the assistant at ord 1)
        // until is_user; that is chat[0].
        const ctx = makeContext([
            { is_user: true, mes: 'u0' },
            { is_user: false, mes: 'a0' },
            { is_user: true, mes: 'u1' },
            { is_user: false, mes: 'a1' },
            { is_user: true, mes: 'u2' },
            { is_user: false, mes: 'a2' },
        ]);
        expect(assistantSeqRangeToChatRange({ start: 1, end: 2 }, ctx)).toEqual({ start: 0, end: 3 });
    });

    test('returns null when end ordinal exceeds available assistants', () => {
        const ctx = makeContext([
            { is_user: true, mes: 'u' },
            { is_user: false, mes: 'a' },
        ]);
        expect(assistantSeqRangeToChatRange({ start: 1, end: 5 }, ctx)).toBeNull();
    });

    test('falls back to assistant index when no preceding user (opening greeting)', () => {
        const ctx = makeContext([
            { is_user: false, mes: 'greeting' }, // ordinal 1, no prior user
            { is_user: true, mes: 'u' },
            { is_user: false, mes: 'a' },
        ]);
        expect(assistantSeqRangeToChatRange({ start: 1, end: 1 }, ctx)).toEqual({ start: 0, end: 0 });
    });

    test('skips empty-mes messages when counting assistant ordinals', () => {
        // Mirrors isExtractableAssistantMessage: empty `mes` (after trim)
        // is not counted as an assistant for seq purposes.
        const ctx = makeContext([
            { is_user: true, mes: 'u0' },
            { is_user: false, mes: 'a0' },   // ord 1 → chat[1]
            { is_user: false, mes: '' },     // SKIPPED (empty)
            { is_user: true, mes: 'u1' },
            { is_user: false, mes: 'a1' },   // ord 2 → chat[4]; user anchor chat[3]
        ]);
        expect(assistantSeqRangeToChatRange({ start: 2, end: 2 }, ctx)).toEqual({ start: 3, end: 4 });
    });

    test('skips whitespace-only mes when counting assistant ordinals', () => {
        // isExtractableAssistantMessage trims before length check.
        const ctx = makeContext([
            { is_user: true, mes: 'u0' },
            { is_user: false, mes: '   \n\t' }, // SKIPPED (whitespace-only)
            { is_user: false, mes: 'a' },       // ord 1 → chat[2]; user anchor chat[0]
        ]);
        expect(assistantSeqRangeToChatRange({ start: 1, end: 1 }, ctx)).toEqual({ start: 0, end: 2 });
    });

    test('counts is_system assistant messages (hidden via /hide) per extraction predicate', () => {
        // isExtractableAssistantMessage deliberately ignores is_system so
        // hide/unhide doesn't drift seq coords. Our translator must
        // mirror that — a hidden assistant still gets a seq ordinal.
        const ctx = makeContext([
            { is_user: true, mes: 'u0' },
            { is_user: false, is_system: true, mes: 'hidden' }, // ord 1 → chat[1]
            { is_user: true, mes: 'u1' },
            { is_user: false, mes: 'a1' },                       // ord 2 → chat[3]
        ]);
        expect(assistantSeqRangeToChatRange({ start: 1, end: 2 }, ctx)).toEqual({ start: 0, end: 3 });
    });

    test('returns null for non-numeric or malformed range', () => {
        const ctx = makeContext([{ is_user: false, mes: 'a' }]);
        expect(assistantSeqRangeToChatRange(null, ctx)).toBeNull();
        expect(assistantSeqRangeToChatRange({ start: 'x', end: 1 }, ctx)).toBeNull();
        expect(assistantSeqRangeToChatRange({}, ctx)).toBeNull();
    });

    test('returns null when context has no chat array', () => {
        expect(assistantSeqRangeToChatRange({ start: 1, end: 1 }, {})).toBeNull();
        expect(assistantSeqRangeToChatRange({ start: 1, end: 1 }, null)).toBeNull();
    });
});

describe('trimmers: floorRange replaces seqTo when present', () => {
    const ctx = makeContext([
        { is_user: true, mes: 'u0' },
        { is_user: false, mes: 'a0' }, // ord 1
        { is_user: true, mes: 'u1' },
        { is_user: false, mes: 'a1' }, // ord 2
    ]);

    test('trimCandidatePreview: floorRange present → output has chat[] floorRange, no seqTo', () => {
        const node = {
            id: 'n1',
            type: 'event',
            level: 'semantic',
            title: 'T',
            seqTo: 2,
            semanticDepth: 0,
            floorRange: { start: 1, end: 2 },
        };
        const out = trimCandidatePreview(node, ctx);
        expect(out.floorRange).toEqual({ start: 0, end: 3 });
        expect(out.seqTo).toBeUndefined();
    });

    test('trimCandidatePreview: floorRange absent → output has seqTo, no floorRange', () => {
        const node = {
            id: 'n2',
            type: 'character_sheet',
            level: 'semantic',
            title: 'Alice',
            seqTo: 5,
            semanticDepth: 0,
        };
        const out = trimCandidatePreview(node, ctx);
        expect(out.seqTo).toBe(5);
        expect(out.floorRange).toBeUndefined();
    });

    test('trimCandidatePreview: floorRange refs deleted chat → output has floorRange:null, no seqTo', () => {
        const node = {
            id: 'n3',
            type: 'event',
            level: 'semantic',
            title: 'T',
            seqTo: 99,
            semanticDepth: 0,
            floorRange: { start: 1, end: 99 },
        };
        const out = trimCandidatePreview(node, ctx);
        expect(out.floorRange).toBeNull();
        expect(out.seqTo).toBeUndefined();
    });

    test('trimRankedPreview: floorRange present → translates, drops seqTo, keeps score/scoreMode', () => {
        const entry = {
            id: 'n1',
            type: 'event',
            title: 'T',
            seqTo: 2,
            score: 0.7,
            scoreMode: 'keyword',
            floorRange: { start: 1, end: 2 },
        };
        const out = trimRankedPreview(entry, ctx);
        expect(out.floorRange).toEqual({ start: 0, end: 3 });
        expect(out.seqTo).toBeUndefined();
        expect(out.score).toBe(0.7);
        expect(out.scoreMode).toBe('keyword');
    });

    test('trimRankedPreview: floorRange absent → keeps seqTo', () => {
        const entry = {
            id: 'n1',
            type: 'character_sheet',
            title: 'Alice',
            seqTo: 5,
            score: 0.4,
            scoreMode: 'vector',
        };
        const out = trimRankedPreview(entry, ctx);
        expect(out.seqTo).toBe(5);
        expect(out.floorRange).toBeUndefined();
    });

    test('trimExpandPreview: floorRange present → translates, drops seqTo', () => {
        const node = {
            id: 'n1',
            type: 'event',
            level: 'semantic',
            title: 'T',
            seqTo: 2,
            floorRange: { start: 1, end: 2 },
        };
        const out = trimExpandPreview(node, ctx);
        expect(out.floorRange).toEqual({ start: 0, end: 3 });
        expect(out.seqTo).toBeUndefined();
    });

    test('trimExpandPreview: floorRange absent → keeps seqTo', () => {
        const node = {
            id: 'n2',
            type: 'character_sheet',
            level: 'semantic',
            title: 'Alice',
            seqTo: 5,
        };
        const out = trimExpandPreview(node, ctx);
        expect(out.seqTo).toBe(5);
        expect(out.floorRange).toBeUndefined();
    });

    test('trimmers all return null for non-object input (unchanged contract)', () => {
        expect(trimCandidatePreview(null, ctx)).toBeNull();
        expect(trimExpandPreview(null, ctx)).toBeNull();
        expect(trimRankedPreview(null, ctx)).toBeNull();
    });

    test('trimmers: missing context still works (legacy callers omit it)', () => {
        // When context is omitted but floorRange is present, translation
        // can't succeed (no chat), so floorRange comes through as null.
        const node = {
            id: 'n1',
            type: 'event',
            level: 'semantic',
            title: 'T',
            seqTo: 2,
            semanticDepth: 0,
            floorRange: { start: 1, end: 2 },
        };
        const out = trimCandidatePreview(node);
        expect(out.floorRange).toBeNull();
        expect(out.seqTo).toBeUndefined();
    });

    test('trimmers: partial-range (only start) treated as malformed → null', () => {
        // The schema requires both start and end as numbers; partial
        // ranges should be rejected by hasValidFloorRange and fall
        // through to the seqTo branch.
        const node = {
            id: 'n1',
            type: 'event',
            level: 'semantic',
            title: 'T',
            seqTo: 2,
            semanticDepth: 0,
            floorRange: { start: 1 },
        };
        const out = trimCandidatePreview(node, ctx);
        expect(out.seqTo).toBe(2);
        expect(out.floorRange).toBeUndefined();
    });
});
