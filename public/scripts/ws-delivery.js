// SPDX-License-Identifier: AGPL-3.0-or-later

const TICKET_PROTOCOL_PREFIX = 'luker-ws-ticket.';
const DEFAULT_RECONNECT_BACKOFF_MS = 500;

export function createLukerDelivery({ reconnectBackoffMs = DEFAULT_RECONNECT_BACKOFF_MS } = {}) {
    let ws = null;
    let ticketProvider = null;
    let closed = false;
    const pending = new Map();  // request_id → { controller, lastSeq, initialHeaders }

    async function connectOnce() {
        const ticket = await ticketProvider();
        return new Promise((resolve, reject) => {
            const proto = `${TICKET_PROTOCOL_PREFIX}${ticket}`;
            const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
            const socket = new WebSocket(`${wsProto}//${location.host}/api/ws-delivery`, [proto]);
            socket.onopen = () => { ws = socket; setupHandlers(socket); resolve(); };
            socket.onerror = () => reject(new Error('ws connection failed'));
            socket.onclose = () => {
                if (ws === socket) ws = null;
                if (!closed) scheduleReconnect();
            };
        });
    }

    function setupHandlers(socket) {
        socket.onmessage = (evt) => {
            let msg;
            try { msg = JSON.parse(evt.data); } catch { return; }
            const entry = pending.get(msg.request_id);
            if (!entry) return;
            if (msg.type === 'chunk') {
                if (typeof msg.seq === 'number') entry.lastSeq = msg.seq;
                const bytes = Uint8Array.from(atob(msg.data), c => c.charCodeAt(0));
                try { entry.controller.enqueue(bytes); } catch {}
            } else if (msg.type === 'end') {
                if (typeof msg.seq === 'number') entry.lastSeq = msg.seq;
                try { entry.controller.close(); } catch {}
                pending.delete(msg.request_id);
            } else if (msg.type === 'error') {
                try { entry.controller.error(new Error(msg.message || msg.code || 'ws delivery error')); } catch {}
                pending.delete(msg.request_id);
            } else if (msg.type === 'head') {
                // future: allow dispatch to update headers; MVP ignores
            }
        };
        socket.onclose = () => { if (ws === socket) ws = null; if (!closed) scheduleReconnect(); };
    }

    function scheduleReconnect() {
        setTimeout(async () => {
            if (closed) return;
            try {
                await connectOnce();
                // Re-subscribe / resume all pending
                for (const [requestId, entry] of pending.entries()) {
                    const fromSeq = entry.lastSeq > 0 ? entry.lastSeq + 1 : 0;
                    ws.send(JSON.stringify(fromSeq > 0
                        ? { type: 'resume', request_id: requestId, from_seq: fromSeq }
                        : { type: 'subscribe', request_id: requestId }));
                }
            } catch {
                scheduleReconnect();
            }
        }, reconnectBackoffMs);
    }

    function subscribeInternal(requestId, initialHeaders, fromSeq) {
        let controller;
        const stream = new ReadableStream({
            start(c) { controller = c; },
            cancel() { unsubscribe(requestId); },
        });
        pending.set(requestId, { controller, lastSeq: fromSeq > 0 ? fromSeq - 1 : 0, initialHeaders });
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(fromSeq > 0
                ? { type: 'resume', request_id: requestId, from_seq: fromSeq }
                : { type: 'subscribe', request_id: requestId }));
        }
        return {
            stream,
            unsubscribe: (reason) => unsubscribe(requestId, reason),
        };
    }

    function unsubscribe(requestId, reason = null) {
        const entry = pending.get(requestId);
        if (ws && ws.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify({ type: 'unsubscribe', request_id: requestId })); } catch {}
        }
        // Terminate the caller's ReadableStream so any pending
        // `reader.read()` resolves. Without this, callers looping on
        // `for await (const chunk of response.body)` hang forever after
        // an abort. `controller.error` propagates as AbortError-shaped
        // exception; `controller.close` is used when the caller is
        // shutting down cleanly (no explicit reason).
        if (entry?.controller) {
            try {
                if (reason instanceof Error || (reason && typeof reason.message === 'string')) {
                    entry.controller.error(reason);
                } else {
                    entry.controller.close();
                }
            } catch { /* controller may already be closed */ }
        }
        pending.delete(requestId);
    }

    return {
        async connect(provider) {
            ticketProvider = provider;
            await connectOnce();
        },
        subscribe(requestId, initialHeaders) {
            // Always request replay from seq 1 to avoid a race: server-side
            // runLukerDispatch uses setImmediate, so dispatch may begin (and
            // events accumulate) before the client's WS subscribe arrives.
            // Bare `subscribe` is live-only and would drop those early events;
            // `resume {from_seq: 1}` replays from the start of the stream.
            return subscribeInternal(requestId, initialHeaders || {}, 1);
        },
        resume(requestId, fromSeq) {
            return subscribeInternal(requestId, {}, fromSeq);
        },
        isConnected() { return ws !== null && ws.readyState === WebSocket.OPEN; },
        close() { closed = true; if (ws) ws.close(); pending.clear(); },
    };
}

export const PROXY_PATTERNS = [
    '/api/backends/chat-completions/generate',
    '/api/backends/text-completions/generate',
    '/api/backends/kobold/generate',
    '/api/novelai/generate',
    '/api/sd/generate',
    '/api/sd/comfy/generate',
    '/api/sd/drawthings/generate',
    '/api/sd/together/generate',
    '/api/sd/pollinations/generate',
    '/api/sd/stability/generate',
    '/api/sd/comfyrunpod/generate',
    '/api/sd/sdcpp/generate',
    '/api/sd/huggingface/generate',
    '/api/sd/electronhub/generate',
    '/api/sd/chutes/generate',
    '/api/sd/nanogpt/generate',
    '/api/sd/bfl/generate',
    '/api/sd/falai/generate',
    '/api/sd/xai/generate',
    '/api/sd/aimlapi/generate-image',
    '/api/sd/zai/generate',
    '/api/sd/workersai/generate',
];

function defaultShouldProxy(url) {
    const s = String(url || '');
    return PROXY_PATTERNS.some(p => s.includes(p));
}

export function installFetchProxy(delivery, options = {}) {
    const shouldProxy = options.shouldProxy || defaultShouldProxy;
    const originalFetch = options.originalFetch || window.fetch.bind(window);
    // Optional headers provider so out-of-band POSTs (like /abort) carry the
    // same CSRF/session headers the SPA uses for normal requests. Without
    // this, `/api/generation/:id/abort` fails CSRF middleware with 403 and
    // the server never learns to stop upstream generation.
    const getExtraHeaders = typeof options.getExtraHeaders === 'function'
        ? options.getExtraHeaders
        : () => ({});

    // Fire-and-forget POST to notify the server that a proxied generation
    // was aborted client-side. The server endpoint may not exist yet; any
    // error (404, network) is swallowed so aborts remain best-effort.
    function sendAbortNotification(requestId) {
        try {
            const p = originalFetch(`/api/generation/${encodeURIComponent(requestId)}/abort`, {
                method: 'POST',
                headers: {
                    ...getExtraHeaders(),
                    'x-luker-request-id': requestId,
                },
            });
            if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch {
            // ignore
        }
    }

    async function proxiedFetch(url, init) {
        if (!shouldProxy(url)) return originalFetch(url, init);
        // Client-provided request id: reuse body.luker_generation.job_id when
        // caller pre-generated one (openai.js:4201 does this so it can poll
        // /jobs/status?id= with the same uuid). Otherwise mint a fresh one
        // and let the server echo it via x-luker-generation-id.
        let requestId = crypto.randomUUID();
        try {
            const b = init?.body;
            if (typeof b === 'string') {
                const parsed = JSON.parse(b);
                const bodyId = String(parsed?.luker_generation?.job_id || '').trim();
                if (bodyId) requestId = bodyId;
            }
        } catch { /* body not JSON or unparseable — keep the minted uuid */ }
        // Normalize caller headers to a plain object so `spread` works even
        // when the caller passed a `Headers` instance (spread on Headers
        // yields empty because Headers isn't a plain object).
        const callerHeaders = init?.headers;
        const normalizedHeaders = callerHeaders instanceof Headers
            ? Object.fromEntries(callerHeaders.entries())
            : (callerHeaders || {});
        const headers = { ...normalizedHeaders, 'x-luker-request-id': requestId };
        const httpResp = await originalFetch(url, { ...(init || {}), headers });
        if (!httpResp.ok) return httpResp;
        try { await httpResp.clone().json(); } catch { /* body may be empty */ }
        // Server echoes the actual job id via header — take it as source of
        // truth in case body id / header id / server-mint disagree.
        const serverJobId = httpResp.headers.get('x-luker-generation-id');
        if (serverJobId && serverJobId !== requestId) {
            requestId = serverJobId;
        }
        const initialHeaders = {};
        httpResp.headers.forEach((v, k) => {
            if (k.toLowerCase().startsWith('x-luker-')) initialHeaders[k] = v;
        });
        const { stream, unsubscribe } = delivery.subscribe(requestId, initialHeaders);
        // Wire caller-supplied AbortSignal: on abort, unsubscribe (which cancels
        // the WS-side stream) AND notify the server so it can stop the upstream
        // generation. Server endpoint is best-effort — failure is swallowed.
        const signal = init?.signal;
        if (signal) {
            const onAbort = () => {
                // Terminate the caller's ReadableStream with an AbortError
                // so any `for await response.body` loop unwinds immediately.
                // Then notify the server so upstream generation stops.
                const abortErr = new DOMException('The user aborted a request.', 'AbortError');
                unsubscribe(abortErr);
                sendAbortNotification(requestId);
            };
            if (signal.aborted) {
                onAbort();
            } else {
                signal.addEventListener('abort', onAbort, { once: true });
            }
        }
        return new Response(stream, {
            status: httpResp.status,
            headers: { ...Object.fromEntries(httpResp.headers.entries()), 'content-type': 'text/event-stream' },
        });
    }

    window.fetch = proxiedFetch;
    return () => { window.fetch = originalFetch; };
}
