import { jest } from '@jest/globals';
import http from 'node:http';
import WebSocket from 'ws';
import { createDeliveryServer } from '../src/ws-delivery.js';
import {
    createGenerationJob,
    appendGenerationEvent,
} from '../src/endpoints/backends/luker-generation.js';

async function startTestServer({ verifyTicket }) {
    const httpServer = http.createServer((req, res) => res.end('ok'));
    const delivery = createDeliveryServer({ httpServer, verifyTicket });
    await new Promise(r => httpServer.listen(0, r));
    const port = httpServer.address().port;
    return { port, close: async () => { delivery.close(); await new Promise(r => httpServer.close(r)); } };
}

function connectWs(port, ticket) {
    return new WebSocket(`ws://127.0.0.1:${port}/api/ws-delivery`, [`luker-ws-ticket.${ticket}`]);
}

function waitOpen(ws) { return new Promise(r => ws.once('open', r)); }
function waitClose(ws) {
    return new Promise(r => {
        // Attach an error handler so a 401 upgrade rejection doesn't propagate as
        // an unhandled error before the close event fires.
        ws.on('error', () => {});
        ws.once('close', r);
    });
}

// Buffer messages so callers can request them sequentially without racing the
// socket. Without a buffer, back-to-back replay frames from the server may be
// delivered before a second `once('message')` listener attaches.
function makeMsgQueue(ws) {
    const pending = [];
    const waiters = [];
    ws.on('message', (data) => {
        const parsed = JSON.parse(String(data));
        if (waiters.length) waiters.shift()(parsed);
        else pending.push(parsed);
    });
    ws.on('error', (err) => {
        while (waiters.length) waiters.shift()(Promise.reject(err));
    });
    return () => new Promise((resolve) => {
        if (pending.length) resolve(pending.shift());
        else waiters.push(resolve);
    });
}

describe('ws-delivery server', () => {
    test('rejects upgrade when ticket invalid', async () => {
        const server = await startTestServer({
            verifyTicket: () => { throw new Error('bad ticket'); },
        });
        try {
            const ws = connectWs(server.port, 'bogus');
            await waitClose(ws);
            expect(ws.readyState).toBe(WebSocket.CLOSED);
        } finally { await server.close(); }
    });

    test('accepts upgrade with valid ticket', async () => {
        const server = await startTestServer({
            verifyTicket: () => ({ user_handle: 'alice' }),
        });
        try {
            const ws = connectWs(server.port, 'good');
            await waitOpen(ws);
            expect(ws.readyState).toBe(WebSocket.OPEN);
            ws.close();
        } finally { await server.close(); }
    });

    test('subscribe delivers future chunks to owner', async () => {
        const server = await startTestServer({
            verifyTicket: () => ({ user_handle: 'alice' }),
        });
        try {
            const request = { user: { profile: { handle: 'alice' }, directories: {} }, body: {} };
            const job = createGenerationJob(request, { job_id: 'deliv-1', persist_target: null });
            const ws = connectWs(server.port, 'good');
            await waitOpen(ws);
            const nextMsg = makeMsgQueue(ws);
            ws.send(JSON.stringify({ type: 'subscribe', request_id: 'deliv-1' }));
            // Give server tick to register subscription
            await new Promise(r => setTimeout(r, 20));
            appendGenerationEvent(job, { kind: 'chunk', data: Buffer.from([65, 66, 67]).toString('base64') });
            const msg = await nextMsg();
            expect(msg.type).toBe('chunk');
            expect(msg.request_id).toBe('deliv-1');
            expect(msg.data).toBe(Buffer.from([65, 66, 67]).toString('base64'));
            ws.close();
        } finally { await server.close(); }
    });

    test('subscribe by non-owner rejected with error message', async () => {
        const server = await startTestServer({
            verifyTicket: () => ({ user_handle: 'mallory' }),
        });
        try {
            const request = { user: { profile: { handle: 'alice' }, directories: {} }, body: {} };
            createGenerationJob(request, { job_id: 'deliv-2', persist_target: null });
            const ws = connectWs(server.port, 'good');
            await waitOpen(ws);
            const nextMsg = makeMsgQueue(ws);
            ws.send(JSON.stringify({ type: 'subscribe', request_id: 'deliv-2' }));
            const msg = await nextMsg();
            expect(msg.type).toBe('error');
            expect(msg.code).toBe('forbidden');
            ws.close();
        } finally { await server.close(); }
    });

    test('encodes Uint8Array chunk data to base64 on wire', async () => {
        const server = await startTestServer({
            verifyTicket: () => ({ user_handle: 'alice' }),
        });
        try {
            const request = { user: { profile: { handle: 'alice' }, directories: {} }, body: {} };
            const job = createGenerationJob(request, { job_id: 'b64-test-1', persist_target: null });
            const ws = connectWs(server.port, 'good');
            await waitOpen(ws);
            const nextMsg = makeMsgQueue(ws);
            ws.send(JSON.stringify({ type: 'subscribe', request_id: 'b64-test-1' }));
            await new Promise(r => setTimeout(r, 20));
            // Emit via ctx.emit.chunk pattern: raw Uint8Array bytes
            appendGenerationEvent(job, { kind: 'chunk', data: new Uint8Array([104, 105]) });
            const msg = await nextMsg();
            expect(msg.type).toBe('chunk');
            expect(msg.data).toBe(Buffer.from([104, 105]).toString('base64')); // 'aGk='
            ws.close();
        } finally { await server.close(); }
    });

    test('encoded string chunk data passes through unchanged', async () => {
        const server = await startTestServer({
            verifyTicket: () => ({ user_handle: 'alice' }),
        });
        try {
            const request = { user: { profile: { handle: 'alice' }, directories: {} }, body: {} };
            const job = createGenerationJob(request, { job_id: 'b64-test-2', persist_target: null });
            const ws = connectWs(server.port, 'good');
            await waitOpen(ws);
            const nextMsg = makeMsgQueue(ws);
            ws.send(JSON.stringify({ type: 'subscribe', request_id: 'b64-test-2' }));
            await new Promise(r => setTimeout(r, 20));
            const preEncoded = Buffer.from([1, 2, 3]).toString('base64');
            appendGenerationEvent(job, { kind: 'chunk', data: preEncoded });
            const msg = await nextMsg();
            expect(msg.type).toBe('chunk');
            expect(msg.data).toBe(preEncoded);
            ws.close();
        } finally { await server.close(); }
    });

    test('resume replays from from_seq', async () => {
        const server = await startTestServer({
            verifyTicket: () => ({ user_handle: 'alice' }),
        });
        try {
            const request = { user: { profile: { handle: 'alice' }, directories: {} }, body: {} };
            const job = createGenerationJob(request, { job_id: 'deliv-3', persist_target: null });
            // Pre-populate events
            appendGenerationEvent(job, { kind: 'chunk', data: 'AQ==' });
            appendGenerationEvent(job, { kind: 'chunk', data: 'Ag==' });
            appendGenerationEvent(job, { kind: 'chunk', data: 'Aw==' });

            const ws = connectWs(server.port, 'good');
            await waitOpen(ws);
            const nextMsg = makeMsgQueue(ws);
            ws.send(JSON.stringify({ type: 'resume', request_id: 'deliv-3', from_seq: 2 }));

            const msg1 = await nextMsg();
            const msg2 = await nextMsg();
            expect(msg1.type).toBe('chunk');
            expect(msg1.seq).toBe(2);
            expect(msg2.seq).toBe(3);
            ws.close();
        } finally { await server.close(); }
    });

    // Zombie-subscription dedup: after a network flap the client opens a
    // fresh WS (ws2) and re-subscribes to an in-flight job. Server hasn't
    // detected ws1's death yet (pong timeout is 70s). Without cross-socket
    // dedup, ws1 and ws2 both hold live subscribers for the same job, and
    // every future event is delivered on both — cheap when ws1's TCP is
    // truly dead, but a duplication vector when ws1 is only degraded /
    // partially reachable. Fix: when a same-user subscribe/resume arrives
    // for a request_id that already has a subscriber from an OLDER socket,
    // the older socket's subscription is torn down first.
    test('re-subscribe from same user retires the older socket subscription', async () => {
        const server = await startTestServer({
            verifyTicket: () => ({ user_handle: 'alice' }),
        });
        try {
            const request = { user: { profile: { handle: 'alice' }, directories: {} }, body: {} };
            const job = createGenerationJob(request, { job_id: 'dedup-1', persist_target: null });

            const ws1 = connectWs(server.port, 'good');
            await waitOpen(ws1);
            const nextMsg1 = makeMsgQueue(ws1);
            ws1.send(JSON.stringify({ type: 'subscribe', request_id: 'dedup-1' }));
            await new Promise(r => setTimeout(r, 20));

            // Second connection from same user, subscribes to same job (the
            // client thinks ws1 is dead and is reconnecting).
            const ws2 = connectWs(server.port, 'good');
            await waitOpen(ws2);
            const nextMsg2 = makeMsgQueue(ws2);
            ws2.send(JSON.stringify({ type: 'resume', request_id: 'dedup-1', from_seq: 1 }));
            await new Promise(r => setTimeout(r, 20));

            // A fresh event now: only ws2 should receive it. ws1's zombie
            // subscription must have been retired by the server when ws2
            // subscribed.
            appendGenerationEvent(job, { kind: 'chunk', data: Buffer.from([88]).toString('base64') });

            const msg2 = await nextMsg2();
            expect(msg2.type).toBe('chunk');
            expect(msg2.data).toBe(Buffer.from([88]).toString('base64'));

            // ws1 should NOT receive it. Race a short window against the
            // possibility of an unwanted duplicate delivery.
            const raced = await Promise.race([
                nextMsg1().then(m => ({ got: m })),
                new Promise(r => setTimeout(() => r({ got: null }), 100)),
            ]);
            expect(raced.got).toBeNull();

            ws1.close();
            ws2.close();
        } finally { await server.close(); }
    });

    // Malformed ws frame from client does not surface as uncaughtException
    // (or a raw socket error mid-handshake) causes the ws Receiver on the
    // server-side WebSocket instance to emit 'error'. Prior to the fix in
    // ws-delivery.js, neither the wss connection ws nor the pre-upgrade raw
    // net.Socket had an 'error' listener, so the error bubbled to
    // process.uncaughtException — which server-main.js handles by exiting
    // the entire server process. The receiver-error path is exercised here;
    // the raw-socket handler in onUpgrade is defensive coverage for the same
    // class of client-side network failures during handshake.
    test('malformed ws frame from client does not surface as uncaughtException', async () => {
        const server = await startTestServer({
            verifyTicket: () => ({ user_handle: 'alice' }),
        });
        const uncaught = [];
        const record = (err) => { uncaught.push(err); };
        // prependListener beats jest-installed handlers so we observe whether
        // the ws-delivery path really let an error through.
        process.prependListener('uncaughtException', record);
        try {
            const ws = connectWs(server.port, 'good');
            // Client-side noop error handler — unrelated wiring shouldn't
            // pollute the process-level probe.
            ws.on('error', () => {});
            await waitOpen(ws);
            // Bypass ws.send() masking + framing and write raw bytes.
            // 0xFF sets RSV2 and RSV3 (RFC 6455 §5.2); the server-side ws
            // Receiver parses the frame, fails validation, and — critically —
            // emits the RangeError as an 'error' on the WebSocket instance.
            // The stack matches the production crash trace users hit:
            // `TCP.onStreamRead (node:internal/stream_base_commons)`.
            ws._socket.write(Buffer.from([0xFF, 0x80, 0, 0, 0, 0]));
            // Give the server-side receiver time to parse and emit.
            await new Promise(r => setTimeout(r, 200));
            expect(uncaught).toEqual([]);
        } finally {
            process.removeListener('uncaughtException', record);
            await server.close();
        }
    });
});
