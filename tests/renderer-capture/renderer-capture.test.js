import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startFakeDevtools } from './_lib/fake-devtools-server.js';

const HEAP = '{"snapshot":{}}';
const TRACE = '{"traceEvents":[]}\n';

let dataRoot;
let server;
let capture;

async function loadCapture() {
    jest.resetModules();
    return import('../../src/renderer-capture/index.js');
}

beforeEach(async () => {
    dataRoot = mkdtempSync(path.join(tmpdir(), 'luker-data-'));
    globalThis.DATA_ROOT = dataRoot;
    capture = await loadCapture();
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

describe('renderer capture entry points', () => {
    test('probes availability when no devtools socket is listening', async () => {
        const missing = path.join(tmpdir(), 'luker-absent-devtools.sock');
        await expect(capture.probeCapture({ socketPath: missing }))
            .resolves.toEqual({ available: false, reason: expect.any(String) });
    });

    test('probes availability against a live devtools socket', async () => {
        server = await startFakeDevtools();
        await expect(capture.probeCapture({ socketPath: server.socketPath }))
            .resolves.toEqual({ available: true, reason: null });
    });

    test('captures a heap snapshot into the data root', async () => {
        server = await startFakeDevtools({ heapChunks: ['{"snapshot":', '{}}'] });
        process.env.LUKER_RENDERER_DEVTOOLS_SOCKET = server.socketPath;

        const result = await capture.captureHeapSnapshot();

        expect(result.name).toMatch(/^luker-heap-\d{8}-\d{6}-\d{3}\.heapsnapshot$/);
        expect(result.bytes).toBe(Buffer.byteLength(HEAP));
        expect(readFileSync(capture.artifactPath(result.name), 'utf8')).toBe(HEAP);
    });

    test('drops the artifact when the heap capture fails', async () => {
        server = await startFakeDevtools({ errorOnHeapStart: true });
        process.env.LUKER_RENDERER_DEVTOOLS_SOCKET = server.socketPath;

        await expect(capture.captureHeapSnapshot()).rejects.toThrow('boom');
        expect(readdirSync(capture.captureDir())).toEqual([]);
    });

    test('reports a failure when the artifact file cannot be created', async () => {
        server = await startFakeDevtools({ heapChunks: [HEAP] });
        process.env.LUKER_RENDERER_DEVTOOLS_SOCKET = server.socketPath;

        mkdirSync(capture.captureDir(), { recursive: true });
        chmodSync(capture.captureDir(), 0o500);

        try {
            await expect(capture.captureHeapSnapshot()).rejects.toThrow(/EACCES|permission denied/);
        } finally {
            chmodSync(capture.captureDir(), 0o700);
        }

        expect(readdirSync(capture.captureDir())).toEqual([]);
    });

    test('records a trace across start and stop', async () => {
        server = await startFakeDevtools({
            traceEvents: [{ name: 'paint', ph: 'X', ts: 100, dur: 25 }],
        });
        process.env.LUKER_RENDERER_DEVTOOLS_SOCKET = server.socketPath;

        expect(capture.isTraceRecording()).toBe(false);
        const started = await capture.startTrace();
        expect(capture.isTraceRecording()).toBe(true);

        server.emitTraceEvents([{ name: 'layout', ph: 'X', ts: 50, dur: 10 }]);
        await new Promise((resolve) => setTimeout(resolve, 20));

        const stopped = await capture.stopTrace();
        expect(stopped.name).toBe(started.name);
        const content = readFileSync(capture.artifactPath(stopped.name), 'utf8');
        expect(stopped.bytes).toBe(Buffer.byteLength(content));
        expect(JSON.parse(content)).toEqual({
            traceEvents: [
                { name: 'layout', ph: 'X', ts: 50, dur: 10 },
                { name: 'paint', ph: 'X', ts: 100, dur: 25 },
            ],
        });
        expect(capture.isTraceRecording()).toBe(false);
    });

    test('prefers the browser target when /json/version exposes webSocketDebuggerUrl', async () => {
        server = await startFakeDevtools({
            versionInfo: { webSocketDebuggerUrl: 'ws://localhost/devtools/browser/test' },
        });
        process.env.LUKER_RENDERER_DEVTOOLS_SOCKET = server.socketPath;

        await capture.startTrace();
        expect(server.connections).toHaveLength(1);
        expect(server.connections[0].url).toBe('/devtools/browser/test');
        expect(server.connections[0].methods).toContain('Target.setDiscoverTargets');
        capture.abortTrace();
    });

    test('falls back to the page target when browser Tracing.start fails', async () => {
        server = await startFakeDevtools({
            versionInfo: { webSocketDebuggerUrl: 'ws://localhost/devtools/browser/test' },
            rejectBrowserTracing: true,
        });
        process.env.LUKER_RENDERER_DEVTOOLS_SOCKET = server.socketPath;

        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            await capture.startTrace();
            expect(server.connections).toHaveLength(2);
            expect(server.connections[0].url).toBe('/devtools/browser/test');
            expect(server.connections[1].url).toBe('/devtools/page/test');
            expect(server.connections[1].methods).toContain('Page.enable');
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('targetMode=page'));
            capture.abortTrace();
        } finally {
            warnSpy.mockRestore();
        }
    });

    test('falls back to the page target when browser websocket closes before Tracing.start replies', async () => {
        server = await startFakeDevtools({
            versionInfo: { webSocketDebuggerUrl: 'ws://localhost/devtools/browser/test' },
            closeBrowserOnStart: true,
            traceEvents: [{ name: 'fallback-event', ph: 'I', ts: 42 }],
        });
        process.env.LUKER_RENDERER_DEVTOOLS_SOCKET = server.socketPath;

        const started = await capture.startTrace();
        expect(server.connections).toHaveLength(2);
        expect(server.connections[1].url).toBe('/devtools/page/test');
        expect(capture.isTraceRecording()).toBe(true);

        const stopped = await capture.stopTrace();
        expect(stopped.name).toBe(started.name);
        expect(JSON.parse(readFileSync(capture.artifactPath(stopped.name), 'utf8'))).toEqual({
            traceEvents: [{ name: 'fallback-event', ph: 'I', ts: 42 }],
        });
    });

    test('auto-finalizes on browser target when Target.targetInfoChanged changes URL for the tracked page', async () => {
        server = await startFakeDevtools({
            versionInfo: { webSocketDebuggerUrl: 'ws://localhost/devtools/browser/test' },
            traceEvents: [{ name: 'after-url-change', ph: 'I', ts: 25 }],
        });
        process.env.LUKER_RENDERER_DEVTOOLS_SOCKET = server.socketPath;

        const started = await capture.startTrace();
        server.emitTraceEvents([{ name: 'before-url-change', ph: 'X', ts: 10, dur: 5 }]);
        await new Promise((resolve) => setTimeout(resolve, 20));

        // Same URL or unrelated targetId must not stop recording
        server.changeTargetInfo('page-1', 'http://127.0.0.1:8000/');
        server.changeTargetInfo('unrelated', 'http://127.0.0.1:8000/other');
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(capture.isTraceRecording()).toBe(true);

        server.changeTargetInfo('page-1', 'http://127.0.0.1:8000/reloaded');
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(capture.isTraceRecording()).toBe(false);
        const saved = readFileSync(capture.artifactPath(started.name), 'utf8');
        expect(JSON.parse(saved)).toEqual({
            traceEvents: [
                { name: 'before-url-change', ph: 'X', ts: 10, dur: 5 },
                { name: 'after-url-change', ph: 'I', ts: 25 },
            ],
        });
    });

    test('logs targetMode=browser when browser tracing succeeds', async () => {
        server = await startFakeDevtools({
            versionInfo: { webSocketDebuggerUrl: 'ws://localhost/devtools/browser/test' },
        });
        process.env.LUKER_RENDERER_DEVTOOLS_SOCKET = server.socketPath;

        const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
        try {
            await capture.startTrace();
            expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('targetMode=browser'));
            capture.abortTrace();
        } finally {
            infoSpy.mockRestore();
        }
    });

    test('refuses a second recording', async () => {
        server = await startFakeDevtools();
        process.env.LUKER_RENDERER_DEVTOOLS_SOCKET = server.socketPath;

        await capture.startTrace();
        await expect(capture.startTrace()).rejects.toThrow('a recording is already running');
        capture.abortTrace();
    });

    test('refuses to stop when nothing is recording', async () => {
        await expect(capture.stopTrace()).rejects.toThrow('no recording is running');
    });

    test('aborts a recording and drops the empty artifact', async () => {
        server = await startFakeDevtools();
        process.env.LUKER_RENDERER_DEVTOOLS_SOCKET = server.socketPath;

        const started = await capture.startTrace();
        expect(capture.abortTrace()).toBe(true);
        expect(capture.isTraceRecording()).toBe(false);
        expect(existsSync(capture.artifactPath(started.name))).toBe(false);
        expect(capture.abortTrace()).toBe(false);
    });

    test('removes an artifact on request', async () => {
        server = await startFakeDevtools({ heapChunks: [HEAP] });
        process.env.LUKER_RENDERER_DEVTOOLS_SOCKET = server.socketPath;

        const result = await capture.captureHeapSnapshot();
        expect(existsSync(capture.artifactPath(result.name))).toBe(true);
        capture.removeArtifact(result.name);
        expect(existsSync(capture.artifactPath(result.name))).toBe(false);
    });

    test('auto-finalizes and preserves a valid trace when Target.targetCrashed fires for the tracked page', async () => {
        server = await startFakeDevtools({
            versionInfo: { webSocketDebuggerUrl: 'ws://localhost/devtools/browser/test' },
            traceEvents: [{ name: 'flushed-on-crash', ph: 'I', ts: 200 }],
        });
        process.env.LUKER_RENDERER_DEVTOOLS_SOCKET = server.socketPath;

        const started = await capture.startTrace();
        server.emitTraceEvents([{ name: 'before-crash', ph: 'X', ts: 100, dur: 40 }]);
        await new Promise((resolve) => setTimeout(resolve, 20));

        // Unrelated target crash must not interrupt recording
        server.crashTarget('unrelated-target');
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(capture.isTraceRecording()).toBe(true);

        server.crashTarget('page-1');
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(capture.isTraceRecording()).toBe(false);
        expect(server.connections[0].methods).toContain('Tracing.end');
        const saved = readFileSync(capture.artifactPath(started.name), 'utf8');
        expect(JSON.parse(saved)).toEqual({
            traceEvents: [
                { name: 'before-crash', ph: 'X', ts: 100, dur: 40 },
                { name: 'flushed-on-crash', ph: 'I', ts: 200 },
            ],
        });
    });

    test('auto-finalizes and preserves a valid trace when Target.targetDestroyed fires for the tracked page', async () => {
        server = await startFakeDevtools({
            versionInfo: { webSocketDebuggerUrl: 'ws://localhost/devtools/browser/test' },
            traceEvents: [{ name: 'after-destroy', ph: 'I', ts: 300 }],
        });
        process.env.LUKER_RENDERER_DEVTOOLS_SOCKET = server.socketPath;

        const started = await capture.startTrace();
        server.destroyTarget('page-1');
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(capture.isTraceRecording()).toBe(false);
        const saved = readFileSync(capture.artifactPath(started.name), 'utf8');
        expect(JSON.parse(saved)).toEqual({
            traceEvents: [{ name: 'after-destroy', ph: 'I', ts: 300 }],
        });
    });

    test('finalizes and preserves a sealed trace when the page navigates', async () => {
        server = await startFakeDevtools({
            traceEvents: [{ name: 'after-nav', ph: 'I', ts: 20 }],
        });
        process.env.LUKER_RENDERER_DEVTOOLS_SOCKET = server.socketPath;

        const started = await capture.startTrace();
        server.emitTraceEvents([{ name: 'before-nav', ph: 'X', ts: 10, dur: 5 }]);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(capture.isTraceRecording()).toBe(true);

        server.navigate();
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(capture.isTraceRecording()).toBe(false);
        const saved = readFileSync(capture.artifactPath(started.name), 'utf8');
        expect(saved.endsWith(']}\n')).toBe(true);
        expect(JSON.parse(saved)).toEqual({
            traceEvents: [
                { name: 'before-nav', ph: 'X', ts: 10, dur: 5 },
                { name: 'after-nav', ph: 'I', ts: 20 },
            ],
        });
    });

    test('seals and preserves the partial trace on disk when the WebSocket closes unexpectedly', async () => {
        server = await startFakeDevtools();
        process.env.LUKER_RENDERER_DEVTOOLS_SOCKET = server.socketPath;

        const started = await capture.startTrace();
        server.emitTraceEvents([{ name: 'partial-event', ph: 'X', ts: 15, dur: 3 }]);
        await new Promise((resolve) => setTimeout(resolve, 20));

        server.closeWs();
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(capture.isTraceRecording()).toBe(false);
        const saved = readFileSync(capture.artifactPath(started.name), 'utf8');
        expect(saved.endsWith(']}\n')).toBe(true);
        expect(JSON.parse(saved)).toEqual({
            traceEvents: [{ name: 'partial-event', ph: 'X', ts: 15, dur: 3 }],
        });
    });

    test('makes concurrent stopTrace calls safe and idempotent', async () => {
        server = await startFakeDevtools({
            traceEvents: [{ name: 'one', ph: 'I', ts: 1 }],
        });
        process.env.LUKER_RENDERER_DEVTOOLS_SOCKET = server.socketPath;

        const started = await capture.startTrace();
        const [first, second] = await Promise.all([capture.stopTrace(), capture.stopTrace()]);
        expect(first).toEqual(second);
        expect(first.name).toBe(started.name);
        expect(capture.isTraceRecording()).toBe(false);
    });

    test('prunes older trace files beyond the 2 newest when starting a new trace', async () => {
        server = await startFakeDevtools();
        process.env.LUKER_RENDERER_DEVTOOLS_SOCKET = server.socketPath;

        mkdirSync(capture.captureDir(), { recursive: true });
        writeFileSync(capture.artifactPath('luker-trace-20261113-000001-000.json'), TRACE);
        writeFileSync(capture.artifactPath('luker-trace-20261113-000002-000.json'), TRACE);
        writeFileSync(capture.artifactPath('luker-trace-20261113-000003-000.json'), TRACE);

        const started = await capture.startTrace();
        const files = readdirSync(capture.captureDir()).sort();
        expect(files).toEqual([
            'luker-trace-20261113-000002-000.json',
            'luker-trace-20261113-000003-000.json',
            started.name,
        ]);
        capture.abortTrace();
    });

    test('refuses a second recording while one is starting', async () => {
        server = await startFakeDevtools({ traceChunks: [TRACE] });
        process.env.LUKER_RENDERER_DEVTOOLS_SOCKET = server.socketPath;

        const results = await Promise.allSettled([capture.startTrace(), capture.startTrace()]);

        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    });

    test('refuses a second heap capture while one is running', async () => {
        server = await startFakeDevtools({ heapChunks: [HEAP] });
        process.env.LUKER_RENDERER_DEVTOOLS_SOCKET = server.socketPath;

        const results = await Promise.allSettled([
            capture.captureHeapSnapshot(),
            capture.captureHeapSnapshot(),
        ]);

        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    });
});
