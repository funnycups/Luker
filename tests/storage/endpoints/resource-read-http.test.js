import request from 'supertest';

import { createPrivateRepresentation, sendPrivateRepresentation, sendResourceReadError } from '../../../src/http-resource-cache.js';
import { router as bootstrapRouter } from '../../../src/endpoints/bootstrap.js';
import { makeEndpointHarness } from '../harness/endpoint-harness.js';

describe('private resource representations', () => {
    let harness;

    beforeEach(async () => {
        harness = await makeEndpointHarness({
            mode: 'fs',
            mount(app) {
                app.use('/api', bootstrapRouter);
                app.get('/resource', (req, res) => {
                    const representation = createPrivateRepresentation({
                        account: 'u',
                        resource: 'example',
                        text: 'first body',
                        contentType: 'text/plain; charset=utf-8',
                    });
                    sendPrivateRepresentation(req, res, representation);
                });
                app.get('/failure', (req, res) => {
                    sendResourceReadError(res, {
                        code: 'invalid_resource',
                        resource: 'example',
                        detail: 'not valid JSON',
                        status: 422,
                    });
                });
            },
        });
    });

    afterEach(async () => {
        await harness.cleanup();
    });

    test('validates a representation before returning 304', async () => {
        const first = await request(harness.server)
            .get('/resource')
            .query({ account: 'u' })
            .expect(200);

        expect(first.headers['cache-control']).toBe('private, no-cache, max-age=1');
        expect(first.headers.etag).toMatch(/^W\/"[a-f0-9]{64}"$/);
        expect(first.text).toBe('first body');

        const unchanged = await request(harness.server)
            .get('/resource')
            .query({ account: 'u' })
            .set('If-None-Match', first.headers.etag)
            .expect(304);

        expect(unchanged.text).toBe('');
        expect(unchanged.headers.etag).toBe(first.headers.etag);
    });

    test('derives a different validator for another account', () => {
        const sameText = createPrivateRepresentation({
            account: 'u',
            resource: 'example',
            text: 'first body',
            contentType: 'text/plain; charset=utf-8',
        });
        const otherAccount = createPrivateRepresentation({
            account: 'other',
            resource: 'example',
            text: 'first body',
            contentType: 'text/plain; charset=utf-8',
        });

        expect(otherAccount.etag).not.toBe(sameText.etag);
    });

    test('rejects a representation for a different authenticated account', async () => {
        const response = await request(harness.server)
            .get('/resource')
            .query({ account: 'other' })
            .expect(403);

        expect(response.headers['cache-control']).toBe('no-store');
    });

    test('does not cache resource errors', async () => {
        const response = await request(harness.server)
            .get('/failure')
            .expect(422);

        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.body).toMatchObject({
            code: 'invalid_resource',
            resource: 'example',
        });
    });

    test('returns minimal authenticated bootstrap metadata without caching it', async () => {
        const response = await request(harness.server)
            .get('/api/bootstrap/metadata')
            .expect(200);

        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.body).toMatchObject({
            account: 'u',
            enable_extensions: expect.any(Boolean),
            enable_extensions_auto_update: expect.any(Boolean),
            enable_accounts: expect.any(Boolean),
            secret_state: expect.any(Object),
        });
        expect(response.body).not.toHaveProperty('settings');
        expect(response.body).not.toHaveProperty('characters');
    });
});
