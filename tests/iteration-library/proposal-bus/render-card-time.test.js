// tests/iteration-library/proposal-bus/render-card-time.test.js
import { describe, test, expect } from '@jest/globals';
import { renderProposalCard } from '../../../public/scripts/iteration-library/proposal-bus/render-card.js';

const HANDLER = {
    renderDiffCard: () => '',
    icon: () => '',
    label: () => '',
    target: () => '',
    inverseAvailable: false,
};

// Returns only the substituted values, so the assertion depends on the
// time formatting and not on any template wording.
const valuesOnlyI18n = (_template, ...values) => values.join('|');

function statusChipText(entry) {
    const html = renderProposalCard(entry, HANDLER, { i18n: valuesOnlyI18n });
    const match = html.match(/iter_proposal_card_status_[a-zA-Z]+">([^<]*)</);
    return match ? match[1] : null;
}

describe('render-card status time', () => {
    test('a finite timestamp outside the Date range renders an empty time', () => {
        expect(statusChipText({ id: 'invalid', status: 'committed', committedAt: 1e20 })).toBe('');
    });
    test('a numeric timestamp renders as local HH:MM', () => {
        const ts = new Date(2026, 9, 9, 7, 5).getTime();
        expect(statusChipText({ id: 'p1', kind: 'profile-edit', status: 'committed', committedAt: ts })).toBe('07:05');
    });

    test('a non-numeric timestamp renders an empty time', () => {
        expect(statusChipText({ id: 'p2', kind: 'profile-edit', status: 'rejected', decidedAt: 'not-a-time' })).toBe('');
    });

    test('a missing timestamp renders an empty time', () => {
        expect(statusChipText({ id: 'p3', kind: 'profile-edit', status: 'rolledBack' })).toBe('');
    });
});
