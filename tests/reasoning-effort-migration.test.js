// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from '@jest/globals';
import { buildReasoningEffortBySource } from '../public/scripts/reasoning-effort.js';

describe('reasoning_effort_by_source migration', () => {
    test('is idempotent', () => {
        const first = buildReasoningEffortBySource('high');
        const second = buildReasoningEffortBySource('high');
        expect(second).toEqual(first);
    });
    test('seeds only reasoning-capable sources', () => {
        const map = buildReasoningEffortBySource('auto');
        expect(Object.keys(map)).not.toContain('ai21');
        expect(map.openai).toBe('auto');
    });
});
