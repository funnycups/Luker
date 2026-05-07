# Unified Generation Layer

The Unified Generation Layer is a backend architecture improvement introduced by Luker that consolidates generation logic scattered across various API endpoints into a shared module, achieving unified wrapping for multiple backends.

## Problem Background

In SillyTavern, different AI backends (OpenAI, Anthropic, Google, Kobold, etc.) each have independent code paths. Each backend endpoint file independently handles request construction, streaming response parsing, error handling, and other logic. This leads to the following issues:

- **Duplicated code** — Similar streaming processing and error retry logic is duplicated across multiple files
- **Inconsistent behavior** — Token statistics and error response formats differ across backends
- **Hard to extend** — Adding a new backend requires implementing the complete request/response processing chain from scratch
- **No unified metering** — Lacks cross-backend token usage tracking capability

## Solution

Luker introduces a Unified Generation Layer endpoint (`/api/backends/luker-generation`) as the primary path for the frontend to initiate AI generation requests. This endpoint receives generation requests from the frontend, forwards them to the corresponding upstream API based on the current Chat Completion Source, and completes streaming response handling, token metering, generation acknowledgment, and persistence within a unified processing pipeline.

### Multi-Backend Unified Wrapping

The Unified Generation Layer supports unified processing for the following backends:

- **OpenAI** and its compatible APIs
- **Anthropic** (Claude)
- **Google** (Gemini / Vertex AI)
- **Kobold** / **TabbyAPI**
- Other Chat Completion compatible backends

The frontend initiates generation requests through the Unified Generation Layer, which is responsible for routing to the correct upstream service, rather than the frontend directly calling each backend's independent endpoint. The individual backend endpoints (`chat-completions.js`, `kobold.js`, etc.) still exist and independently integrate the Request Inspector, but the Unified Generation Layer provides a more complete processing pipeline.

### Shared Token Metering

The Unified Generation Layer automatically calls the [Request Inspector](/improvements/request-inspector) before and after generation requests:

1. After streaming completes, calls `completeInspectionFromStream` to record token usage from stream events
2. On generation failure, calls `failInspection` to record error information
3. On generation abort, calls `abortInspection` to record the interruption

Note: `startInspection` is called by the backend endpoint (e.g. `chat-completions.js`), not by the generation layer itself.

This ensures that regardless of which backend is used, token consumption is accurately tracked.

### Unified Streaming Processing

For SSE streaming responses, the Unified Generation Layer provides shared stream parsing logic:

- Parses SSE event formats from different backends
- Extracts token usage information from streaming events
- Unified stream interruption and recovery handling
- Works with the [WebSocket Proxy](/improvements/ws-proxy) to support stream offset recovery

### Unified Error Handling

Different backends return errors in various formats. The Unified Generation Layer normalizes them into a consistent error response structure, simplifying the frontend's error handling logic.

## Architecture Relationship

```d2
direction: down

FE: "Frontend initiates AI generation request"
EP: "Per-backend endpoint files\nchat-completions.js / kobold.js / ..." {
  shape: diamond
}
UL: "Unified Generation Layer\n/api/backends/luker-generation" {
  style.fill: "#e1f5ff"
}
INSP: "Request Inspector\nToken metering" {
  style.fill: "#fff3e0"
}
SSE: "SSE stream parsing\nUnified stream handling"
ERR: "Error normalization"
UPSTREAM: "Upstream AI service\nOpenAI / Anthropic / Google / Kobold ..."

FE -> EP
EP -> INSP: "startInspection"
EP -> UL
UL -> SSE
UL -> INSP
UL -> ERR
UL -> UPSTREAM
UPSTREAM -> SSE: "streaming response" {style.stroke-dash: 3}
SSE -> INSP: "completeInspectionFromStream"
ERR -> INSP: "failInspection"
```

> [!NOTE]
> The Unified Generation Layer is an internal module, transparent to the frontend. Users don't need to be aware of its existence — just enjoy the consistent experience it provides.

## Relationship with Other Modules

- **[Request Inspector](/improvements/request-inspector)** — The Unified Generation Layer is the primary caller of the Request Inspector
- **[Auth & Quota](/improvements/auth-and-quota)** — Storage quota middleware executes before the Unified Generation Layer, intercepting over-quota requests
- **`chats.js`** — After generation completes, triggers the `acknowledge-generation` flow to associate generation results with chat records
