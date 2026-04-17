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

If the state file doesn't exist (e.g., chats migrated from older versions), the system automatically falls back and creates the state file on the first write.

## Generation Acknowledge

In AI generation scenarios, Luker's Unified Generation Layer implements a Generation Acknowledge mechanism. When the backend completes a generation and persists the result, it confirms in the response that the generation result has been safely stored on the server side.

This means that even if the frontend crashes immediately after receiving the generation result, data won't be lost — because the backend has already completed persistence before returning the response. After receiving the confirmation, the frontend updates its local integrity state to stay in sync with the server.

::: tip Comparison with Traditional Approach
In SillyTavern, AI generation results first arrive at the frontend, which decides when to save. If the frontend crashes before saving, the generated content is lost. Luker's Generation Acknowledge moves the save timing to before the backend response, fundamentally eliminating this window of vulnerability.
:::

## Serialized Chat Writes {#serialized-chat-writes}

To prevent file corruption from concurrent writes, Luker uses a serialization queue to ensure write operations to the same chat file are executed in order.

When multiple write requests arrive simultaneously (e.g., the user rapidly edits multiple messages, or generation completion and user editing happen at the same time), the serialization queue will:

1. Queue requests in arrival order
2. Execute write operations one by one
3. Update the integrity UUID after each write completes
4. If an integrity mismatch is detected while queued, return `409 Conflict`

This ensures that even in high-concurrency scenarios, chat files won't experience data corruption or partial writes.

## Collaboration with Incremental Sync

Backend real-time storage works closely with [Incremental Sync](/improvements/incremental-sync):

- Incremental sync handles "what to transmit" — only transmitting changed data
- Backend real-time storage handles "how to store" — ensuring data is safely persisted
- The chat state file bridges the two — coordinating frontend and backend state through the integrity UUID

Together, they form the foundation of Luker's data safety infrastructure.

## Related Pages

- [Incremental Sync](/improvements/incremental-sync) — The frontend counterpart to backend real-time storage
- [Improvements Overview](/improvements/overview) — Overview of all technical improvements
