# Request Inspector

The Request Inspector is one of Luker's core backend modules, used to track the complete lifecycle of each AI generation request from initiation to completion, and record detailed token usage data. It serves as the infrastructure for generation diagnostics.

## Problem Background

In SillyTavern, after an AI generation request is sent, the backend does not systematically record the request's token consumption. Users cannot know how many tokens each generation actually cost, and administrators cannot track resource usage in multi-user scenarios.

Luker implements a complete request lifecycle tracking system, covering both text generation and image generation requests.

## Core Capabilities

### Request Lifecycle Tracking

Each AI generation request goes through the following state transitions:

1. **Start** (`startInspection`) — Records request metadata, marks the request as being tracked
2. **Complete** (`completeInspection`) — Request returns successfully, records token usage
3. **Fail** (`failInspection`) — Request errors out, records error information
4. **Abort** (`abortInspection`) — User actively cancels generation

### Token Usage Statistics

The Request Inspector records detailed token data for each generation:

- **Prompt Tokens** — Tokens consumed by the input prompt
- **Completion Tokens** — Tokens consumed by the model's generated content
- **Total Tokens** — Total usage

This data is extracted from API responses and associated with user accounts for usage statistics and diagnostic analysis.

### Token Statistics for Streaming Responses

For streaming (SSE) responses, token usage information is typically contained in the last SSE event. The Request Inspector extracts the `usage` field from SSE event streams through the `completeInspectionFromStream` and `extractUsageFromStreamEvents` functions, ensuring accurate token consumption statistics for streaming generation as well.

### Image Generation Request Tracking

Beyond text generation, the Request Inspector also supports tracking image generation requests. Through independent `startImageInspection` / `completeImageInspection` / `failImageInspection` functions, it covers request recording for all image generation backends.

## Key Functions

| Function | Purpose |
|----------|--------|
| `startInspection(requestId, metadata)` | Start tracking a generation request |
| `completeInspection(requestId, result)` | Mark request as complete and record results |
| `failInspection(requestId, error)` | Mark request as failed |
| `abortInspection(requestId)` | Mark request as aborted |
| `completeInspectionFromStream(requestId, events)` | Extract usage from streaming events and complete tracking |
| `extractUsageFromStreamEvents(events)` | Extract token usage from SSE event arrays |
| `startImageInspection(requestId, metadata)` | Start tracking an image generation request |
| `completeImageInspection(requestId, result)` | Complete image generation tracking |
| `failImageInspection(requestId, error)` | Mark image generation as failed |

## Integration Points

The Request Inspector is called by the following modules:

- **`chat-completions.js`** — Records token usage in OpenAI-compatible API calls
- **Unified Generation Layer** — Called uniformly within the [Unified Generation Layer](/improvements/generation-layer)
- **`chats.js`** — Associates generation results in the `acknowledge-generation` endpoint

## Token Usage Statistics

The token usage tracked by the Request Inspector is an independent statistics feature that helps users and administrators understand the resource consumption of AI generation. This is separate from the storage quota management in [Auth & Quota](/improvements/auth-and-quota):

- **Token usage statistics**: The Request Inspector records token consumption for each AI generation, providing usage visualization and diagnostic data
- **Storage quota management**: Manages the allocation and limits of file storage space

> [!TIP]
> The Request Inspector is automatically initialized through `server-startup.js` when the server starts, requiring no additional configuration.
