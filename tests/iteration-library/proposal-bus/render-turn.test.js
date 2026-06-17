import { describe, test, expect } from '@jest/globals';
import { renderTurnActions } from '../../../public/scripts/iteration-library/proposal-bus/render-turn.js';

describe('renderTurnActions', () => {
    test('returns empty string when no entries match', () => {
        expect(renderTurnActions({ pendingCount: 0, committedCount: 0, messageId: 'm1', i18n: (s) => s })).toBe('');
    });

    // Single-item bulk buttons are noise — the per-card Approve / Reject /
    // Rollback controls already cover the only thing the user can do.
    // Keep the turn-action row only when there are 2+ items where
    // "act on all" is actually faster than per-card clicks.
    test('hides Approve/Reject bulk when there is exactly one pending', () => {
        expect(renderTurnActions({ pendingCount: 1, committedCount: 0, messageId: 'm1', i18n: (s) => s })).toBe('');
    });

    test('hides Rollback bulk when there is exactly one committed', () => {
        expect(renderTurnActions({ pendingCount: 0, committedCount: 1, messageId: 'm1', i18n: (s) => s })).toBe('');
    });

    test('shows Approve all + Reject all when there are 2+ pending', () => {
        const html = renderTurnActions({ pendingCount: 3, committedCount: 0, messageId: 'm1', i18n: (s) => s });
        expect(html).toContain('data-proposal-action="approve-all-pending"');
        expect(html).toContain('data-proposal-action="reject-all-pending"');
        expect(html).toContain('data-proposal-message-id="m1"');
    });

    test('shows Rollback this turn when there are 2+ committed', () => {
        const html = renderTurnActions({ pendingCount: 0, committedCount: 2, messageId: 'm1', i18n: (s) => s });
        expect(html).toContain('data-proposal-action="rollback-turn"');
    });

    test('mixed: 2+ pending and 1 committed → only the pending bulk shows', () => {
        // Pending group reaches the threshold; the committed group is
        // a single item, so its bulk button still hides.
        const html = renderTurnActions({ pendingCount: 2, committedCount: 1, messageId: 'm1', i18n: (s) => s });
        expect(html).toContain('data-proposal-action="approve-all-pending"');
        expect(html).toContain('data-proposal-action="reject-all-pending"');
        expect(html).not.toContain('data-proposal-action="rollback-turn"');
    });

    test('mixed: 1 pending and 2+ committed → only the rollback bulk shows', () => {
        const html = renderTurnActions({ pendingCount: 1, committedCount: 2, messageId: 'm1', i18n: (s) => s });
        expect(html).not.toContain('data-proposal-action="approve-all-pending"');
        expect(html).not.toContain('data-proposal-action="reject-all-pending"');
        expect(html).toContain('data-proposal-action="rollback-turn"');
    });

    test('both shown when both groups have 2+', () => {
        const html = renderTurnActions({ pendingCount: 2, committedCount: 2, messageId: 'm1', i18n: (s) => s });
        expect(html).toContain('data-proposal-action="approve-all-pending"');
        expect(html).toContain('data-proposal-action="rollback-turn"');
    });
});

