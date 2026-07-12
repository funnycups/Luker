// SPDX-License-Identifier: AGPL-3.0-or-later

const TICKET_PROTOCOL_PREFIX = 'luker-ws-ticket.';
const DEFAULT_RECONNECT_BACKOFF_MS = 500;

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
        socket.onclose = () => { if (ws === socket) ws = null; if (!closed) scheduleReconnect(); };
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
                    ws.send(JSON.stringify({ type: 'resume', request_id: requestId, from_seq: fromSeq }));
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
