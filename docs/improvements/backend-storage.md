# Backend Real-Time Storage

Luker has redesigned the data persistence architecture, shifting the responsibility of saving data changes from the frontend to the backend, achieving real-time persistence and fundamentally eliminating the risk of data loss caused by browser crashes, network interruptions, or unexpected closures.

## Problem Background

In SillyTavern, data saving is triggered by the frontend: the frontend serializes the complete chat data and sends it to the backend for overwrite. This pattern has serious data safety risks:

- **Browser crashes** — If the browser crashes before the save request is sent, all unsaved modifications are lost
- **Network interruptions** — Save requests may fail due to network issues, and the frontend may not retry
- **Generation interruptions** — If the connection drops during AI generation, the generated content may not be saved
- **Race conditions** — Concurrent save requests may cause data overwrites

Luker thoroughly solves these problems through backend real-time storage.

## Real-Time Data Persistence

All data changes arriving at the backend through [Incremental Sync](/improvements/incremental-sync) endpoints are immediately written to disk. The backend does not use in-memory caching or delayed writes — after each append, patch, or metadata update operation completes, the data is safely persisted to the file system.

After the write completes, the backend updates the chat state file, recording the new integrity UUID and timestamp, ensuring subsequent operations can correctly detect concurrent conflicts.

## Chat State File {#chat-state-file}

Each chat file has a corresponding state file stored in the same directory as the chat file. The state file records:

- **integrity** — The current file's integrity UUID, used for [concurrent conflict detection](/improvements/incremental-sync#integrity-hash-concurrent-conflict-detection)
- **updated_at** — Timestamp of the last write

The state file is stored separately from the chat file, avoiding full-file rewrites caused by frequently updating the integrity value within the chat file.

```d2
direction: right

DIR: "chats/<character>/"
CHAT: "{chat}.jsonl" {
  style.fill: "#e1f5ff"
}
STATE: "{chat}.luker-state.chat_sync.json" {
  style.fill: "#fff3e0"
}
NS1: "{chat}.luker-state.memory_graph__meta.json"
NS2: "{chat}.luker-state.luker_orchestrator__schema.json"

DIR -> CHAT
DIR -> STATE
DIR -> NS1
DIR -> NS2
```

- `{chat}.jsonl` — Chat main file
- `{chat}.luker-state.chat_sync.json` — integrity + updated_at (sync metadata)
- `{chat}.luker-state.<namespace>.json` — Per-plugin namespace state (one independent sidecar per plugin)

If the state file doesn't exist (e.g., chats migrated from older versions), the system automatically falls back and creates the state file on the first write.

## Generation Acknowledge

In AI generation scenarios, Luker's Unified Generation Layer implements a Generation Acknowledge mechanism. When the backend completes a generation and persists the result, it confirms in the response that the generation result has been safely stored on the server side.

```d2
shape: sequence_diagram

FE: "Frontend"
BE: "Backend (unified generation layer)"
LLM: "Upstream LLM"
Disk: "Disk"

FE -> BE: "Initiate AI generation request"
BE -> LLM: "Forward request"
LLM -> BE: "Streaming response"
BE -> Disk: "Persist generation result in real-time"
Disk -> BE: "Write complete"
BE -> FE: "Return response + acknowledge"
FE -> FE: "Update local integrity state"

BE."Even if the frontend crashes after receiving ack, data is on disk"
```

This means that even if the frontend crashes immediately after receiving the generation result, data won't be lost — because the backend has already completed persistence before returning the response. After receiving the confirmation, the frontend updates its local integrity state to stay in sync with the server.

::: tip Comparison with Traditional Approach
In SillyTavern, AI generation results first arrive at the frontend, which decides when to save. If the frontend crashes before saving, the generated content is lost. Luker's Generation Acknowledge moves the save timing to before the backend response, fundamentally eliminating this window of vulnerability.
:::

## Serialized Chat Writes {#serialized-chat-writes}

To prevent write races and corruption, Luker serializes chat write tasks on the frontend (via `runSerializedChatWrite`), while the backend enforces integrity checks on every write.

When multiple write operations are triggered close together (e.g., rapid message edits, or generation completion overlapping with manual edits), the flow is:

1. Frontend write tasks are queued in arrival order
2. Tasks are executed one by one against incremental endpoints
3. After each successful write, the backend updates the integrity UUID in the chat state sidecar
4. If a queued request carries stale integrity, the backend returns `409 Conflict`

This client-side serialization plus backend integrity validation keeps writes ordered without relying on a backend in-memory write queue.

## Collaboration with Incremental Sync

Backend real-time storage works closely with [Incremental Sync](/improvements/incremental-sync):

- Incremental sync handles "what to transmit" — only transmitting changed data
- Backend real-time storage handles "how to store" — ensuring data is safely persisted
- The chat state file bridges the two — coordinating frontend and backend state through the integrity UUID

Together, they form the foundation of Luker's data safety infrastructure.

## Related Pages

- [Incremental Sync](/improvements/incremental-sync) — The frontend counterpart to backend real-time storage
- [Improvements Overview](/improvements/overview) — Overview of all technical improvements
