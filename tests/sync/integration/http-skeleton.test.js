/**
 * HTTP router skeleton for `/api/sync/v1/`.
 *
 * Verifies:
 *   - `GET /health` is reachable through the mounted router.
 *   - `GET /session/manifest` requires a valid bearer token (issued via
 *     `createSyncSession`); a missing, malformed, or expired token must
 *     yield 401.
 *
 * The basic-auth bypass that `isBasicAuthExemptRequest` performs for
 * `/session/*` paths is covered by `tests/basicAuth.test.js`.
 *
 * Storage mode is irrelevant for this skeleton — no repo calls happen — so
 * the test only runs against `fs` to keep the inner loop fast. Storage
 * gating is enforced by the session-lifecycle layer.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../../storage/harness/endpoint-harness.js';
import { router as syncRouter } from '../../../src/endpoints/sync.js';
import { createSyncSession } from '../../../src/sync/session.js';
import { ensureShadowRepo } from '../../../src/sync/shadow.js';
import { upsertLanBackend } from '../../../src/sync/state.js';

const FS_HARNESSES = ENDPOINT_HARNESSES.filter(h => h.mode === 'fs');

describe.each(FS_HARNESSES)('sync router skeleton on $name', ({ mode }) => {
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

    test('GET /api/sync/v1/health is reachable through the mounted router', async () => {
        const r = await request(harness.server).get('/api/sync/v1/health');
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ ok: true, protocol: 2 });
    });

    test('GET /api/sync/v1/session/manifest accepts a valid bearer token', async () => {
        // Session routes serve only registered backends with a shadow; the
        // offer creates both before issuing a token.
        await upsertLanBackend({ userRoot: harness.dirs.root, backendId: 'alice@phone', label: 'Phone', categories: [] });
        await ensureShadowRepo({ userRoot: harness.dirs.root, peerId: 'alice@phone' });
        const { token, expiresAt } = createSyncSession({
            handle: 'alice',
            peerId: 'alice@phone',
            userRoot: harness.dirs.root,
        });

        const r = await request(harness.server)
            .get('/api/sync/v1/session/manifest')
            .set('Authorization', `Bearer ${token}`);

        expect(r.status).toBe(200);
        // A freshly-initialized shadow has neither a main nor an incoming ref.
        expect(r.body).toEqual({ handle: 'alice', peerId: 'alice@phone', expiresAt, headOid: null, incomingOid: null });
    });

    test('GET /api/sync/v1/session/manifest rejects missing or malformed bearer', async () => {
        // No header at all.
        const r0 = await request(harness.server).get('/api/sync/v1/session/manifest');
        expect(r0.status).toBe(401);

        // Header present but the value is not 64 hex chars.
        const r1 = await request(harness.server)
            .get('/api/sync/v1/session/manifest')
            .set('Authorization', 'Bearer not-hex');
        expect(r1.status).toBe(401);

        // 64 chars, but `z` is not a hex digit — still rejected.
        const r2 = await request(harness.server)
            .get('/api/sync/v1/session/manifest')
            .set('Authorization', `Bearer ${'z'.repeat(64)}`);
        expect(r2.status).toBe(401);

        // Well-formed but unissued token — rejected because the session
        // cache has no entry.
        const r3 = await request(harness.server)
            .get('/api/sync/v1/session/manifest')
            .set('Authorization', `Bearer ${'a'.repeat(64)}`);
        expect(r3.status).toBe(401);
    });
});
