import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertRemoteBackend, assertRemoteHead, assertCasResult, REMOTE_BACKEND_KINDS } from '../../src/sync/backends/contract.js';
import { ensureShadowRepo } from '../../src/sync/shadow.js';
import { childOidsOfWireObject, hasObjectLocally, readObjectForWire } from '../../src/sync/objects.js';
import { FAILPOINTS, failpointMarker } from '../../src/sync/pipeline/failpoints.js';
import { DirectoryBackend, initDirectoryRemote } from './_lib/directory-backend.js';
import { commitFiles } from './_lib/commits.js';

const PUSH_CHILD = fileURLToPath(new URL('./_lib/directory-push-child.mjs', import.meta.url));

function looseObjectOids(gitdir) {
    const objectsDir = path.join(gitdir, 'objects');
    return fs.readdirSync(objectsDir)
        .filter(name => /^[a-f0-9]{2}$/.test(name))
        .flatMap(prefix => fs.readdirSync(path.join(objectsDir, prefix)).map(rest => prefix + rest));
}

const valid = () => ({
    id: 'b1',
    kind: 'lan',
    readHead: async () => null,
    fetchInto: async () => {},
    pushObjects: async () => {},
    casHead: async () => ({ ok: true }),
});

describe('RemoteBackend contract', () => {
    test('lists production kinds', () => {
        expect(REMOTE_BACKEND_KINDS).toEqual(['lan', 's3']);
    });

    test('accepts a complete backend with or without notifyPeer', () => {
        expect(assertRemoteBackend(valid())).toBeTruthy();
        expect(assertRemoteBackend({ ...valid(), notifyPeer: async () => {} })).toBeTruthy();
    });

    test('reports every missing piece at once', () => {
        const broken = { ...valid(), id: '', casHead: undefined, notifyPeer: 'yes' };
        expect(() => assertRemoteBackend(broken)).toThrow(/id must be a non-empty string.*casHead must be a function.*notifyPeer must be a function/);
        expect(() => assertRemoteBackend(null)).toThrow(TypeError);
    });

    test('validates head and CAS results', () => {
        expect(assertRemoteHead(null)).toBeNull();
        expect(assertRemoteHead({ oid: 'a'.repeat(40), etag: 'e' })).toEqual({ oid: 'a'.repeat(40), etag: 'e' });
        expect(() => assertRemoteHead({ oid: 'short', etag: 'e' })).toThrow(TypeError);
        expect(() => assertRemoteHead({ oid: 'a'.repeat(40), etag: '' })).toThrow(TypeError);
        expect(assertCasResult({ ok: true })).toEqual({ ok: true });
        expect(assertCasResult({ ok: false, reason: 'conflict' })).toEqual({ ok: false, reason: 'conflict' });
        expect(() => assertCasResult({ ok: false, reason: 'other' })).toThrow(TypeError);
        expect(() => assertCasResult(undefined)).toThrow(TypeError);
    });
});

describe('DirectoryBackend', () => {
    let tmp;
    let remoteDir;
    let userRoot;
    beforeEach(async () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-dirbackend-'));
        remoteDir = path.join(tmp, 'remote.git');
        userRoot = path.join(tmp, 'user');
        fs.mkdirSync(userRoot);
        await initDirectoryRemote(remoteDir);
    });
    afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

    test('satisfies the contract and publishes with compare-and-swap', async () => {
        const backend = assertRemoteBackend(new DirectoryBackend({ id: 'remote', remoteDir, userRoot }));
        expect(assertRemoteHead(await backend.readHead())).toBeNull();
        const { gitDir } = await ensureShadowRepo({ userRoot, peerId: 'remote' });
        const c1 = await commitFiles(gitDir, { 'characters/a.png': 'A' });
        await backend.pushObjects(c1, null);
        expect(assertCasResult(await backend.casHead(null, c1))).toEqual({ ok: true });
        expect(assertRemoteHead(await backend.readHead())).toEqual({ oid: c1, etag: c1 });
        const c2 = await commitFiles(gitDir, { 'characters/a.png': 'B' }, [c1]);
        await backend.pushObjects(c2, c1);
        expect(assertCasResult(await backend.casHead(null, c2))).toEqual({ ok: false, reason: 'conflict' });
        expect(assertRemoteHead(await backend.readHead()).oid).toBe(c1);
        expect(assertCasResult(await backend.casHead(c1, c2))).toEqual({ ok: true });
    });

    test('casHead refuses a head whose objects were never pushed', async () => {
        const backend = new DirectoryBackend({ id: 'remote', remoteDir, userRoot });
        const { gitDir } = await ensureShadowRepo({ userRoot, peerId: 'remote' });
        const c1 = await commitFiles(gitDir, { 'characters/a.png': 'A' });
        await expect(backend.casHead(null, c1)).rejects.toThrow(c1);
        expect(assertRemoteHead(await backend.readHead())).toBeNull();
    });

    test('a rival publish between readHead and casHead is a conflict', async () => {
        const rivalRoot = path.join(tmp, 'rival');
        fs.mkdirSync(rivalRoot);
        const rival = new DirectoryBackend({ id: 'remote', remoteDir, userRoot: rivalRoot });
        const rivalShadow = await ensureShadowRepo({ userRoot: rivalRoot, peerId: 'remote' });
        const rivalHead = await commitFiles(rivalShadow.gitDir, { 'characters/a.png': 'rival' });

        const hooks = {
            beforeCasHead: async () => {
                await rival.pushObjects(rivalHead, null);
                expect(assertCasResult(await rival.casHead(null, rivalHead))).toEqual({ ok: true });
            },
        };
        const backend = new DirectoryBackend({ id: 'remote', remoteDir, userRoot, hooks });
        const { gitDir } = await ensureShadowRepo({ userRoot, peerId: 'remote' });
        const c1 = await commitFiles(gitDir, { 'characters/a.png': 'A' });
        const head = assertRemoteHead(await backend.readHead());
        await backend.pushObjects(c1, null);
        expect(assertCasResult(await backend.casHead(head?.etag ?? null, c1))).toEqual({ ok: false, reason: 'conflict' });
        expect(assertRemoteHead(await backend.readHead()).oid).toBe(rivalHead);
        expect(typeof hooks.beforeCasHead).toBe('function');
    });

    test('a push killed after its first object leaves only complete sub-graphs in the remote', async () => {
        const { gitDir } = await ensureShadowRepo({ userRoot, peerId: 'remote' });
        const c1 = await commitFiles(gitDir, { 'characters/a.png': 'A', 'characters/b.png': 'B', 'worlds/w.json': '{}' });

        const result = spawnSync(process.execPath, [PUSH_CHILD, remoteDir, userRoot, c1], {
            env: { ...process.env, LUKER_SYNC_FAILPOINT: FAILPOINTS.FETCH_AFTER_FIRST_OBJECT },
            encoding: 'utf8',
        });
        expect(result.stderr).toBe(failpointMarker(FAILPOINTS.FETCH_AFTER_FIRST_OBJECT));
        expect(result.signal).toBe('SIGKILL');
        expect(result.stdout).toBe('');

        const present = looseObjectOids(remoteDir);
        expect(present).toHaveLength(1);
        expect(present).not.toContain(c1);
        for (const oid of present) {
            const object = await readObjectForWire({ dir: remoteDir, gitdir: remoteDir, oid });
            for (const child of childOidsOfWireObject(object.type, object.body)) {
                expect(await hasObjectLocally({ dir: remoteDir, gitdir: remoteDir, oid: child })).toBe(true);
            }
        }

        const backend = new DirectoryBackend({ id: 'remote', remoteDir, userRoot });
        await backend.pushObjects(c1, null);
        expect(assertCasResult(await backend.casHead(null, c1))).toEqual({ ok: true });
    });

    test('fetchInto copies remote objects into another device shadow', async () => {
        const publisher = new DirectoryBackend({ id: 'remote', remoteDir, userRoot });
        const { gitDir } = await ensureShadowRepo({ userRoot, peerId: 'remote' });
        const c1 = await commitFiles(gitDir, { 'characters/a.png': 'A' });
        await publisher.pushObjects(c1, null);
        await publisher.casHead(null, c1);

        const otherRoot = path.join(tmp, 'other');
        fs.mkdirSync(otherRoot);
        const other = new DirectoryBackend({ id: 'remote', remoteDir, userRoot: otherRoot });
        const otherShadow = await ensureShadowRepo({ userRoot: otherRoot, peerId: 'remote' });
        expect(await hasObjectLocally({ dir: otherShadow.workdir, gitdir: otherShadow.gitDir, oid: c1 })).toBe(false);
        await other.fetchInto([c1], []);
        expect(await hasObjectLocally({ dir: otherShadow.workdir, gitdir: otherShadow.gitDir, oid: c1 })).toBe(true);
    });
});
