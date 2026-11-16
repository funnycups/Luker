// SPDX-License-Identifier: AGPL-3.0-or-later
import { test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { router as chatCompletionsRouter } from '../../src/endpoints/backends/chat-completions.js';

/** @type {http.Server} */
let targetServer;
/** @type {http.Server} */
let proxyServer;
/** @type {string[]} */
let proxyHits = [];
let targetUrl;
let proxyUrl;
let userRoot;

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve(server.address().port);
        });
    });
}

function close(server) {
    return new Promise(resolve => server.close(resolve));
}

beforeAll(async () => {
    targetServer = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
    });
    const targetPort = await listen(targetServer);
    targetUrl = `http://127.0.0.1:${targetPort}/v1`;

    proxyServer = http.createServer((req, res) => {
        proxyHits.push(String(req.url));
        const destination = new URL(String(req.url));
        const upstream = http.request({
            hostname: destination.hostname,
            port: destination.port,
            path: `${destination.pathname}${destination.search}`,
            method: req.method,
            headers: req.headers,
        }, upstreamResponse => {
            res.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
            upstreamResponse.pipe(res);
        });
        upstream.on('error', () => {
            res.writeHead(502);
            res.end();
        });
        req.pipe(upstream);
    });
    const proxyPort = await listen(proxyServer);
    proxyUrl = `http://127.0.0.1:${proxyPort}`;

    userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-status-proxy-'));
});

beforeEach(() => {
    proxyHits = [];
});

afterAll(async () => {
    await close(proxyServer);
    await close(targetServer);
    fs.rmSync(userRoot, { recursive: true, force: true });
});

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = {
            profile: { handle: 'status-proxy-test' },
            directories: { root: userRoot },
        };
        next();
    });
    app.use('/api/backends/chat-completions', chatCompletionsRouter);
    return app;
}

test('POST /status rejects an unsupported network_proxy protocol', async () => {
    const response = await request(makeApp())
        .post('/api/backends/chat-completions/status')
        .send({
            chat_completion_source: 'custom',
            custom_url: targetUrl,
            network_proxy: 'ftp://127.0.0.1:21',
        });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/Unsupported proxy protocol/);
    expect(proxyHits).toHaveLength(0);
});

test('POST /status sends the model-list request through network_proxy', async () => {
    const response = await request(makeApp())
        .post('/api/backends/chat-completions/status')
        .send({
            chat_completion_source: 'custom',
            custom_url: targetUrl,
            network_proxy: proxyUrl,
        });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{ id: 'mock-model' }]);
    expect(proxyHits).toHaveLength(1);
    expect(proxyHits[0]).toContain(`${targetUrl}/models`);
});
