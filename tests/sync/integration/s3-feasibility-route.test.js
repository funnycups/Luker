import { test, expect, beforeAll, afterAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import http from 'node:http';
import { createSyncRouter } from '../../../src/endpoints/sync.js';

let server, endpoint, hits = 0;
beforeAll(async () => {
    server = http.createServer((_req, res) => { hits++; res.end(); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
test.each([true, false])('removed feasibility HTTP route returns 404 without network for admin=%s', async admin => {
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.user = { profile: { handle: 'u', admin }, directories: {} }; next(); });
    app.use('/api/sync/v1', createSyncRouter());
    const response = await request(app).post('/api/sync/v1/diagnostics/s3-feasibility').send({ endpoint, region: 'us-east-1', bucket: 'unused', accessKeyId: 'private-access', secretAccessKey: 'private-secret', forcePathStyle: true, createBucket: true });
    expect(response.status).toBe(404); expect(hits).toBe(0);
});
