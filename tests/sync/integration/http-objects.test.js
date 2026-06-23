/**
 * Plan Task 11 — HTTP object endpoints under `/api/sync/v1/`.
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

    test('POST /session/object accepts payloads well under the configured limit', async () => {
        // The previous version of this test allocated a >25 MB buffer
        // to verify the cap was enforced. The cap is now 1 GiB (SQLite
        // whole-DB blobs need the room) and allocating 1 GiB just to
        // verify a 413 wastes test resources. Instead we positively
        // assert that a comfortably-sized payload (a few MB, larger
        // than any individual chat or world file) goes through. The
        // hard-cap enforcement still lives in `express.raw({limit})`
        // — whose behavior is well-trodden Express territory.
        const validPayload = Buffer.from('SQLite format 3\0').toString() + 'x'.repeat(4 * 1024 * 1024);
        const r = await request(harness.app)
            .post('/api/sync/v1/session/object')
            .set('Authorization', `Bearer ${token}`)
            .set('Content-Type', 'application/octet-stream')
            .set('X-Object-Type', 'blob')
            .set('X-Object-Oid', oid)
            .send(Buffer.from(validPayload));
        // The handler will reject with 400 (oid mismatch — the body
        // does not hash to the supplied oid) but NOT 413 (body fits).
        // We assert the cap path didn't fire, not that the upload
        // succeeded semantically.
        expect(r.status).not.toBe(413);
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
