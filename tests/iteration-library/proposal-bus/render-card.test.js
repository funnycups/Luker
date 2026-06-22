import { describe, test, expect, jest } from '@jest/globals';
import { renderProposalCard } from '/scripts/iteration-library/proposal-bus/render-card.js';
import { createBus } from '/scripts/iteration-library/proposal-bus/bus.js';
import { presetClone } from '/scripts/iteration-library/proposal-bus/kinds/preset-clone.js';
import { registerTarget, clearRegistry } from '/scripts/iteration-library/storage/target-registry.js';

const HANDLER = {
    renderDiffCard: () => '<div class="diff">DIFF</div>',
    label: () => 'Update skill file',
    icon: () => '✏️',
    target: () => 'skill_foo (global)',
};

function entry(overrides = {}) {
    return {
        id: 'k_1_aaa',
        kind: 'k',
        sourceCallId: 'c1',
        status: 'pending',
        target: { type: 'preset' },
        inverse: [{ op: 'replace', path: '/a', value: 1 }],
        meta: null,
        createdAt: 0,
        decidedAt: null,
        committedAt: null,
        rolledBackAt: null,
        conflictError: null,
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

    test('committed card with non-empty inverse shows Rollback button', () => {
        const html = renderProposalCard(
            entry({ status: 'committed', committedAt: Date.now() }),
            HANDLER,
            { i18n: (s) => s },
        );
        expect(html).toContain('data-proposal-action="rollback"');
    });

    test('committed card with empty inverse hides Rollback (no semantic undo)', () => {
        const html = renderProposalCard(
            entry({ status: 'committed', inverse: [], committedAt: Date.now() }),
            HANDLER,
            { i18n: (s) => s },
        );
        expect(html).not.toContain('data-proposal-action="rollback"');
    });

    test('committed card with inverseAvailable=false hides Rollback (handler opt-out)', () => {
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

    test('conflict card carries conflict explanation HTML but NO Approve/Reject buttons (write was dropped, AI already notified)', () => {
        const e = entry({
            status: 'conflict',
            conflictError: {
                targetType: 'preset',
                targetName: null,
                jsonPath: '/a',
                reason: 'external modification on patched path',
            },
        });
        const html = renderProposalCard(e, HANDLER, { i18n: (s) => s });
        expect(html).toContain('iter_proposal_card_conflict');
        // The bus enqueues a conflict outcome the moment it sees drift,
        // which drainOutcomes reports back to the AI. Re-approving from
        // here would commit a stale diff; rejecting adds nothing the
        // outcome doesn't already carry. So the card chrome is read-only.
        expect(html).not.toContain('data-proposal-action="approve"');
        expect(html).not.toContain('data-proposal-action="reject"');
    });

    test('conflict card omits the controls row entirely when there is nothing to render', () => {
        const e = entry({
            status: 'conflict',
            conflictError: { targetType: 'preset', targetName: null, jsonPath: '/a', reason: 'drift' },
        });
        const html = renderProposalCard(e, HANDLER, { i18n: (s) => s });
        expect(html).not.toContain('iter_proposal_card_controls');
    });
});

describe('preset-clone descriptor suppresses the Rollback button even with non-empty inverse', () => {
    beforeEach(() => clearRegistry());

    function presetLiveHandler(initial) {
        let s = JSON.parse(JSON.stringify(initial));
        return {
            read: jest.fn(async () => JSON.parse(JSON.stringify(s))),
            write: jest.fn(async (_meta, next) => { s = JSON.parse(JSON.stringify(next)); }),
            describe: () => 'preset(foo)',
            renderDiffCard: () => '<div class="diff">CLONE DIFF</div>',
            label: () => 'Clone preset',
            icon: () => '📋',
            target: () => 'preset(foo)',
        };
    }

    test('committed preset-clone card omits Rollback even though inverse is non-empty (clone-and-switch is non-rollbackable)', async () => {
        // Register the preset target with a live handler so the bus can read/write.
        const h = presetLiveHandler({ a: 1 });
        registerTarget('preset', h);

        // Wire the real exported descriptor + add renderer hooks the
        // card chrome needs (renderDiffCard/label/icon/target). Doing it
        // this way exercises the same kinds.get(e.kind) lookup that the
        // popup's renderCardsForMessage uses in production.
        const bus = createBus();
        bus.registerKind(presetClone.kind, {
            ...presetClone,
            renderDiffCard: h.renderDiffCard,
            label: h.label,
            icon: h.icon,
            target: h.target,
        });

        // Non-empty inverse — `compare({a:1}, {a:2})` produces one op,
        // which would normally enable the Rollback button via
        // `hasInverse && handler.inverseAvailable !== false`.
        const { id } = await bus.propose({
            kind: 'preset-clone',
            target: { type: 'preset' },
            before: { a: 1 },
            after: { a: 2 },
            sourceCallId: 'call_clone_1',
        });
        const result = await bus.approve(id);
        expect(result.status).toBe('committed');

        const html = bus.renderCardsForMessage('call_clone_1');
        expect(html).toContain('data-proposal-kind="preset-clone"');
        expect(html).toContain('iter_proposal_card_committed');
        expect(html).not.toContain('data-proposal-action="rollback"');
    });
});
