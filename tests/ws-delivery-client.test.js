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

    test('unsubscribe with Error reason rejects headPromise if head not yet resolved', async () => {
        const { createLukerDelivery } = await import('../public/scripts/ws-delivery.js');
        const delivery = createLukerDelivery();
        await delivery.connect(async () => 'tik');
        const { headPromise, unsubscribe } = delivery.subscribe('req-abort', {});
        // Abort before any frame arrives — this is the exact scenario that
        // orphans headPromise in the buggy version and hangs the caller's
        // async chain (proxiedFetch → Generate → sendTextareaMessage → mutex).
        const abortErr = new Error('The user aborted a request.');
        unsubscribe(abortErr);
        await expect(headPromise).rejects.toBe(abortErr);
    });

    test('unsubscribe without reason rejects headPromise with generic error', async () => {
        const { createLukerDelivery } = await import('../public/scripts/ws-delivery.js');
        const delivery = createLukerDelivery();
        await delivery.connect(async () => 'tik');
        const { headPromise, unsubscribe } = delivery.subscribe('req-cancel', {});
        unsubscribe();
        await expect(headPromise).rejects.toThrow(/cancelled before head/);
    });

    test('unsubscribe after head resolved does not re-settle headPromise', async () => {
        const { createLukerDelivery } = await import('../public/scripts/ws-delivery.js');
        const delivery = createLukerDelivery();
        await delivery.connect(async () => 'tik');
        const ws = MockWebSocket.instances[0];
        const { headPromise, unsubscribe } = delivery.subscribe('req-post-head', {});
        ws._receive({ type: 'head', request_id: 'req-post-head', status: 200, headers: { 'x-test': '1' } });
        const head = await headPromise;
        expect(head.status).toBe(200);
        // Later unsubscribe must not throw; headPromise is already resolved and
        // must stay resolved (double-settle would violate promise semantics).
        expect(() => unsubscribe()).not.toThrow();
    });

    test('close rejects all pending headPromises', async () => {
        const { createLukerDelivery } = await import('../public/scripts/ws-delivery.js');
        const delivery = createLukerDelivery();
        await delivery.connect(async () => 'tik');
        const s1 = delivery.subscribe('req-c1', {});
        const s2 = delivery.subscribe('req-c2', {});
        delivery.close();
        await expect(s1.headPromise).rejects.toThrow(/closed/);
        await expect(s2.headPromise).rejects.toThrow(/closed/);
    });

    // Reproduces the "你你你好好好" text-triplication bug: multiple reconnect
    // triggers (onclose + online + visibilitychange + stale-check) can each
    // independently call scheduleReconnect, resulting in N concurrent WebSocket
    // instances all subscribed to the same request. Every future server chunk
    // then arrives on every socket, and the SSE consumer's `text += replyDelta`
    // accumulates each chunk N times. Fix must ensure at most ONE reconnect
    // attempt in flight at any time — regardless of how many sources fire.
    test('concurrent reconnect triggers do not open multiple sockets', async () => {
        const { createLukerDelivery } = await import('../public/scripts/ws-delivery.js');
        const delivery = createLukerDelivery({ reconnectBackoffMs: 5 });
        await delivery.connect(async () => 'tik');
        const ws1 = MockWebSocket.instances[0];
        delivery.subscribe('req-race', {});
        // Simulate all four reconnect sources firing while ws1 is dead:
        // 1. Underlying close (network flap) → scheduleReconnect
        // 2. `online` event → forceReconnect → scheduleReconnect
        // 3. `visibilitychange:visible` → forceReconnect → scheduleReconnect
        // 4. A prior stale-check that already close()d ws → scheduleReconnect
        ws1.close();
        delivery.forceReconnect('online');
        delivery.forceReconnect('visibilitychange:visible');
        delivery.forceReconnect('stale-check');
        // Wait past the reconnect backoff so all pending timers fire.
        await new Promise(r => setTimeout(r, 40));
        // Exactly ONE new WS should exist (total 2: original + one reconnect),
        // not one per trigger source.
        expect(MockWebSocket.instances).toHaveLength(2);
    });

    test('reconnect sends resume for each pending request exactly once', async () => {
        const { createLukerDelivery } = await import('../public/scripts/ws-delivery.js');
        const delivery = createLukerDelivery({ reconnectBackoffMs: 5 });
        await delivery.connect(async () => 'tik');
        const ws1 = MockWebSocket.instances[0];
        delivery.subscribe('req-multi-1', {});
        delivery.subscribe('req-multi-2', {});
        // Bump lastSeq for one so we can verify the resume from_seq math too.
        ws1._receive({ type: 'chunk', request_id: 'req-multi-1', seq: 5, data: 'QQ==' });
        ws1.close();
        delivery.forceReconnect('online');
        delivery.forceReconnect('visibilitychange:visible');
        await new Promise(r => setTimeout(r, 40));
        // Total sockets: at most 2 (original + one reconnect).
        expect(MockWebSocket.instances.length).toBeLessThanOrEqual(2);
        const ws2 = MockWebSocket.instances[MockWebSocket.instances.length - 1];
        const resumes1 = ws2.sent.filter(s => s.includes('"resume"') && s.includes('"req-multi-1"'));
        const resumes2 = ws2.sent.filter(s => s.includes('"resume"') && s.includes('"req-multi-2"'));
        expect(resumes1).toHaveLength(1);
        expect(resumes2).toHaveLength(1);
        // from_seq must be lastSeq + 1 for req-multi-1 (which received seq=5).
        expect(resumes1[0]).toContain('"from_seq":6');
        // from_seq must be 1 for req-multi-2 (never received a chunk).
        expect(resumes2[0]).toContain('"from_seq":1');
    });

    // Chunk delivery under a reconnect race: even if the client bug ever
    // recurred and multiple sockets subscribed, the downstream stream must
    // only see each chunk once. This asserts the observable end-to-end
    // property (single copy of each chunk in the ReadableStream) that the
    // "你你你好好好" bug violates.
    test('chunks after reconnect are enqueued exactly once', async () => {
        const { createLukerDelivery } = await import('../public/scripts/ws-delivery.js');
        const delivery = createLukerDelivery({ reconnectBackoffMs: 5 });
        await delivery.connect(async () => 'tik');
        const ws1 = MockWebSocket.instances[0];
        const { stream } = delivery.subscribe('req-once', {});
        // Fire multiple reconnect triggers to simulate the racy production
        // path (mobile tab-return + online event + stale-check all racing).
        ws1.close();
        delivery.forceReconnect('online');
        delivery.forceReconnect('visibilitychange:visible');
        await new Promise(r => setTimeout(r, 40));
        // Whatever set of live sockets ends up existing, deliver the same
        // chunk on ALL of them (simulates the server fanning out to N
        // subscribers because the client opened N sockets that each did
        // resume). The client-side must dedupe so the stream sees one copy.
        for (const ws of MockWebSocket.instances) {
            if (ws.readyState === 1) {
                ws._receive({ type: 'chunk', request_id: 'req-once', seq: 1, data: 'aGVsbG8=' });  // 'hello'
            }
        }
        // End it on the primary live socket.
        const liveWs = MockWebSocket.instances.find(w => w.readyState === 1);
        liveWs._receive({ type: 'end', request_id: 'req-once', seq: 2 });
        const reader = stream.getReader();
        let combined = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            combined += new TextDecoder().decode(value);
        }
        // The bug produces 'hellohellohello' (or worse). Correct output is 'hello'.
        expect(combined).toBe('hello');
    });
});
