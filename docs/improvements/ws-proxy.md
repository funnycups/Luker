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
