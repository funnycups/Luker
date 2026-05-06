# WebSocket Proxy

Luker provides a WebSocket (WS) proxy feature that transmits AI generation requests through a persistent WebSocket tunnel, replacing the traditional HTTP request approach. This is especially useful in environments with unstable or restricted networks.

## What is WS Proxy

In the traditional approach, each AI generation request is an independent HTTP request. If the network fluctuates, the request may be interrupted, causing generation results to be lost.

The WS proxy transmits these requests through a **persistent WebSocket connection**. Once a WebSocket connection is established, it remains open, and all generation requests and responses communicate bidirectionally through this connection, without the need to repeatedly establish new connections.

In simple terms:

- **Traditional HTTP mode**: Each generation → Establish connection → Send request → Receive response → Close connection
- **WS proxy mode**: Establish one connection → All generation requests reuse this connection → Continuous communication

## Why WS Proxy is Needed

### Unstable Network Environments

In mobile networks, cross-border networks, or environments with weak Wi-Fi signals, HTTP long connections are prone to interruption from brief network fluctuations. The WS proxy can better handle these situations through heartbeat keep-alive and automatic reconnection mechanisms.

### Firewall and Proxy Restrictions

In some network environments, firewalls or enterprise proxies may timeout and disconnect long-duration HTTP connections. The WebSocket protocol's communication method after connection establishment differs from regular HTTP, and in some scenarios can bypass these restrictions.

### Streaming Generation Reliability

AI generation typically uses streaming transmission (SSE), and a single generation may last tens of seconds. The WS proxy provides a more reliable underlying channel for streaming transmission.

## Internal Dispatch Mechanism

The WS proxy uses `app.handle()` for internal request dispatch instead of HTTP self-fetch. The WS upgrade itself is the auth boundary — Basic Auth is enforced once at the handshake, then dispatched requests are tagged with an internal Symbol so the Basic Auth middleware short-circuits without re-challenging.

### Upgrade-stage authentication

When Basic Auth is enabled (`listen` + `basicAuthMode`), `server.on('upgrade')` calls `tryBasicAuth(req)` against the upgrade request's `Authorization` header. On failure the proxy writes a real `HTTP/1.1 401` (with `WWW-Authenticate: Basic`) and destroys the socket; the browser-side fetch shim falls back to plain HTTP, where the browser attaches the same Basic Auth credentials it stores for the origin. This matters in practice because **WebSocket upgrades from iOS Safari, in-app WebViews, and tunneling reverse proxies (frpc, cloudflared, etc.) frequently strip the `Authorization` header**. By validating at the upgrade, we either confirm the channel is authenticated or fall back gracefully — instead of letting the WS connection succeed and then 401'ing every dispatched request.

### app.handle() Dispatch

When the WS proxy receives a generation request from a client, it constructs mock `http.IncomingMessage` and `http.ServerResponse` objects and dispatches them directly through Express via `app.handle(req, res, callback)` — no HTTP round-trip is involved.

**Mock IncomingMessage**: Built with a `Readable` stream as the socket (required by Node's internal `_destroy`/`eos` plumbing). The request body is pushed into the stream and then `null` is pushed to signal end-of-body. The mock request is also tagged with the `WS_PROXY_AUTH_BYPASS` Symbol exported from `basicAuth.js` — Basic Auth treats this as proof the request crossed the WS auth boundary and skips its credential check. The Symbol is module-private, so headers, query strings, and body fields cannot smuggle it onto a real HTTP request.

**Mock ServerResponse**: Built with a `Writable` stream as the socket. All response output (`writeHead`, `setHeader`, `write`, `end`) is intercepted and forwarded to the WS client as `{ type: "head" }` and `{ type: "chunk" }` messages.

### Why Not HTTP Self-Fetch

A self-fetch through `localhost` would force a second `Authorization: Basic` round-trip, which we cannot reliably reproduce because the WS upgrade often arrives without that header (browsers don't let JavaScript set it, and many WebView/proxy setups drop it). `app.handle()` keeps the request inside the process, runs through cookie session, CSRF, and login middleware as normal, and lets Basic Auth honor the WS-validated boundary instead of demanding fresh credentials.

### Cookie and CSRF Forwarding

Cookies and the CSRF token are extracted from the WS connection context (the upgrade request headers and URL query parameters) and injected into the mock request headers. This ensures the dispatched request carries the same authentication context as the original WS connection, without requiring the client to re-send credentials per request.

### Security boundary

- **WS upgrade still gated by Basic Auth.** When Basic Auth is configured, the upgrade handler runs `tryBasicAuth(req)` and rejects with `401 Unauthorized` (or `429 Too Many Requests` when the rate limiter trips) before allowing the handshake. With Basic Auth disabled, the gate is skipped, mirroring HTTP behavior.
- **Symbol cannot be forged.** `WS_PROXY_AUTH_BYPASS` is a module-scoped `Symbol`. HTTP headers and query strings cannot create same-Symbol properties on a request object — only code with access to the import sees the Symbol value.
- **Application-layer middleware still runs.** cookieSession, CSRF, and `requireLoginMiddleware` execute on every dispatched request. Unauthenticated callers (no valid session, no valid CSRF token) are rejected by these gates regardless of the bypass marker.

### Heartbeat and Keepalive

To prevent spurious disconnects (code=1006) caused by NAT timeouts, idle proxies, or network switches, the server sends WebSocket protocol-level pings every 30 seconds. The application-level `ping`/`pong` message pair provides an additional keepalive layer. Both mechanisms ensure dead TCP connections are detected promptly, allowing the client to trigger reconnection before user-visible failures occur.

### Stream Offset Recovery

If a WS connection drops mid-stream, the backend keeps the internal dispatch running and buffers all response chunks. When the client reconnects and sends a `{ type: "resume", id, fromChunk }` message, buffered data starting at the specified offset is replayed and live streaming continues. This means even a brief network interruption does not lose content that has already been generated.

### Job Cleanup

Orphaned jobs (those with no WS connection attached) are cleaned up based on the `lastActivity` timestamp rather than `createdAt`. A job is considered stale if it has been idle (no chunks, no head, no end event) for longer than the orphan TTL, regardless of when it was created. Active jobs with a live WS connection are never killed by the cleanup interval.

## Reconnection and Recovery Capabilities

The WS proxy has multiple built-in robustness mechanisms:

### Heartbeat Keep-Alive

After the connection is established, the client and server periodically exchange heartbeat messages to ensure the connection remains active. If either side hasn't received a heartbeat for an extended period, it will proactively check the connection status.

### Automatic Reconnection on Disconnect

When the WebSocket connection is unexpectedly disconnected, the client automatically attempts to re-establish the connection without requiring manual user intervention.

### Stream Offset Recovery

If the connection is briefly interrupted during AI generation, the WS proxy supports **stream offset recovery** — after reconnecting, it continues receiving generated content from the breakpoint rather than starting over. This means that even with a brief network interruption, you won't lose content that has already been generated.

## Use Cases

The following scenarios are particularly suitable for using the WS proxy:

- **Mobile device usage** — Maintaining uninterrupted generation when switching between networks (Wi-Fi ↔ cellular)
- **Remote server deployment** — Accessing Luker deployed on a remote server through an unstable network
- **Long text generation** — Reducing failures caused by timeouts when generating longer responses
- **Enterprise network environments** — Bypassing network devices that may interfere with long connections

::: tip
The WS proxy is Luker's internal transport optimization, transparent to users — you don't need any additional configuration, Luker will automatically use it when appropriate.
:::

## Related Pages

- [Performance Optimization](/improvements/performance) — Other performance improvements
- [Generation Layer](/improvements/generation-layer) — Luker's unified generation architecture
