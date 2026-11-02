import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';

import { startLanDevice } from '../_lib/lan-devices.js';
import { readRegistry, removeBackendCompletely, updateRegistry, upsertLanBackend } from '../../../src/sync/state.js';
import { createPairingCode } from '../../../src/sync/session.js';
import { ensureShadowRepo, getShadowPaths } from '../../../src/sync/shadow.js';
import { readCommitFiles } from '../../../src/sync/pipeline/git-tree.js';
import { atomicFs } from '../../../src/sync/pipeline/atomic-fs.js';
import { incomingRefFor } from '../../../src/sync/backends/lan/incoming.js';
import { THROWPOINTS } from '../../../src/sync/pipeline/failpoints.js';
import { registerSyncHooks } from '../../../src/sync/pipeline/sync-hooks.js';
import { _resetGateForTests } from '../../../src/sync/in-progress-gate.js';
import { syncService } from '../../../src/sync/sync-service.js';
import { commitFiles } from '../_lib/commits.js';

const SECRET = 'a'.repeat(64);
const PEER = 'u@0a1b2c3d';
let callback;
const body = extra => ({ peerId: PEER, label: 'Phone', protocol: 2, callback, ...extra });

describe('authenticated /session/offer', () => {
    let A;
    let B;
    beforeEach(async () => {
        _resetGateForTests();
        A = await startLanDevice();
        B = await startLanDevice();
        callback = B.userStore.selfCallback();
        await upsertLanBackend({ userRoot: A.userRoot, backendId: PEER, label: 'Phone', categories: ['worlds'], syncSecret: SECRET });
    });
    afterEach(async () => { await A.close(); await B.close(); });

    test.each([null, { scheme: 'http', port: 1, baseUrls: [] }])('failed pairing callback %j leaves the code and registry unchanged', async callback => {
        const code = createPairingCode({ handle: 'u', peerId: PEER });
        const before = await readRegistry({ userRoot: A.userRoot });
        const failed = await A.offer(body({ callback }), { pairCode: code });
        expect(failed).toMatchObject({ status: 502, body: { code: 'PEER_CALLBACK_UNREACHABLE' } });
        expect(failed.body.token).toBeUndefined();
        expect(failed.body.syncSecret).toBeUndefined();
        expect(await readRegistry({ userRoot: A.userRoot })).toEqual(before);
        const retry = await A.offer(body({ callback: B.userStore.selfCallback() }), { pairCode: code });
        expect(retry.status).toBe(200);
        expect(retry.body.syncSecret).toMatch(/^[a-f0-9]{64}$/);
        expect(B.requests).toEqual(['GET /api/sync/v1/health']);
    });

    test('an offer without credentials gets 401 and changes nothing', async () => {
        const before = await readRegistry({ userRoot: A.userRoot });
        expect(await A.offer(body())).toMatchObject({ status: 401, body: { code: 'PEER_AUTH_REQUIRED' } });
        expect(await readRegistry({ userRoot: A.userRoot })).toEqual(before);
    });

    test('an offer without protocol 2 gets 426', async () => {
        expect(await A.offer(body({ protocol: undefined }), { secret: SECRET })).toMatchObject({ status: 426, body: { code: 'PEER_PROTOCOL_OUTDATED' } });
        expect(await A.offer(body({ protocol: 1 }), { secret: SECRET })).toMatchObject({ status: 426 });
    });

    test('a wrong secret gets 401 PEER_AUTH_FAILED and changes nothing', async () => {
        const before = await readRegistry({ userRoot: A.userRoot });
        expect(await A.offer(body(), { secret: 'b'.repeat(64) })).toMatchObject({ status: 401, body: { code: 'PEER_AUTH_FAILED' } });
        expect(await readRegistry({ userRoot: A.userRoot })).toEqual(before);
    });

    test('an offer for a peer this user does not have gets 404 PEER_FORGOTTEN', async () => {
        expect(await A.offer(body({ peerId: 'u@ffffffff' }), { secret: SECRET })).toMatchObject({ status: 404, body: { code: 'PEER_FORGOTTEN' } });
    });

    test('an unknown peer gets 404 PEER_FORGOTTEN before any secret check', async () => {
        expect(await A.offer(body({ peerId: 'u@ffffffff' }), { secret: 'b'.repeat(64) })).toMatchObject({ status: 404, body: { code: 'PEER_FORGOTTEN' } });
    });

    test('a pair code for an unknown peer gets 404 PEER_FORGOTTEN and stays usable', async () => {
        const OTHER = 'u@ffffffff';
        const code = createPairingCode({ handle: 'u', peerId: OTHER });
        expect(await A.offer(body({ peerId: OTHER }), { pairCode: code })).toMatchObject({ status: 404, body: { code: 'PEER_FORGOTTEN' } });
        await upsertLanBackend({ userRoot: A.userRoot, backendId: OTHER, label: 'Tablet', categories: [] });
        const paired = await A.offer(body({ peerId: OTHER }), { pairCode: code });
        expect(paired.status).toBe(200);
        expect(paired.body.syncSecret).toMatch(/^[a-f0-9]{64}$/);
    });

    test('an offer for another handle gets 412 HANDLE_MISMATCH', async () => {
        expect(await A.offer(body({ peerId: 'bob@0a1b2c3d' }), { secret: SECRET })).toMatchObject({ status: 412, body: { code: 'HANDLE_MISMATCH', gotHandle: 'bob', expectedHandle: 'u' } });
    });

    test('a pair code is traded once for a durable secret', async () => {
        const code = createPairingCode({ handle: 'u', peerId: PEER });
        const first = await A.offer(body(), { pairCode: code });
        expect(first.status).toBe(200);
        expect(first.body.syncSecret).toMatch(/^[a-f0-9]{64}$/);
        expect((await readRegistry({ userRoot: A.userRoot })).backends[PEER].lan.syncSecret).toBe(first.body.syncSecret);
        expect((await A.offer(body(), { pairCode: code })).status).toBe(401);
        expect((await A.offer(body(), { secret: first.body.syncSecret })).status).toBe(200);
    });

    test('an offer snapshots live data into main before returning the token', async () => {
        A.write('worlds/w.json', '{"a":1}');
        const res = await A.offer(body(), { secret: SECRET });
        expect(res.body).toMatchObject({ peerId: PEER, protocol: 2, deviceLabel: expect.any(String) });
        const manifest = await A.call('GET', '/session/manifest', { headers: { Authorization: `Bearer ${res.body.token}` } });
        const { gitDir } = await ensureShadowRepo({ userRoot: A.userRoot, peerId: PEER });
        expect((await readCommitFiles({ gitdir: gitDir, commitOid: manifest.body.headOid })).has('worlds/w.json')).toBe(true);
    });

    test('an offer cannot move peerBaseUrl to a host other than its own address', async () => {
        await A.offer(body(), { secret: SECRET });
        expect((await readRegistry({ userRoot: A.userRoot })).backends[PEER].lan.peerBaseUrl).toBe(B.baseUrl);
    });

    test('an offer merges a pending incoming push into live before returning', async () => {
        const { gitDir } = await ensureShadowRepo({ userRoot: A.userRoot, peerId: PEER });
        const pushed = await commitFiles(gitDir, { 'worlds/pushed.json': '{"from":"B"}' });
        await git.writeRef({ fs: atomicFs, gitdir: gitDir, ref: incomingRefFor(PEER), value: pushed, force: true });
        expect((await A.offer(body(), { secret: SECRET })).status).toBe(200);
        expect(A.read('worlds/pushed.json')).toBe('{"from":"B"}');
    });

    test('a pair-code offer whose local step fails leaves the code usable', async () => {
        const { gitDir } = await ensureShadowRepo({ userRoot: A.userRoot, peerId: PEER });
        const pushed = await commitFiles(gitDir, { 'worlds/pushed.json': '{"from":"B"}' });
        await git.writeRef({ fs: atomicFs, gitdir: gitDir, ref: incomingRefFor(PEER), value: pushed, force: true });
        const code = createPairingCode({ handle: 'u', peerId: PEER });
        process.env.LUKER_SYNC_THROWPOINT = THROWPOINTS.RECONCILE_WRITE;
        process.env.LUKER_SYNC_THROWPOINT_MATCH = 'worlds/pushed.json';
        let failed;
        try {
            failed = await A.offer(body(), { pairCode: code });
        } finally {
            delete process.env.LUKER_SYNC_THROWPOINT;
            delete process.env.LUKER_SYNC_THROWPOINT_MATCH;
        }
        expect(failed).toMatchObject({ status: 500, body: { code: 'THROWPOINT' } });
        expect(failed.body.syncSecret).toBeUndefined();
        expect((await readRegistry({ userRoot: A.userRoot })).backends[PEER].lan.syncSecret).toBe(SECRET);

        const retry = await A.offer(body(), { pairCode: code });
        expect(retry.status).toBe(200);
        expect(retry.body.syncSecret).toMatch(/^[a-f0-9]{64}$/);
        expect((await readRegistry({ userRoot: A.userRoot })).backends[PEER].lan.syncSecret).toBe(retry.body.syncSecret);
        expect(A.read('worlds/pushed.json')).toBe('{"from":"B"}');
        expect((await A.offer(body(), { pairCode: code })).status).toBe(401);
    });

    test('an offer whose backend is removed after its local step gets 404 PEER_FORGOTTEN', async () => {
        const { gitDir } = await ensureShadowRepo({ userRoot: A.userRoot, peerId: PEER });
        const pushed = await commitFiles(gitDir, { 'worlds/pushed.json': '{"from":"B"}' });
        await git.writeRef({ fs: atomicFs, gitdir: gitDir, ref: incomingRefFor(PEER), value: pushed, force: true });
        // The registry serializes reads behind writes, so this deletion,
        // queued while the local step runs, lands before any registry read
        // the offer makes afterwards.
        let removed = null;
        const unregister = registerSyncHooks({
            afterReconcile: owner => {
                if (owner.userRoot !== A.userRoot || removed) return;
                removed = updateRegistry({ userRoot: A.userRoot }, registry => { delete registry.backends[PEER]; });
            },
        });
        try {
            expect(await A.offer(body(), { secret: SECRET })).toMatchObject({ status: 404, body: { code: 'PEER_FORGOTTEN' } });
        } finally {
            unregister();
            await removed;
        }
        expect(removed).not.toBeNull();
    });

    test('an offer racing the removal of its backend gets 404 PEER_FORGOTTEN', async () => {
        let release;
        const held = syncService.withShadowLock(A.userRoot, PEER, () => new Promise(resolve => { release = resolve; }));
        const removal = syncService.removeBackend(A.owner, PEER);
        try {
            expect(await A.offer(body(), { secret: SECRET })).toMatchObject({ status: 404, body: { code: 'PEER_FORGOTTEN' } });
        } finally {
            release();
            await held;
            await removal;
        }
        expect((await readRegistry({ userRoot: A.userRoot })).backends[PEER]).toBeUndefined();
    });

    test('a session of a removed backend gets 404 PEER_FORGOTTEN and recreates no shadow', async () => {
        const res = await A.offer(body(), { secret: SECRET });
        const auth = { headers: { Authorization: `Bearer ${res.body.token}` } };
        const { peerDir } = getShadowPaths({ userRoot: A.userRoot, peerId: PEER });
        await removeBackendCompletely({ userRoot: A.userRoot, backendId: PEER });
        const forgotten = { status: 404, body: { code: 'PEER_FORGOTTEN' } };
        expect(await A.call('GET', '/session/manifest', auth)).toMatchObject(forgotten);
        expect(await A.call('GET', `/session/object/${'a'.repeat(40)}`, auth)).toMatchObject(forgotten);
        expect(await A.call('POST', '/session/ref', { ...auth, body: { ref: 'refs/heads/main', expectedOid: '', newOid: 'a'.repeat(40) } })).toMatchObject(forgotten);
        expect(fs.existsSync(peerDir)).toBe(false);
    });

    test('a session whose backend left the registry gets 404 PEER_FORGOTTEN', async () => {
        const res = await A.offer(body(), { secret: SECRET });
        await updateRegistry({ userRoot: A.userRoot }, registry => { delete registry.backends[PEER]; });
        expect(await A.call('GET', '/session/manifest', { headers: { Authorization: `Bearer ${res.body.token}` } }))
            .toMatchObject({ status: 404, body: { code: 'PEER_FORGOTTEN' } });
    });

    test('removing the backend closes the sessions its offers issued', async () => {
        const res = await A.offer(body(), { secret: SECRET });
        const auth = { headers: { Authorization: `Bearer ${res.body.token}` } };
        expect((await A.call('GET', '/session/manifest', auth)).status).toBe(200);
        await syncService.removeBackend({ ...A.owner, userRoot: A.userRoot + path.sep }, PEER);
        expect((await A.call('GET', '/session/manifest', auth)).status).toBe(401);
    });
});
