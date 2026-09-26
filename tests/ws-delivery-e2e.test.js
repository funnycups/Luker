import http from 'node:http';
import express from 'express';
import WebSocket from 'ws';
import { createDeliveryServer } from '../src/ws-delivery.js';
import { runLukerDispatch } from '../src/luker-dispatch/runner.js';

global.WebSocket = WebSocket;

async function startServer() {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { profile: { handle: 'alice' }, directories: {} };
        next();
    });
    app.post('/api/backends/chat-completions/generate', (req, res) =>
        runLukerDispatch(req, res, {
            endpoint: 'chat-completions',
            select: () => async (ctx) => {
                ctx.emit.chunk(new Uint8Array([104, 105])); // 'hi'
                ctx.emit.end();
            },
        }));
    const httpServer = http.createServer(app);
    createDeliveryServer({ httpServer, verifyTicket: () => ({ user_handle: 'alice' }) });
    await new Promise(r => httpServer.listen(0, r));
    return { port: httpServer.address().port, close: () => new Promise(r => httpServer.close(r)) };
}

test('end-to-end: HTTP POST → task created → WS subscribe → chunk delivered', async () => {
    const server = await startServer();
    try {
        const requestId = 'e2e-1';
        const httpResp = await fetch(`http://127.0.0.1:${server.port}/api/backends/chat-completions/generate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-luker-request-id': requestId },
            body: '{}',
        });
        expect(httpResp.status).toBe(200);
        expect(httpResp.headers.get('x-luker-generation-id')).toBe(requestId);
        await httpResp.json();

        const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/ws-delivery`, ['luker-ws-ticket.dummy']);
        await new Promise(r => ws.once('open', r));
        // Match production JS client (public/scripts/ws-delivery.js): always
        // resume from seq 1 to avoid the setImmediate race where the dispatch
        // may have already run and events accumulated before the client's WS
        // frame arrives. Bare `subscribe` is live-only (server ws-delivery.js
        // line 101: fromSeq=0 for subscribe) and would drop those early events.
        // Queue-based collector: registering a persistent `on('message')`
        // listener before sending the subscribe frame guarantees we don't
        // miss frames that arrive back-to-back (chunk + end may fire in the
        // same tick; a per-iteration `once` pattern loses the second one).
        const messages = [];
        const done = new Promise(resolve => {
            ws.on('message', (raw) => {
                const msg = JSON.parse(String(raw));
                messages.push(msg);
                if (msg.type === 'end') resolve();
            });
        });
        ws.send(JSON.stringify({ type: 'resume', request_id: requestId, from_seq: 1 }));
        await done;
        const chunkMsg = messages.find(m => m.type === 'chunk');
        expect(chunkMsg.data).toBe(Buffer.from([104, 105]).toString('base64'));
        expect(messages.some(m => m.type === 'end')).toBe(true);
        ws.close();
    } finally { await server.close(); }
});
