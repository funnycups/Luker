import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startFakeDevtools } from './_lib/fake-devtools-server.js';

const HEAP = '{"snapshot":{}}';
const TRACE = '{"traceEvents":[]}\n';

let dataRoot;
let server;
let endpoints;
let capture;
let adminApp;

function makeApp(adminRouter) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { profile: { handle: 'tester' } };
        next();
    });
    app.use('/api/debug/capture', adminRouter);
    return app;
}

beforeEach(async () => {
    dataRoot = mkdtempSync(path.join(tmpdir(), 'luker-data-'));
    globalThis.DATA_ROOT = dataRoot;
    jest.resetModules();

    endpoints = await import('../../src/endpoints/renderer-capture.js');
    capture = await import('../../src/renderer-capture/index.js');
    adminApp = makeApp(endpoints.createRendererCaptureRouter({ isAdmin: () => true }));
});

afterEach(async () => {
    if (server) {
        await server.close();
        server = null;
    }
    delete process.env.LUKER_RENDERER_DEVTOOLS_SOCKET;
    delete globalThis.DATA_ROOT;
    rmSync(dataRoot, { recursive: true, force: true });
});

describe('renderer capture endpoints', () => {
    test('refuses every capture route for a non-admin caller', async () => {
        const app = makeApp(endpoints.createRendererCaptureRouter({ isAdmin: () => false }));

        for (const call of [
            request(app).get('/api/debug/capture/status'),
            request(app).post('/api/debug/capture/heap'),
            request(app).post('/api/debug/capture/trace/start'),
            request(app).post('/api/debug/capture/trace/stop'),
        ]) {
            const response = await call;
            expect(response.status).toBe(403);
        }
    });

    test('reports the capture as unavailable without a devtools socket', async () => {
        process.env.LUKER_RENDERER_DEVTOOLS_SOCKET = path.join(tmpdir(), 'luker-absent-devtools.sock');

        const response = await request(adminApp).get('/api/debug/capture/status');

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ available: false, recording: false, reason: expect.any(String) });
    });

    test('captures a heap snapshot and names the artifact', async () => {
        server = await startFakeDevtools({ heapChunks: ['{"snapshot":', '{}}'] });
        process.env.LUKER_RENDERER_DEVTOOLS_SOCKET = server.socketPath;

        const response = await request(adminApp).post('/api/debug/capture/heap');

        expect(response.status).toBe(200);
        expect(response.body.bytes).toBe(Buffer.byteLength(HEAP));
        expect(existsSync(capture.artifactPath(response.body.name))).toBe(true);
    });

    test('reports a failed capture with the reason', async () => {
        server = await startFakeDevtools({ errorOnHeapStart: true });
        process.env.LUKER_RENDERER_DEVTOOLS_SOCKET = server.socketPath;

        const response = await request(adminApp).post('/api/debug/capture/heap');

        expect(response.status).toBe(500);
        expect(response.body.error).toContain('boom');
    });

    test('tracks the recording state across start and stop', async () => {
        server = await startFakeDevtools({ traceEvents: [] });
        process.env.LUKER_RENDERER_DEVTOOLS_SOCKET = server.socketPath;
        const app = adminApp;

        expect((await request(app).get('/api/debug/capture/status')).body.recording).toBe(false);

        const started = await request(app).post('/api/debug/capture/trace/start');
        expect(started.status).toBe(200);
        expect((await request(app).get('/api/debug/capture/status')).body.recording).toBe(true);

        const stopped = await request(app).post('/api/debug/capture/trace/stop');
        expect(stopped.status).toBe(200);
        expect(stopped.body.name).toBe(started.body.name);
        expect(stopped.body.bytes).toBe(Buffer.byteLength(TRACE));
        expect((await request(app).get('/api/debug/capture/status')).body.recording).toBe(false);
    });

    test('refuses a second recording with a conflict', async () => {
        server = await startFakeDevtools({ traceChunks: [TRACE] });
        process.env.LUKER_RENDERER_DEVTOOLS_SOCKET = server.socketPath;
        const app = adminApp;

        await request(app).post('/api/debug/capture/trace/start');
        const again = await request(app).post('/api/debug/capture/trace/start');
        expect(again.status).toBe(409);
    });

    test('refuses to stop when nothing is recording', async () => {
        const response = await request(adminApp).post('/api/debug/capture/trace/stop');
        expect(response.status).toBe(409);
    });

    test('stops reporting a recording once the renderer goes away', async () => {
        server = await startFakeDevtools({ traceChunks: [TRACE] });
        process.env.LUKER_RENDERER_DEVTOOLS_SOCKET = server.socketPath;
        const app = adminApp;

        await request(app).post('/api/debug/capture/trace/start');
        expect((await request(app).get('/api/debug/capture/status')).body.recording).toBe(true);

        await server.close();
        server = null;

        expect((await request(app).get('/api/debug/capture/status')).body.recording).toBe(false);
    });

    test('serves an artifact once and deletes it', async () => {
        mkdirSync(capture.captureDir(), { recursive: true });
        writeFileSync(capture.artifactPath('probe.json'), '{}');
        const app = adminApp;

        const first = await request(app).get('/api/debug/capture/artifact/probe.json');
        expect(first.status).toBe(200);
        expect(first.headers['content-disposition']).toContain('attachment');
        expect(first.text).toBe('{}');
        expect(existsSync(capture.artifactPath('probe.json'))).toBe(false);

        const second = await request(app).get('/api/debug/capture/artifact/probe.json');
        expect(second.status).toBe(404);
    });

    test('rejects a name that escapes the artifact directory', async () => {
        const response = await request(adminApp).get('/api/debug/capture/artifact/..%2F..%2Fconfig.yaml');
        expect(response.status).toBe(400);
    });

    test('rejects a name that resolves to the capture directory itself', async () => {
        mkdirSync(capture.captureDir(), { recursive: true });

        for (const name of ['%2e', '%2e%2e']) {
            const response = await request(adminApp).get(`/api/debug/capture/artifact/${name}`);
            // Either the containment check rejects it or the router normalises
            // it away before a handler sees it; neither may serve anything.
            expect([400, 404]).toContain(response.status);
        }

        expect(existsSync(capture.captureDir())).toBe(true);
    }, 5000);

    test('answers a directory inside the artifact directory without touching it', async () => {
        const nested = path.join(capture.captureDir(), 'subdir');
        mkdirSync(nested, { recursive: true });

        const response = await request(adminApp).get('/api/debug/capture/artifact/subdir');
        expect(response.status).toBe(404);
        expect(existsSync(nested)).toBe(true);
    }, 5000);
});
