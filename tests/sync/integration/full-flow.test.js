import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import http from 'node:http';
import git from 'isomorphic-git';

import { startLanDevice, pair } from '../_lib/lan-devices.js';
import { until } from '../_lib/until.js';
import { readRegistry, updateRegistry } from '../../../src/sync/state.js';
import { blobOidOf, readCommitFiles } from '../../../src/sync/pipeline/git-tree.js';
import { CONFLICTS_PATH, readEntries } from '../../../src/sync/pipeline/conflict-records.js';
import { ensureShadowRepo } from '../../../src/sync/shadow.js';
import { atomicFs } from '../../../src/sync/pipeline/atomic-fs.js';
import { _resetGateForTests } from '../../../src/sync/in-progress-gate.js';

const HEADER = JSON.stringify({ user_name: 'U', character_name: 'Seraphina', chat_metadata: {} });
const CHAT = 'chats/Seraphina/c1.jsonl';

describe('two LAN devices on the shared pipeline', () => {
    let A;
    let B;
    beforeEach(async () => {
        _resetGateForTests();
        A = await startLanDevice();
        B = await startLanDevice();
    });
    afterEach(async () => {
        await A.close();
        await B.close();
    });

    test('pairing gives the accepting device the other device\'s data', async () => {
        A.write('worlds/glade.json', '{"name":"Glade"}');
        const id = await pair(A, B);
        expect(B.read('worlds/glade.json')).toBe('{"name":"Glade"}');
        expect((await readRegistry({ userRoot: A.userRoot })).backends[id].lan.peerBaseUrl).toBe(B.baseUrl);
        expect((await readRegistry({ userRoot: B.userRoot })).backends[id].lan).toMatchObject({ peerBaseUrl: A.baseUrl, syncSecret: expect.stringMatching(/^[a-f0-9]{64}$/) });
    });

    test('an edit on A reaches B through push and notify without a call on B', async () => {
        const id = await pair(A, B);
        A.write('worlds/ember.json', '{"lit":true}');
        expect((await A.call('POST', `/backends/${id}/sync`)).body).toMatchObject({ ok: true });
        await until(() => B.read('worlds/ember.json') === '{"lit":true}');
    });

    test('manual syncs started on both devices at once both finish', async () => {
        const id = await pair(A, B);
        A.write('worlds/a.json', 'A');
        B.write('worlds/b.json', 'B');
        const [ra, rb] = await Promise.all([A.call('POST', `/backends/${id}/sync`), B.call('POST', `/backends/${id}/sync`)]);
        expect(ra.body.ok && rb.body.ok).toBe(true);
        await A.call('POST', `/backends/${id}/sync`);
        await B.call('POST', `/backends/${id}/sync`);
        // A merges what B pushed in the run B's notify started.
        await until(() => A.idle() && B.idle());
        const mainOf = async device => git.resolveRef({ fs: atomicFs, gitdir: (await ensureShadowRepo({ userRoot: device.userRoot, peerId: id })).gitDir, ref: 'refs/heads/main' });
        expect(await mainOf(A)).toBe(await mainOf(B));
        expect([A.read('worlds/b.json'), B.read('worlds/a.json')]).toEqual(['B', 'A']);
    });

    test('conflicting syncs started on both devices at once end with one fork and records naming each device', async () => {
        for (const [device, label] of [[A, 'Desk'], [B, 'Phone']]) {
            await updateRegistry({ userRoot: device.userRoot }, registry => { registry.device.label = label; });
        }
        A.write('worlds/w.json', 'base');
        A.write(CHAT, `${HEADER}\nbase`);
        const id = await pair(A, B);
        await until(() => A.idle() && B.idle());
        expect((await readRegistry({ userRoot: A.userRoot })).backends[id].lan.peerDeviceLabel).toBe('Phone');
        expect((await readRegistry({ userRoot: B.userRoot })).backends[id].lan.peerDeviceLabel).toBe('Desk');
        const content = { Desk: [A, 'from Desk'], Phone: [B, 'from Phone'] };
        for (const [device, text] of Object.values(content)) {
            device.write('worlds/w.json', text);
            device.write(CHAT, `${HEADER}\n${text}`);
        }
        await Promise.all([A.call('POST', `/backends/${id}/sync`), B.call('POST', `/backends/${id}/sync`)]);
        await until(() => A.idle() && B.idle());
        const mainOf = async device => git.resolveRef({ fs: atomicFs, gitdir: (await ensureShadowRepo({ userRoot: device.userRoot, peerId: id })).gitDir, ref: 'refs/heads/main' });
        expect(await mainOf(A)).toBe(await mainOf(B));
        const { gitDir } = await ensureShadowRepo({ userRoot: A.userRoot, peerId: id });
        const files = await readCommitFiles({ gitdir: gitDir, commitOid: await mainOf(A) });
        expect([...files.keys()].filter(key => key.startsWith('chats/Seraphina/') && key.endsWith('.jsonl') && key !== CHAT)).toHaveLength(1);
        const { 'worlds/w.json': record } = await readEntries({ gitdir: gitDir, files, path: CONFLICTS_PATH, kind: 'conflicts' });
        expect(record.kept).toBe(files.get('worlds/w.json').oid);
        expect(record.ours).toBe(blobOidOf(Buffer.from(content[record.oursDevice][1])));
        expect(record.theirs).toBe(blobOidOf(Buffer.from(content[record.theirsDevice][1])));
    });

    test('a peer with protocol 1 is rejected at pair time', async () => {
        const stub = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}'); });
        await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
        try {
            const res = await B.call('POST', '/pair/accept', { body: { peerBaseUrl: `http://127.0.0.1:${stub.address().port}`, remotePeerId: 'u@0a1b2c3d', label: 'Old', categories: ['worlds'], pairCode: 'c'.repeat(64) } });
            expect(res).toMatchObject({ status: 426, body: { code: 'PEER_PROTOCOL_OUTDATED' } });
            expect((await readRegistry({ userRoot: B.userRoot })).backends['u@0a1b2c3d']).toBeUndefined();
        } finally {
            await new Promise(resolve => stub.close(resolve));
        }
    });

    test('a pairing link with an id that is not a ref component is refused', async () => {
        expect(await B.call('POST', '/pair/accept', { body: { peerBaseUrl: A.baseUrl, remotePeerId: 'u@..', label: 'x', categories: ['worlds'], pairCode: 'c'.repeat(64) } })).toMatchObject({ status: 400 });
    });

    test('pair start returns the link contents and records the backend', async () => {
        const start = await A.call('POST', '/pair/start', { body: { label: 'Desktop', categories: ['characters', 'chats'] } });
        expect(start).toMatchObject({ status: 200, body: { label: 'Desktop', categories: ['characters', 'chats'], peerBaseUrl: A.baseUrl, pairCode: expect.stringMatching(/^[a-f0-9]{64}$/) } });
        expect(start.body.peerId).toMatch(/^u@[a-f0-9]{8}$/);
        expect((await A.call('GET', '/backends')).body.backends[start.body.peerId]).toMatchObject({ kind: 'lan', label: 'Desktop', categories: ['characters', 'chats'] });
        expect((await A.call('POST', '/pair/start', { body: { label: 'X', categories: [] } })).status).toBe(400);
    });

    test('pair accept answers with the first sync and the new backend', async () => {
        const start = await A.call('POST', '/pair/start', { body: { label: 'B device', categories: ['worlds'] } });
        const accept = await B.call('POST', '/pair/accept', { body: {
            peerBaseUrl: A.baseUrl, remotePeerId: start.body.peerId, label: 'A device', categories: ['worlds'], pairCode: start.body.pairCode,
            peerAuth: { username: 'u', password: 'pw' },
        } });
        expect(accept).toMatchObject({ status: 200, body: { ok: true, backendId: start.body.peerId, label: 'A device', conflicts: 0, lastSync: { error: null } } });
        const listed = await B.call('GET', '/backends');
        expect(listed.body.backends[start.body.peerId]).toMatchObject({ label: 'A device', lan: { hasStoredCredentials: true } });
        expect(JSON.stringify(listed.body)).not.toContain('pw');
    });

    test('pair accept refuses an incomplete body', async () => {
        for (const body of [{ label: 'A', categories: ['worlds'] }, { peerBaseUrl: A.baseUrl, remotePeerId: 'u@0a1b2c3d', categories: [] }]) {
            expect((await B.call('POST', '/pair/accept', { body })).status).toBe(400);
        }
    });

    test('an unreachable peer gives 502 and records nothing', async () => {
        const closed = http.createServer();
        await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
        const { port } = closed.address();
        await new Promise(resolve => closed.close(resolve));
        const res = await B.call('POST', '/pair/accept', { body: { peerBaseUrl: `http://127.0.0.1:${port}`, remotePeerId: 'u@0a1b2c3d', label: 'A', categories: ['worlds'], pairCode: 'c'.repeat(64) } });
        expect(res).toMatchObject({ status: 502, body: { stage: 'offer', code: 'PEER_UNREACHABLE', detail: 'ECONNREFUSED' } });
        expect((await readRegistry({ userRoot: B.userRoot })).backends).toEqual({});
    });

    test('a local failure before the offer gives 500 and contacts nobody', async () => {
        const start = await A.call('POST', '/pair/start', { body: { label: 'B device', categories: ['worlds'] } });
        const before = A.requests.length;
        B.userStore.selfCallback = () => { throw new Error('no listening address'); };
        const res = await B.call('POST', '/pair/accept', { body: { peerBaseUrl: A.baseUrl, remotePeerId: start.body.peerId, label: 'A device', categories: ['worlds'], pairCode: start.body.pairCode } });
        expect(res).toMatchObject({ status: 500, body: { code: 'SYNC_FAILED' } });
        expect(A.requests.slice(before)).toEqual([]);
    });

    test('a pairing code works once', async () => {
        const start = await A.call('POST', '/pair/start', { body: { label: 'B device', categories: ['worlds'] } });
        const body = { peerBaseUrl: A.baseUrl, remotePeerId: start.body.peerId, label: 'A device', categories: ['worlds'], pairCode: start.body.pairCode };
        expect((await B.call('POST', '/pair/accept', { body })).status).toBe(200);
        const C = await startLanDevice();
        try {
            expect(await C.call('POST', '/pair/accept', { body })).toMatchObject({ status: 401, body: { stage: 'offer', code: 'PEER_AUTH_FAILED' } });
            expect((await readRegistry({ userRoot: C.userRoot })).backends).toEqual({});
        } finally {
            await C.close();
        }
    });
});
