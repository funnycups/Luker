import { describe, test, expect } from '@jest/globals';
import { renderTurnActions } from '../../../public/scripts/iteration-library/proposal-bus/render-turn.js';

describe('renderTurnActions', () => {
    test('returns empty string when no entries match', () => {
        expect(renderTurnActions({ pendingCount: 0, committedCount: 0, messageId: 'm1', i18n: (s) => s })).toBe('');
    });

    test('shows Approve all + Reject all when there is at least one pending', () => {
        const html = renderTurnActions({ pendingCount: 3, committedCount: 0, messageId: 'm1', i18n: (s) => s });
        expect(html).toContain('data-proposal-action="approve-all-pending"');
        expect(html).toContain('data-proposal-action="reject-all-pending"');
        expect(html).toContain('data-proposal-message-id="m1"');
    });

    test('shows Rollback this turn when there is at least one committed', () => {
        const html = renderTurnActions({ pendingCount: 0, committedCount: 2, messageId: 'm1', i18n: (s) => s });
        expect(html).toContain('data-proposal-action="rollback-turn"');
    });

    test('both shown when both groups exist', () => {
        const html = renderTurnActions({ pendingCount: 2, committedCount: 1, messageId: 'm1', i18n: (s) => s });
        expect(html).toContain('data-proposal-action="approve-all-pending"');
        expect(html).toContain('data-proposal-action="rollback-turn"');
    });
});
