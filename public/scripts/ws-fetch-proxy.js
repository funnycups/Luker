/**
 * WS Fetch Proxy — monkey-patches window.fetch to tunnel long-running
 * generate requests over a persistent WebSocket connection instead of HTTP.
 *
 * Key feature: disconnect recovery. When the WS drops mid-stream, pending
 * requests are NOT rejected. On reconnect, the client sends "resume" for
 * each in-flight request. The server replays buffered chunks and continues
 * streaming. From the caller's perspective, the stream just paused briefly.
 *
 * Loaded as a classic <script> (not module) so it patches fetch before
 * any ES module imports run.
 */
(function () {
    'use strict';

    // ── Configuration ──────────────────────────────────────────────

    /** URL patterns that should be proxied over WS */
    const PROXY_PATTERNS = [
        '/api/backends/chat-completions/generate',
        '/api/backends/text-completions/generate',
        '/api/backends/kobold/generate',
        '/api/novelai/generate',
        '/api/sd/comfy/generate',
        '/api/sd/generate',
        '/api/sd/drawthings/generate',
        '/api/sd/together/generate',
        '/api/sd/pollinations/generate',
        '/api/sd/stability/generate',
    ];

    const HEARTBEAT_INTERVAL = 25000;  // 25s ping
    const HEARTBEAT_TIMEOUT  = 60000;  // 60s pong deadline
    const RECONNECT_BASE     = 1000;   // initial reconnect delay
    const RECONNECT_MAX      = 30000;  // max reconnect delay
    const RECONNECT_JITTER   = 0.3;    // ±30% jitter

    // ── State ───────────────────────────────────────────────────────

    const originalFetch = window.fetch;
    /** @type {WebSocket|null} */
    let ws = null;
    let reconnectDelay = RECONNECT_BASE;
    let heartbeatTimer = null;
    let pongTimer = null;
    let lastMessageAt = 0;
    let csrfToken = '';
    let intentionalClose = false;

    /**
     * Pending requests: id → entry
     * Entries survive WS disconnects — they are only removed on
     * end, error, abort, or explicit cleanup.
     * @type {Map<string, object>}
     */
    const pending = new Map();

    // ── Helpers ─────────────────────────────────────────────────────

    function generateId() {
        if (crypto.randomUUID) return crypto.randomUUID();
        return 'xxxx-xxxx-xxxx'.replace(/x/g, () =>
            Math.floor(Math.random() * 16).toString(16));
    }

    function shouldProxy(url) {
        if (!url || typeof url !== 'string') return false;
        return PROXY_PATTERNS.some(p => url.includes(p));
    }

    /** Base64 string → Uint8Array */
    function b64ToUint8(b64) {
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return arr;
    }

    function i18n(text) {
        const translateFn = /** @type {any} */ (globalThis.translate);
        if (typeof translateFn === 'function') {
            return translateFn(text, text);
        }
        return text;
    }

    // ── CSRF Token ──────────────────────────────────────────────────

    async function fetchCsrfToken() {
        try {
            const resp = await originalFetch('/csrf-token');
            const data = await resp.json();
            csrfToken = data.token || '';
        } catch (e) {
            console.warn('[ws-proxy] Failed to fetch CSRF token:', e.message);
        }
    }

    // ── WebSocket Connection ────────────────────────────────────────

    function getWsUrl() {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${proto}//${location.host}/ws/proxy?csrf=${encodeURIComponent(csrfToken)}`;
    }

    function connect() {
        if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
            return;
        }

        intentionalClose = false;
        ws = new WebSocket(getWsUrl());

        ws.onopen = () => {
            console.log('[ws-proxy] Connected');
            reconnectDelay = RECONNECT_BASE;
            lastMessageAt = Date.now();
            startHeartbeat();

            // Resume any in-flight requests that survived the disconnect
            resumePendingRequests();
        };

        ws.onmessage = (event) => {
            // Any inbound frame means the socket is alive, not only explicit pong.
            lastMessageAt = Date.now();
            if (pongTimer) {
                clearTimeout(pongTimer);
                pongTimer = null;
            }

            let msg;
            try {
                msg = JSON.parse(event.data);
            } catch {
                return;
            }
            handleMessage(msg);
        };

        ws.onclose = (event) => {
            stopHeartbeat();
            console.warn(`[ws-proxy] Disconnected (code=${event.code})`);

            // Do NOT reject pending requests — they will be resumed on reconnect.
            // Only requests that haven't received head yet AND have no chance of
            // recovery (intentional close) should be rejected.
            if (intentionalClose) {
                for (const [id, req] of pending) {
                    if (!req.headReceived) {
                        req.reject(new TypeError('WebSocket proxy closed'));
                    } else if (req.controller) {
                        req.controller.error(new Error('WebSocket proxy closed'));
                    }
                    pending.delete(id);
                }
            }
            // For unintentional disconnects, keep pending entries alive

            if (!intentionalClose) {
                scheduleReconnect();
            }
        };

        ws.onerror = () => {
            // onclose will fire after this
        };
    }

    /**
     * After reconnecting, send resume for all pending requests.
     */
    function resumePendingRequests() {
        if (pending.size === 0) return;
        console.log(`[ws-proxy] Resuming ${pending.size} in-flight request(s)`);
        for (const [id, entry] of pending) {
            if (ws && ws.readyState === WebSocket.OPEN) {
                // For requests that already received head, we need to tell
                // the server to replay from where we left off.
                // For requests that haven't received head yet, the server
                // will replay everything from the beginning.
                ws.send(JSON.stringify({
                    type: 'resume',
                    id,
                    // Resume from the next chunk we have not received yet.
                    fromChunk: entry.receivedChunks || 0,
                }));
                entry.resumed = true;
            }
        }
    }

    function scheduleReconnect() {
        const jitter = 1 + (Math.random() * 2 - 1) * RECONNECT_JITTER;
        const delay = Math.min(reconnectDelay * jitter, RECONNECT_MAX);
        console.log(`[ws-proxy] Reconnecting in ${Math.round(delay)}ms`);
        setTimeout(async () => {
            reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
            // Refresh CSRF token before reconnecting (session may have rotated)
            await fetchCsrfToken();
            connect();
        }, delay);
    }

    // ── Heartbeat ───────────────────────────────────────────────────

    function startHeartbeat() {
        stopHeartbeat();
        heartbeatTimer = setInterval(() => {
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
            if (pongTimer) {
                return;
            }

            ws.send(JSON.stringify({ type: 'ping' }));
            const sentAt = Date.now();
            pongTimer = setTimeout(() => {
                // If we have received any frame after ping, treat it as healthy.
                if (lastMessageAt > sentAt) {
                    pongTimer = null;
                    return;
                }
                console.warn('[ws-proxy] Pong timeout, closing');
                if (ws) ws.close();
                pongTimer = null;
            }, HEARTBEAT_TIMEOUT);
        }, HEARTBEAT_INTERVAL);
    }

    function stopHeartbeat() {
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
        if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
    }

    // ── Message Handler ────────────────────────────────────────────

    function handleMessage(msg) {
        if (msg.type === 'pong') {
            if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
            return;
        }

        const req = pending.get(msg.id);
        if (!req) return;

        switch (msg.type) {
            case 'head': {
                // On resume, we may receive head again — only create the
                // Response/stream on the first head.
                if (req.headReceived) {
                    // Already have head — this is a resume replay, skip
                    break;
                }

                req.headReceived = true;
                req.status = msg.status;
                req.headers = msg.headers;

                // Create a ReadableStream for the body
                const stream = new ReadableStream({
                    start(controller) {
                        req.controller = controller;
                        // Flush any chunks that arrived before head
                        for (const chunk of req.chunks) {
                            controller.enqueue(chunk);
                        }
                        req.chunks = [];
                    },
                    cancel() {
                        sendAbort(msg.id);
                    },
                });

                // Build a real Response object
                const headers = new Headers(msg.headers || {});
                const response = new Response(stream, {
                    status: msg.status,
                    statusText: statusTextFromCode(msg.status),
                    headers,
                });

                req.resolve(response);
                break;
            }

            case 'chunk': {
                const bytes = b64ToUint8(msg.data);
                req.receivedChunks = (req.receivedChunks || 0) + 1;
                if (req.controller) {
                    try {
                        req.controller.enqueue(bytes);
                    } catch {
                        // Stream may have been cancelled by the consumer
                    }
                } else {
                    // Head hasn't arrived yet — buffer
                    req.chunks.push(bytes);
                }
                break;
            }

            case 'end': {
                if (req.controller) {
                    try { req.controller.close(); } catch { /* already closed */ }
                }
                pending.delete(msg.id);
                break;
            }

            case 'error': {
                if (!req.headReceived) {
                    req.reject(new TypeError(`WS proxy error: ${msg.message}`));
                } else if (req.controller) {
                    try { req.controller.error(new Error(msg.message)); } catch { /* */ }
                }
                pending.delete(msg.id);
                break;
            }
        }
    }

    function sendAbort(id) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'abort', id }));
        }
        pending.delete(id);
    }

    function statusTextFromCode(code) {
        const map = { 200: 'OK', 201: 'Created', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable' };
        return map[code] || '';
    }

    // ── Monkey-Patched fetch ────────────────────────────────────────

    /**
     * Wait until WS is connected (with timeout).
     * @param {number} timeoutMs
     * @returns {Promise<boolean>}
     */
    function waitForConnection(timeoutMs = 5000) {
        if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve(true);
        return new Promise((resolve) => {
            const start = Date.now();
            const check = () => {
                if (ws && ws.readyState === WebSocket.OPEN) return resolve(true);
                if (Date.now() - start > timeoutMs) return resolve(false);
                setTimeout(check, 50);
            };
            check();
        });
    }

    window.fetch = async function patchedFetch(input, init) {
        // Normalize URL
        const url = typeof input === 'string' ? input
            : input instanceof URL ? input.toString()
            : input instanceof Request ? input.url
            : String(input);

        if (!shouldProxy(url)) {
            return originalFetch.apply(this, arguments);
        }

        // Wait for WS connection
        const connected = await waitForConnection(3000);
        if (!connected) {
            console.warn('[ws-proxy] WS not connected, falling back to HTTP');
            if (typeof toastr !== 'undefined') {
                toastr.error(i18n('WebSocket connection failed. Request will fall back to HTTP (possibly due to authentication failure).'), i18n('WS Proxy'));
            }
            return originalFetch.apply(this, arguments);
        }

        const id = generateId();

        // Extract headers
        const headers = {};
        if (init?.headers) {
            const h = init.headers instanceof Headers ? init.headers : new Headers(init.headers);
            h.forEach((v, k) => { headers[k] = v; });
        }

        // Build request message
        const msg = {
            type: 'request',
            id,
            url,
            method: init?.method || 'GET',
            headers,
            body: init?.body || null,
        };

        return new Promise((resolve, reject) => {
            const entry = {
                resolve,
                reject,
                headReceived: false,
                controller: null,
                chunks: [],
                receivedChunks: 0,
                status: 0,
                headers: {},
                resumed: false,
            };
            pending.set(id, entry);

            // Handle AbortSignal
            const signal = init?.signal;
            if (signal) {
                if (signal.aborted) {
                    pending.delete(id);
                    reject(new DOMException('The operation was aborted.', 'AbortError'));
                    return;
                }
                signal.addEventListener('abort', () => {
                    sendAbort(id);
                    if (!entry.headReceived) {
                        reject(new DOMException('The operation was aborted.', 'AbortError'));
                    } else if (entry.controller) {
                        try { entry.controller.error(new DOMException('The operation was aborted.', 'AbortError')); } catch { /* */ }
                    }
                }, { once: true });
            }

            ws.send(JSON.stringify(msg));
        });
    };

    // Keep a reference for debugging
    window.__wsProxy = {
        get connected() { return ws && ws.readyState === WebSocket.OPEN; },
        get pending() { return pending.size; },
        get pendingIds() { return [...pending.keys()]; },
        reconnect() { if (ws) ws.close(); },
        get patterns() { return [...PROXY_PATTERNS]; },
    };

    // ── Bootstrap ──────────────────────────────────────────────────

    // Fetch CSRF token then connect
    fetchCsrfToken().then(connect);

    console.log('[ws-proxy] Fetch proxy installed for:', PROXY_PATTERNS);
})();
