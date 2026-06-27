/**
 * HTTP object endpoints under `/api/sync/v1/`.
 *
 * Verifies the three new routes:
 *   - `GET  /session/object/:oid` — raw bytes + X-Object-Type / X-Object-Oid headers
 *   - `POST /session/object`      — raw body + X-Object-Type / X-Object-Oid headers
 *   - `POST /session/ref`         — CAS update of refs/heads/* with 409 on mismatch
 *
 * The shadow repo and the sync session are stood up via the same real-product
 * paths the running server uses (`ensureShadowRepo`, `createSyncSession`),
 * driven by the `fs`-mode endpoint harness. We pass `userRoot` directly into
 * `createSyncSession` (matching the real `/session/offer` flow added in Task
 * 12) so the session's `shadowFor` resolves to the *current* harness's user
 * root without going through the per-handle directory cache — which previous
 * tests in the same process may have populated against a now-stale path.
 *
 * Storage gating (spec §6.3) is not relevant for object/ref transfer — those
 * speak only the shadow repo, never the storage engine — so this test runs
 * only against `fs` to keep the inner loop fast. SQLite mode coverage lives
 * in the orchestrator integration tests added by later plan tasks.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import request from 'supertest';
import git from 'isomorphic-git';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../../storage/harness/endpoint-harness.js';
import { router as syncRouter } from '../../../src/endpoints/sync.js';
import { createSyncSession } from '../../../src/sync/session.js';
import { ensureShadowRepo } from '../../../src/sync/shadow.js';
import { readObjectForWire } from '../../../src/sync/objects.js';

const FS_HARNESSES = ENDPOINT_HARNESSES.filter(h => h.mode === 'fs');

describe.each(FS_HARNESSES)('sync HTTP object transfer on $name', ({ mode }) => {
    let harness;
    let shadow;
    let token;
    let oid;

    beforeEach(async () => {
        harness = await makeEndpointHarness({
            mode,
            mount: app => app.use('/api/sync/v1', syncRouter),
        });

        // Stand up a shadow with a real commit so GET has something to serve.
        shadow = await ensureShadowRepo({ userRoot: harness.dirs.root, peerId: 'alice@phone' });
        fs.writeFileSync(path.join(shadow.workdir, 'hi.txt'), 'hello');
        await git.add({ fs, dir: shadow.workdir, gitdir: shadow.gitDir, filepath: 'hi.txt' });
        oid = await git.commit({
            fs,
            dir: shadow.workdir,
            gitdir: shadow.gitDir,
            message: 'init',
            author: { name: 't', email: 't@t' },
        });
        token = createSyncSession({
            handle: harness.handle,
            peerId: 'alice@phone',
            userRoot: harness.dirs.root,
        }).token;
    });

    afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    test('GET /session/object/:oid streams raw object body with type header', async () => {
        const r = await request(harness.app)
            .get(`/api/sync/v1/session/object/${oid}`)
            .set('Authorization', `Bearer ${token}`)
            .buffer(true)
            .parse((res, cb) => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => cb(null, Buffer.concat(chunks)));
            });
        expect(r.status).toBe(200);
        expect(r.headers['x-object-type']).toBe('commit');
        expect(r.headers['x-object-oid']).toBe(oid);
        expect(Buffer.isBuffer(r.body)).toBe(true);
        expect(r.body.length).toBeGreaterThan(0);
    });

    test('GET /session/object/:oid returns 400 for malformed oid', async () => {
        const r = await request(harness.app)
            .get('/api/sync/v1/session/object/not-an-oid')
            .set('Authorization', `Bearer ${token}`);
        expect(r.status).toBe(400);
    });

    test('GET /session/object/:oid returns 404 for missing oid', async () => {
        const r = await request(harness.app)
            .get(`/api/sync/v1/session/object/${'0'.repeat(40)}`)
            .set('Authorization', `Bearer ${token}`);
        expect(r.status).toBe(404);
    });

    test('POST /session/object accepts raw body and lands the object', async () => {
        // Read the commit's wire bytes from peer A, then POST them to a
        // freshly-empty shadow under peer B. End-to-end this is the same
        // round trip the sync orchestrator does, just collapsed to a single
        // process so we can assert the receiver's ODB sees the same oid.
        const obj = await readObjectForWire({ dir: shadow.workdir, gitdir: shadow.gitDir, oid });
        const token2 = createSyncSession({
            handle: harness.handle,
            peerId: 'alice@laptop',
            userRoot: harness.dirs.root,
        }).token;
        await ensureShadowRepo({ userRoot: harness.dirs.root, peerId: 'alice@laptop' });

        const r = await request(harness.app)
            .post('/api/sync/v1/session/object')
            .set('Authorization', `Bearer ${token2}`)
            .set('Content-Type', 'application/octet-stream')
            .set('X-Object-Type', 'commit')
            .set('X-Object-Oid', oid)
            .send(obj.body);
        expect(r.status).toBe(200);
        expect(r.body).toEqual(expect.objectContaining({ oid }));
    });

    test('POST /session/object rejects when X-Object-Oid is missing', async () => {
        const r = await request(harness.app)
            .post('/api/sync/v1/session/object')
            .set('Authorization', `Bearer ${token}`)
            .set('Content-Type', 'application/octet-stream')
            .set('X-Object-Type', 'commit')
            .send(Buffer.from('whatever'));
        expect(r.status).toBe(400);
    });

    test('POST /session/object rejects when X-Object-Type is invalid', async () => {
        const r = await request(harness.app)
            .post('/api/sync/v1/session/object')
            .set('Authorization', `Bearer ${token}`)
            .set('Content-Type', 'application/octet-stream')
            .set('X-Object-Oid', oid)
            .set('X-Object-Type', 'not-a-type')
            .send(Buffer.from('whatever'));
        expect(r.status).toBe(400);
    });

    test('POST /session/object then GET /session/object/:oid round-trips a multi-MB blob', async () => {
        // Positive end-to-end streaming check. A few-MB blob is larger than
        // any individual chat or world file (so we're past the territory
        // where Express's default in-memory body handling would have
        // sufficed) and small enough to keep CI fast. The body flows
        // request body → `writeObjectFromWireStream`'s tmp file under
        // `<gitdir>/objects/incoming/` → isomorphic-git's hash+deflate;
        // the GET reads it back via `readObjectForWire` and writes the
        // raw bytes to the response. Asserting byte equality on both
        // ends proves the wire path actually moves the full payload
        // without any silent truncation or buffering surprises.
        const payload = Buffer.alloc(4 * 1024 * 1024, 'a');
        const payloadOid = await git.writeObject({
            fs, dir: shadow.workdir, gitdir: shadow.gitDir,
            type: 'blob', object: payload, format: 'content',
        });

        const peerBToken = createSyncSession({
            handle: harness.handle,
            peerId: 'alice@laptop',
            userRoot: harness.dirs.root,
        }).token;
        await ensureShadowRepo({ userRoot: harness.dirs.root, peerId: 'alice@laptop' });

        const post = await request(harness.app)
            .post('/api/sync/v1/session/object')
            .set('Authorization', `Bearer ${peerBToken}`)
            .set('Content-Type', 'application/octet-stream')
            .set('X-Object-Type', 'blob')
            .set('X-Object-Oid', payloadOid)
            .send(payload);
        expect(post.status).toBe(200);
        expect(post.body).toEqual(expect.objectContaining({ oid: payloadOid }));

        const got = await request(harness.app)
            .get(`/api/sync/v1/session/object/${payloadOid}`)
            .set('Authorization', `Bearer ${peerBToken}`)
            .buffer(true)
            .parse((res, cb) => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => cb(null, Buffer.concat(chunks)));
            });
        expect(got.status).toBe(200);
        expect(got.headers['x-object-type']).toBe('blob');
        expect(got.headers['x-object-oid']).toBe(payloadOid);
        expect(got.body.equals(payload)).toBe(true);
    });

    test('POST /session/ref CAS-updates the ref when expectedOid matches current', async () => {
        // Shadow already has refs/heads/main pointing at `oid` from the
        // initial commit. Self-update (oid → oid) is sufficient to prove the
        // CAS path and avoids needing a second real commit just for the
        // happy-path test.
        const r = await request(harness.app)
            .post('/api/sync/v1/session/ref')
            .set('Authorization', `Bearer ${token}`)
            .send({ ref: 'refs/heads/main', expectedOid: oid, newOid: oid });
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ ref: 'refs/heads/main', oid });
    });

    test('POST /session/ref returns 409 with current oid when expectedOid mismatches', async () => {
        const r = await request(harness.app)
            .post('/api/sync/v1/session/ref')
            .set('Authorization', `Bearer ${token}`)
            .send({ ref: 'refs/heads/main', expectedOid: '0'.repeat(40), newOid: oid });
        expect(r.status).toBe(409);
        expect(r.body).toEqual(expect.objectContaining({ error: 'Ref changed', currentOid: oid }));
    });

    test('POST /session/ref rejects refs outside refs/heads/', async () => {
        const r = await request(harness.app)
            .post('/api/sync/v1/session/ref')
            .set('Authorization', `Bearer ${token}`)
            .send({ ref: 'refs/tags/v1', expectedOid: oid, newOid: oid });
        expect(r.status).toBe(400);
    });
});
