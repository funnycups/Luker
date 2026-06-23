import { describe, test, expect } from '@jest/globals';
import os from 'node:os';
import {
    createSyncSession,
    consumeSyncSession,
    closeSyncSession,
    SYNC_SESSION_TTL_MS,
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
