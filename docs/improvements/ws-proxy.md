# WebSocket Proxy

The WebSocket proxy carries AI generation requests over one persistent connection instead of opening a new HTTP connection for every request. It is built for mobile networks, cross-border links and networks that cut long-lived connections, and it reduces generation failures mid-stream.

## The problem it solves

In the traditional mode, each generation is an independent HTTP request. A brief network drop, a mobile handover or a proxy timeout can interrupt the request and lose everything generated so far.

The WebSocket proxy keeps a long-lived connection between the page and the Luker server, and all generation requests share it. The connection reconnects after a drop; if it breaks during generation, the stream resumes from the last received point instead of starting over.

```d2
direction: down

HTTP: "Plain HTTP: a new connection per request" {
  H1: "Client"
  H2: "Server"
  H3: "Client"
  H4: "Server"
  H5: "Client"
  H6: "Server"

  H1 -> H2: "TCP + TLS handshake"
  H2 -> H1: "Response, then close" {style.stroke-dash: 3}
  H3 -> H4: "TCP + TLS handshake"
  H4 -> H3: "Response, then close" {style.stroke-dash: 3}
  H5 -> H6: "TCP + TLS handshake"
  H6 -> H5: "Response, then close" {style.stroke-dash: 3}
}

WS: "WebSocket proxy: one persistent tunnel" {
  W1: "Client"
  W2: "Server"

  W1 <-> W2: "Connect once"
  W2 <-> W1: "Heartbeat keeps it alive; requests share the link" {style.stroke-dash: 3}
}
```

## When it helps

- A phone moves between Wi-Fi and cellular.
- Luker runs on a remote server reached over an unstable network.
- Long replies are likely to be cut by a proxy or firewall.
- A corporate network closes idle HTTP connections.

The proxy is transparent. Luker uses it when appropriate; no configuration is required.

## Reliability

**Heartbeat**: client and server exchange periodic heartbeats so intermediate devices do not close an idle connection.

**Automatic reconnect**: after an unexpected disconnect, the client reconnects without a page reload.

**Resume from offset**: if the connection drops during generation, the client resumes from the last received position without duplicating or losing content.

**Task cleanup**: generations with no activity are cleaned up, while a generation that is still producing output is left alone.

## Security

The proxy does not bypass login, session or CSRF checks. It verifies the current login when the tunnel is established, and every request still passes the same middleware as ordinary HTTP. Connection credentials are short-lived, single-use, never placed in the URL, and cannot be forged through headers or query parameters.

## Related pages

- [Performance](/improvements/performance) — other performance work
- [Unified generation layer](/improvements/generation-layer) — how generation requests are handled
- [Remote access](/guide/remote-access) — reaching Luker from outside the LAN
