# Incremental Sync

Incremental Sync is Luker's fundamental improvement to SillyTavern's data transmission architecture, replacing full overwrites with incremental patches to dramatically reduce bandwidth consumption and eliminate concurrent write conflicts.

## Problem Background

SillyTavern's data saving uses a full-transmission model: every modification (even editing a single character in one message) serializes the entire chat history and sends it to the backend for overwrite. This causes several serious issues:

- **Bandwidth waste** — A chat history with hundreds of messages can be hundreds of MB (especially when some plugins store large amounts of data in chat metadata), and every operation requires transmitting the full data
- **Write conflicts** — When multiple tabs or devices operate simultaneously, later writes overwrite earlier ones, causing data loss
- **Performance bottleneck** — Serialization and transmission of large chat histories is itself a performance burden
- **Save latency** — The I/O overhead of full writes makes real-time saving impossible

```d2
direction: right

LK: "Luker: incremental patch" {
  style.fill: "#e8f5e9"
  edit: "User edits one char"
  diff: "Diff changed fields"
  patch: "Send 1-2 KB patch"
  apply: "Patch by line index"
  edit -> diff -> patch -> apply
}

ST: "SillyTavern: full overwrite" {
  style.fill: "#fff3e0"
  edit: "User edits one char"
  full: "Serialize whole chat (hundreds of MB)"
  overwrite: "Overwrite full file"
  edit -> full -> overwrite
}
```

## Incremental Endpoints

Luker introduces three incremental endpoints covering different modification scenarios for chat data:

### Append Messages (append)

When a user sends a new message or AI generates a new reply, only the new message needs to be appended to the end of the chat file, rather than rewriting the entire file. This is the most common operation path and the scenario with the greatest performance benefit.

After receiving the request, the backend directly appends the new message to the end of the file with O(1) time complexity, independent of the total length of the chat history. The backend also performs deduplication checks on the last stored message to prevent duplicate appends caused by network retries.

### Patch Messages (patch)

When a user edits an existing message (such as modifying content, switching swipes, or updating message metadata), specific lines are patched by message index, updating only the changed messages.

Supports batch patching of multiple messages in a single request, with idempotency — automatically detecting already-applied operations and skipping duplicate submissions.

### Update Metadata (patch-metadata)

When chat metadata (such as title, tags, chat settings, etc.) changes, deep merge is used for updates rather than replacing the entire metadata object.

Deep merge means only fields included in the request are updated; unmentioned fields remain unchanged. This is especially important for chats containing extensive extension metadata.

## Integrity Hash Concurrent Conflict Detection

After each write operation completes, the backend generates a new UUID, writes it to the [chat state file](/improvements/backend-storage#chat-state-file), and returns it in the response. The frontend caches this value and includes it in subsequent write requests:

1. **Match** — Write executes normally, returns a new integrity UUID
2. **Mismatch** — Returns `409 Conflict`, indicating the file has been modified by another source since the last operation

This fundamentally prevents concurrent write conflicts — whether in multi-tab, multi-device, or multi-user scenarios.

```d2
shape: sequence_diagram

FE: "Frontend"
BE: "Backend"
State: "Chat state file"

First write: integrity matches: {
  FE -> BE: "PATCH (carries integrity=A)"
  BE -> State: "Read current integrity=A"
  BE -> BE: "Match → apply patch"
  BE -> State: "Write new integrity=B"
  BE -> FE: "200 OK + integrity=B"
}

Concurrent: another source already wrote: {
  FE -> BE: "PATCH (carries integrity=B)"
  BE -> State: "Read current integrity=C\n(modified by another tab)"
  BE -> BE: "Mismatch B ≠ C"
  BE -> FE: "409 Conflict"
  FE -> FE: "Re-fetch latest data"
  FE -> BE: "Retry based on latest state\n(carries integrity=C)"
}
```

::: warning Conflict Handling
When receiving a `409 Conflict`, the frontend needs to re-fetch the latest data and retry based on the latest state. This ensures data consistency, but also means that in extreme concurrency scenarios, users may need to wait for the retry to complete.
:::

::: info Design Reference
The metadata update endpoint's design references the concepts of [RFC 6902](https://datatracker.ietf.org/doc/html/rfc6902) (JSON Patch), achieving incremental updates through structured operations. The message patch endpoint is simplified for line-based storage — using line indexes for positioning, which is more suitable for the linear structure of chat histories.
:::

## Incremental Patch Saving for Settings Data

Beyond chat data, Luker's settings data (user preferences, extension configurations, preset parameters, etc.) also supports incremental patch saving. Settings changes are applied to the server-side settings file through deep merge, also with integrity hash conflict detection, preventing settings loss from concurrent modifications.

This means modifying a single sampling parameter no longer requires transmitting the entire settings object — only the changed fields need to be sent.

## Debounce Mechanism

To avoid excessive network requests from frequent small modifications, incremental sync implements a debounce mechanism:

- Multiple modifications within a short time window are combined into a single patch request
- When a user continuously edits messages, the actual network request is only triggered after a pause
- Settings changes also use delayed merging, avoiding a flood of requests from operations like slider dragging

Debouncing reduces network overhead without compromising data safety — because [Backend Real-Time Storage](/improvements/backend-storage) ensures data is immediately persisted once it reaches the server.

## Collaboration with Backend Real-Time Storage

Incremental Sync works closely with [Backend Real-Time Storage](/improvements/backend-storage) to form a complete data safety chain:

1. Frontend detects data changes
2. Debounce merges multiple modifications within a short time window
3. Sends incremental patch request (carrying integrity UUID)
4. Frontend serializes local write tasks through the [serialized chat write flow](/improvements/backend-storage#serialized-chat-writes)
5. Backend verifies integrity → Applies patch → Persists to disk → Updates state file
6. Returns new integrity UUID for the next request

This flow ensures a complete chain from frontend data changes to disk persistence, both efficient and safe.

::: tip Performance Benefits
For a chat history with 500 messages, when editing one message: SillyTavern needs to transmit approximately 2-5 MB of full data, while Luker only needs to transmit approximately 1-2 KB of patch data. The difference is especially noticeable on mobile networks or in high-latency environments.
:::

## Related Pages

- [Backend Real-Time Storage](/improvements/backend-storage) — The backend counterpart to incremental sync
- [Improvements Overview](/improvements/overview) — Overview of all technical improvements
