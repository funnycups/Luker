import { describe, test, expect, jest } from '@jest/globals';
import { createProposalBus } from '../../../public/scripts/iteration-library/proposal-bus/index.js';

function makeHandler(overrides = {}) {
    return {
        fingerprint: jest.fn(async (snap) => `fp:${JSON.stringify(snap ?? null)}`),
        readCurrent: jest.fn(async () => ({ snapshot: null, fingerprint: 'fp:null' })),
        commit: jest.fn(async () => {}),
        inverse: jest.fn(() => null),
        renderDiffCard: jest.fn(() => '<div>diff</div>'),
        label: jest.fn(() => 'Test edit'),
        icon: jest.fn(() => '✏️'),
        target: jest.fn(() => 'some/target'),
        ...overrides,
    };
}

describe('ProposalBus — propose + gate', () => {
    test('registerKind twice on same id throws', () => {
        const bus = createProposalBus({ mode: 'test', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k1', makeHandler());
        expect(() => bus.registerKind('k1', makeHandler())).toThrow(/already registered/i);
    });

    test('propose with unregistered kind throws', async () => {
        const bus = createProposalBus({ mode: 'test', i18n: (s) => s, onChange: () => {} });
        await expect(bus.propose({ kind: 'nope', op: {}, snapshot: null })).rejects.toThrow(/unknown kind/i);
    });

    test('propose returns id + fingerprint and stores entry as pending', async () => {
        const bus = createProposalBus({ mode: 'test', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k1', makeHandler());
        const out = await bus.propose({ kind: 'k1', sourceCallId: 'c1', op: { x: 1 }, snapshot: { y: 2 } });
        expect(out.id).toMatch(/^k1_/);
        expect(out.fingerprint).toBe('fp:{"y":2}');
        const all = bus._testOnly_entries();
        expect(all).toHaveLength(1);
        expect(all[0].status).toBe('pending');
        expect(all[0].kind).toBe('k1');
        expect(all[0].sourceCallId).toBe('c1');
        expect(all[0].op).toEqual({ x: 1 });
        expect(all[0].snapshot).toEqual({ y: 2 });
        expect(all[0].fingerprint).toBe('fp:{"y":2}');
        expect(typeof all[0].createdAt).toBe('number');
        expect(all[0].decidedAt).toBe(null);
        expect(all[0].committedAt).toBe(null);
    });

    test('propose fires onChange', async () => {
        const onChange = jest.fn();
        const bus = createProposalBus({ mode: 'test', i18n: (s) => s, onChange });
        bus.registerKind('k1', makeHandler());
        await bus.propose({ kind: 'k1', op: {}, snapshot: null });
        expect(onChange).toHaveBeenCalledTimes(1);
    });

    test('hasOutstanding is false on empty bus', () => {
        const bus = createProposalBus({ mode: 'test', i18n: (s) => s, onChange: () => {} });
        expect(bus.hasOutstanding()).toBe(false);
    });

    test('hasOutstanding is true with one pending entry', async () => {
        const bus = createProposalBus({ mode: 'test', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k1', makeHandler());
        await bus.propose({ kind: 'k1', op: {}, snapshot: null });
        expect(bus.hasOutstanding()).toBe(true);
    });

    test('proposal id is unique across N proposals', async () => {
        const bus = createProposalBus({ mode: 'test', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k1', makeHandler());
        const ids = [];
        for (let i = 0; i < 5; i++) {
            const out = await bus.propose({ kind: 'k1', op: {}, snapshot: { i } });
            ids.push(out.id);
        }
        expect(new Set(ids).size).toBe(5);
    });
});
