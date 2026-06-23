import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSyncState, recordPeer, recordSyncCompletion, removePeer, removePeerCompletely } from '../../src/sync/state.js';
import { ensureShadowRepo, getShadowPaths } from '../../src/sync/shadow.js';

describe('sync state file', () => {
    let userRoot;
    beforeEach(() => { userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-sync-state-')); });
    afterEach(() => fs.rmSync(userRoot, { recursive: true, force: true }));

    test('readSyncState returns empty when no file exists', () => {
        expect(readSyncState({ userRoot })).toEqual({ peers: {} });
    });

    test('recordPeer adds a new peer entry, then readSyncState reflects it', async () => {
        await recordPeer({ userRoot, peerId: 'alice@phone', label: 'Phone', categories: ['characters'] });
        const state = readSyncState({ userRoot });
        expect(state.peers['alice@phone']).toEqual(expect.objectContaining({
            label: 'Phone',
            categories: ['characters'],
            pairedAt: expect.any(Number),
        }));
    });

    test('recordSyncCompletion stamps lastSyncAt without losing other fields', async () => {
        await recordPeer({ userRoot, peerId: 'p', label: 'P', categories: ['chats'] });
        await recordSyncCompletion({ userRoot, peerId: 'p', headOid: 'a'.repeat(40) });
        const state = readSyncState({ userRoot });
        expect(state.peers['p']).toEqual(expect.objectContaining({
            label: 'P',
            categories: ['chats'],
            lastSyncAt: expect.any(Number),
            lastSyncedOid: 'a'.repeat(40),
        }));
    });

    test('removePeer removes the peer from state', async () => {
        await recordPeer({ userRoot, peerId: 'p', label: 'P', categories: [] });
        await removePeer({ userRoot, peerId: 'p' });
        expect(readSyncState({ userRoot }).peers).toEqual({});
    });

    test('recordPeer rejects unsafe peerId values', async () => {
        await expect(recordPeer({ userRoot, peerId: '', label: 'x', categories: [] })).rejects.toThrow();
        await expect(recordPeer({ userRoot, peerId: '..', label: 'x', categories: [] })).rejects.toThrow();
        await expect(recordPeer({ userRoot, peerId: '.', label: 'x', categories: [] })).rejects.toThrow();
        await expect(recordPeer({ userRoot, peerId: 'a/b', label: 'x', categories: [] })).rejects.toThrow();
    });

    test('readSyncState warns and returns empty when state file is malformed', () => {
        const dir = path.join(userRoot, '.sync');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'state.json'), '{ bad json');

        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const state = readSyncState({ userRoot });
            expect(state).toEqual({ peers: {} });
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('failed to read'));
        } finally {
            warnSpy.mockRestore();
        }
    });

    test('readSyncState rejects array shape for peers', () => {
        const dir = path.join(userRoot, '.sync');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'state.json'), '{"peers": []}');

        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const state = readSyncState({ userRoot });
            expect(state).toEqual({ peers: {} });
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unexpected shape'));
        } finally {
            warnSpy.mockRestore();
        }
    });

    test('removePeerCompletely removes both the registry entry AND the on-disk shadow dir', async () => {
        const peerId = 'alice@phone';
        await recordPeer({ userRoot, peerId, label: 'Phone', categories: ['characters'] });
        await ensureShadowRepo({ userRoot, peerId });
        const { peerDir } = getShadowPaths({ userRoot, peerId });

        // Sanity: shadow exists, registry has the peer.
        expect(fs.existsSync(peerDir)).toBe(true);
        expect(readSyncState({ userRoot }).peers[peerId]).toBeTruthy();

        await removePeerCompletely({ userRoot, peerId });

        // Both gone: this is the regression we care about. The legacy
        // removePeer leaves peerDir behind, which is precisely what the
        // "Forget peer" UI button must NOT do.
        expect(fs.existsSync(peerDir)).toBe(false);
        expect(readSyncState({ userRoot }).peers[peerId]).toBeUndefined();
    });

    test('removePeerCompletely is idempotent on absent peers', async () => {
        // Never recorded, shadow never created — should still resolve cleanly.
        await expect(removePeerCompletely({ userRoot, peerId: 'never-existed' })).resolves.toBeUndefined();
        expect(readSyncState({ userRoot }).peers).toEqual({});
    });

    test('removePeerCompletely cleans up a partial state (entry present, shadow already gone)', async () => {
        const peerId = 'alice@phone';
        await recordPeer({ userRoot, peerId, label: 'Phone', categories: ['characters'] });
        // Simulate the shadow having been deleted out-of-band.
        await removePeerCompletely({ userRoot, peerId });
        // Calling again must not throw.
        await expect(removePeerCompletely({ userRoot, peerId })).resolves.toBeUndefined();
    });

    test('removePeerCompletely rejects unsafe peerId values', async () => {
        await expect(removePeerCompletely({ userRoot, peerId: '..' })).rejects.toThrow();
        await expect(removePeerCompletely({ userRoot, peerId: 'a/b' })).rejects.toThrow();
    });
});
