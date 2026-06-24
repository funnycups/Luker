/**
 * Persistent peer credentials for LAN Sync multi-user mode.
 *
 * In multi-user mode the user must supply basic-auth credentials in the
 * pair form so B's server can fetch A's `/session/offer`. Pre-this-change
 * those credentials were used once and forgotten — every subsequent
 * "Sync now" 401'd because no Authorization header went out. The
 * registry now persists `peerAuth` on the entry; this file proves that:
 *
 *   - `recordPeer` stores only complete credentials and preserves the
 *     existing blob when the caller doesn't supply one,
 *   - `clearPeerAuth` drops the blob without touching the rest of the
 *     entry and is idempotent on absent peers,
 *   - the on-disk `state.json` is mode 0600 because it now holds
 *     plaintext credentials.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    readSyncState,
    recordPeer,
    recordSyncCompletion,
    clearPeerAuth,
} from '../../src/sync/state.js';

describe('peer credentials are persisted', () => {
    let userRoot;
    const statePath = () => path.join(userRoot, '.sync', 'state.json');

    beforeEach(() => {
        userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-sync-peerauth-'));
    });
    afterEach(() => {
        fs.rmSync(userRoot, { recursive: true, force: true });
    });

    test('recordPeer stores peerAuth when both fields are non-empty', async () => {
        await recordPeer({
            userRoot,
            peerId: 'alice@phone',
            label: 'Phone',
            categories: ['characters'],
            peerBaseUrl: 'http://10.0.0.5:8000',
            peerAuth: { username: 'alice', password: 'secret' },
        });

        const state = readSyncState({ userRoot });
        expect(state.peers['alice@phone']).toEqual(expect.objectContaining({
            label: 'Phone',
            categories: ['characters'],
            peerBaseUrl: 'http://10.0.0.5:8000',
            peerAuth: { username: 'alice', password: 'secret' },
        }));
    });

    test('recordPeer preserves the stored peerAuth when re-called without one', async () => {
        // Mirrors the real flow: /pair/accept records auth, then a later
        // /pair/start (or relabel) for the same peer mustn't clobber the
        // stored credentials just because /pair/start has no auth field.
        await recordPeer({
            userRoot,
            peerId: 'alice@phone',
            label: 'Phone',
            categories: ['characters'],
            peerAuth: { username: 'alice', password: 'secret' },
        });
        await recordPeer({
            userRoot,
            peerId: 'alice@phone',
            label: 'Phone (renamed)',
            categories: ['characters', 'world-info'],
            // no peerAuth
        });

        const state = readSyncState({ userRoot });
        expect(state.peers['alice@phone'].peerAuth).toEqual({ username: 'alice', password: 'secret' });
        expect(state.peers['alice@phone'].label).toBe('Phone (renamed)');
        expect(state.peers['alice@phone'].categories).toEqual(['characters', 'world-info']);
    });

    test('recordPeer preserves stored peerAuth when peerAuth is explicitly null', async () => {
        // The endpoint sets peerAuth to null when the request body omits
        // the field entirely; that path must still preserve credentials.
        await recordPeer({
            userRoot,
            peerId: 'alice@phone',
            label: 'Phone',
            categories: ['characters'],
            peerAuth: { username: 'alice', password: 'secret' },
        });
        await recordPeer({
            userRoot,
            peerId: 'alice@phone',
            label: 'Phone',
            categories: ['characters'],
            peerAuth: null,
        });
        expect(readSyncState({ userRoot }).peers['alice@phone'].peerAuth).toEqual({
            username: 'alice',
            password: 'secret',
        });
    });

    test('recordPeer ignores half-filled credentials (missing password)', async () => {
        await recordPeer({
            userRoot,
            peerId: 'alice@phone',
            label: 'Phone',
            categories: ['characters'],
            peerAuth: { username: 'alice' },
        });
        expect(readSyncState({ userRoot }).peers['alice@phone'].peerAuth).toBeUndefined();
    });

    test('recordPeer ignores half-filled credentials (missing username)', async () => {
        await recordPeer({
            userRoot,
            peerId: 'alice@phone',
            label: 'Phone',
            categories: ['characters'],
            peerAuth: { password: 'secret' },
        });
        expect(readSyncState({ userRoot }).peers['alice@phone'].peerAuth).toBeUndefined();
    });

    test('recordPeer ignores credentials with empty strings', async () => {
        await recordPeer({
            userRoot,
            peerId: 'alice@phone',
            label: 'Phone',
            categories: ['characters'],
            peerAuth: { username: '', password: '' },
        });
        expect(readSyncState({ userRoot }).peers['alice@phone'].peerAuth).toBeUndefined();
    });

    test('clearPeerAuth drops the field without disturbing other peer state', async () => {
        await recordPeer({
            userRoot,
            peerId: 'alice@phone',
            label: 'Phone',
            categories: ['characters'],
            peerBaseUrl: 'http://10.0.0.5:8000',
            peerAuth: { username: 'alice', password: 'secret' },
        });
        await recordSyncCompletion({ userRoot, peerId: 'alice@phone', headOid: 'b'.repeat(40) });

        await clearPeerAuth({ userRoot, peerId: 'alice@phone' });

        const peer = readSyncState({ userRoot }).peers['alice@phone'];
        expect(peer.peerAuth).toBeUndefined();
        expect(peer.label).toBe('Phone');
        expect(peer.categories).toEqual(['characters']);
        expect(peer.peerBaseUrl).toBe('http://10.0.0.5:8000');
        expect(peer.lastSyncedOid).toBe('b'.repeat(40));
        expect(peer.lastSyncAt).toEqual(expect.any(Number));
    });

    test('clearPeerAuth on absent peer is a no-op', async () => {
        // No throw, no entry created — the file may not exist either.
        await expect(clearPeerAuth({ userRoot, peerId: 'never-paired' })).resolves.toBeUndefined();
        expect(readSyncState({ userRoot }).peers).toEqual({});
    });

    test('clearPeerAuth on peer without stored credentials is a no-op', async () => {
        await recordPeer({
            userRoot,
            peerId: 'alice@phone',
            label: 'Phone',
            categories: ['characters'],
        });
        const before = readSyncState({ userRoot });
        await expect(clearPeerAuth({ userRoot, peerId: 'alice@phone' })).resolves.toBeUndefined();
        const after = readSyncState({ userRoot });
        expect(after).toEqual(before);
    });

    test('clearPeerAuth rejects unsafe peerId values', async () => {
        await expect(clearPeerAuth({ userRoot, peerId: '..' })).rejects.toThrow();
        await expect(clearPeerAuth({ userRoot, peerId: 'a/b' })).rejects.toThrow();
    });

    // POSIX mode bits are cosmetic on Windows (the file is r/w via ACLs
    // not the unix mode word), so the explicit 0600 assertion is meaningless
    // there. Select the test fn at framework-resolve time per platform.
    const posixTest = process.platform === 'win32' ? test.skip : test;

    posixTest('state.json is mode 0600 after recordPeer', async () => {
        await recordPeer({
            userRoot,
            peerId: 'alice@phone',
            label: 'Phone',
            categories: ['characters'],
            peerAuth: { username: 'alice', password: 'secret' },
        });
        // Mode bits only — POSIX user/group/other rwx. The other bits
        // depend on the umask of the tmp dir and aren't load-bearing.
        const mode = fs.statSync(statePath()).mode & 0o777;
        expect(mode).toBe(0o600);
    });

    posixTest('state.json is mode 0600 after recordSyncCompletion and clearPeerAuth too', async () => {
        // Every write path goes through writeSyncState, so the mode
        // policy must hold across the full surface — otherwise a later
        // sync-completion stamp could widen perms back to default.
        await recordPeer({
            userRoot,
            peerId: 'alice@phone',
            label: 'Phone',
            categories: ['characters'],
            peerAuth: { username: 'alice', password: 'secret' },
        });
        await recordSyncCompletion({ userRoot, peerId: 'alice@phone', headOid: 'c'.repeat(40) });
        expect(fs.statSync(statePath()).mode & 0o777).toBe(0o600);

        await clearPeerAuth({ userRoot, peerId: 'alice@phone' });
        expect(fs.statSync(statePath()).mode & 0o777).toBe(0o600);
    });
});
