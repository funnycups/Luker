/**
 * `/session/offer` and `/session/close` endpoints.
 *
 * Exercises the session-bootstrap flow that turns the authenticated user's
 * basic-auth identity into a multi-use bearer token for the rest of
 * `/api/sync/v1/session/*`. Each test runs end-to-end through supertest
 * against the real router, real session cache, and a real fs-mode
 * `makeEndpointHarness` — no mocks. The harness installs a middleware that
 * populates `req.user`, which stands in for the production basic-auth +
 * `setUserDataMiddleware` pair (covered by `tests/basicAuth.test.js`); on
 * top of that we assert the endpoint's own behavior.
 *
 * The mysql/postgres 412 gate lives in a sibling file
 * (`http-storage-gate.test.js`) because it has to stub `getStorageEngine`
 * without dragging mysql/postgres into the default unit-test surface.
 *
 * Coverage:
 *   - happy path: offer issues a 64-hex token that unlocks `/session/manifest`
 *   - missing peerId → 400
 *   - close: subsequent `/session/manifest` with the same token → 401
 *   - close with no/invalid bearer → 401 from `requireSyncToken`
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../../storage/harness/endpoint-harness.js';
import { router as syncRouter } from '../../../src/endpoints/sync.js';

const FS_HARNESSES = ENDPOINT_HARNESSES.filter(h => h.mode === 'fs');

describe.each(FS_HARNESSES)('sync session lifecycle on $name', ({ mode }) => {
    let harness;

    beforeEach(async () => {
        harness = await makeEndpointHarness({
            mode,
            mount: app => app.use('/api/sync/v1', syncRouter),
        });
    });

    afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    test('POST /session/offer issues a usable bearer token', async () => {
        const r = await request(harness.app)
            .post('/api/sync/v1/session/offer')
            .send({
                peerId: `${harness.handle}@phone`,
                label: 'Phone',
                categories: ['characters', 'chats'],
            });
        expect(r.status).toBe(200);
        expect(r.body.token).toMatch(/^[a-f0-9]{64}$/);
        expect(r.body.url).toContain('/api/sync/v1/session/manifest');
        expect(r.body.expiresAt).toBeGreaterThan(Date.now());
        expect(r.body.peerId).toBe(`${harness.handle}@phone`);
        expect(r.body.label).toBe('Phone');

        // The token must unlock the manifest route. This is the actual
        // contract the peer relies on: not just "we got a token back" but
        // "the token works on the rest of /session/*".
        const m = await request(harness.app)
            .get('/api/sync/v1/session/manifest')
            .set('Authorization', `Bearer ${r.body.token}`);
        expect(m.status).toBe(200);
        expect(m.body).toEqual(expect.objectContaining({
            peerId: `${harness.handle}@phone`,
            handle: harness.handle,
        }));
    });

    test('POST /session/offer rejects when peerId is missing or blank', async () => {
        const noPeer = await request(harness.app)
            .post('/api/sync/v1/session/offer')
            .send({ label: 'no peerId' });
        expect(noPeer.status).toBe(400);
        expect(noPeer.body.error).toMatch(/peerId/i);

        const blankPeer = await request(harness.app)
            .post('/api/sync/v1/session/offer')
            .send({ peerId: '   ', label: 'still no peerId' });
        expect(blankPeer.status).toBe(400);
    });

    test('POST /session/offer defaults categories to [] when omitted or non-array', async () => {
        // Verifies the input-coercion contract: callers can send the field
        // or leave it out; non-array input falls back to empty rather than
        // throwing or being stored as a wrong-shape payload. The session
        // payload itself is not externally readable, but the downstream
        // orchestrator trusts `categories` to be an array.
        const r = await request(harness.app)
            .post('/api/sync/v1/session/offer')
            .send({ peerId: `${harness.handle}@phone`, categories: 'not-an-array' });
        expect(r.status).toBe(200);
        expect(r.body.token).toMatch(/^[a-f0-9]{64}$/);
    });

    test('POST /session/close invalidates the bearer token', async () => {
        const offer = await request(harness.app)
            .post('/api/sync/v1/session/offer')
            .send({ peerId: `${harness.handle}@phone`, label: 'Phone', categories: [] });
        expect(offer.status).toBe(200);
        const token = offer.body.token;

        // Confirm the token works before close, so a failure on the
        // after-close request unambiguously means close did its job.
        const before = await request(harness.app)
            .get('/api/sync/v1/session/manifest')
            .set('Authorization', `Bearer ${token}`);
        expect(before.status).toBe(200);

        const close = await request(harness.app)
            .post('/api/sync/v1/session/close')
            .set('Authorization', `Bearer ${token}`);
        expect(close.status).toBe(200);
        expect(close.body).toEqual({ ok: true });

        const after = await request(harness.app)
            .get('/api/sync/v1/session/manifest')
            .set('Authorization', `Bearer ${token}`);
        expect(after.status).toBe(401);
    });

    test('POST /session/close itself requires a valid bearer', async () => {
        const noHeader = await request(harness.app)
            .post('/api/sync/v1/session/close');
        expect(noHeader.status).toBe(401);

        const wrongShape = await request(harness.app)
            .post('/api/sync/v1/session/close')
            .set('Authorization', 'Bearer not-hex');
        expect(wrongShape.status).toBe(401);

        const wellFormedUnissued = await request(harness.app)
            .post('/api/sync/v1/session/close')
            .set('Authorization', `Bearer ${'a'.repeat(64)}`);
        expect(wellFormedUnissued.status).toBe(401);
    });
});
