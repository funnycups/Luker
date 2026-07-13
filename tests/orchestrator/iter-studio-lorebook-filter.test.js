// tests/orchestrator/iter-studio-lorebook-filter.test.js
import { describe, test, expect } from '@jest/globals';
import { applyLorebookFilterPatchArgs } from '../../public/scripts/extensions/orchestrator/lorebook-filter.js';

/**
 * Iter-studio tools thin-wrap applyLorebookFilterPatchArgs.
 * These tests lock in the contract; the executor branches in main.js
 * just dispatch to this helper. E2E coverage in Task 7 verifies the
 * full round-trip through iter-studio session lifecycle.
 */

describe('iter-studio patch helper contract (locks Task 6 dispatch behavior)', () => {
    test('set book filter happy path', () => {
        const next = applyLorebookFilterPatchArgs(
            { bookPattern: '', entryPattern: 'e' },
            { pattern: '^new$' },
            { dimension: 'book' },
        );
        expect(next.bookPattern).toBe('^new$');
        expect(next.entryPattern).toBe('e');
    });
    test('clear (= set to empty string) happy path', () => {
        const next = applyLorebookFilterPatchArgs(
            { bookPattern: '^old$', entryPattern: '' },
            { pattern: '' },
            { dimension: 'book' },
        );
        expect(next.bookPattern).toBe('');
    });
    test('set entry filter throws with tool name in message', () => {
        expect(() =>
            applyLorebookFilterPatchArgs({ bookPattern: '', entryPattern: '' }, { pattern: '[bad(' }, { dimension: 'entry' }),
        ).toThrow(/luker_orch_set_lorebook_entry_filter.*invalid_args/);
    });
});
