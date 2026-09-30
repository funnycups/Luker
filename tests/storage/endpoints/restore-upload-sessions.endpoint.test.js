// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import request from 'supertest';

import { makeEndpointHarness } from '../harness/endpoint-harness.js';
import { router as usersPrivateRouter } from '../../../src/endpoints/users-private.js';

const ZIP_BYTES = Buffer.from('PK\u0003\u0004fake-zip-payload-for-sessions', 'binary');

function collectText(res, cb) {
    let text = '';
    res.on('data', (chunk) => { text += chunk; });
    res.on('end', () => cb(null, text));
    res.on('error', cb);
}

async function initSession(app, body = {}) {
    return await request(app)
        .post('/api/users/restore-backup/uploads')
        .send({ handle: 'u', fileName: 'backup.zip', size: ZIP_BYTES.length, ...body });
}

async function putChunk(app, uploadId, offset, bytes) {
    return await request(app)
        .put(`/api/users/restore-backup/uploads/${uploadId}/chunks/${offset}`)
        .set('Content-Type', 'application/octet-stream')
        .send(bytes);
}

describe('restore upload session endpoints', () => {
    let harness;
    let previousDataRoot;

    beforeEach(async () => {
        previousDataRoot = globalThis.DATA_ROOT;
        harness = await makeEndpointHarness({
            mode: 'fs',
            mount: (app) => {
                // Simulates a non-admin requester without rebuilding the
                // harness (which fixes req.user for the whole file).
                app.use('/api/users', (req, _res, next) => {
                    if (req.headers['x-test-nonadmin']) {
                        req.user = { profile: { handle: 'u', admin: false, enabled: true }, directories: req.user.directories };
                    }
                    next();
                });
                app.use('/api/users', usersPrivateRouter);
            },
        });
        globalThis.DATA_ROOT = harness.dataRoot;
    });

    afterEach(async () => {
        globalThis.DATA_ROOT = previousDataRoot;
        if (harness) await harness.cleanup();
    });

    test('init validates handle, extension and size', async () => {
        expect((await initSession(harness.app, { handle: '' })).status).toBe(400);
        expect((await initSession(harness.app, { fileName: 'backup.txt' })).status).toBe(400);
        expect((await initSession(harness.app, { size: 0 })).status).toBe(400);
        expect((await initSession(harness.app, { size: 1.5 })).status).toBe(400);
    });

    test('init denies a non-admin uploading for another handle', async () => {
        const res = await request(harness.app)
            .post('/api/users/restore-backup/uploads')
            .set('x-test-nonadmin', '1')
            .send({ handle: 'someone-else', fileName: 'backup.zip', size: 10 });
        expect(res.status).toBe(403);
    });

    test('init returns an id and persists the declared size', async () => {
        const res = await initSession(harness.app);
        expect(res.status).toBe(200);
        expect(res.body.uploadId).toMatch(/^[0-9a-f]{32}$/);
    });

    test('chunks must be application/octet-stream', async () => {
        const { body } = await initSession(harness.app);
        const res = await request(harness.app)
            .put(`/api/users/restore-backup/uploads/${body.uploadId}/chunks/0`)
            .set('Content-Type', 'application/json')
            .send({ nope: true });
        expect(res.status).toBe(400);
    });

    test('chunk offsets are bounds-checked', async () => {
        const { body } = await initSession(harness.app);
        expect((await putChunk(harness.app, body.uploadId, -1, Buffer.from('x'))).status).toBe(400);
        const tooFar = await putChunk(harness.app, body.uploadId, ZIP_BYTES.length, Buffer.from('x'));
        expect(tooFar.status).toBe(400);
    });

    test('chunk overrun is rejected', async () => {
        const { body } = await initSession(harness.app, { size: 4 });
        const res = await putChunk(harness.app, body.uploadId, 0, Buffer.from('12345'));
        expect(res.status).toBe(400);
    });

    test('chunk retry at the same offset is idempotent', async () => {
        const { body } = await initSession(harness.app);
        const first = await putChunk(harness.app, body.uploadId, 0, ZIP_BYTES.subarray(0, 4));
        const second = await putChunk(harness.app, body.uploadId, 0, ZIP_BYTES.subarray(0, 4));
        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
    });

    test('finalize rejects an incomplete upload with the missing offset', async () => {
        const { body } = await initSession(harness.app);
        await putChunk(harness.app, body.uploadId, 0, ZIP_BYTES.subarray(0, 4));
        const res = await request(harness.app)
            .post(`/api/users/restore-backup/uploads/${body.uploadId}/finalize`)
            .send({});
        expect(res.status).toBe(400);
        expect(res.body.missingOffset).toBe(4);
    });

    test('finalize streams assemble progress then a result', async () => {
        const { body } = await initSession(harness.app);
        await putChunk(harness.app, body.uploadId, 0, ZIP_BYTES.subarray(0, 10));
        await putChunk(harness.app, body.uploadId, 10, ZIP_BYTES.subarray(10));
        const res = await request(harness.app)
            .post(`/api/users/restore-backup/uploads/${body.uploadId}/finalize`)
            .set('Accept', 'application/x-ndjson')
            .buffer(true)
            .parse(collectText)
            .send({});
        expect(res.status).toBe(200);
        const lines = res.body.trim().split('\n').map((line) => JSON.parse(line));
        expect(lines.some((line) => line.type === 'progress' && line.phase === 'assemble')).toBe(true); // banned-words-allow
        const result = lines.find((line) => line.type === 'result');
        expect(result.size).toBe(ZIP_BYTES.length);
    });

    test('finalize is idempotent on retry', async () => {
        const { body } = await initSession(harness.app);
        await putChunk(harness.app, body.uploadId, 0, ZIP_BYTES);
        const first = await request(harness.app)
            .post(`/api/users/restore-backup/uploads/${body.uploadId}/finalize`)
            .send({});
        const second = await request(harness.app)
            .post(`/api/users/restore-backup/uploads/${body.uploadId}/finalize`)
            .send({});
        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(second.body.size).toBe(ZIP_BYTES.length);
    });

    test('delete removes the session and later access 404s', async () => {
        const { body } = await initSession(harness.app);
        const del = await request(harness.app)
            .delete(`/api/users/restore-backup/uploads/${body.uploadId}`)
            .send({});
        expect(del.status).toBe(204);
        const after = await putChunk(harness.app, body.uploadId, 0, Buffer.from('x'));
        expect(after.status).toBe(404);
    });

    test('non-admin cannot touch another user session', async () => {
        const res = await request(harness.app)
            .post('/api/users/restore-backup/uploads')
            .send({ handle: 'other', fileName: 'backup.zip', size: 4 });
        expect(res.status).toBe(200); // admin requester may create for other
        const { uploadId } = res.body;
        const chunk = await request(harness.app)
            .put(`/api/users/restore-backup/uploads/${uploadId}/chunks/0`)
            .set('x-test-nonadmin', '1')
            .set('Content-Type', 'application/octet-stream')
            .send(Buffer.from('x'));
        expect(chunk.status).toBe(403);
    });
});
