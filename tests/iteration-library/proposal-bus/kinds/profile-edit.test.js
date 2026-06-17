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

    // Regression: every iter-studio popup ships an `async readLive` (it
    // wraps `loadLive()` which may await disk I/O before returning the
    // re-read state). The handler's readCurrent forgot to `await` it,
    // so `snapshot` was a Promise. canonicalJson sees a Promise as
    // `{}` (no own enumerable keys), so every fingerprint after the
    // first one collapsed to sha256("{}") and NEVER matched the
    // proposal's fingerprint of the real profile — every fresh approve
    // bounced to status='conflict' with "外部已变更" before the user
    // had a chance to do anything. Lock this down by giving readLive
    // an async signature that returns a real object; the handler must
    // await it and fingerprint the resolved value, not the Promise.
    test('readCurrent awaits an async readLive (the production shape)', async () => {
        const liveAtReadTime = { spec: { stages: [{ id: 'a' }] } };
        const readLive = jest.fn(async () => liveAtReadTime);
        const h = createProfileEditHandler({
            commitLive: jest.fn(async () => {}),
            readLive,
        });
        const { snapshot, fingerprint } = await h.readCurrent({ op: 'set', path: '', newValue: {} });
        // Snapshot must be the resolved value, not the Promise itself.
        expect(snapshot).toBe(liveAtReadTime);
        // Fingerprint must match what fingerprint() produces for the
        // SAME object — i.e. the bus's drift check would see "no
        // change" when the disk really did not change.
        expect(fingerprint).toBe(await h.fingerprint(liveAtReadTime));
        // And it must NOT match the empty-object fingerprint (which is
        // what we'd get if a Promise had been hashed through
        // canonicalJson).
        expect(fingerprint).not.toBe(await h.fingerprint({}));
    });

    test('approve on an unchanged async-readLive commits cleanly (no false conflict)', async () => {
        // Full end-to-end through the bus, using the production-shaped
        // async readLive. Pre-fix this returned status='conflict' on the
        // first approve because readCurrent's missing `await` meant the
        // bus compared `fingerprint(snapshot)` against `fingerprint(Promise)`.
        const { createProposalBus } = await import('../../../../public/scripts/iteration-library/proposal-bus/index.js');
        const profile = { a: 1, b: [{ x: 'q' }] };
        const commitLive = jest.fn(async () => {});
        const handler = createProfileEditHandler({
            commitLive,
            readLive: async () => profile,
        });
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('profile-edit', handler);
        const { id } = await bus.propose({
            kind: 'profile-edit',
            op: { op: 'set', path: '', newValue: { a: 2, b: [{ x: 'q' }] } },
            snapshot: profile,
        });
        const out = await bus.approve(id);
        expect(out).toEqual({ ok: true, status: 'committed' });
        expect(commitLive).toHaveBeenCalledWith({ a: 2, b: [{ x: 'q' }] });
        const entry = bus._testOnly_entries().find((e) => e.id === id);
        expect(entry.status).toBe('committed');
        expect(entry.conflictInfo).toBe(null);
    });
});
