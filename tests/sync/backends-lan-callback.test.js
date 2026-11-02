import { describe, test, expect } from '@jest/globals';
import { pickCallbackBaseUrl, selfCallback } from '../../src/sync/backends/lan/callback.js';

describe('callback address', () => {
    test('a listed URL whose host is the remote address wins', () => {
        expect(pickCallbackBaseUrl({ callback: { scheme: 'http', port: 8000, baseUrls: ['http://127.0.0.1:8000', 'http://192.168.1.5:8000/'] }, remoteAddress: '::ffff:192.168.1.5' }))
            .toBe('http://192.168.1.5:8000');
    });
    test('without a listed match the URL is built from the remote address', () => {
        expect(pickCallbackBaseUrl({ callback: { scheme: 'https', port: 8443, baseUrls: ['http://10.9.9.9:1'] }, remoteAddress: '192.168.1.7' })).toBe('https://192.168.1.7:8443');
        expect(pickCallbackBaseUrl({ callback: { scheme: 'http', port: 8000, baseUrls: [] }, remoteAddress: 'fe80::1' })).toBe('http://[fe80::1]:8000');
    });
    test('a callback can never point at a host other than the caller', () => {
        const picked = pickCallbackBaseUrl({ callback: { scheme: 'http', port: 80, baseUrls: ['http://evil.example', 'javascript:alert(1)'] }, remoteAddress: '10.0.0.2' });
        expect(new URL(picked).hostname).toBe('10.0.0.2');
    });
    test('a malformed callback yields nothing', () => {
        for (const callback of [null, 'x', { scheme: 'ftp', port: 21 }, { scheme: 'http', port: 0 }, { scheme: 'http', port: 70000 }]) {
            expect(pickCallbackBaseUrl({ callback, remoteAddress: '10.0.0.2' })).toBeNull();
        }
        expect(pickCallbackBaseUrl({ callback: { scheme: 'http', port: 8000 }, remoteAddress: '' })).toBeNull();
    });
    test('selfCallback uses the listen port and scheme', () => {
        expect(selfCallback({ port: 8000, ssl: false, listen: false })).toEqual({ scheme: 'http', port: 8000, baseUrls: ['http://127.0.0.1:8000'] });
        expect(selfCallback({ port: 8443, ssl: true, listen: false }).scheme).toBe('https');
        expect(selfCallback({})).toBeNull();
    });
});
