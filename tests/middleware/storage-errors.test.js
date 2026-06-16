import { describe, test, expect } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { storageErrorHandler } from '../../src/middleware/storage-errors.js';
import {
    StorageReadOnlyError,
    ConflictError,
    NotFoundError,
} from '../../src/storage/errors.js';

/**
 * Build a minimal Express app whose single route forwards `err` through to
 * the storage error handler. Keeps the test surface tiny so failures point at
 * the mapping logic and not at route plumbing.
 */
function makeApp(routeHandler) {
    const app = express();
    app.use(express.json());
    app.post('/test', routeHandler);
    app.use(storageErrorHandler);
    return app;
}

describe('storageErrorHandler middleware', () => {
    test('maps StorageReadOnlyError to 503 with storage_read_only code', async () => {
        const app = makeApp((_req, _res, next) => next(new StorageReadOnlyError()));
        const res = await request(app).post('/test').send({});
        expect(res.status).toBe(503);
        expect(res.body.error).toBe('storage_read_only');
        // The message is the source-of-truth for operator messaging — verify
        // it still names migration so the client UI can surface the right
        // explanation.
        expect(res.body.message).toMatch(/migration/);
    });

    test('maps ConflictError to 409 with code passed through and details preserved', async () => {
        const app = makeApp((_req, _res, next) =>
            next(new ConflictError('integrity_mismatch', { foo: 'bar' })),
        );
        const res = await request(app).post('/test').send({});
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('integrity_mismatch');
        expect(res.body.details).toEqual({ foo: 'bar' });
    });

    test('maps ConflictError without details to 409 with undefined details field', async () => {
        const app = makeApp((_req, _res, next) =>
            next(new ConflictError('some_code')),
        );
        const res = await request(app).post('/test').send({});
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('some_code');
        // JSON serialization drops undefined fields, so `details` should be
        // absent. Either absent or null is fine — we just don't want a value.
        expect(res.body.details).toBeUndefined();
    });

    test('maps NotFoundError to 404 (no body)', async () => {
        const app = makeApp((_req, _res, next) =>
            next(new NotFoundError('chat', { handle: 'u', name: 'x' })),
        );
        const res = await request(app).post('/test').send({});
        expect(res.status).toBe(404);
    });

    test('passes through unknown errors to Express default handler (500)', async () => {
        // Don't use makeApp here because the unknown-error path must reach the
        // Express default handler, which only kicks in when no further
        // middleware handles it.
        const app = express();
        app.use(express.json());
        app.post('/test', (_req, _res, next) => next(new Error('something else')));
        app.use(storageErrorHandler);
        const res = await request(app).post('/test').send({});
        expect(res.status).toBe(500);
    });

    test('does not double-respond when headers already sent', async () => {
        const app = express();
        app.use(express.json());
        // Route writes a 200 then synthetically forwards a storage error. The
        // handler must detect res.headersSent and call next(err) instead of
        // crashing the response stream.
        app.post('/test', (_req, res, next) => {
            res.status(200).send('OK');
            try {
                throw new StorageReadOnlyError();
            } catch (e) {
                next(e);
            }
        });
        app.use(storageErrorHandler);
        const res = await request(app).post('/test').send({});
        // First response wins — the client sees the 200.
        expect(res.status).toBe(200);
        expect(res.text).toBe('OK');
    });
});
