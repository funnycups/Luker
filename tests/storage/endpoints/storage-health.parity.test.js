// /api/storage/health parity: the public health endpoint must behave the same
// across all four engines. A successful ping yields 200 with kind +
// schemaVersion + latencyMs; an engine whose ping throws yields 503 with a
// short, redacted error string.
//
// The endpoint is mounted PUBLIC (no auth, no req.user). Sqlite is the only
// engine whose ping is per-handle in practice — when invoked with no handle
// it falls back to a transport-level success (engine is loaded, library
// available; per-user DBs are exercised on real requests). That's why the
// healthy-sqlite case here still returns 200 without ever opening a user DB.
//
// The broken-engine test runs against fs because fs is always available and
// its ping is trivially patchable to throw. The point is to verify the
// endpoint maps any ping-throw into 503, regardless of engine.

import request from 'supertest';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../harness/endpoint-harness.js';
import { router as storageHealthRouter } from '../../../src/endpoints/storage-health.js';

describe.each(ENDPOINT_HARNESSES)('GET /api/storage/health on $name', ({ mode }) => {
    let harness;

    beforeEach(async () => {
        harness = await makeEndpointHarness({
            mode,
            mount: (app) => {
                app.use('/api/storage', storageHealthRouter);
            },
        });
    });

    afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    test('returns 200 with kind, schemaVersion, and latencyMs when engine is healthy', async () => {
        const res = await request(harness.app).get('/api/storage/health');
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.kind).toBe(mode);
        expect(typeof res.body.latencyMs).toBe('number');
        expect(res.body.latencyMs).toBeGreaterThanOrEqual(0);
        // schemaVersion is best-effort: engines without getSchemaVersion()
        // surface 0. All four engines currently return 0 (Stage 0 hasn't
        // exposed the value publicly yet — that's a future task).
        expect(typeof res.body.schemaVersion).toBe('number');
    });
});

describe('GET /api/storage/health with broken engine', () => {
    let harness;

    afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    test('returns 503 with redacted error when ping throws', async () => {
        harness = await makeEndpointHarness({
            mode: 'fs',
            mount: (app) => {
                app.use('/api/storage', storageHealthRouter);
            },
        });
        const orig = harness.engine.ping.bind(harness.engine);
        harness.engine.ping = async () => {
            throw Object.assign(new Error('synthetic transport failure'), { code: 'EBROKEN' });
        };
        try {
            const res = await request(harness.app).get('/api/storage/health');
            expect(res.status).toBe(503);
            expect(res.body.ok).toBe(false);
            expect(res.body.kind).toBe('fs');
            expect(typeof res.body.error).toBe('string');
            // Error string includes the err.code prefix so operators can
            // correlate without us leaking stack traces over the wire.
            expect(res.body.error).toContain('EBROKEN');
        } finally {
            harness.engine.ping = orig;
        }
    });
});
