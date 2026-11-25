// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from '@jest/globals';
import {
    joinReasoningDetailsText,
    mergeReasoningDetails,
} from '../public/scripts/util/reasoning-details.js';

describe('mergeReasoningDetails: consecutive-run merging', () => {
    test('consecutive reasoning.text fragments concatenate text and fill metadata once', () => {
        const accumulated = [];
        mergeReasoningDetails(accumulated, [{ type: 'reasoning.text', text: 'Let', index: 0 }]);
        mergeReasoningDetails(accumulated, [{ type: 'reasoning.text', text: ' me', signature: 'sig-1', format: 'anthropic-claude-v1', index: 0 }]);
        mergeReasoningDetails(accumulated, [{ type: 'reasoning.text', text: ' think.', index: 0 }]);
        expect(accumulated).toEqual([
            { type: 'reasoning.text', text: 'Let me think.', signature: 'sig-1', format: 'anthropic-claude-v1', index: 0 },
        ]);
    });

    test('consecutive reasoning.summary fragments concatenate summary', () => {
        const accumulated = [];
        mergeReasoningDetails(accumulated, [{ type: 'reasoning.summary', summary: 'a', format: 'openai-responses-v1', index: 0 }]);
        mergeReasoningDetails(accumulated, [{ type: 'reasoning.summary', summary: 'b', index: 0 }]);
        expect(accumulated).toEqual([
            { type: 'reasoning.summary', summary: 'ab', format: 'openai-responses-v1', index: 0 },
        ]);
    });

    test('runs of the same type stay separate when interrupted by another type', () => {
        const accumulated = [];
        mergeReasoningDetails(accumulated, [
            { type: 'reasoning.text', text: 'a' },
            { type: 'reasoning.text', text: 'b' },
            { type: 'reasoning.encrypted', id: 'rs_1', data: 'blob' },
            { type: 'reasoning.text', text: 'c' },
        ]);
        expect(accumulated).toEqual([
            { type: 'reasoning.text', text: 'ab' },
            { type: 'reasoning.encrypted', id: 'rs_1', data: 'blob' },
            { type: 'reasoning.text', text: 'c' },
        ]);
    });

    test('consecutive encrypted entries are pushed as-is, never merged', () => {
        const accumulated = [];
        mergeReasoningDetails(accumulated, [
            { type: 'reasoning.encrypted', id: 'rs_1', data: 'blob-1' },
            { type: 'reasoning.encrypted', id: 'rs_2', data: 'blob-2' },
        ]);
        expect(accumulated).toEqual([
            { type: 'reasoning.encrypted', id: 'rs_1', data: 'blob-1' },
            { type: 'reasoning.encrypted', id: 'rs_2', data: 'blob-2' },
        ]);
    });
});

describe('joinReasoningDetailsText', () => {
    test('concatenates text and summary entries in order, ignoring encrypted entries', () => {
        expect(joinReasoningDetailsText([
            { type: 'reasoning.text', text: 'a' },
            { type: 'reasoning.encrypted', id: 'rs_1', data: 'blob' },
            { type: 'reasoning.summary', summary: 'b' },
            { type: 'reasoning.text', text: 'c' },
        ])).toBe('abc');
    });

    test('returns empty string for missing or empty input', () => {
        expect(joinReasoningDetailsText(null)).toBe('');
        expect(joinReasoningDetailsText([])).toBe('');
    });
});
