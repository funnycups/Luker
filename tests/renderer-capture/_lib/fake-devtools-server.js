/**
 * A real devtools endpoint for tests.
 *
 * It is an HTTP server on a unix socket that answers `/json/list` and upgrades
 * to a WebSocket speaking the subset of CDP the capture path uses. Nothing
 * here stands in for code under test: the tests connect to it over a real
 * socket exactly the way the app connects to the embedded webview's devtools
 * server.
 */
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const DEFAULT_TARGETS = [
    {
        id: 'page-1',
        type: 'page',
        url: 'http://127.0.0.1:8000/',
        webSocketDebuggerUrl: 'ws://localhost/devtools/page/test',
    },
];

function handleCdp(ws, requestUrl, state) {
    const {
        heapChunks,
        traceChunks,
        traceEvents,
        closeOnHeapStart,
        errorOnHeapStart,
        notifyDuringTraceDrain,
        rejectBrowserTracing,
        closeBrowserOnStart,
        connections,
    } = state;
    const connRecord = { url: requestUrl, methods: [], startParams: null };
    connections.push(connRecord);
    let traceIndex = 0;

    ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        connRecord.methods.push(message.method);
        const reply = (result) => ws.send(JSON.stringify({ id: message.id, result }));

        switch (message.method) {
            case 'HeapProfiler.enable':
                reply({});
                break;
            case 'HeapProfiler.takeHeapSnapshot': {
                if (errorOnHeapStart) {
                    ws.send(JSON.stringify({ id: message.id, error: { code: -32000, message: 'boom' } }));
                    return;
                }
                const [first, ...rest] = heapChunks;
                if (first !== undefined) {
                    ws.send(JSON.stringify({ method: 'HeapProfiler.addHeapSnapshotChunk', params: { chunk: first } }));
                }
                if (closeOnHeapStart) {
                    ws.close();
                    return;
                }
                for (const chunk of rest) {
                    ws.send(JSON.stringify({ method: 'HeapProfiler.addHeapSnapshotChunk', params: { chunk } }));
                }
                reply({});
                break;
            }
            case 'Tracing.start':
                connRecord.startParams = message.params ?? null;
                if (closeBrowserOnStart && requestUrl.includes('/devtools/browser/')) {
                    ws.terminate();
                    return;
                }
                if (rejectBrowserTracing && requestUrl.includes('/devtools/browser/')) {
                    ws.send(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Tracing not supported on browser target' } }));
                    return;
                }
                reply({});
                break;
            case 'Target.setDiscoverTargets':
            case 'Page.enable':
            case 'IO.close':
                reply({});
                break;
            case 'Tracing.end':
                reply({});
                if (traceEvents.length > 0) {
                    ws.send(JSON.stringify({ method: 'Tracing.dataCollected', params: { value: traceEvents } }));
                }
                ws.send(JSON.stringify({ method: 'Tracing.tracingComplete', params: { stream: '1', dataLossOccurred: false } }));
                break;
            case 'IO.read': {
                const data = traceChunks[traceIndex] ?? '';
                traceIndex += 1;
                reply({ data, eof: traceIndex >= traceChunks.length });
                if (notifyDuringTraceDrain) {
                    ws.send(JSON.stringify({ method: 'Page.loadEventFired', params: { timestamp: traceIndex } }));
                }
                break;
            }
            default:
                reply({});
        }
    });
}

/**
 * @param {{ targets?: object[], versionInfo?: object|null, heapChunks?: string[], traceChunks?: string[], traceEvents?: object[], closeOnHeapStart?: boolean, errorOnHeapStart?: boolean, holdConnectionOpen?: boolean, notifyDuringTraceDrain?: boolean, rejectBrowserTracing?: boolean, closeBrowserOnStart?: boolean }} [options]
 * @returns {Promise<{ socketPath: string, connections: Array<{ url: string, methods: string[], startParams: object|null }>, navigate: () => void, emitTraceEvents: (events: object[]) => void, crashTarget: (targetId?: string) => void, destroyTarget: (targetId?: string) => void, changeTargetInfo: (targetId?: string, url?: string) => void, closeWs: () => void, close: () => Promise<void> }>}
 */
export async function startFakeDevtools(options = {}) {
    const {
        targets = DEFAULT_TARGETS,
        versionInfo = {},
        heapChunks = [],
        traceChunks = [],
        traceEvents = [],
        closeOnHeapStart = false,
        errorOnHeapStart = false,
        holdConnectionOpen = false,
        notifyDuringTraceDrain = false,
        rejectBrowserTracing = false,
        closeBrowserOnStart = false,
    } = options;

    const dir = mkdtempSync(path.join(tmpdir(), 'luker-devtools-'));
    const socketPath = path.join(dir, 'devtools.sock');
    const wss = new WebSocketServer({ noServer: true });
    const sockets = new Set();
    const connections = [];

    const sendJsonResponse = (response, payload) => {
        const body = JSON.stringify(payload);
        response.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
        });
        // The embedded devtools server answers with a complete response and
        // then keeps the connection open, so a client that waits for the
        // socket to end never hears back.
        if (holdConnectionOpen) {
            response.write(body);
            return;
        }
        response.end(body);
    };

    const server = createServer((request, response) => {
        if (request.url === '/json/list') {
            sendJsonResponse(response, targets);
            return;
        }
        if (request.url === '/json/version' && versionInfo !== null) {
            sendJsonResponse(response, versionInfo);
            return;
        }
        response.writeHead(404);
        response.end();
    });

    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });

    server.on('upgrade', (request, socket, head) => {
        wss.handleUpgrade(request, socket, head, (ws) => handleCdp(ws, request.url || '', {
            heapChunks,
            traceChunks,
            traceEvents,
            closeOnHeapStart,
            errorOnHeapStart,
            notifyDuringTraceDrain,
            rejectBrowserTracing,
            closeBrowserOnStart,
            connections,
        }));
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
    });

    const broadcast = (message) => {
        const raw = JSON.stringify(message);
        for (const client of wss.clients) {
            client.send(raw);
        }
    };

    return {
        socketPath,
        connections,
        /**
         * Announce a page navigation the way the embedded devtools server does.
         */
        navigate() {
            broadcast({
                method: 'Page.frameNavigated',
                params: { frame: { id: 'test', url: 'http://127.0.0.1:8000/next' } },
            });
        },
        emitTraceEvents(events) {
            broadcast({
                method: 'Tracing.dataCollected',
                params: { value: events },
            });
        },
        crashTarget(targetId = 'page-1') {
            broadcast({
                method: 'Target.targetCrashed',
                params: { targetId, status: 'crashed', errorCode: 9 },
            });
        },
        destroyTarget(targetId = 'page-1') {
            broadcast({
                method: 'Target.targetDestroyed',
                params: { targetId },
            });
        },
        changeTargetInfo(targetId = 'page-1', url = 'http://127.0.0.1:8000/next') {
            broadcast({
                method: 'Target.targetInfoChanged',
                params: { targetInfo: { targetId, type: 'page', url } },
            });
        },
        closeWs() {
            for (const client of wss.clients) {
                client.terminate();
            }
        },
        async close() {
            for (const client of wss.clients) {
                client.terminate();
            }
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise((resolve) => wss.close(resolve));
            await new Promise((resolve) => server.close(resolve));
            rmSync(dir, { recursive: true, force: true });
        },
    };
}
