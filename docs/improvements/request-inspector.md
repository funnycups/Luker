# Request Inspector

The Request Inspector is one of Luker's core backend modules, used to track the complete lifecycle of each AI generation request from initiation to completion, and record detailed token usage data. It serves as the infrastructure for generation diagnostics.

## Problem Background

In SillyTavern, after an AI generation request is sent, the backend does not systematically record the request's token consumption. Users cannot know how many tokens each generation actually cost, and administrators cannot track resource usage in multi-user scenarios.

Luker implements a complete request lifecycle tracking system, covering text generation, image generation, and vector-embedding / rerank requests.

## Core Capabilities

### Request Lifecycle Tracking

Each AI generation request goes through the following state transitions:

1. **Start** — Records request metadata, marks the request as being tracked
2. **Complete** — Request returns successfully, records token usage
3. **Fail** — Request errors out, records error information
4. **Abort** — User actively cancels generation

```d2
direction: down

start: "" {
  shape: circle
  width: 20
  style.fill: "#222"
}
in_progress: "in_progress"
done: "completed"
failed: "failed"
aborted: "aborted"
end_: "" {
  shape: circle
  width: 20
  style.fill: "#222"
}

note: "Streaming responses extract usage from the final SSE event of the stream" {
  shape: text
  style.fill: "#fff8d4"
}

start -> in_progress: "records metadata"
in_progress -> done: "records token usage"
in_progress -> failed: "records error message"
in_progress -> aborted: "user cancels"
done -> end_
failed -> end_
aborted -> end_
in_progress -- note: {style.stroke-dash: 3}
```

### Token Usage Statistics

The Request Inspector records detailed token data for each generation:

- **Prompt Tokens** — Tokens consumed by the input prompt
- **Completion Tokens** — Tokens consumed by the model's generated content
- **Total Tokens** — Total usage

This data is extracted from API responses and associated with user accounts for usage statistics and diagnostic analysis.

### Token Statistics for Streaming Responses

For streaming (SSE) responses, token usage information is typically contained in the last SSE event. The Request Inspector extracts the `usage` field from the SSE event stream, ensuring accurate token consumption statistics for streaming generation as well.

### Image Generation Request Tracking

Beyond text generation, the Request Inspector also tracks image generation requests, covering every image generation backend.

### Embedding & Rerank Request Tracking

The Request Inspector also spans the vector subsystem, recording embedding, query, and rerank calls sent to every remote vector provider (OpenAI, Cohere, Jina, Ollama, VLLM, Voyage, and so on) and the KoboldCpp direct-embed bridge. Local-only inference sources that never leave the process are skipped so the ring buffer stays focused on actual upstream traffic.

## Relation to Storage Quotas

The token usage tracked by the Request Inspector is an independent statistics feature that helps users and administrators understand the resource consumption of AI generation. This is separate from the storage quota management in [Auth & Quota](/improvements/auth-and-quota):

- **Token usage statistics**: The Request Inspector records token consumption for each AI generation, providing usage visualization and diagnostic data
- **Storage quota management**: Manages the allocation and limits of file storage space

> [!TIP]
> The Request Inspector starts automatically with the server; no additional configuration is required.
