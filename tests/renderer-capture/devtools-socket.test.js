import { describe, test, expect } from '@jest/globals';
import {
    abstractSocketPath,
    resolveSocketPath,
    fetchTargets,
    fetchVersionInfo,
    selectPageTarget,
    selectBrowserWsUrl,
} from '../../src/renderer-capture/devtools-socket.js';
import { startFakeDevtools } from './_lib/fake-devtools-server.js';

describe('devtools socket discovery', () => {
    test('builds the abstract socket name from the host pid', () => {
        expect(abstractSocketPath(4321)).toBe('\0webview_devtools_remote_4321');
    });

    test('prefers the explicit socket override', () => {
        expect(resolveSocketPath({ LUKER_RENDERER_DEVTOOLS_SOCKET: '/tmp/x.sock', LUKER_HOST_PID: '1' }))
            .toBe('/tmp/x.sock');
    });

    test('names the socket after the host pid when no override is set', () => {
        expect(resolveSocketPath({ LUKER_HOST_PID: '99' })).toBe('\0webview_devtools_remote_99');
    });

    test('refuses to guess a socket path without the host pid', () => {
        expect(() => resolveSocketPath({})).toThrow('LUKER_HOST_PID is not set');
    });

    test('reads the target list off the devtools socket', async () => {
        const server = await startFakeDevtools();
        try {
            const targets = await fetchTargets(server.socketPath);
            expect(targets).toHaveLength(1);
            expect(selectPageTarget(targets).url).toBe('http://127.0.0.1:8000/');
        } finally {
            await server.close();
        }
    });

    test('ignores targets that are not the local page', async () => {
        const server = await startFakeDevtools({
            targets: [
                { type: 'worker', url: 'http://127.0.0.1:8000/' },
                { type: 'page', url: 'https://example.com/' },
            ],
        });
        try {
            expect(selectPageTarget(await fetchTargets(server.socketPath))).toBeNull();
        } finally {
            await server.close();
        }
    });

    test('fails when nothing is listening on the socket', async () => {
        await expect(fetchTargets('/tmp/luker-no-such-devtools.sock')).rejects.toThrow();
    });

    test('reads the target list without waiting for the connection to close', async () => {
        const server = await startFakeDevtools({ holdConnectionOpen: true });
        try {
            const targets = await fetchTargets(server.socketPath);
            expect(targets).toHaveLength(1);
        } finally {
            await server.close();
        }
    }, 5000);

    test('reads /json/version and extracts the browser websocket URL', async () => {
        const server = await startFakeDevtools({
            versionInfo: {
                Browser: 'ArkWeb/7.0',
                webSocketDebuggerUrl: 'ws://localhost/devtools/browser/test',
            },
        });
        try {
            const versionInfo = await fetchVersionInfo(server.socketPath);
            expect(versionInfo.Browser).toBe('ArkWeb/7.0');
            expect(selectBrowserWsUrl(versionInfo)).toBe('ws://localhost/devtools/browser/test');
        } finally {
            await server.close();
        }
    });

    test('returns null when /json/version has no browser websocket URL', () => {
        expect(selectBrowserWsUrl({ Browser: 'ArkWeb/7.0' })).toBeNull();
        expect(selectBrowserWsUrl(null)).toBeNull();
        expect(selectBrowserWsUrl({})).toBeNull();
    });
});
