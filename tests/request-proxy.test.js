// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, test, expect, jest } from '@jest/globals';
import { ProxyAgent } from 'proxy-agent';
import { createRequestProxyAgent, createProxyBoundFetch } from '../src/request-proxy.js';

describe('createRequestProxyAgent', () => {
    test('returns undefined for empty or whitespace-only URLs', () => {
        expect(createRequestProxyAgent('')).toBeUndefined();
        expect(createRequestProxyAgent('   ')).toBeUndefined();
        expect(createRequestProxyAgent(undefined)).toBeUndefined();
    });

    test('rejects malformed URLs', () => {
        expect(() => createRequestProxyAgent('not a url')).toThrow(/Invalid proxy URL/);
    });

    test('rejects unsupported proxy protocols', () => {
        expect(() => createRequestProxyAgent('ftp://127.0.0.1:21')).toThrow(/Unsupported proxy protocol/);
    });

    test('creates a ProxyAgent and reuses it for the same URL', () => {
        const url = 'http://127.0.0.1:18080';
        const first = createRequestProxyAgent(url);
        const second = createRequestProxyAgent(url);

        expect(first).toBeInstanceOf(ProxyAgent);
        expect(second).toBe(first);
    });
});

describe('createProxyBoundFetch', () => {
    test('returns the original fetch when no agent is configured', () => {
        const fetchImpl = jest.fn();
        expect(createProxyBoundFetch(fetchImpl, undefined)).toBe(fetchImpl);
    });

    test('passes the configured agent on every request', async () => {
        const fetchImpl = jest.fn(async () => ({ ok: true }));
        const agent = createRequestProxyAgent('http://127.0.0.1:18081');
        const boundFetch = createProxyBoundFetch(fetchImpl, agent);

        await boundFetch('https://example.com/v1/models', { method: 'GET', headers: { authorization: 'Bearer test' } });

        expect(fetchImpl).toHaveBeenCalledWith('https://example.com/v1/models', {
            method: 'GET',
            headers: { authorization: 'Bearer test' },
            agent,
        });
    });
});
