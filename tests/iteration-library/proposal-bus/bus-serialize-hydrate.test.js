import { jest } from '@jest/globals';
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

describe('bus.serialize/hydrate (v3)', () => {
    test('serialize returns version 3 envelope', async () => {
        registerTarget('preset', liveHandler({}));
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        await bus.propose({
            kind: 'k', target: { type: 'preset' }, before: {}, after: { a: 1 }, sourceCallId: 'c1',
        });
        const data = bus.serialize();
        expect(data.version).toBe(3);
        expect(data.entries).toHaveLength(1);
        expect(data.entries[0]).toMatchObject({
            kind: 'k',
            target: { type: 'preset' },
            inverse: [{ op: 'remove', path: '/a' }],
            status: 'pending',
            sourceCallId: 'c1',
        });
        expect(data.entries[0]).not.toHaveProperty('snapshot');
        expect(data.entries[0]).not.toHaveProperty('op');
        expect(data.entries[0]).not.toHaveProperty('fingerprint');
        expect(data.entries[0]).not.toHaveProperty('_pendingAfter');
    });

    test('hydrate restores v3 entries verbatim (excluding _pendingAfter)', async () => {
        registerTarget('preset', liveHandler({}));
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        bus.hydrate({
            version: 3,
            entries: [{
                id: 'k_5_aaaaaa',
                kind: 'k',
                target: { type: 'preset' },
                inverse: [{ op: 'replace', path: '/a', value: 1 }],
                status: 'committed',
                sourceCallId: null,
                meta: null,
                createdAt: 1,
                decidedAt: 2,
                committedAt: 3,
                rolledBackAt: null,
                conflictError: null,
            }],
            outcomeQueue: [],
        });
        expect(bus._testOnly_entries()).toHaveLength(1);
        expect(bus._testOnly_entries()[0].inverse).toEqual([{ op: 'replace', path: '/a', value: 1 }]);
    });

    test('hydrate rejects version 2 (no silent acceptance)', () => {
        const bus = createBus();
        bus.hydrate({ version: 2, entries: [], outcomeQueue: [] });
        expect(bus._testOnly_entries()).toHaveLength(0);
    });

    test('hydrate preserves seq from id', () => {
        registerTarget('preset', liveHandler({}));
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        bus.hydrate({
            version: 3,
            entries: [{ id: 'k_5_xxx', kind: 'k', target: { type: 'preset' }, inverse: [],
                status: 'pending', sourceCallId: null, meta: null, createdAt: 0, decidedAt: null,
                committedAt: null, rolledBackAt: null, conflictError: null }],
            outcomeQueue: [],
        });
        return bus.propose({ kind: 'k', target: { type: 'preset' }, before: {}, after: { x: 1 } })
            .then(({ id }) => {
                const seqNum = Number(id.split('_')[1]);
                expect(seqNum).toBeGreaterThan(5);
            });
    });
});
