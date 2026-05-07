# WebSocket Proxy

Luker provides a WebSocket (WS) proxy feature that transmits AI generation requests through a persistent WebSocket tunnel, replacing the traditional HTTP request approach. This is especially useful in environments with unstable or restricted networks.

## What is WS Proxy

In the traditional approach, each AI generation request is an independent HTTP request. If the network fluctuates, the request may be interrupted, causing generation results to be lost.

The WS proxy transmits these requests through a **persistent WebSocket connection**. Once a WebSocket connection is established, it remains open, and all generation requests and responses communicate bidirectionally through this connection, without the need to repeatedly establish new connections.

```d2
direction: down

HTTP: "Traditional HTTP: new connection each time" {
  H_C1: "Client"
  H_S1: "Server"
  H_C2: "Client"
  H_S2: "Server"
  H_C3: "Client"
  H_S3: "Server"

  H_C1 -> H_S1: "new TCP+TLS"
  H_S1 -> H_C1: "respond + close" {style.stroke-dash: 3}
  H_C2 -> H_S2: "new TCP+TLS"
  H_S2 -> H_C2: "respond + close" {style.stroke-dash: 3}
  H_C3 -> H_S3: "new TCP+TLS"
}

WS: "WS proxy: persistent tunnel" {
  W_C: "Client"
  W_S: "Server"

  W_C <-> W_S: "establish WS once"
  W_S <-> W_C: "heartbeat + multi-request reuse" {style.stroke-dash: 3}
}
```

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

## Reconnection and Recovery Capabilities

The WS proxy has multiple built-in robustness mechanisms:

### Heartbeat Keep-Alive

After the connection is established, the client and server periodically exchange heartbeat messages to ensure the connection remains active. If either side hasn't received a heartbeat for an extended period, it will proactively check the connection status.

### Automatic Reconnection on Disconnect

When the WebSocket connection is unexpectedly disconnected, the client automatically attempts to re-establish the connection without requiring manual user intervention.

### Stream Offset Recovery

If the connection is briefly interrupted during AI generation, the WS proxy supports **stream offset recovery** — after reconnecting, it continues receiving generated content from the breakpoint rather than starting over. This means that even with a brief network interruption, you won't lose content that has already been generated.

## Internal Dispatch Mechanism

The WS proxy is two-staged: **the upgrade is gated by a single-use ticket**, and **dispatched requests run through `app.handle()` in-process**. Application-layer middleware (cookieSession, CSRF, login checks) still runs on every dispatched request, but Basic Auth — an HTTP-only gate — is verified once at ticket issuance, so the WS channel itself becomes the auth boundary.

```d2
direction: down

LOGIN: "Page already logged in\nbasicAuth + cookieSession established"
TICKET_REQ: "Client POST /api/ws-ticket\n(runs full HTTP middleware stack)"
TICKET_RESP: "Server mintTicket\n32-byte random hex, 30s TTL, single use" {
  style.fill: "#fff3e0"
}
UP: "new WebSocket(url, [luker-ws-ticket.<ticket>])\nJS puts ticket into Sec-WebSocket-Protocol"
GATE: "server.on('upgrade')\nparse subprotocol → consumeTicket" {
  style.fill: "#fff3e0"
}
WS_MSG: "WebSocket message\nchannel is now trusted"

DISPATCH: "Dispatch path" {
  GOOD_MOCK: "Build mock req/res\ntag with WS_PROXY_AUTH_BYPASS Symbol"
  GOOD_HANDLE: "app.handle(req, res)"
  GOOD_BASIC: "Basic Auth middleware\nsees Symbol → short-circuit"
  GOOD_REST: "cookieSession / CSRF /\nrequireLogin run normally"
  GOOD_RES: "Streaming chunks tunneled back over WS" {
    style.fill: "#e8f5e9"
  }
  GOOD_MOCK -> GOOD_HANDLE -> GOOD_BASIC -> GOOD_REST -> GOOD_RES
}

LOGIN -> TICKET_REQ -> TICKET_RESP -> UP -> GATE
GATE -> WS_MSG: "pass"
WS_MSG -> DISPATCH.GOOD_MOCK: "dispatch"
```

### Why a ticket and not the `Authorization` header

Native browser `WebSocket` does not let JavaScript set HTTP headers, so the upgrade can only carry whatever credentials the underlying environment chooses to attach. iOS Safari, in-app WKWebView wrappers, frpc / cloudflared, and several nginx setups all **strip `Authorization` from WebSocket upgrades** even when the same browser happily attaches it to ordinary HTTP requests. The result is an upgrade that looks successful but produces `401 missing_authorization` on every dispatched request.

`Sec-WebSocket-Protocol` is a WebSocket-protocol field that JS *can* populate via `new WebSocket(url, protocols)`, and intermediaries do not mangle it. We therefore mint the ticket on the HTTP path (where `Authorization` is reliable) and present it through the subprotocol header — sidestepping the "WebSocket can't carry headers" limitation entirely.

### How it works

1. **Mint a ticket.** The client `POST`s to `/api/ws-ticket`, which is mounted in `setupPrivateEndpoints` and therefore protected by the full HTTP middleware stack: Basic Auth, cookieSession, setUserData, requireLogin, CSRF. The server returns `{ ticket }` — a 64-character hex string from `crypto.randomBytes(32)`, recorded in an in-process `Map` with a 30-second TTL.
2. **Carry it on upgrade.** The client opens `new WebSocket('/ws/proxy', [`luker-ws-ticket.${ticket}`])`. The browser writes the value into `Sec-WebSocket-Protocol`.
3. **Validate at upgrade.** `server.on('upgrade')` extracts the ticket and calls `consumeTicket()`, which atomically validates and removes it (single-use). On failure the proxy writes `HTTP/1.1 401` and destroys the socket.
4. **Echo the protocol.** `wss.handleUpgrade` invokes the configured `handleProtocols` callback, which selects the same `luker-ws-ticket.<ticket>` string back; `ws` writes it into the `101 Switching Protocols` response so the handshake completes.
5. **Build a mock request.** `startJob` constructs an `IncomingMessage` over a `Readable` socket (Node's internal `_destroy`/`eos` plumbing requires a real Readable), pushes the body, and pushes `null` to signal end-of-body.
6. **Mark dispatched.** The mock request is tagged with the `WS_PROXY_AUTH_BYPASS` Symbol exported from `basicAuth.js`. The Symbol is module-scoped, so headers / query / body fields can never set a same-keyed property on the request object.
7. **`app.handle(req, res)`.** The request flows through every Express middleware: cookieSession parses the cookie, setUserData populates `request.user`, CSRF validates the token, requireLogin gates by login state, and basicAuth — seeing the Symbol — short-circuits.
8. **Stream responses.** A mock `ServerResponse` (over a `Writable` sink) intercepts `writeHead` / `setHeader` / `write` / `end` and forwards them through the WS tunnel as `{ type: "head" }` / `{ type: "chunk" }` / `{ type: "end" }` messages.

### Security boundary

| Threat | HTTP path today | Ticket scheme |
|---|---|---|
| Anonymous caller | basicAuth blocks | `/api/ws-ticket` blocked by basicAuth — no ticket |
| Stolen cookie alone | basicAuth blocks (no Auth header) | `/api/ws-ticket` blocked by basicAuth — no ticket |
| Stolen basicAuth alone | requireLogin blocks (no session) | `/api/ws-ticket` blocked by requireLogin — no ticket |
| Both stolen | full access | full access — no new attack surface |
| Ticket in transit (MITM) | n/a | 30 s TTL + single-use, infeasible over HTTPS |
| Ticket replay | n/a | single-use, deleted on consume |

- **Tickets do not carry user identity.** They authorize *channel access* only. Per-user identity is decided on every dispatched request by `cookieSession` + `setUserDataMiddleware` + `requireLoginMiddleware`. A stolen ticket gives an attacker exactly nothing if they don't also have a valid login session — and if they have one, they could mint their own ticket anyway.
- **The Symbol cannot be forged.** `WS_PROXY_AUTH_BYPASS` is a module-private `Symbol`; no header, query parameter, or body field can install a same-key property on the request object.
- **Application-layer middleware still runs.** cookieSession, CSRF, setUserData, and requireLogin gate every dispatched request regardless of the bypass marker. Unauthenticated callers — even those holding a valid ticket — are still rejected.

### Connection Robustness

- **Heartbeat keepalive**: Client and server periodically exchange heartbeat messages, preventing intermediate network devices from timing out idle connections
- **Stream offset recovery**: If the connection briefly drops mid-generation, the client can reconnect and resume from the breakpoint
- **Job cleanup**: Stale jobs are detected via the `lastActivity` timestamp rather than `createdAt`, ensuring active long-running generations are never killed by accident
- **Re-mint ticket on reconnect**: Each reconnection first calls `POST /api/ws-ticket` for a fresh ticket; the old ticket has already been consumed and cannot be reused.


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
