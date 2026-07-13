// SPDX-License-Identifier: AGPL-3.0-or-later

const TICKET_PROTOCOL_PREFIX = 'luker-ws-ticket.';
const DEFAULT_RECONNECT_BACKOFF_MS = 500;
// Client-side stale-connection detector. The server pings on a fixed cadence
// (see src/ws-delivery.js WS_SERVER_PING_INTERVAL_MS = 30_000). If we haven't
// heard *anything* — ping frames, real data frames — from the server for
// longer than this window, the TCP is almost certainly a zombie (mobile
// suspend / laptop sleep / NAT rebind / wifi→cellular handoff) and we force
// a reconnect. Set to 3× the server ping interval so a single dropped ping
// plus normal jitter doesn't trigger a false teardown.
const CLIENT_STALE_THRESHOLD_MS = 90_000;
// How often the client polls its own last-recv timestamp to detect the
// zombie condition. Cheap timer; 10s cadence catches zombies within one
// window without wasting cycles.
const CLIENT_STALE_CHECK_INTERVAL_MS = 10_000;

// requestId is a routing correlation id (not a security primitive), so a
// Math.random fallback is fine when crypto.randomUUID is unavailable —
// which happens in insecure contexts (HTTP served from non-localhost).
function uuidv4() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

export function createLukerDelivery({ reconnectBackoffMs = DEFAULT_RECONNECT_BACKOFF_MS } = {}) {
    let ws = null;
    let ticketProvider = null;
    let closed = false;
    const pending = new Map();  // request_id → { controller, lastSeq, initialHeaders }
    // Timestamp of the last frame received from the server (ping, chunk, head,
    // anything). Used by the stale-check timer to detect zombie TCP where
    // ws.readyState === OPEN in the browser but no bytes actually flow.
    let lastServerFrameAt = 0;
    let staleCheckTimer = null;

    function noteServerFrame() {
        lastServerFrameAt = Date.now();
    }

    function startStaleCheck() {
        if (staleCheckTimer) return;
        staleCheckTimer = setInterval(() => {
            if (closed) return;
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
            const age = Date.now() - lastServerFrameAt;
            if (age > CLIENT_STALE_THRESHOLD_MS) {
                // Zombie: no server frame in the whole window. ws.close() is
                // graceful but may itself hang on a dead TCP; terminating the
                // underlying socket is only possible via close() from the
                // browser side. Call close() and let onclose fire scheduleReconnect.
                // If the socket is truly dead the browser eventually surfaces
                // onclose within a few seconds via its own OS-level detection.
                console.warn(`[ws-delivery] no server frame for ${age}ms — force reconnect`);
                try { ws.close(4000, 'stale'); } catch { /* already closed */ }
            }
        }, CLIENT_STALE_CHECK_INTERVAL_MS);
        // Node's setInterval returns a Timeout with .unref(); browsers'
        // returns a number. In Jest (Node runtime) this prevents the interval
        // from keeping the event loop alive after tests finish. In the
        // browser this line is a harmless no-op.
        if (typeof staleCheckTimer?.unref === 'function') staleCheckTimer.unref();
    }

    function stopStaleCheck() {
        if (staleCheckTimer) {
            clearInterval(staleCheckTimer);
            staleCheckTimer = null;
        }
    }

    async function connectOnce() {
        const ticket = await ticketProvider();
        return new Promise((resolve, reject) => {
            const proto = `${TICKET_PROTOCOL_PREFIX}${ticket}`;
            const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
            const socket = new WebSocket(`${wsProto}//${location.host}/api/ws-delivery`, [proto]);
            let settled = false;
            socket.onopen = () => {
                settled = true;
                ws = socket;
                noteServerFrame();
                setupHandlers(socket);
                startStaleCheck();
                console.info('[ws-delivery] connected');
                resolve();
            };
            socket.onerror = (evt) => {
                // Both used during initial connect (below) AND kept as the
                // long-lived error listener after onopen — setupHandlers no
                // longer clobbers this so mid-life protocol errors are logged
                // instead of silently vanishing.
                if (!settled) {
                    settled = true;
                    console.warn('[ws-delivery] connect failed');
                    reject(new Error('ws connection failed'));
                } else {
                    console.warn('[ws-delivery] socket error', evt?.message || '');
                }
            };
            socket.onclose = (evt) => {
                if (ws === socket) ws = null;
                stopStaleCheck();
                console.warn(`[ws-delivery] closed code=${evt?.code} reason="${evt?.reason || ''}" wasClean=${evt?.wasClean}`);
                if (!closed) scheduleReconnect();
            };
        });
    }

    function setupHandlers(socket) {
        socket.onmessage = (evt) => {
            noteServerFrame();
            let msg;
            try { msg = JSON.parse(evt.data); } catch { return; }
            // App-level heartbeat: server pings on a fixed cadence, we reply
            // immediately. Handled BEFORE the pending lookup because pings
            // carry no request_id.
            if (msg.type === 'ping') {
                try {
                    socket.send(JSON.stringify({ type: 'pong', ts: msg.ts }));
                } catch { /* socket died mid-reply; onclose will fire */ }
                return;
            }
            const entry = pending.get(msg.request_id);
            if (!entry) {
                // Late frame for a request_id we've already GC'd (unsubscribed
                // or ended). Log at debug loudness so long-open pages don't
                // fill the console but a real bug (frame for never-subscribed
                // id) still shows up on inspection.
                if (msg.request_id) {
                    console.debug(`[ws-delivery] frame for unknown request_id=${msg.request_id} type=${msg.type}`);
                }
                return;
            }
            if (msg.type === 'head') {
                // Upstream status/headers passthrough. Resolves the promise
                // proxiedFetch is awaiting so it can construct `new Response`
                // with correct status. Server dispatch contract: always emit
                // head once, immediately after the upstream fetch resolves.
                if (!entry.headResolved) {
                    entry.headResolved = true;
                    const status = Number.isFinite(msg.status) ? Number(msg.status) : 200;
                    const headers = (msg.headers && typeof msg.headers === 'object') ? msg.headers : {};
                    entry.resolveHead({ status, headers });
                }
            } else if (msg.type === 'chunk') {
                if (typeof msg.seq === 'number') entry.lastSeq = msg.seq;
                // Fallback: if head frame never arrived (dispatch bug / very
                // old server), resolve with 200 so the caller doesn't hang.
                if (!entry.headResolved) {
                    entry.headResolved = true;
                    entry.resolveHead({ status: 200, headers: {} });
                }
                const bytes = Uint8Array.from(atob(msg.data), c => c.charCodeAt(0));
                try { entry.controller.enqueue(bytes); } catch {}
            } else if (msg.type === 'end') {
                if (typeof msg.seq === 'number') entry.lastSeq = msg.seq;
                if (!entry.headResolved) {
                    entry.headResolved = true;
                    entry.resolveHead({ status: 200, headers: {} });
                }
                try { entry.controller.close(); } catch {}
                pending.delete(msg.request_id);
            } else if (msg.type === 'error') {
                // Structured error frame from dispatch (thrown Error path).
                // If head hasn't resolved, surface as HTTP 502 with the
                // error message as body so callers can do `await response.text()`
                // or `await response.json()` for diagnostics without hanging.
                // If head already resolved (error mid-stream), error the
                // caller's stream so `for await response.body` throws.
                if (!entry.headResolved) {
                    entry.headResolved = true;
                    const errMsg = msg.message || msg.code || 'ws delivery error';
                    entry.resolveHead({ status: 502, headers: { 'content-type': 'text/plain' } });
                    try { entry.controller.enqueue(new TextEncoder().encode(errMsg)); } catch {}
                    try { entry.controller.close(); } catch {}
                } else {
                    try { entry.controller.error(new Error(msg.message || msg.code || 'ws delivery error')); } catch {}
                }
                pending.delete(msg.request_id);
            }
        };
        // NOTE: onclose and onerror are intentionally NOT re-installed here.
        // connectOnce() attaches them and they remain active for the whole
        // socket lifetime, so mid-life errors and closes reach the same
        // logging + reconnect path as connect-time ones.
    }

    function scheduleReconnect() {
        setTimeout(async () => {
            if (closed) return;
            try {
                await connectOnce();
                // Re-subscribe / resume all pending. Always use `resume` with
                // `from_seq >= 1` so the server replays any events that were
                // emitted (and lost) during the disconnect window. Bare
                // `subscribe` is live-only on the server and would miss the
                // head/first-chunk frame if it landed while the socket was
                // closing.
                for (const [requestId, entry] of pending.entries()) {
                    const fromSeq = entry.lastSeq > 0 ? entry.lastSeq + 1 : 1;
                    console.info(`[ws-delivery] resume request_id=${requestId} from_seq=${fromSeq}`);
                    ws.send(JSON.stringify({ type: 'resume', request_id: requestId, from_seq: fromSeq }));
                }
            } catch (err) {
                console.warn('[ws-delivery] reconnect failed, retrying:', err?.message || err);
                scheduleReconnect();
            }
        }, reconnectBackoffMs);
    }

    // Force a reconnect from outside the socket lifecycle (visibilitychange /
    // online events). Idempotent: if the socket is already dead/closing, the
    // scheduled reconnect will pick up; if it's alive, we tear it so onclose
    // fires and reconnect runs the resume loop with pending intact.
    function forceReconnect(reason) {
        if (closed) return;
        if (ws && ws.readyState === WebSocket.OPEN) {
            console.info(`[ws-delivery] force reconnect: ${reason}`);
            try { ws.close(4001, reason); } catch { /* ignore */ }
        } else if (!ws) {
            // No live socket and none in-flight — kick off a reconnect
            // immediately instead of waiting for the next backoff tick.
            console.info(`[ws-delivery] force reconnect (no live socket): ${reason}`);
            scheduleReconnect();
        }
    }

    function subscribeInternal(requestId, initialHeaders, fromSeq) {
        let controller;
        const stream = new ReadableStream({
            start(c) { controller = c; },
            cancel() { unsubscribe(requestId); },
        });
        // headPromise resolves with upstream {status, headers} from the
        // dispatch's `head` frame. proxiedFetch awaits this before
        // constructing `new Response` so the caller sees the real upstream
        // status (401/429/500/etc), not a synthetic 200. See setupHandlers
        // for fallbacks when head never arrives.
        let resolveHead;
        const headPromise = new Promise((res) => { resolveHead = res; });
        pending.set(requestId, {
            controller,
            lastSeq: fromSeq > 0 ? fromSeq - 1 : 0,
            initialHeaders,
            resolveHead,
            headResolved: false,
        });
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(fromSeq > 0
                ? { type: 'resume', request_id: requestId, from_seq: fromSeq }
                : { type: 'subscribe', request_id: requestId }));
        } else {
            // Queued: pending is populated so reconnect's resume loop will
            // pick this up. Log so a hung request in this state is diagnosable.
            console.warn(`[ws-delivery] subscribe queued (ws not open, readyState=${ws?.readyState ?? 'null'}) request_id=${requestId}`);
        }
        return {
            stream,
            headPromise,
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
        // Exposed so page-lifecycle hooks (visibilitychange/online, installed
        // by installLifecycleHooks below) can force a reconnect when they
        // detect the tab just came out of a background/offline state where
        // the WS may have died silently.
        forceReconnect,
        close() {
            closed = true;
            stopStaleCheck();
            if (ws) ws.close();
            pending.clear();
        },
    };
}

/**
 * Install browser page-lifecycle hooks that force a reconnect when the tab
 * returns to visible state (was backgrounded, may have been discarded /
 * suspended) or when the network comes back online. These are the classic
 * scenarios where the WS TCP dies silently and neither browser onclose nor
 * OS TCP keepalive notices for minutes to hours; page-lifecycle events give
 * us a deterministic reconnect trigger instead of waiting for the stale-check
 * timer window (see CLIENT_STALE_THRESHOLD_MS) to expire.
 *
 * Called from public/script.js after createLukerDelivery + connect.
 *
 * @param {ReturnType<createLukerDelivery>} delivery
 * @returns {() => void} Disposer that removes both listeners.
 */
export function installLifecycleHooks(delivery) {
    const onVisibilityChange = () => {
        if (document.visibilityState !== 'visible') return;
        if (delivery.isConnected()) {
            // Alive but may be a zombie the OS hasn't reaped — the stale-check
            // timer will handle it within CLIENT_STALE_THRESHOLD_MS. No need
            // to tear a good connection just because the tab was hidden.
            return;
        }
        delivery.forceReconnect('visibilitychange:visible');
    };
    const onOnline = () => {
        delivery.forceReconnect('online');
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('online', onOnline);
    return () => {
        document.removeEventListener('visibilitychange', onVisibilityChange);
        window.removeEventListener('online', onOnline);
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
    // Default target = top window; iframe callers pass `iframe.contentWindow`
    // so the proxy lands in the iframe's realm. TavernHelper (JS-Slash-Runner)
    // and similar third-party runtimes execute user scripts inside a
    // `TH-render` iframe whose own `window.fetch` was never proxied, so calls
    // to `/api/backends/*/generate` from those scripts hit the runner's
    // immediate `{}` body and never subscribe to the WS delivery — see
    // installFetchProxyForAllIframes below for the iframe lifecycle driver.
    const targetWindow = options.targetWindow || window;

    // Idempotency: re-install on the same window is a no-op that returns the
    // existing disposer. The iframe-lifecycle driver re-invokes this on every
    // `iframe.load` (to survive navigate/reload resetting `contentWindow.fetch`)
    // and needs the second/third call to short-circuit instead of stacking
    // wrappers around our own proxiedFetch.
    if (targetWindow.__lukerFetchProxyDisposer) return targetWindow.__lukerFetchProxyDisposer;

    // Rebind built-ins to the target realm. Without this, `new Response(...)`
    // constructs a parent-realm Response returned to iframe consumers, so
    // `response instanceof Response` inside the iframe evaluates to `false`
    // (iframe.Response !== parent.Response). Same for Headers instance-checks
    // on caller `init.headers`, and DOMException-typed abort errors. Shadowing
    // the outer globals via destructure means the function body below keeps
    // its existing `Response` / `Headers` / `DOMException` identifiers with no
    // further edits, but they now resolve to the target-window classes.
    const { Response, Headers, DOMException } = targetWindow;

    const shouldProxy = options.shouldProxy || defaultShouldProxy;
    const originalFetch = options.originalFetch || targetWindow.fetch.bind(targetWindow);
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
        let requestId = uuidv4();
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
        const { stream, headPromise, unsubscribe } = delivery.subscribe(requestId, initialHeaders);
        console.info(`[ws-delivery] proxiedFetch subscribe request_id=${requestId} url=${String(url).split('?')[0]}`);
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
        // Wait for the dispatch to publish upstream {status, headers} via a
        // `head` frame, OR fallback to {200, {}} when the first chunk/end/
        // error arrives without a head. Contract: every dispatch emits head
        // once, right after ctx.fetch resolves. This ensures response.status
        // reflects the real upstream status (401/429/500/etc) instead of a
        // synthetic 200, so existing client-side branches that check
        // `response.status` or `!response.ok` fire correctly.
        const head = await headPromise;
        console.info(`[ws-delivery] head resolved request_id=${requestId} status=${head.status}`);
        const mergedHeaders = {
            ...initialHeaders,
            'content-type': 'text/event-stream',
            ...(head.headers || {}),
        };
        return new Response(stream, {
            status: head.status || 200,
            headers: mergedHeaders,
        });
    }

    targetWindow.fetch = proxiedFetch;
    const disposer = () => {
        // Only restore if nobody else has since re-monkey-patched fetch in
        // this window; blindly restoring would clobber a later override.
        if (targetWindow.fetch === proxiedFetch) targetWindow.fetch = originalFetch;
        delete targetWindow.__lukerFetchProxyDisposer;
    };
    targetWindow.__lukerFetchProxyDisposer = disposer;
    return disposer;
}

/**
 * Install the fetch proxy into every same-origin iframe on the page, current
 * and future. Cross-origin iframes silently skip (SecurityError on
 * `contentWindow` access is the browser contract for cross-origin isolation,
 * not an actionable failure).
 *
 * Motivation: TavernHelper's JS-Slash-Runner (and any script runtime that
 * sandboxes user scripts inside `<iframe>`) gives each script its own
 * `window.fetch` untouched by the top-window proxy. Under the runner-based
 * `/generate` architecture (src/luker-dispatch/runner.js) the HTTP body is
 * always `{}` and the real payload lands over WebSocket delivery, so iframe
 * scripts calling `fetch('/api/backends/chat-completions/generate', ...)`
 * see `{}` and treat it as an "invalid response format" failure. Patching
 * every iframe realm restores the contract for all such scripts uniformly.
 *
 * Lifecycle coverage is deliberately three-step and none is optional:
 *   1. Patch existing iframes at install time — covers iframes that already
 *      landed in the DOM before delivery boot (unlikely for TH-render at
 *      first-load, but not zero for pre-warmed / pinned messages).
 *   2. MutationObserver — TH-render iframes are runtime-created (per rendered
 *      message / per script activation); without this, we cover exactly zero
 *      TavernHelper scripts in the common case.
 *   3. `iframe.load` event re-patch — browsers reset `contentWindow.fetch`
 *      on navigate / reload / srcdoc rewrite. `installFetchProxy` is
 *      idempotent per-window so redundant patch calls are harmless.
 *
 * @param {ReturnType<createLukerDelivery>} delivery Shared delivery instance
 *     from the top window; all iframe subscriptions multiplex over the same
 *     WebSocket, no per-iframe WS.
 * @param {object} [options] Same shape as `installFetchProxy`'s options
 *     (getExtraHeaders / shouldProxy); `targetWindow` is set per-iframe and
 *     any caller-supplied value is ignored.
 * @returns {() => void} Disposer that disconnects the observer. Already-
 *     patched iframes retain their proxy (there's no safe global unwind).
 */
export function installFetchProxyForAllIframes(delivery, options = {}) {
    function patchIframe(iframe) {
        // Cross-origin: contentWindow access throws SecurityError. Silent
        // skip — this is the browser's boundary, not a diagnosable state.
        let win;
        try { win = iframe.contentWindow; } catch { return; }
        if (!win) return;
        try {
            installFetchProxy(delivery, { ...options, targetWindow: win });
        } catch (err) {
            // Real errors (e.g. iframe.contentWindow.Response missing on some
            // exotic iframe type) surface loudly — swallowing would hide the
            // exact "generate requests silently fail" class of bug this whole
            // module exists to prevent.
            console.warn('[ws-delivery] iframe fetch patch failed:', err?.message || err);
        }
    }

    function attachLoadHook(iframe) {
        iframe.addEventListener('load', () => patchIframe(iframe));
    }

    // Step 1: existing iframes.
    for (const iframe of document.querySelectorAll('iframe')) {
        patchIframe(iframe);
        attachLoadHook(iframe);
    }

    // Step 2 + 3: watch for iframes added at any depth. `subtree: true` so we
    // pick up iframes wrapped inside a container element (TH-render wraps
    // iframes inside a `.mes` bubble subtree, not as direct <body> children).
    const mo = new MutationObserver(mutations => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (!(node instanceof Element)) continue;
                if (node.tagName === 'IFRAME') {
                    patchIframe(node);
                    attachLoadHook(node);
                    continue;
                }
                // Container node that may itself contain iframes.
                const nested = node.querySelectorAll?.('iframe');
                if (!nested) continue;
                for (const iframe of nested) {
                    patchIframe(iframe);
                    attachLoadHook(iframe);
                }
            }
        }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });

    return () => mo.disconnect();
}
