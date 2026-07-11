// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest } from '@jest/globals';

class MockWebSocket {
    static instances = [];
    constructor(url, protocols) {
        this.url = url;
        this.protocols = protocols;
        this.readyState = 0;
        this.sent = [];
        MockWebSocket.instances.push(this);
        setTimeout(() => this._open(), 0);
    }
    _open() {
        this.readyState = 1;
        if (this.onopen) this.onopen();
    }
    send(data) { this.sent.push(data); }
    close() { this.readyState = 3; if (this.onclose) this.onclose({ code: 1000 }); }
    _receive(msg) { if (this.onmessage) this.onmessage({ data: JSON.stringify(msg) }); }
}
MockWebSocket.OPEN = 1;
MockWebSocket.CLOSED = 3;

beforeEach(() => {
    MockWebSocket.instances = [];
    global.WebSocket = MockWebSocket;
    global.location = { host: 'localhost:8000' };
});

describe('lukerDelivery client', () => {
    test('connect opens WS with ticket protocol', async () => {
        const { createLukerDelivery } = await import('../public/scripts/ws-delivery.js');
        const delivery = createLukerDelivery();
        await delivery.connect(async () => 'test-ticket');
        expect(MockWebSocket.instances).toHaveLength(1);
        const ws = MockWebSocket.instances[0];
        expect(ws.protocols).toEqual(['luker-ws-ticket.test-ticket']);
        expect(delivery.isConnected()).toBe(true);
    });

    test('subscribe sends resume-from-1 to avoid race', async () => {
        const { createLukerDelivery } = await import('../public/scripts/ws-delivery.js');
        const delivery = createLukerDelivery();
        await delivery.connect(async () => 'tik');
        const ws = MockWebSocket.instances[0];
        const { stream } = delivery.subscribe('req-1', {});
        // Public `subscribe` internally sends resume{from_seq:1} so events
        // emitted before the WS subscribe arrives (server dispatch runs on
        // setImmediate) are replayed from the start of the stream.
        expect(ws.sent).toContainEqual(JSON.stringify({ type: 'resume', request_id: 'req-1', from_seq: 1 }));
        expect(stream).toBeDefined();
    });

    test('incoming chunk enqueued to stream', async () => {
        const { createLukerDelivery } = await import('../public/scripts/ws-delivery.js');
        const delivery = createLukerDelivery();
        await delivery.connect(async () => 'tik');
        const ws = MockWebSocket.instances[0];
        const { stream } = delivery.subscribe('req-2', {});
        ws._receive({ type: 'chunk', request_id: 'req-2', seq: 1, data: 'QUJD' });  // 'ABC'
        ws._receive({ type: 'end', request_id: 'req-2', seq: 2 });
        const reader = stream.getReader();
        const first = await reader.read();
        expect(first.done).toBe(false);
        expect(Array.from(first.value)).toEqual([65, 66, 67]);
        const second = await reader.read();
        expect(second.done).toBe(true);
    });

    test('error frame before head surfaces as 502 body via headPromise', async () => {
        const { createLukerDelivery } = await import('../public/scripts/ws-delivery.js');
        const delivery = createLukerDelivery();
        await delivery.connect(async () => 'tik');
        const ws = MockWebSocket.instances[0];
        const { stream, headPromise } = delivery.subscribe('req-3', {});
        ws._receive({ type: 'error', request_id: 'req-3', seq: 1, code: 'forbidden', message: 'nope' });
        const head = await headPromise;
        expect(head.status).toBe(502);
        const reader = stream.getReader();
        const first = await reader.read();
        expect(first.done).toBe(false);
        const text = new TextDecoder().decode(first.value);
        expect(text).toMatch(/nope/);
        const second = await reader.read();
        expect(second.done).toBe(true);
    });

    test('error frame after head errors the stream', async () => {
        const { createLukerDelivery } = await import('../public/scripts/ws-delivery.js');
        const delivery = createLukerDelivery();
        await delivery.connect(async () => 'tik');
        const ws = MockWebSocket.instances[0];
        const { stream, headPromise } = delivery.subscribe('req-3b', {});
        // head arrives first, resolving headPromise
        ws._receive({ type: 'head', request_id: 'req-3b', status: 200, headers: {} });
        await headPromise;
        // Then error mid-stream
        ws._receive({ type: 'error', request_id: 'req-3b', seq: 1, code: 'timeout', message: 'lost' });
        const reader = stream.getReader();
        await expect(reader.read()).rejects.toThrow(/lost/);
    });

    test('reconnect after WS close, resume outstanding subs', async () => {
        const { createLukerDelivery } = await import('../public/scripts/ws-delivery.js');
        const delivery = createLukerDelivery({ reconnectBackoffMs: 5 });
        await delivery.connect(async () => 'tik');
        const ws1 = MockWebSocket.instances[0];
        delivery.subscribe('req-4', {});
        ws1._receive({ type: 'chunk', request_id: 'req-4', seq: 1, data: 'QQ==' });
        // Kill WS
        ws1.close();
        // Wait for reconnect
        await new Promise(r => setTimeout(r, 30));
        expect(MockWebSocket.instances).toHaveLength(2);
        const ws2 = MockWebSocket.instances[1];
        // Should have sent resume with from_seq=2
        expect(ws2.sent.some(s => s.includes('"resume"') && s.includes('"from_seq":2'))).toBe(true);
    });
});
