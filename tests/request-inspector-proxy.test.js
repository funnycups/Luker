// SPDX-License-Identifier: AGPL-3.0-or-later
import { test, expect, beforeEach, afterEach } from '@jest/globals';
import http from 'node:http';
import https from 'node:https';
import {
    startInspection,
    getBufferForHandle,
    describeNetworkProxy,
} from '../src/request-inspector.js';
import initRequestProxy from '../src/request-proxy.js';

let handleSeq = 0;
let originalHttpAgent;
let originalHttpsAgent;
let originalAllProxy;
let originalNoProxy;

function makeRequest(networkProxy) {
    handleSeq++;
    return {
        user: { profile: { handle: `ri-proxy-${handleSeq}` } },
        body: {
            chat_completion_source: 'custom',
            model: 'test-model',
            messages: [{ role: 'user', content: 'hi' }],
            ...(networkProxy ? { network_proxy: networkProxy } : {}),
        },
    };
}

function enableGlobalProxy(url) {
    initRequestProxy({
        enabled: true,
        url,
        bypass: ['example.invalid'],
        enableKeepAlive: false,
        privateRequestFilterEnabled: false,
    });
}

function disableGlobalProxy() {
    initRequestProxy({
        enabled: false,
        url: '',
        bypass: [],
        enableKeepAlive: false,
        privateRequestFilterEnabled: false,
    });
}

function restoreEnv(key, value) {
    if (value === undefined) {
        delete process.env[key];
    } else {
        process.env[key] = value;
    }
}

beforeEach(() => {
    originalHttpAgent = http.globalAgent;
    originalHttpsAgent = https.globalAgent;
    originalAllProxy = process.env.all_proxy;
    originalNoProxy = process.env.no_proxy;
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
    disableGlobalProxy();
});

test('describeNetworkProxy reports the profile proxy and strips credentials', () => {
    enableGlobalProxy('http://127.0.0.1:3128');
    const req = makeRequest('http://proxy-user:proxy-secret@127.0.0.1:7890');

    expect(describeNetworkProxy(req)).toEqual({
        scope: 'profile',
        url: 'http://127.0.0.1:7890',
    });
});

test('describeNetworkProxy reports the global proxy when the profile has none', () => {
    enableGlobalProxy('http://global-user:global-secret@127.0.0.1:3128');

    expect(describeNetworkProxy(makeRequest())).toEqual({
        scope: 'global',
        url: 'http://127.0.0.1:3128',
    });
});

test('describeNetworkProxy reports a direct connection when no proxy is configured', () => {
    disableGlobalProxy();

    expect(describeNetworkProxy(makeRequest())).toEqual({ scope: 'direct', url: '' });
});

test('startInspection stores the proxy description without credentials', () => {
    enableGlobalProxy('http://global-user:global-secret@127.0.0.1:3128');
    const req = makeRequest('socks5://proxy-user:proxy-secret@127.0.0.1:1080');

    startInspection(req);
    const entry = getBufferForHandle(req.user.profile.handle).find(e => e.id === req.__inspectorId);

    expect(entry.networkProxy).toEqual({ scope: 'profile', url: 'socks5://127.0.0.1:1080' });
    expect(JSON.stringify(entry)).not.toContain('proxy-secret');
    expect(JSON.stringify(entry)).not.toContain('global-secret');
});
