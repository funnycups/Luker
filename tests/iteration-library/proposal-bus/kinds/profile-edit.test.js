import { describe, test, expect, jest } from '@jest/globals';
import { createProfileEditHandler } from '../../../../public/scripts/iteration-library/proposal-bus/kinds/profile-edit.js';

describe('profile-edit KindHandler', () => {
    test('fingerprint is async and deterministic for equivalent objects', async () => {
        const h = createProfileEditHandler({
            commitLive: jest.fn(async () => {}),
            readLive: () => ({ a: 1, b: 2 }),
        });
        const f1 = await h.fingerprint({ x: 1, y: { z: 'q' } });
        const f2 = await h.fingerprint({ y: { z: 'q' }, x: 1 });
        expect(typeof f1).toBe('string');
        expect(f1).toBe(f2);
    });

    test('readCurrent reads via injected readLive and fingerprints it', async () => {
        const readLive = jest.fn(() => ({ live: 'now' }));
        const h = createProfileEditHandler({
            commitLive: jest.fn(async () => {}),
            readLive,
        });
        const { snapshot, fingerprint } = await h.readCurrent({ op: 'set', path: '', newValue: { v: 1 } });
        expect(readLive).toHaveBeenCalled();
        expect(snapshot).toEqual({ live: 'now' });
        expect(fingerprint).toBe(await h.fingerprint({ live: 'now' }));
    });

    test('commit forwards op.newValue to injected commitLive', async () => {
        const commitLive = jest.fn(async () => {});
        const h = createProfileEditHandler({
            commitLive,
            readLive: () => null,
        });
        await h.commit({ op: 'set', path: '', newValue: { fresh: true } });
        expect(commitLive).toHaveBeenCalledTimes(1);
        const [arg] = commitLive.mock.calls[0];
        expect(arg).toEqual({ fresh: true });
    });

    test('inverse returns a set op restoring the snapshot', () => {
        const h = createProfileEditHandler({
            commitLive: jest.fn(),
            readLive: () => null,
        });
        const inv = h.inverse({ op: 'set', path: '', newValue: { after: true } }, { before: true });
        expect(inv).toEqual({ op: 'set', path: '', newValue: { before: true } });
    });

    test('inverse returns null when snapshot is undefined', () => {
        const h = createProfileEditHandler({
            commitLive: jest.fn(),
            readLive: () => null,
        });
        expect(h.inverse({ op: 'set' }, undefined)).toBeNull();
    });

    test('label / icon / target accessors return configured strings', () => {
        const h = createProfileEditHandler({
            commitLive: jest.fn(),
            readLive: () => null,
            label: () => 'Profile change',
            icon: () => '✏',
            target: (entry) => `agent:${entry?.meta?.agentId ?? '?'}`,
        });
        expect(h.label({})).toBe('Profile change');
        expect(h.icon({})).toBe('✏');
        expect(h.target({ meta: { agentId: 'main' } })).toBe('agent:main');
    });

    test('renderDiffCard delegates to injected renderer with snapshot+newValue', () => {
        const renderDiff = jest.fn(() => '<div>diff</div>');
        const h = createProfileEditHandler({
            commitLive: jest.fn(),
            readLive: () => null,
            renderDiff,
        });
        const entry = {
            op: { op: 'set', path: '', newValue: { after: true } },
            snapshot: { before: true },
        };
        const out = h.renderDiffCard(entry, { escapeHtml: (s) => s });
        expect(out).toBe('<div>diff</div>');
        expect(renderDiff).toHaveBeenCalledWith({ before: true }, { after: true }, expect.any(Object));
    });

    test('inverseAvailable defaults to true', () => {
        const h = createProfileEditHandler({
            commitLive: jest.fn(),
            readLive: () => null,
        });
        expect(h.inverseAvailable).toBe(true);
    });
});
