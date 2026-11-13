import { describe, test, expect } from '@jest/globals';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connectChannel } from '../../src/renderer-capture/cdp-channel.js';
import { fetchTargets, selectPageTarget } from '../../src/renderer-capture/devtools-socket.js';
import {
    writeHeapSnapshot,
    writeTraceStart,
    writeTraceDrain,
    createStreamingTraceWriter,
    TRACE_CATEGORIES,
} from '../../src/renderer-capture/capture-session.js';
import { startFakeDevtools } from './_lib/fake-devtools-server.js';

async function openChannel(server) {
    const target = selectPageTarget(await fetchTargets(server.socketPath));
    return connectChannel(server.socketPath, target.webSocketDebuggerUrl);
}

/**
 * A real artifact file. The capture writes through the descriptor it is
 * handed, so the assertions read the bytes back off disk.
 */
function openArtifact() {
    const dir = mkdtempSync(path.join(tmpdir(), 'luker-artifact-'));
    const file = path.join(dir, 'artifact');
    const fd = openSync(file, 'w');
    return {
        fd,
        read: () => readFileSync(file, 'utf8'),
        dispose: () => {
            closeSync(fd);
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

describe('heap snapshot capture', () => {
    test('streams every heap chunk into the artifact', async () => {
        const server = await startFakeDevtools({ heapChunks: ['{"snapshot"', ':{}}'] });
        const artifact = openArtifact();
        try {
            const channel = await openChannel(server);
            const bytes = await writeHeapSnapshot({ channel, fd: artifact.fd });
            expect(artifact.read()).toBe('{"snapshot":{}}');
            expect(bytes).toBe(15);
            channel.close();
        } finally {
            artifact.dispose();
            await server.close();
        }
    });

    test('reports a failure when the renderer disappears mid-capture', async () => {
        const server = await startFakeDevtools({ heapChunks: ['{"snapshot"'], closeOnHeapStart: true });
        const artifact = openArtifact();
        try {
            const channel = await openChannel(server);
            await expect(writeHeapSnapshot({ channel, fd: artifact.fd })).rejects.toThrow();
        } finally {
            artifact.dispose();
            await server.close();
        }
    });

    test('reports a failure when the renderer answers with an error', async () => {
        const server = await startFakeDevtools({ errorOnHeapStart: true });
        const artifact = openArtifact();
        try {
            const channel = await openChannel(server);
            await expect(writeHeapSnapshot({ channel, fd: artifact.fd }))
                .rejects.toThrow('HeapProfiler.takeHeapSnapshot: boom');
        } finally {
            artifact.dispose();
            await server.close();
        }
    });

    test('reports a failure when the snapshot arrives without a single chunk', async () => {
        const server = await startFakeDevtools({ heapChunks: [] });
        const artifact = openArtifact();
        try {
            const channel = await openChannel(server);
            await expect(writeHeapSnapshot({ channel, fd: artifact.fd }))
                .rejects.toThrow('the heap snapshot arrived without any data');
        } finally {
            artifact.dispose();
            await server.close();
        }
    });
});

describe('performance trace capture', () => {
    test('asks for a ReportEvents trace and writes incremental JSON chunks as dataCollected arrives', async () => {
        const server = await startFakeDevtools({
            traceEvents: [{ name: 'trailing', ph: 'I', ts: 30 }],
        });
        const artifact = openArtifact();
        try {
            const channel = await openChannel(server);
            const writer = createStreamingTraceWriter(artifact.fd);
            await writeTraceStart({ channel, categories: TRACE_CATEGORIES, writer, discoverTargets: false });

            expect(server.connections[0].startParams).toEqual({
                categories: TRACE_CATEGORIES,
                transferMode: 'ReportEvents',
            });
            expect(server.connections[0].methods).toContain('Page.enable');

            server.emitTraceEvents([
                { name: 'first', ph: 'X', ts: 10, dur: 5 },
                { name: 'second', ph: 'X', ts: 20, dur: 5 },
            ]);
            await new Promise((resolve) => setTimeout(resolve, 20));

            expect(writer.eventCount).toBe(2);
            expect(artifact.read()).toBe('{"traceEvents":[{"name":"first","ph":"X","ts":10,"dur":5},{"name":"second","ph":"X","ts":20,"dur":5}');

            const bytes = await writeTraceDrain({ channel, writer });
            const text = artifact.read();
            expect(text.endsWith(']}\n')).toBe(true);
            expect(bytes).toBe(Buffer.byteLength(text));
            expect(JSON.parse(text)).toEqual({
                traceEvents: [
                    { name: 'first', ph: 'X', ts: 10, dur: 5 },
                    { name: 'second', ph: 'X', ts: 20, dur: 5 },
                    { name: 'trailing', ph: 'I', ts: 30 },
                ],
            });
            channel.close();
        } finally {
            artifact.dispose();
            await server.close();
        }
    });

    test('enables Target.setDiscoverTargets when attached to a browser target', async () => {
        const server = await startFakeDevtools({
            versionInfo: { webSocketDebuggerUrl: 'ws://localhost/devtools/browser/test' },
        });
        const artifact = openArtifact();
        try {
            const channel = await connectChannel(server.socketPath, 'ws://localhost/devtools/browser/test');
            const writer = createStreamingTraceWriter(artifact.fd);
            await writeTraceStart({ channel, categories: TRACE_CATEGORIES, writer, discoverTargets: true });

            expect(server.connections[0].methods).toContain('Target.setDiscoverTargets');
            expect(server.connections[0].methods).not.toContain('Page.enable');

            const bytes = await writeTraceDrain({ channel, writer });
            expect(artifact.read()).toBe('{"traceEvents":[]}\n');
            expect(bytes).toBe(Buffer.byteLength('{"traceEvents":[]}\n'));
            channel.close();
        } finally {
            artifact.dispose();
            await server.close();
        }
    });

    test('keeps every streamed trace event when unrelated notifications land before tracingComplete', async () => {
        const server = await startFakeDevtools({
            traceEvents: [{ name: 'final', ph: 'I', ts: 99 }],
        });
        const artifact = openArtifact();
        try {
            const channel = await openChannel(server);
            const writer = createStreamingTraceWriter(artifact.fd);
            await writeTraceStart({ channel, categories: TRACE_CATEGORIES, writer, discoverTargets: false });

            server.navigate();
            server.emitTraceEvents([{ name: 'mid', ph: 'B', ts: 50 }]);
            await new Promise((resolve) => setTimeout(resolve, 20));

            const bytes = await writeTraceDrain({ channel, writer });
            const parsed = JSON.parse(artifact.read());
            expect(parsed).toEqual({
                traceEvents: [
                    { name: 'mid', ph: 'B', ts: 50 },
                    { name: 'final', ph: 'I', ts: 99 },
                ],
            });
            expect(bytes).toBe(Buffer.byteLength(artifact.read()));
            channel.close();
        } finally {
            artifact.dispose();
            await server.close();
        }
    });
});
