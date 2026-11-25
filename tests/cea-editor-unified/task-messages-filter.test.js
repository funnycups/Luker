// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

// Pins the read-first legacy filler filter for CEA card iteration:
//   role == 'user' + auto == true          -> DROP (all legacy fillers)
//   role == 'user' + auto missing/false    -> KEEP
//   role == 'assistant'                    -> KEEP
//   role == 'system'                       -> KEEP
//   any other role                         -> DROP

import { describe, expect, test } from '@jest/globals';
import { isReplayableIterationMessage } from '../../public/scripts/iteration-library/iter-message-filter.js';

describe('CEA iteration message filter — read-first legacy filler filter', () => {
    test('legacy untagged auto:true user filler is dropped on replay', () => {
        const messages = [
            { role: 'user', content: 'iterate the personality' },
            { role: 'assistant', content: 'proposed', toolCalls: [], toolResults: [] },
            { role: 'user', content: '[Legacy filler from pre-refactor drainBusOutcomes]', auto: true },
            { role: 'assistant', content: 'ok', toolCalls: [], toolResults: [] },
        ];
        const filtered = messages.filter(isReplayableIterationMessage);
        expect(filtered).toHaveLength(3);
        expect(filtered[0].content).toBe('iterate the personality');
        expect(filtered[1].role).toBe('assistant');
        expect(filtered[2].role).toBe('assistant');
        expect(filtered.some(m => String(m?.content || '').includes('Legacy filler'))).toBe(false);
    });

    test('legacy drain-summary-tagged auto:true user message is also DROPPED', () => {
        const drainSummary = {
            role: 'user',
            content: '[User reviewed 1 proposal(s): Committed (1): cea-character-edits]',
            auto: true,
            kind: 'drain_summary',
        };
        expect(isReplayableIterationMessage(drainSummary)).toBe(false);
    });

    test('non-auto user messages always survive (regular human turns)', () => {
        const messages = [
            { role: 'user', content: 'first message' },
            { role: 'user', content: 'follow-up', auto: false },
        ];
        const filtered = messages.filter(isReplayableIterationMessage);
        expect(filtered).toHaveLength(2);
        expect(filtered.map(m => m.content)).toEqual(['first message', 'follow-up']);
    });

    test('assistant messages replay regardless of `auto`; system messages are dropped on replay', () => {
        const messages = [
            { role: 'system', content: 'prime' },
            { role: 'assistant', content: 'ok', auto: true, toolCalls: [], toolResults: [] },
        ];
        const filtered = messages.filter(isReplayableIterationMessage);
        expect(filtered).toHaveLength(1);
        expect(filtered[0].role).toBe('assistant');
        expect(isReplayableIterationMessage(messages[0])).toBe(false);
    });
});
