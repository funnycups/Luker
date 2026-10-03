import { describe, test, expect } from '@jest/globals';
import os from 'node:os';
import {
    createSyncSession,
    consumeSyncSession,
    closeSyncSession,
    createPairingCode,
    consumePairingCode,
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
});
