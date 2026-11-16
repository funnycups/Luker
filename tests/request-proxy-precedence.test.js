// SPDX-License-Identifier: AGPL-3.0-or-later
import { test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import http from 'node:http';
import https from 'node:https';
import { createDispatchContext } from '../src/luker-dispatch/context.js';
import initRequestProxy from '../src/request-proxy.js';
import { startRecordingProxy } from './e2e/_lib/recording-proxy.js';

/** @type {http.Server} */
let targetServer;
let targetUrl;
let profileProxy;

let originalHttpAgent;
let originalHttpsAgent;
let originalAllProxy;
let originalNoProxy;

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

function contextFor(handle, networkProxy) {
    const abortController = new AbortController();
    return createDispatchContext({
        request: {
            body: { model: 'test-model', network_proxy: networkProxy },
            user: { profile: { handle }, directories: {} },
            headers: {},
        },
        task: { id: `${handle}-job`, owner: handle, abortController },
        abortController,
        onEmit: () => {},
    });
}

function restoreEnv(key, value) {
    if (value === undefined) {
        delete process.env[key];
    } else {
        process.env[key] = value;
    }
}

beforeAll(async () => {
    targetServer = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('target-ok');
    });
    const targetPort = await listen(targetServer);
    targetUrl = `http://127.0.0.1:${targetPort}/v1/models`;

    profileProxy = await startRecordingProxy();
});

afterAll(async () => {
    await profileProxy.stop();
    await close(targetServer);
});

beforeEach(() => {
    originalHttpAgent = http.globalAgent;
    originalHttpsAgent = https.globalAgent;
    originalAllProxy = process.env.all_proxy;
    originalNoProxy = process.env.no_proxy;
    profileProxy.requests.length = 0;

    // Point the global proxy at a dead endpoint. Override the ambient
    // loopback no_proxy so a fallback to the global proxy cannot silently
    // succeed by going direct.
    initRequestProxy({
        enabled: true,
        url: 'http://127.0.0.1:1',
        bypass: ['example.invalid'],
        enableKeepAlive: false,
        privateRequestFilterEnabled: false,
    });
});

afterEach(() => {
    const activeHttpAgent = http.globalAgent;
    const activeHttpsAgent = https.globalAgent;
    try { activeHttpAgent?.destroy?.(); } catch { /* ignore */ }
    if (activeHttpsAgent !== activeHttpAgent) {
        try { activeHttpsAgent?.destroy?.(); } catch { /* ignore */ }
    }
    http.globalAgent = originalHttpAgent;
    https.globalAgent = originalHttpsAgent;
    restoreEnv('all_proxy', originalAllProxy);
    restoreEnv('no_proxy', originalNoProxy);
});

test('a profile proxy overrides the configured global proxy', async () => {
    const ctx = contextFor('profile-proxy-test', profileProxy.baseURL);
    const response = await ctx.fetch(targetUrl);

    expect(await response.text()).toBe('target-ok');
    expect(profileProxy.requests).toHaveLength(1);
});
