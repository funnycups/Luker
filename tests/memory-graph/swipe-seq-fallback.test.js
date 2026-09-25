/**
 * Regression coverage for the swipe-regenerate snapshot-kill bug.
 *
 * Chain: overswipe REGENERATE (public/script.js, `swipe()` →
 * OVERSWIPE_BEHAVIOR.REGENERATE branch) clears `chat[mesId].mes` to ''
 * BEFORE `animateSwipe()` emits MESSAGE_SWIPED. The memory-graph
 * MESSAGE_SWIPED listener derives the affected assistant seq via
 * `findAffectedAssistantSeqFromMessageIndex`, whose extractable walk
 * (isExtractableAssistantMessage: non-user, non-empty mes) skips the wiped
 * slot and returned null. `applyMutationInvalidationImpl` then fed
 * fromSeq=null into `shouldPreserveLatestRecallSnapshotForAssistantMutation`,
 * which cleared `latestRecallSnapshot` — so every swipe retry ran a fresh
 * RAG recall instead of reusing the snapshot anchored at the unchanged
 * last user message.
 *
 * Fix contract: when the target slot is an assistant-role message
 * (!is_user && !is_system) that the extractable walk cannot count (wiped or
 * otherwise empty body), fall back to role-based counting — the same
 * coordinate system `buildLastUserAnchorFromMessages` uses for
 * `anchorAssistantFloor`, which the preserve check compares against.
 */

import { describe, test, expect, beforeAll } from '@jest/globals';
import './_mocks/main-module-stack.js';

describe('findAffectedAssistantSeqFromMessageIndex', () => {
    let findAffectedAssistantSeqFromMessageIndex;

    beforeAll(async () => {
        const main = await import('../../public/scripts/extensions/memory-graph/main.js');
        findAffectedAssistantSeqFromMessageIndex = main.findAffectedAssistantSeqFromMessageIndex;
    });

    test('counts extractable assistants up to and including the target (existing behavior)', () => {
        const context = { chat: [
            { is_user: true, mes: 'u1' },
            { is_user: false, mes: 'a1' },
            { is_user: true, mes: 'u2' },
            { is_user: false, mes: 'a2' },
        ] };
        // Target index 3 = 'a2', the 2nd extractable assistant.
        expect(findAffectedAssistantSeqFromMessageIndex(context, 3)).toBe(2);
        // Target index 0 = a user message: seq of the first extractable
        // assistant at or after it ('a1' at index 1) = 1.
        expect(findAffectedAssistantSeqFromMessageIndex(context, 0)).toBe(1);
    });

    test('returns role-based seq for a wiped assistant slot (swipe regenerate state)', () => {
        // Overswipe REGENERATE wipes mes='' on the target slot before
        // MESSAGE_SWIPED fires. The slot is still an assistant role message.
        const context = { chat: [
            { is_user: true, mes: 'u1' },
            { is_user: false, mes: 'a1' },
            { is_user: true, mes: 'anchor user message' },
            { is_user: false, mes: '' }, // wiped swiped slot at index 3
        ] };
        // Role-based assistants up to and including index 3 = 2
        // ('a1' + the wiped slot). Must NOT be null: null makes
        // shouldPreserveLatestRecallSnapshotForAssistantMutation clear
        // the recall snapshot and forces a fresh recall on every swipe.
        expect(findAffectedAssistantSeqFromMessageIndex(context, 3)).toBe(2);
    });

    test('role-based fallback skips empty assistant slots before the target', () => {
        const context = { chat: [
            { is_user: false, mes: '' },  // empty assistant slot (never generated)
            { is_user: true, mes: 'u1' },
            { is_user: false, mes: '' },  // wiped target at index 2
        ] };
        // Role-based count up to index 2 inclusive = 2; the empty slot at
        // index 0 occupies a role-assistant rank even though it is not
        // extractable, keeping the coordinate aligned with anchorAssistantFloor.
        expect(findAffectedAssistantSeqFromMessageIndex(context, 2)).toBe(2);
    });

    test('still returns extractable-seq for user targets and null out-of-range', () => {
        const context = { chat: [
            { is_user: true, mes: 'u1' },
            { is_user: false, mes: 'a1' },
            { is_user: true, mes: 'u2' },
        ] };
        // User target at index 2: no extractable assistant at or after it —
        // legacy semantics for user/system targets stay unchanged (null).
        expect(findAffectedAssistantSeqFromMessageIndex(context, 2)).toBe(null);
        expect(findAffectedAssistantSeqFromMessageIndex(context, 0)).toBe(1); // 'a1' at index 1
        expect(findAffectedAssistantSeqFromMessageIndex(context, 99)).toBe(null); // past the end
        const emptyContext = { chat: [] };
        expect(findAffectedAssistantSeqFromMessageIndex(emptyContext, 0)).toBe(null);
    });

    test('wiped target before later extractable assistants still falls back to role count', () => {
        const context = { chat: [
            { is_user: true, mes: 'u1' },
            { is_user: false, mes: '' },   // wiped slot at index 1
            { is_user: false, mes: 'a2' }, // later non-empty assistant
        ] };
        // The extractable walk would return the seq of 'a2' (1) for target
        // index 1, but the role-based fallback must count the wiped slot
        // itself: role assistants up to index 1 inclusive = 1.
        expect(findAffectedAssistantSeqFromMessageIndex(context, 1)).toBe(1);
    });
});
