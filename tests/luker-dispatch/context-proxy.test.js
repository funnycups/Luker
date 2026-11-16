// SPDX-License-Identifier: AGPL-3.0-or-later
import { test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import http from 'node:http';
import { createDispatchContext } from '../../src/luker-dispatch/context.js';

/** @type {http.Server} */
let targetServer;
/** @type {http.Server} */
let proxyServer;
/** @type {string[]} */
let proxyHits = [];

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

let targetUrl;
let proxyUrl;

beforeAll(async () => {
    targetServer = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('proxied-ok');
    });
    const targetPort = await listen(targetServer);
    targetUrl = `http://127.0.0.1:${targetPort}/v1/models`;

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
});

beforeEach(() => {
    proxyHits = [];
});

afterAll(async () => {
    await close(proxyServer);
    await close(targetServer);
});

test('createDispatchContext routes ctx.fetch through the profile network proxy', async () => {
    const handle = 'proxy-context-test';
    const abortController = new AbortController();
    const request = {
        body: { model: 'test-model', network_proxy: proxyUrl },
        user: { profile: { handle }, directories: {} },
        headers: {},
    };

    const ctx = createDispatchContext({
        request,
        task: { id: 'proxy-context-job', owner: handle, abortController },
        abortController,
        onEmit: () => {},
    });

    const response = await ctx.fetch(targetUrl);
    expect(await response.text()).toBe('proxied-ok');
    expect(proxyHits).toHaveLength(1);
    expect(proxyHits[0]).toContain(targetUrl);
});
