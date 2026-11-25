import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { createBus } from '/scripts/iteration-library/proposal-bus/bus.js';
import { clearRegistry } from '/scripts/iteration-library/storage/target-registry.js';
import { STATE_ERROR_REASONS } from '/scripts/lib/state-errors.js';

const ENTRY_ID = 'lorebook-write_1_abcdef';

function hydratedEntry(status) {
    return {
        id: ENTRY_ID,
        kind: 'lorebook-write',
        target: { type: 'lorebook', name: 'World Lore' },
        inverse: [{ op: 'replace', path: '/entries/1/content', value: 'The lantern is trimmed at dusk.' }],
        sourceCallId: 'c1',
        status,
        meta: null,
        createdAt: 1,
        decidedAt: status === 'pending' ? null : 2,
        committedAt: status === 'committed' ? 3 : null,
        rolledBackAt: null,
        conflictError: null,
    };
}

function hydratedBus(status) {
    const bus = createBus();
    bus.registerKind('lorebook-write', {});
    bus.hydrate({ version: 3, entries: [hydratedEntry(status)], outcomeQueue: [] });
    return bus;
}

beforeEach(() => clearRegistry());

describe('bus with a hydrated entry whose target type has no handler', () => {
    test('approve parks the entry as a conflict instead of throwing', async () => {
        const bus = hydratedBus('pending');
        const out = await bus.approve(ENTRY_ID);
        expect(out).toMatchObject({ ok: false, status: 'conflict', reason: STATE_ERROR_REASONS.VALIDATION_ARGS });
        expect(bus.listEntries()[0].status).toBe('conflict');
        expect(bus.drainOutcomes()).toEqual([expect.objectContaining({ id: ENTRY_ID, status: 'conflict' })]);
    });

    test('rollback parks the entry as a conflict instead of throwing', async () => {
        const bus = hydratedBus('committed');
        const failed = jest.fn();
        bus.events.addEventListener('bus:rollback-failed', failed);
        const out = await bus.rollback(ENTRY_ID);
        expect(out).toMatchObject({ ok: false, status: 'conflict', reason: STATE_ERROR_REASONS.VALIDATION_ARGS });
        expect(failed).toHaveBeenCalledTimes(1);
        expect(bus.listEntries()[0].status).toBe('conflict');
    });
});
