import { describe, test, expect, jest } from '@jest/globals';
import os from 'node:os';
import {
    createSyncSession,
    consumeSyncSession,
    closeSyncSession,
    closeSyncSessionsFor,
    createPairingCode,
    consumePairingCode,
    restorePairingCode,
    SYNC_SESSION_TTL_MS,
    PAIR_CODE_TTL_MS,
} from '../../src/sync/session.js';

describe('sync session tokens', () => {
    const userRoot = os.tmpdir();

    test('createSyncSession returns a 64-hex token and expiry', () => {
        const { token, expiresAt } = createSyncSession({ handle: 'alice', peerId: 'alice@phone', userRoot });
        expect(token).toMatch(/^[a-f0-9]{64}$/);
        expect(expiresAt).toBeGreaterThan(Date.now());
        expect(expiresAt).toBeLessThanOrEqual(Date.now() + SYNC_SESSION_TTL_MS + 50);
    });

    test('consumeSyncSession returns the original payload while valid', () => {
        const { token } = createSyncSession({ handle: 'alice', peerId: 'alice@phone', userRoot });
        const first = consumeSyncSession(token);
        expect(first).toEqual(expect.objectContaining({ handle: 'alice', peerId: 'alice@phone' }));
        // Multi-use: a second consume within TTL also succeeds.
        const second = consumeSyncSession(token);
        expect(second).toEqual(expect.objectContaining({ handle: 'alice', peerId: 'alice@phone' }));
    });

    test('consumeSyncSession returns null for unknown tokens', () => {
        expect(consumeSyncSession('z'.repeat(64))).toBeNull();
        expect(consumeSyncSession('not-hex')).toBeNull();
        expect(consumeSyncSession('')).toBeNull();
        expect(consumeSyncSession(null)).toBeNull();
    });

    test('closeSyncSession invalidates a token immediately', () => {
        const { token } = createSyncSession({ handle: 'alice', peerId: 'alice@phone', userRoot });
        expect(consumeSyncSession(token)).not.toBeNull();
        closeSyncSession(token);
        expect(consumeSyncSession(token)).toBeNull();
    });

    test('createSyncSession refuses payload missing userRoot', () => {
        expect(() => createSyncSession({ handle: 'alice', peerId: 'alice@phone' }))
            .toThrow(/userRoot/);
    });

    test('a session used within the TTL stays valid past its first expiry', () => {
        const start = 1_000_000;
        const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
        try {
            const { token } = createSyncSession({ handle: 'u', peerId: 'u@aa', userRoot: '/tmp/u' });
            clock.mockReturnValue(start + SYNC_SESSION_TTL_MS - 1);
            expect(consumeSyncSession(token)).not.toBeNull();
            clock.mockReturnValue(start + SYNC_SESSION_TTL_MS + 10);
            expect(consumeSyncSession(token)).not.toBeNull();
            clock.mockReturnValue(start + 3 * SYNC_SESSION_TTL_MS);
            expect(consumeSyncSession(token)).toBeNull();
        } finally {
            clock.mockRestore();
        }
    });

    test('closeSyncSessionsFor ends only the sessions of that backend', () => {
        const mine = createSyncSession({ handle: 'u', peerId: 'u@aa', userRoot: '/tmp/u' }).token;
        const other = createSyncSession({ handle: 'u', peerId: 'u@bb', userRoot: '/tmp/u' }).token;
        closeSyncSessionsFor({ userRoot: '/tmp/u', peerId: 'u@aa' });
        expect(consumeSyncSession(mine)).toBeNull();
        expect(consumeSyncSession(other)).not.toBeNull();
    });

    test('closeSyncSessionsFor matches the resolved user root', () => {
        const token = createSyncSession({ handle: 'u', peerId: 'u@cc', userRoot: '/tmp/u/' }).token;
        closeSyncSessionsFor({ userRoot: '/tmp/x/../u', peerId: 'u@cc' });
        expect(consumeSyncSession(token)).toBeNull();
    });
});

describe('one-time pairing codes', () => {
    test('createPairingCode returns a 64-hex code', () => {
        const code = createPairingCode({ handle: 'alice', peerId: 'alice@phone' });
        expect(code).toMatch(/^[a-f0-9]{64}$/);
    });

    test('consumePairingCode returns the payload when binding matches', () => {
        const code = createPairingCode({ handle: 'alice', peerId: 'alice@phone' });
        const payload = consumePairingCode(code, { handle: 'alice', peerId: 'alice@phone' });
        expect(payload).toEqual(expect.objectContaining({ handle: 'alice', peerId: 'alice@phone' }));
    });

    test('consumePairingCode is single-use — a replay returns null', () => {
        const code = createPairingCode({ handle: 'alice', peerId: 'alice@phone' });
        expect(consumePairingCode(code, { handle: 'alice', peerId: 'alice@phone' })).not.toBeNull();
        expect(consumePairingCode(code, { handle: 'alice', peerId: 'alice@phone' })).toBeNull();
    });

    test('consumePairingCode rejects a mismatched peerId without burning the code', () => {
        const code = createPairingCode({ handle: 'alice', peerId: 'alice@phone' });
        expect(consumePairingCode(code, { handle: 'alice', peerId: 'alice@laptop' })).toBeNull();
        // The legitimate binding still works afterwards.
        expect(consumePairingCode(code, { handle: 'alice', peerId: 'alice@phone' })).not.toBeNull();
    });

    test('consumePairingCode rejects a mismatched handle without burning the code', () => {
        const code = createPairingCode({ handle: 'alice', peerId: 'alice@phone' });
        expect(consumePairingCode(code, { handle: 'bob', peerId: 'alice@phone' })).toBeNull();
        expect(consumePairingCode(code, { handle: 'alice', peerId: 'alice@phone' })).not.toBeNull();
    });

    test('consumePairingCode returns null for unknown or malformed codes', () => {
        expect(consumePairingCode('z'.repeat(64), { handle: 'alice', peerId: 'alice@phone' })).toBeNull();
        expect(consumePairingCode('not-hex', { handle: 'alice', peerId: 'alice@phone' })).toBeNull();
        expect(consumePairingCode('', { handle: 'alice', peerId: 'alice@phone' })).toBeNull();
        expect(consumePairingCode(null, { handle: 'alice', peerId: 'alice@phone' })).toBeNull();
    });

    test('createPairingCode refuses payload missing handle or peerId', () => {
        expect(() => createPairingCode({ peerId: 'alice@phone' })).toThrow(/handle/);
        expect(() => createPairingCode({ handle: 'alice' })).toThrow(/peerId/);
    });

    test('pairing codes live no longer than the documented link lifetime', () => {
        expect(PAIR_CODE_TTL_MS).toBe(10 * 60 * 1000);
    });

    test('a restored code is usable once more but only within its original lifetime', () => {
        const start = 5_000_000;
        const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
        try {
            const binding = { handle: 'alice', peerId: 'alice@phone' };
            const code = createPairingCode(binding);
            const payload = consumePairingCode(code, binding);
            restorePairingCode(code, payload);
            expect(consumePairingCode(code, binding)).not.toBeNull();
            expect(consumePairingCode(code, binding)).toBeNull();

            const late = createPairingCode(binding);
            const latePayload = consumePairingCode(late, binding);
            clock.mockReturnValue(start + PAIR_CODE_TTL_MS - 1);
            restorePairingCode(late, latePayload);
            clock.mockReturnValue(start + PAIR_CODE_TTL_MS + 1);
            expect(consumePairingCode(late, binding)).toBeNull();
        } finally {
            clock.mockRestore();
        }
    });
});
