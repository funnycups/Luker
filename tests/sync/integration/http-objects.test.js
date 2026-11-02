/**
 * HTTP object endpoints under `/api/sync/v1/`:
 *   - `GET  /session/object/:oid` — raw bytes + X-Object-Type / X-Object-Oid headers
 *   - `POST /session/object`      — raw body + X-Object-Type / X-Object-Oid headers
 *   - `POST /session/ref`         — compare-and-swap of the session's incoming ref
 *
 * Sessions come from authenticated offers against a real router, so every
 * route resolves the shadow the offer's local step created.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import git from 'isomorphic-git';

import { startLanDevice } from '../_lib/lan-devices.js';
import { commitFiles } from '../_lib/commits.js';
import { ensureShadowRepo } from '../../../src/sync/shadow.js';
import { upsertLanBackend } from '../../../src/sync/state.js';
import { listObjectsChildrenFirst, readObjectForWire } from '../../../src/sync/objects.js';
import { incomingRefFor } from '../../../src/sync/backends/lan/incoming.js';
import { atomicFs } from '../../../src/sync/pipeline/atomic-fs.js';
import { _resetGateForTests } from '../../../src/sync/in-progress-gate.js';

const SECRET = 'a'.repeat(64);
const PEER = 'u@0a1b2c3d';
const OTHER_PEER = 'u@0a1b2c3e';
const ZERO = '0'.repeat(40);

describe('sync HTTP object transfer', () => {
    let A;
    let shadow;
    let token;
    let oid;
    let source;

    async function openSession(peerId) {
        await upsertLanBackend({ userRoot: A.userRoot, backendId: peerId, label: 'Phone', categories: ['worlds'], syncSecret: SECRET });
        const res = await A.offer({ peerId, label: 'Phone', protocol: 2 }, { secret: SECRET });
        expect(res.status).toBe(200);
        return res.body.token;
    }
    const bearer = (sessionToken, extra) => ({ Authorization: `Bearer ${sessionToken}`, ...extra });
    async function getObject(sessionToken, objectOid) {
        const res = await A.request(`${A.baseUrl}/api/sync/v1/session/object/${objectOid}`, { headers: bearer(sessionToken) });
        return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
    }
    async function postObject(sessionToken, headers, body) {
        const res = await A.request(`${A.baseUrl}/api/sync/v1/session/object`, { method: 'POST', headers: bearer(sessionToken, { 'Content-Type': 'application/octet-stream', ...headers }), body });
        return { status: res.status, body: await res.json() };
    }
    async function pushObjects(head) {
        for (const objectOid of await listObjectsChildrenFirst({ dir: source, gitdir: source, headOid: head, skip: new Set() })) {
            const obj = await readObjectForWire({ dir: source, gitdir: source, oid: objectOid });
            expect((await postObject(token, { 'X-Object-Oid': objectOid, 'X-Object-Type': obj.type }, obj.body)).status).toBe(200);
        }
    }
    const ref = (refName, expectedOid, newOid) => A.call('POST', '/session/ref', { body: { ref: refName, expectedOid, newOid }, headers: bearer(token) });

    beforeEach(async () => {
        _resetGateForTests();
        A = await startLanDevice();
        token = await openSession(PEER);
        shadow = await ensureShadowRepo({ userRoot: A.userRoot, peerId: PEER });
        oid = await commitFiles(shadow.gitDir, { 'hi.txt': 'hello' });
        source = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-source-'));
        await git.init({ fs: atomicFs, dir: source, gitdir: source, bare: true, defaultBranch: 'main' });
    });

    afterEach(async () => {
        await A.close();
        fs.rmSync(source, { recursive: true, force: true });
    });

    test('GET /session/object/:oid streams raw object body with type header', async () => {
        const r = await getObject(token, oid);
        expect(r.status).toBe(200);
        expect(r.headers.get('x-object-type')).toBe('commit');
        expect(r.headers.get('x-object-oid')).toBe(oid);
        expect(r.body.length).toBeGreaterThan(0);
    });

    test('GET /session/object/:oid returns 400 for malformed oid', async () => {
        expect((await getObject(token, 'not-an-oid')).status).toBe(400);
    });

    test('GET /session/object/:oid returns 404 for missing oid', async () => {
        expect((await getObject(token, ZERO)).status).toBe(404);
    });

    test('POST /session/object accepts raw body and lands the object', async () => {
        // The commit's wire bytes from one backend's shadow land in the
        // shadow of another backend, which does not hold them yet.
        const obj = await readObjectForWire({ dir: shadow.workdir, gitdir: shadow.gitDir, oid });
        const otherToken = await openSession(OTHER_PEER);
        const r = await postObject(otherToken, { 'X-Object-Type': 'commit', 'X-Object-Oid': oid }, obj.body);
        expect(r.status).toBe(200);
        expect(r.body).toEqual(expect.objectContaining({ oid }));
    });

    test('POST /session/object rejects when X-Object-Oid is missing', async () => {
        expect((await postObject(token, { 'X-Object-Type': 'commit' }, Buffer.from('whatever'))).status).toBe(400);
    });

    test('POST /session/object rejects when X-Object-Type is invalid', async () => {
        expect((await postObject(token, { 'X-Object-Oid': oid, 'X-Object-Type': 'not-a-type' }, Buffer.from('whatever'))).status).toBe(400);
    });

    test('POST /session/object then GET /session/object/:oid round-trips a multi-MB blob', async () => {
        // A few-MB blob is larger than any single chat or world file and
        // small enough to keep the suite fast. It flows request body →
        // `writeObjectFromWireStream`'s temp file → the object store, and
        // back through `readObjectForWire`; byte equality on both ends shows
        // the wire path moves the full payload.
        const payload = Buffer.alloc(4 * 1024 * 1024, 'a');
        const payloadOid = await git.writeObject({ fs: atomicFs, gitdir: shadow.gitDir, type: 'blob', object: payload, format: 'content' });
        const otherToken = await openSession(OTHER_PEER);
        const post = await postObject(otherToken, { 'X-Object-Type': 'blob', 'X-Object-Oid': payloadOid }, payload);
        expect(post.status).toBe(200);
        expect(post.body).toEqual(expect.objectContaining({ oid: payloadOid }));
        const got = await getObject(otherToken, payloadOid);
        expect(got.status).toBe(200);
        expect(got.headers.get('x-object-type')).toBe('blob');
        expect(got.headers.get('x-object-oid')).toBe(payloadOid);
        expect(got.body.equals(payload)).toBe(true);
    });

    test('POST /session/ref CAS-updates the incoming ref when expectedOid matches current', async () => {
        const head = await commitFiles(source, { 'worlds/w.json': '{}' });
        await pushObjects(head);
        expect(await ref(incomingRefFor(PEER), ZERO, head)).toMatchObject({ status: 200, body: { ref: incomingRefFor(PEER), oid: head } });
        expect(await git.resolveRef({ fs: atomicFs, gitdir: shadow.gitDir, ref: incomingRefFor(PEER) })).toBe(head);
    });

    test('POST /session/ref returns 409 with current oid when expectedOid mismatches', async () => {
        const head = await commitFiles(source, { 'worlds/w.json': '{}' });
        await pushObjects(head);
        await ref(incomingRefFor(PEER), ZERO, head);
        const r = await ref(incomingRefFor(PEER), ZERO, head);
        expect(r.status).toBe(409);
        expect(r.body).toEqual(expect.objectContaining({ currentOid: head }));
    });

    test('POST /session/ref rejects every ref except the session incoming ref', async () => {
        const head = await commitFiles(source, { 'worlds/w.json': '{}' });
        await pushObjects(head);
        expect((await ref('refs/heads/main', ZERO, head)).status).toBe(400);
        expect((await ref('refs/tags/x', ZERO, head)).status).toBe(400);
    });
});
