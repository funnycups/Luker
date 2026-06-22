import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import { createBus } from '/scripts/iteration-library/proposal-bus/bus.js';
import { registerTarget, clearRegistry } from '/scripts/iteration-library/storage/target-registry.js';

beforeEach(() => clearRegistry());

function liveHandler(initial) {
    let s = JSON.parse(JSON.stringify(initial));
    return {
        read: async () => JSON.parse(JSON.stringify(s)),
        write: async (_meta, next) => { s = JSON.parse(JSON.stringify(next)); },
        describe: () => 't',
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
        const bus = createBus();
        const evt = fakeClick();
        const consumed = await bus.handleClick(evt);
        expect(consumed).toBe(false);
        expect(evt.preventDefault).not.toHaveBeenCalled();
    });

    test('approve action routes to bus.approve and consumes event', async () => {
        registerTarget('preset', liveHandler({ a: 1 }));
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        const { id } = await bus.propose({
            kind: 'k', target: { type: 'preset' }, before: { a: 1 }, after: { a: 2 },
        });
        const evt = fakeClick({ action: 'approve', proposalId: id });
        const consumed = await bus.handleClick(evt);
        expect(consumed).toBe(true);
        expect(evt.preventDefault).toHaveBeenCalled();
        const entry = bus._testOnly_entries().find((e) => e.id === id);
        expect(entry.status).toBe('committed');
    });

    test('reject action routes to bus.reject', async () => {
        registerTarget('preset', liveHandler({ a: 1 }));
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        const { id } = await bus.propose({
            kind: 'k', target: { type: 'preset' }, before: { a: 1 }, after: { a: 2 },
        });
        const evt = fakeClick({ action: 'reject', proposalId: id });
        const consumed = await bus.handleClick(evt);
        expect(consumed).toBe(true);
        const entry = bus._testOnly_entries().find((e) => e.id === id);
        expect(entry.status).toBe('rejected');
    });

    test('unknown action returns false', async () => {
        const bus = createBus();
        const evt = fakeClick({ action: 'nope' });
        const consumed = await bus.handleClick(evt);
        expect(consumed).toBe(false);
    });
});
