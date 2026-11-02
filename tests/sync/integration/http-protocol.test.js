import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';

import { startLanDevice } from '../_lib/lan-devices.js';
import { readRegistry, upsertLanBackend } from '../../../src/sync/state.js';
import { ensureShadowRepo, getShadowPaths } from '../../../src/sync/shadow.js';
import { listObjectsChildrenFirst, readObjectForWire } from '../../../src/sync/objects.js';
import { incomingRefFor } from '../../../src/sync/backends/lan/incoming.js';
import { atomicFs } from '../../../src/sync/pipeline/atomic-fs.js';
import { PAUSEPOINTS } from '../../../src/sync/pipeline/failpoints.js';
import { _resetGateForTests } from '../../../src/sync/in-progress-gate.js';
import { syncService } from '../../../src/sync/sync-service.js';
import { createSyncSession } from '../../../src/sync/session.js';
import { commitFiles } from '../_lib/commits.js';
import { until } from '../_lib/until.js';

const SECRET = 'a'.repeat(64);
const PEER = 'u@0a1b2c3d';
const ZERO = '0'.repeat(40);

describe('incoming-ref protocol', () => {
    let A;
    let source;
    let token;
    const auth = extra => ({ Authorization: `Bearer ${token}`, ...extra });
    async function pushObjects(head) {
        for (const oid of await listObjectsChildrenFirst({ dir: source, gitdir: source, headOid: head, skip: new Set() })) {
            const obj = await readObjectForWire({ dir: source, gitdir: source, oid });
            const res = await A.request(`${A.baseUrl}/api/sync/v1/session/object`, { method: 'POST', headers: auth({ 'Content-Type': 'application/octet-stream', 'X-Object-Oid': oid, 'X-Object-Type': obj.type }), body: obj.body });
            expect(res.status).toBe(200);
            await res.arrayBuffer();
        }
    }
    const ref = (refName, expectedOid, newOid) => A.call('POST', '/session/ref', { body: { ref: refName, expectedOid, newOid }, headers: auth() });

    beforeEach(async () => {
        _resetGateForTests();
        A = await startLanDevice();
        await upsertLanBackend({ userRoot: A.userRoot, backendId: PEER, label: 'Phone', categories: ['worlds'], syncSecret: SECRET });
        token = (await A.offer({ peerId: PEER, label: 'Phone', protocol: 2 }, { secret: SECRET })).body.token;
        source = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-source-'));
        await git.init({ fs: atomicFs, dir: source, gitdir: source, bare: true, defaultBranch: 'main' });
    });
    afterEach(async () => {
        // Waits for runs a notify started in the background.
        await syncService.removeBackend(A.owner, PEER);
        await A.close();
        fs.rmSync(source, { recursive: true, force: true });
    });

    test('the manifest reports the incoming ref', async () => {
        expect((await A.call('GET', '/session/manifest', { headers: auth() })).body.incomingOid).toBeNull();
        const head = await commitFiles(source, { 'worlds/w.json': '{}' });
        await pushObjects(head);
        expect((await ref(incomingRefFor(PEER), ZERO, head)).status).toBe(200);
        expect((await A.call('GET', '/session/manifest', { headers: auth() })).body.incomingOid).toBe(head);
    });

    test('session ref only accepts the incoming ref of the session peer', async () => {
        const head = await commitFiles(source, { 'worlds/w.json': '{}' });
        await pushObjects(head);
        expect((await ref('refs/heads/main', ZERO, head)).status).toBe(400);
        expect((await ref(incomingRefFor('u@ffffffff'), ZERO, head)).status).toBe(400);
    });

    test('session ref refuses a target whose objects are incomplete', async () => {
        const head = await commitFiles(source, { 'worlds/w.json': '{}' });
        expect(await ref(incomingRefFor(PEER), ZERO, head)).toMatchObject({ status: 422, body: { code: 'INCOMPLETE_OBJECTS' } });
    });

    test('session ref refuses a target that is not a commit', async () => {
        const head = await commitFiles(source, { 'worlds/w.json': '{}' });
        await pushObjects(head);
        const { commit } = await git.readCommit({ fs: atomicFs, gitdir: source, oid: head });
        expect(await ref(incomingRefFor(PEER), ZERO, commit.tree)).toMatchObject({ status: 422, body: { code: 'NOT_A_COMMIT' } });
        const { gitDir } = getShadowPaths({ userRoot: A.userRoot, peerId: PEER });
        expect(await git.resolveRef({ fs: atomicFs, gitdir: gitDir, ref: incomingRefFor(PEER) }).catch(() => null)).toBeNull();
    });

    test('session ref compare-and-swaps the incoming ref and never touches main or live', async () => {
        const { gitDir } = await ensureShadowRepo({ userRoot: A.userRoot, peerId: PEER });
        const mainBefore = await git.resolveRef({ fs: atomicFs, gitdir: gitDir, ref: 'refs/heads/main' }).catch(() => null);
        const first = await commitFiles(source, { 'worlds/w.json': '1' });
        const second = await commitFiles(source, { 'worlds/w.json': '2' }, [first]);
        await pushObjects(second);
        expect((await ref(incomingRefFor(PEER), ZERO, first)).status).toBe(200);
        expect(await ref(incomingRefFor(PEER), ZERO, second)).toMatchObject({ status: 409, body: { currentOid: first } });
        expect((await ref(incomingRefFor(PEER), first, second)).status).toBe(200);
        expect(await git.resolveRef({ fs: atomicFs, gitdir: gitDir, ref: 'refs/heads/main' }).catch(() => null)).toBe(mainBefore);
        expect(A.read('worlds/w.json')).toBeNull();
    });

    test('removing a backend during an offer waits for its local step and stays removed', async () => {
        const pauseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-remove-pause-'));
        process.env.LUKER_SYNC_PAUSEPOINT = 'after-snapshot';
        process.env.LUKER_SYNC_PAUSE_DIR = pauseDir;
        try {
            A.write('worlds/w.json', '{}');
            fs.writeFileSync(path.join(pauseDir, 'after-snapshot.arm'), '');
            const offer = A.offer({ peerId: PEER, label: 'Phone', protocol: 2 }, { secret: SECRET });
            await until(() => fs.existsSync(path.join(pauseDir, 'after-snapshot.reached')));
            const { peerDir } = getShadowPaths({ userRoot: A.userRoot, peerId: PEER });
            const removal = syncService.removeBackend(A.owner, PEER);
            // Gives a removal that does not wait for the local step time to delete the directory.
            await new Promise(resolve => setTimeout(resolve, 200));
            expect(fs.existsSync(peerDir)).toBe(true);
            expect((await A.call('GET', '/session/manifest', { headers: auth() })).status).toBe(401);
            fs.writeFileSync(path.join(pauseDir, 'after-snapshot.release'), '');
            await removal;
            expect((await offer).status).not.toBe(200);
            expect(fs.existsSync(peerDir)).toBe(false);
            expect((await readRegistry({ userRoot: A.userRoot })).backends[PEER]).toBeUndefined();
        } finally {
            delete process.env.LUKER_SYNC_PAUSEPOINT;
            delete process.env.LUKER_SYNC_PAUSE_DIR;
            fs.rmSync(pauseDir, { recursive: true, force: true });
        }
    });

    test('a ref move that waited while its backend was removed recreates nothing', async () => {
        const head = await commitFiles(source, { 'worlds/w.json': '{}' });
        await pushObjects(head);
        const { peerDir } = getShadowPaths({ userRoot: A.userRoot, peerId: PEER });
        const pauseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-ref-pause-'));
        process.env.LUKER_SYNC_PAUSEPOINT = PAUSEPOINTS.SESSION_REF_BEFORE_LOCK;
        process.env.LUKER_SYNC_PAUSE_DIR = pauseDir;
        try {
            fs.writeFileSync(path.join(pauseDir, `${PAUSEPOINTS.SESSION_REF_BEFORE_LOCK}.arm`), '');
            const moved = ref(incomingRefFor(PEER), ZERO, head);
            await until(() => fs.existsSync(path.join(pauseDir, `${PAUSEPOINTS.SESSION_REF_BEFORE_LOCK}.reached`)));
            await syncService.removeBackend(A.owner, PEER);
            fs.writeFileSync(path.join(pauseDir, `${PAUSEPOINTS.SESSION_REF_BEFORE_LOCK}.release`), '');
            expect(await moved).toMatchObject({ status: 404, body: { code: 'PEER_FORGOTTEN' } });
            expect(fs.existsSync(peerDir)).toBe(false);
        } finally {
            delete process.env.LUKER_SYNC_PAUSEPOINT;
            delete process.env.LUKER_SYNC_PAUSE_DIR;
            fs.rmSync(pauseDir, { recursive: true, force: true });
        }
    });

    test('an object upload that streamed while its backend was removed recreates nothing', async () => {
        const body = Buffer.from('streamed blob');
        const oid = await git.writeBlob({ fs: atomicFs, gitdir: source, blob: body });
        const { peerDir, gitDir } = getShadowPaths({ userRoot: A.userRoot, peerId: PEER });
        const incomingDir = path.join(gitDir, 'objects', 'incoming');
        const upload = http.request(`${A.baseUrl}/api/sync/v1/session/object`, {
            method: 'POST',
            headers: auth({ 'Content-Type': 'application/octet-stream', 'X-Object-Oid': oid, 'X-Object-Type': 'blob', 'Content-Length': body.length }),
        });
        const answered = new Promise((resolve, reject) => {
            upload.on('response', res => {
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
            });
            upload.on('error', reject);
        });
        upload.write(body.subarray(0, 4));
        await until(() => fs.existsSync(incomingDir) && fs.readdirSync(incomingDir).length > 0);
        await syncService.removeBackend(A.owner, PEER);
        upload.end(body.subarray(4));
        expect(await answered).toMatchObject({ status: 404, body: { code: 'PEER_FORGOTTEN' } });
        expect(fs.existsSync(peerDir)).toBe(false);
    });

    test('every session route of a backend being removed answers PEER_FORGOTTEN', async () => {
        let release;
        const held = syncService.withShadowLock(A.userRoot, PEER, () => new Promise(resolve => { release = resolve; }));
        const removal = syncService.removeBackend(A.owner, PEER);
        try {
            // Removal closed the offer's session; a session issued while it
            // runs stands for a request that passed authentication first.
            token = createSyncSession({ handle: A.handle, peerId: PEER, userRoot: A.userRoot, directories: A.directories, owner: A.owner }).token;
            const forgotten = { status: 404, body: { code: 'PEER_FORGOTTEN' } };
            expect(await A.call('GET', '/session/manifest', { headers: auth() })).toMatchObject(forgotten);
            expect(await A.call('GET', `/session/object/${'a'.repeat(40)}`, { headers: auth() })).toMatchObject(forgotten);
            expect(await A.call('POST', '/session/object', { body: {}, headers: auth({ 'X-Object-Oid': 'a'.repeat(40), 'X-Object-Type': 'blob' }) })).toMatchObject(forgotten);
            expect(await ref(incomingRefFor(PEER), ZERO, 'a'.repeat(40))).toMatchObject(forgotten);
            expect(await A.call('POST', '/session/notify', { headers: auth() })).toMatchObject(forgotten);
        } finally {
            release();
            await held;
            await removal;
        }
    });

    test('notify runs the incoming step for the session backend', async () => {
        const head = await commitFiles(source, { 'worlds/notified.json': '{"n":1}' });
        await pushObjects(head);
        await ref(incomingRefFor(PEER), ZERO, head);
        expect((await A.call('POST', '/session/notify', { headers: auth() })).status).toBe(202);
        await until(() => A.read('worlds/notified.json') === '{"n":1}');
    });
});
