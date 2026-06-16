import { describe, test, expect } from '@jest/globals';
import { renderProposalCard } from '../../../public/scripts/iteration-library/proposal-bus/render-card.js';

const HANDLER = {
    renderDiffCard: () => '<div class="diff">DIFF</div>',
    label: () => 'Update skill file',
    icon: () => '✏️',
    target: () => 'skill_foo (global)',
    inverseAvailable: true,
};

function entry(overrides = {}) {
    return {
        id: 'k_1_aaa',
        kind: 'k',
        sourceCallId: 'c1',
        status: 'pending',
        op: {},
        snapshot: null,
        fingerprint: 'fp',
        meta: null,
        createdAt: 0,
        decidedAt: null,
        committedAt: null,
        rolledBackAt: null,
        conflictInfo: null,
        ...overrides,
    };
}

describe('renderProposalCard', () => {
    test('pending card has Approve and Reject buttons with proper data-proposal-action attrs', () => {
        const html = renderProposalCard(entry(), HANDLER, { i18n: (s) => s });
        expect(html).toContain('data-proposal-id="k_1_aaa"');
        expect(html).toContain('data-proposal-kind="k"');
        expect(html).toContain('data-proposal-action="approve"');
        expect(html).toContain('data-proposal-action="reject"');
        expect(html).toContain('iter_proposal_card_pending');
        expect(html).toContain('DIFF');
        expect(html).toContain('Update skill file');
        expect(html).toContain('skill_foo (global)');
        expect(html).toContain('✏️');
    });

    test('rejected card shows Undo reject button only', () => {
        const html = renderProposalCard(entry({ status: 'rejected', decidedAt: Date.now() }), HANDLER, { i18n: (s) => s });
        expect(html).toContain('data-proposal-action="reset"');
        expect(html).not.toContain('data-proposal-action="approve"');
        expect(html).not.toContain('data-proposal-action="reject"');
    });

    test('committed card with handler.inverseAvailable shows Rollback button', () => {
        const html = renderProposalCard(
            entry({ status: 'committed', committedAt: Date.now() }),
            HANDLER,
            { i18n: (s) => s },
        );
        expect(html).toContain('data-proposal-action="rollback"');
    });

    test('committed card with inverseAvailable=false hides Rollback', () => {
        const html = renderProposalCard(
            entry({ status: 'committed', committedAt: Date.now() }),
            { ...HANDLER, inverseAvailable: false },
            { i18n: (s) => s },
        );
        expect(html).not.toContain('data-proposal-action="rollback"');
    });

    test('rolledBack card has no buttons', () => {
        const html = renderProposalCard(
            entry({ status: 'rolledBack', rolledBackAt: Date.now() }),
            HANDLER,
            { i18n: (s) => s },
        );
        expect(html).not.toContain('data-proposal-action="approve"');
        expect(html).not.toContain('data-proposal-action="reject"');
        expect(html).not.toContain('data-proposal-action="rollback"');
        expect(html).not.toContain('data-proposal-action="reset"');
    });

    test('conflict card carries conflict explanation HTML and Approve/Reject buttons', () => {
        const e = entry({
            status: 'conflict',
            conflictInfo: {
                expectedFingerprint: 'a',
                actualFingerprint: 'b',
                actualSnapshot: { current: 'on-disk' },
                at: Date.now(),
            },
        });
        const html = renderProposalCard(e, HANDLER, { i18n: (s) => s });
        expect(html).toContain('iter_proposal_card_conflict');
        expect(html).toContain('data-proposal-action="approve"');
        expect(html).toContain('data-proposal-action="reject"');
    });
});
