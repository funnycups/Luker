import { describe, test, expect, jest } from '@jest/globals';
import { createProposalBus } from '../../../public/scripts/iteration-library/proposal-bus/index.js';

function makeHandler() {
    return {
        fingerprint: async (s) => `fp:${JSON.stringify(s ?? null)}`,
        readCurrent: async () => ({ snapshot: null, fingerprint: 'fp:null' }),
        commit: jest.fn(async () => {}),
        inverse: () => null,
        renderDiffCard: () => '',
        label: () => '',
        icon: () => '',
        target: () => '',
    };
}

function fakeClick({ action, proposalId, messageId } = {}) {
    const target = {
        getAttribute: jest.fn((k) => {
            if (k === 'data-proposal-action') return action ?? null;
            if (k === 'data-proposal-id') return proposalId ?? null;
            if (k === 'data-proposal-message-id') return messageId ?? null;
            return null;
        }),
        closest: jest.fn(function (sel) {
            if (sel === '[data-proposal-action]' && action) return this;
            return null;
        }),
    };
    return {
        target,
        preventDefault: jest.fn(),
        stopPropagation: jest.fn(),
    };
}

describe('ProposalBus — event router', () => {
    test('click without data-proposal-action returns false and does not consume', async () => {
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        const evt = fakeClick();
        const consumed = await bus.handleClick(evt);
        expect(consumed).toBe(false);
        expect(evt.preventDefault).not.toHaveBeenCalled();
    });

    test('approve action routes to bus.approve and consumes event', async () => {
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k', makeHandler());
        const { id } = await bus.propose({ kind: 'k', op: {}, snapshot: null });
        const evt = fakeClick({ action: 'approve', proposalId: id });
        const consumed = await bus.handleClick(evt);
        expect(consumed).toBe(true);
        expect(evt.preventDefault).toHaveBeenCalled();
        const entry = bus._testOnly_entries().find((e) => e.id === id);
        expect(entry.status).toBe('committed');
    });

    test('reject action routes to bus.reject', async () => {
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k', makeHandler());
        const { id } = await bus.propose({ kind: 'k', op: {}, snapshot: null });
        const evt = fakeClick({ action: 'reject', proposalId: id });
        const consumed = await bus.handleClick(evt);
        expect(consumed).toBe(true);
        const entry = bus._testOnly_entries().find((e) => e.id === id);
        expect(entry.status).toBe('rejected');
    });

    test('unknown action returns false', async () => {
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        const evt = fakeClick({ action: 'nope' });
        const consumed = await bus.handleClick(evt);
        expect(consumed).toBe(false);
    });
});
