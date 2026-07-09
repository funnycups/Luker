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
});
