// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { createLukerDelivery, installLifecycleHooks } from '../public/scripts/ws-delivery.js';

function saveGlobalDescriptor(name) {
    return {
        name,
        existed: Object.prototype.hasOwnProperty.call(globalThis, name),
        descriptor: Object.getOwnPropertyDescriptor(globalThis, name),
    };
}

function restoreGlobalDescriptor({ name, existed, descriptor }) {
    if (existed && descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
    } else {
        delete globalThis[name];
    }
}

function createWsDeliveryFixture() {
    const sockets = [];
    const deliveries = new Set();
    const disposers = [];
    const expectedCancellations = [];

    class MockWebSocket {
        constructor(url, protocols) {
            this.url = url;
            this.protocols = protocols;
            this.readyState = 0;
            this.sent = [];
            this._closed = false;
            sockets.push(this);
            this._openTimer = setTimeout(() => {
                this._openTimer = null;
                if (!this._closed) this._open();
            }, 0);
        }
        _open() {
            this.readyState = 1;
            if (this.onopen) this.onopen();
        }
        send(data) { this.sent.push(data); }
        close(code = 1000, reason = '') {
            if (this._openTimer) {
                clearTimeout(this._openTimer);
                this._openTimer = null;
            }
            if (this._closed) return;
            this._closed = true;
            this.readyState = 3;
            if (this.onclose) this.onclose({ code, reason, wasClean: code === 1000 });
        }
        _receive(msg) {
            if (this.onmessage) this.onmessage({ data: JSON.stringify(msg) });
        }
    }
    MockWebSocket.OPEN = 1;
    MockWebSocket.CLOSED = 3;

    const savedWebSocket = saveGlobalDescriptor('WebSocket');
    const savedLocation = saveGlobalDescriptor('location');
    Object.defineProperty(globalThis, 'WebSocket', {
        value: MockWebSocket,
        configurable: true,
        writable: true,
        enumerable: true,
    });
    Object.defineProperty(globalThis, 'location', {
        value: { host: 'localhost:8000', protocol: 'http:' },
        configurable: true,
        writable: true,
        enumerable: true,
    });

    return {
        sockets,
        createDelivery(options = {}) {
            const delivery = createLukerDelivery(options);
            deliveries.add(delivery);
            return delivery;
        },
        async connect(options = {}, ticketProvider = async () => 'tik') {
            const delivery = this.createDelivery(options);
            await delivery.connect(ticketProvider);
            return { delivery, ws: sockets.at(-1) };
        },
        registerDisposer(fn) {
            disposers.push(fn);
        },
        expectRejectedOnClose(promise, matcher = /ws-delivery: closed/) {
            const settled = promise.then(
                (value) => ({ status: 'fulfilled', value }),
                (reason) => ({ status: 'rejected', reason }),
            );
            expectedCancellations.push({ settled, matcher });
        },
        async teardown() {
            const errors = [];
            try {
                for (const dispose of disposers.splice(0).reverse()) {
                    try { dispose(); } catch (err) { errors.push(err); }
                }
                for (const delivery of deliveries) {
                    try { delivery.close(); } catch (err) { errors.push(err); }
                }
                deliveries.clear();
                for (const ws of sockets) {
                    if (ws._openTimer) {
                        clearTimeout(ws._openTimer);
                        ws._openTimer = null;
                    }
                    if (!ws._closed) {
                        ws._closed = true;
                        ws.readyState = MockWebSocket.CLOSED;
                    }
                }
                for (const { settled, matcher } of expectedCancellations.splice(0)) {
                    const outcome = await settled;
                    if (outcome.status !== 'rejected') {
                        errors.push(new Error(`Expected cancelled promise to reject with ${matcher}, got fulfilled`));
                    } else if (!(outcome.reason instanceof Error) || !matcher.test(outcome.reason.message)) {
                        errors.push(new Error(`Expected cancellation error matching ${matcher}, got ${String(outcome.reason)}`));
                    }
                }
            } finally {
                restoreGlobalDescriptor(savedWebSocket);
                restoreGlobalDescriptor(savedLocation);
            }
            if (errors.length === 1) throw errors[0];
            if (errors.length > 1) throw new AggregateError(errors, 'ws-delivery fixture teardown failed');
        },
    };
}

let fixture;

beforeEach(() => {
    fixture = createWsDeliveryFixture();
});

afterEach(async () => {
    await fixture.teardown();
});

describe('lukerDelivery client', () => {
    test('connect opens WS with ticket protocol', async () => {
        const delivery = fixture.createDelivery();
        await delivery.connect(async () => 'test-ticket');
        expect(fixture.sockets).toHaveLength(1);
        const ws = fixture.sockets[0];
        expect(ws.protocols).toEqual(['luker-ws-ticket.test-ticket']);
        expect(delivery.isConnected()).toBe(true);
    });

    test('subscribe sends resume-from-1 to avoid race', async () => {
        const { delivery, ws } = await fixture.connect();
        const { stream, headPromise } = delivery.subscribe('req-1', {});
        fixture.expectRejectedOnClose(headPromise);
        // Public `subscribe` internally sends resume{from_seq:1} so events
        // emitted before the WS subscribe arrives (server dispatch runs on
        // setImmediate) are replayed from the start of the stream.
        expect(ws.sent).toContainEqual(JSON.stringify({ type: 'resume', request_id: 'req-1', from_seq: 1 }));
        expect(stream).toBeDefined();
    });

    test('incoming chunk enqueued to stream', async () => {
        const { delivery, ws } = await fixture.connect();
        const { stream, headPromise } = delivery.subscribe('req-2', {});
        ws._receive({ type: 'chunk', request_id: 'req-2', seq: 1, data: 'QUJD' });  // 'ABC'
        ws._receive({ type: 'end', request_id: 'req-2', seq: 2 });
        await expect(headPromise).resolves.toEqual({ status: 200, headers: {} });
        const reader = stream.getReader();
        const first = await reader.read();
        expect(first.done).toBe(false);
        expect(Array.from(first.value)).toEqual([65, 66, 67]);
        const second = await reader.read();
        expect(second.done).toBe(true);
    });

    test('meta frame invokes onMeta out-of-band without enqueuing bytes into stream', async () => {
        const { delivery, ws } = await fixture.connect();
        const receivedMeta = [];
        const { stream, headPromise } = delivery.subscribe('req-meta', {}, {
            onMeta: (m) => receivedMeta.push(m),
        });
        ws._receive({ type: 'head', request_id: 'req-meta', seq: 1, status: 200, headers: {} });
        ws._receive({ type: 'chunk', request_id: 'req-meta', seq: 2, data: 'QUJD' }); // 'ABC'
        ws._receive({
            type: 'meta',
            request_id: 'req-meta',
            seq: 3,
            meta: { generation_id: 'req-meta', persisted: true, status: 'completed' },
        });
        ws._receive({ type: 'end', request_id: 'req-meta', seq: 4 });

        await expect(headPromise).resolves.toEqual({ status: 200, headers: {} });
        expect(receivedMeta).toEqual([
            { generation_id: 'req-meta', persisted: true, status: 'completed' },
        ]);
        const reader = stream.getReader();
        const first = await reader.read();
        expect(new TextDecoder().decode(first.value)).toBe('ABC');
        const second = await reader.read();
        expect(second.done).toBe(true);
    });

    test('error frame before head surfaces as 502 body via headPromise', async () => {
        const { delivery, ws } = await fixture.connect();
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
        const { delivery, ws } = await fixture.connect();
        const { stream, headPromise } = delivery.subscribe('req-3b', {});
        // head arrives first, resolving headPromise
        ws._receive({ type: 'head', request_id: 'req-3b', status: 200, headers: {} });
        await headPromise;
        // Then error mid-stream
        ws._receive({ type: 'error', request_id: 'req-3b', seq: 1, code: 'timeout', message: 'lost' });
        const reader = stream.getReader();
        await expect(reader.read()).rejects.toThrow(/lost/);
    });

    test('abort frame before head rejects headPromise with AbortError and fires onServerAbort', async () => {
        const { delivery, ws } = await fixture.connect();
        const onServerAbort = jest.fn();
        const { stream, headPromise } = delivery.subscribe('req-abort-pre', {}, { onServerAbort });
        ws._receive({ type: 'error', request_id: 'req-abort-pre', seq: 1, code: 'aborted', message: 'inspector stop' });

        await expect(headPromise).rejects.toMatchObject({ name: 'AbortError' });
        expect(onServerAbort).toHaveBeenCalledWith('req-abort-pre', expect.objectContaining({ code: 'aborted' }));
        const reader = stream.getReader();
        await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
    });

    test('abort frame after head errors the stream with AbortError and fires onServerAbort', async () => {
        const { delivery, ws } = await fixture.connect();
        const onServerAbort = jest.fn();
        const { stream, headPromise } = delivery.subscribe('req-abort-post', {}, { onServerAbort });
        ws._receive({ type: 'head', request_id: 'req-abort-post', status: 200, headers: {} });
        await headPromise;
        ws._receive({ type: 'error', request_id: 'req-abort-post', seq: 2, code: 'aborted', message: 'inspector stop' });

        const reader = stream.getReader();
        await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
        expect(onServerAbort).toHaveBeenCalledWith('req-abort-post', expect.objectContaining({ code: 'aborted' }));
    });

    test('reconnect after WS close, resume outstanding subs', async () => {
        const { delivery, ws: ws1 } = await fixture.connect({ reconnectBackoffMs: 5 });
        const { headPromise } = delivery.subscribe('req-4', {});
        ws1._receive({ type: 'chunk', request_id: 'req-4', seq: 1, data: 'QQ==' });
        await expect(headPromise).resolves.toEqual({ status: 200, headers: {} });
        // Kill WS
        ws1.close();
        // Wait for reconnect
        await new Promise(r => setTimeout(r, 30));
        expect(fixture.sockets).toHaveLength(2);
        const ws2 = fixture.sockets[1];
        // Should have sent resume with from_seq=2
        expect(ws2.sent.some(s => s.includes('"resume"') && s.includes('"from_seq":2'))).toBe(true);
    });

    test('unsubscribe with Error reason rejects headPromise if head not yet resolved', async () => {
        const { delivery } = await fixture.connect();
        const { headPromise, unsubscribe } = delivery.subscribe('req-abort', {});
        // Abort before any frame arrives — this is the exact scenario that
        // orphans headPromise in the buggy version and hangs the caller's
        // async chain (proxiedFetch → Generate → sendTextareaMessage → mutex).
        const abortErr = new Error('The user aborted a request.');
        unsubscribe(abortErr);
        await expect(headPromise).rejects.toBe(abortErr);
    });

    test('unsubscribe without reason rejects headPromise with generic error', async () => {
        const { delivery } = await fixture.connect();
        const { headPromise, unsubscribe } = delivery.subscribe('req-cancel', {});
        unsubscribe();
        await expect(headPromise).rejects.toThrow(/cancelled before head/);
    });

    test('unsubscribe after head resolved does not re-settle headPromise', async () => {
        const { delivery, ws } = await fixture.connect();
        const { headPromise, unsubscribe } = delivery.subscribe('req-post-head', {});
        ws._receive({ type: 'head', request_id: 'req-post-head', status: 200, headers: { 'x-test': '1' } });
        const head = await headPromise;
        expect(head.status).toBe(200);
        // Later unsubscribe must not throw; headPromise is already resolved and
        // must stay resolved (double-settle would violate promise semantics).
        expect(() => unsubscribe()).not.toThrow();
    });

    test('close rejects all pending headPromises', async () => {
        const { delivery } = await fixture.connect();
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
        const { delivery, ws: ws1 } = await fixture.connect({ reconnectBackoffMs: 5 });
        const { headPromise } = delivery.subscribe('req-race', {});
        fixture.expectRejectedOnClose(headPromise);
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
        expect(fixture.sockets).toHaveLength(2);
    });

    test('reconnect sends resume for each pending request exactly once', async () => {
        const { delivery, ws: ws1 } = await fixture.connect({ reconnectBackoffMs: 5 });
        const sub1 = delivery.subscribe('req-multi-1', {});
        const sub2 = delivery.subscribe('req-multi-2', {});
        fixture.expectRejectedOnClose(sub2.headPromise);
        // Bump lastSeq for one so we can verify the resume from_seq math too.
        ws1._receive({ type: 'chunk', request_id: 'req-multi-1', seq: 5, data: 'QQ==' });
        await expect(sub1.headPromise).resolves.toEqual({ status: 200, headers: {} });
        ws1.close();
        delivery.forceReconnect('online');
        delivery.forceReconnect('visibilitychange:visible');
        await new Promise(r => setTimeout(r, 40));
        // Total sockets: at most 2 (original + one reconnect).
        expect(fixture.sockets.length).toBeLessThanOrEqual(2);
        const ws2 = fixture.sockets[fixture.sockets.length - 1];
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
        const { delivery, ws: ws1 } = await fixture.connect({ reconnectBackoffMs: 5 });
        const { stream, headPromise } = delivery.subscribe('req-once', {});
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
        for (const ws of fixture.sockets) {
            if (ws.readyState === 1) {
                ws._receive({ type: 'chunk', request_id: 'req-once', seq: 1, data: 'aGVsbG8=' });  // 'hello'
            }
        }
        // End it on the primary live socket.
        const liveWs = fixture.sockets.find(w => w.readyState === 1);
        liveWs._receive({ type: 'end', request_id: 'req-once', seq: 2 });
        await expect(headPromise).resolves.toEqual({ status: 200, headers: {} });
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

describe('lukerDelivery request inactivity timeout', () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    test('pre-head timeout rejects headPromise with TimeoutError, unsubscribes, fires onTimeout', async () => {
        const { delivery, ws } = await fixture.connect();
        const onTimeout = jest.fn();
        const { headPromise } = delivery.subscribe('req-t1', {}, { timeoutMs: 40, onTimeout });
        await expect(headPromise).rejects.toMatchObject({ name: 'TimeoutError' });
        expect(onTimeout).toHaveBeenCalledWith('req-t1');
        expect(ws.sent.some(s => s.includes('"unsubscribe"'))).toBe(true);
    });

    test('head and chunk frames reset the timer; silence after them errors the stream', async () => {
        const { delivery, ws } = await fixture.connect();
        const onTimeout = jest.fn();
        const { stream, headPromise } = delivery.subscribe('req-t2', {}, { timeoutMs: 100, onTimeout });
        ws._receive({ type: 'head', request_id: 'req-t2', status: 200, headers: {} });
        await expect(headPromise).resolves.toEqual({ status: 200, headers: {} });
        for (let i = 0; i < 4; i++) {
            ws._receive({ type: 'chunk', request_id: 'req-t2', seq: i + 1, data: 'QQ==' });
            await sleep(40);
        }
        expect(onTimeout).not.toHaveBeenCalled();
        const reader = stream.getReader();
        await reader.read();
        await sleep(250);
        expect(onTimeout).toHaveBeenCalledTimes(1);
        await expect(reader.read()).rejects.toMatchObject({ name: 'TimeoutError' });
    });

    test('end clears the timer', async () => {
        const { delivery, ws } = await fixture.connect();
        const onTimeout = jest.fn();
        const { headPromise } = delivery.subscribe('req-t3', {}, { timeoutMs: 40, onTimeout });
        ws._receive({ type: 'head', request_id: 'req-t3', status: 200, headers: {} });
        await expect(headPromise).resolves.toEqual({ status: 200, headers: {} });
        ws._receive({ type: 'end', request_id: 'req-t3', seq: 1 });
        await sleep(120);
        expect(onTimeout).not.toHaveBeenCalled();
    });

    test('timeoutMs 0 or missing keeps the old no-timer behavior', async () => {
        const { delivery } = await fixture.connect();
        const { headPromise } = delivery.subscribe('req-t4', {}, { timeoutMs: 0 });
        let settled = false;
        const observed = headPromise.then(
            (value) => { settled = true; return { status: 'fulfilled', value }; },
            (reason) => { settled = true; return { status: 'rejected', reason }; },
        );
        await sleep(80);
        expect(settled).toBe(false);
        delivery.close();
        const closedOutcome = await observed;
        expect(closedOutcome.status).toBe('rejected');
        expect(closedOutcome.reason).toBeInstanceOf(Error);
        expect(closedOutcome.reason.message).toMatch(/ws-delivery: closed/);
    });

    test('lifecycle hooks reconnect on online/visibilitychange and detach listeners on dispose', async () => {
        const docListeners = new Map();
        const winListeners = new Map();
        const makeTarget = (store, extra = {}) => ({
            ...extra,
            addEventListener(type, fn) {
                if (!store.has(type)) store.set(type, new Set());
                store.get(type).add(fn);
            },
            removeEventListener(type, fn) {
                store.get(type)?.delete(fn);
            },
            dispatch(type) {
                for (const fn of [...(store.get(type) || [])]) fn();
            },
        });
        const savedDocument = saveGlobalDescriptor('document');
        const savedWindow = saveGlobalDescriptor('window');
        const fakeDoc = makeTarget(docListeners, { visibilityState: 'visible' });
        const fakeWin = makeTarget(winListeners);
        Object.defineProperty(globalThis, 'document', { value: fakeDoc, configurable: true, writable: true });
        Object.defineProperty(globalThis, 'window', { value: fakeWin, configurable: true, writable: true });
        fixture.registerDisposer(() => {
            restoreGlobalDescriptor(savedDocument);
            restoreGlobalDescriptor(savedWindow);
        });

        const { delivery, ws: ws1 } = await fixture.connect({ reconnectBackoffMs: 5 });
        const dispose = installLifecycleHooks(delivery);
        fixture.registerDisposer(dispose);

        expect(docListeners.get('visibilitychange')?.size).toBe(1);
        expect(winListeners.get('online')?.size).toBe(1);

        // Online event forces reconnect of a live socket.
        fakeWin.dispatch('online');
        await sleep(35);
        expect(fixture.sockets).toHaveLength(2);
        expect(ws1.readyState).toBe(3);

        // Disposing detaches both listeners so further events do not trigger reconnects.
        dispose();
        expect(docListeners.get('visibilitychange')?.size).toBe(0);
        expect(winListeners.get('online')?.size).toBe(0);
        fakeWin.dispatch('online');
        fakeDoc.dispatch('visibilitychange');
        await sleep(25);
        expect(fixture.sockets).toHaveLength(2);
    });
});
