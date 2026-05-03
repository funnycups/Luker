# Chat & State

APIs for reading chat data, sending and editing messages, persisting chat metadata, and storing per-chat / per-character state.

## Chat Data (Read-Only)

The following properties provide read-only access to the current chat:

| Property | Type | Description |
|------|------|------|
| `context.chat` | `ChatMessage[]` | Current chat message array |
| `context.characters` | `Character[]` | Character list |
| `context.groups` | `Group[]` | Group list |
| `context.name1` | `string` | User name |
| `context.name2` | `string` | Character name |
| `context.characterId` | `number` | Current character ID |
| `context.groupId` | `string` | Current group ID |
| `context.chat_metadata` | `object` | Metadata of the current chat |
| `context.online_status` | `string` | API connection status |

## Messages API

Luker provides a unified high-level message API. Every operation is a full pipeline: memory update + DOM rendering + event emission + persistence.

### addMessages

```ts
addMessages(
 messages: ChatMessage | ChatMessage[],
 options?: { scroll?: boolean, silent?: boolean }
): Promise<number | number[]>
```

Adds one or more messages to the chat.

- Automatically pushes to `chat[]`, renders DOM, emits `MESSAGE_SENT`/`MESSAGE_RECEIVED` and `MESSAGE_RENDERED` events, and persists to backend
- When an array is passed, operations are batched with a single persistence call
- Returns the index of the new message(s) (`number` for single, `number[]` for batch)

```js
// Add a single message
const index = await context.addMessages({
 name: 'System',
 mes: 'This is a system message',
 is_system: true,
});

// Batch add
const indices = await context.addMessages([
 { name: 'User', mes: 'Hello', is_user: true },
 { name: 'Assistant', mes: 'Hi! How can I help?', is_user: false },
]);
```

### updateMessages

```ts
updateMessages(
 updates: { index: number, patch: object } | { index: number, patch: object }[],
 options?: { rerender?: boolean, silent?: boolean }
): Promise<void>
```

Updates one or more messages and persists the changes.

- Fields from the `patch` object are merged into `chat[index]`
- Automatically re-renders DOM, emits `MESSAGE_EDITED` and `MESSAGE_UPDATED` events, and persists via RFC 6902 incremental patch
- Batch operations are merged into a single persistence call

```js
// Update a single message
await context.updateMessages({
 index: 4,
 patch: { mes: 'Updated content' },
});

// Batch update
await context.updateMessages([
 { index: 3, patch: { mes: 'New content A' } },
 { index: 5, patch: { mes: 'New content B', extra: { model: 'gpt-4o' } } },
]);
```

### deleteMessages

```ts
deleteMessages(
 index: number | number[],
 options?: { swipe?: number, silent?: boolean }
): Promise<ChatMessage | ChatMessage[]>
```

Deletes one or more messages.

- Automatically removes from `chat[]`, cleans up DOM, emits `MESSAGE_DELETED` event, and persists via RFC 6902 incremental patch
- Batch deletion automatically handles index shifting
- When the `swipe` option is specified, only that specific swipe is deleted rather than the entire message
- Returns the deleted message object(s)

```js
// Delete a single message
const deleted = await context.deleteMessages(5);

// Batch delete
const deletedList = await context.deleteMessages([3, 5, 7]);

// Delete only a specific swipe
await context.deleteMessages(5, { swipe: 2 });
```

### getMessage

```ts
getMessage(index: number): Readonly<ChatMessage> | null
```

Retrieves the message at the specified index (read-only). Returns a Proxy object that throws an error on write attempts, guiding developers to use `updateMessages()`.

### getMessageCount

```ts
getMessageCount(): number
```

Returns the total number of messages in the current chat.

---

::: warning Deprecated Low-Level APIs
The following functions are still available but marked as deprecated. Plugin developers should use the unified API above:

- `addOneMessage()` → Use `addMessages()`
- `deleteLastMessage()` → Use `deleteMessages(chat.length - 1)`
- `deleteMessage()` → Use `deleteMessages()`
- `updateMessageBlock()` → Use `updateMessages()`
- `patchChatMessages()` → Low-level RFC 6902 transport, use `updateMessages()` / `deleteMessages()`
- `appendChatMessages()` → Low-level append transport, use `addMessages()`
:::

## Chat Persistence

### saveChatMetadata

```ts
saveChatMetadata(withMetadata?: object): Promise<boolean>
```

Saves chat metadata. If `withMetadata` is provided, it is merged into `chat_metadata` before saving.

## Chat State

Chat State is a new chat-bound state mechanism introduced by Luker, allowing plugins to bind structured data to a specific chat instead of stuffing it into `chat_metadata`.

### getChatState

```ts
getChatState(
  namespace: string,
  options?: { target?: ChatTarget }
): Promise<any | null>
```

Reads the chat state for a given namespace. Returns `null` if no data exists for that namespace.

- `namespace`: A unique identifier for the plugin; using the plugin name is recommended
- `target`: Optional; specifies the target chat (for cross-chat reads, e.g., branching scenarios)

### getChatStateBatch

```ts
getChatStateBatch(
  namespaces: string[],
  options?: { target?: ChatTarget }
): Promise<Record<string, any>>
```

Reads chat state for multiple namespaces in batch. Returns an object keyed by namespace.

### updateChatState

```ts
updateChatState(
  namespace: string,
  updater: (current: any) => any,
  options?: { target?: ChatTarget }
): Promise<{ ok: boolean }>
```

**Recommended read-modify-write approach.** The `updater` function receives the current state and returns the new state. The system automatically handles concurrency conflicts.

```js
await context.updateChatState('my-plugin', (current = {}) => ({
  ...current,
  counter: (current.counter || 0) + 1,
  lastUpdated: Date.now(),
}));
```

### deleteChatState

```ts
deleteChatState(
  namespace: string,
  options?: { target?: ChatTarget }
): Promise<{ ok: boolean }>
```

Deletes the chat state for a given namespace.

### Best Practices

- Use `updateChatState()` for read-modify-write instead of manually chaining `getChatState()` + `patchChatState()`
- Keep payloads as JSON-serializable plain objects
- Handle `ok: false` return values to keep your plugin UI resilient
- For large plugin data, prefer Chat State over `chat_metadata`
- If your state needs to follow swipes, message deletes, and chat switches automatically, use [Floor State](#floor-state) instead of writing reconciliation logic on top of `updateChatState`

## Floor State

Floor State is a thin layer on top of Chat State that tracks every write at the chat tail (floor index + swipe id) and replays the surviving commits whenever the chat structure changes. Plugins and CardApps that need state to follow swipes, deletes, and chat switches without reconciling manually should use this API instead of `updateChatState` directly.

### How it works

A floor state instance owns one chat-state namespace (`<ns>`) and a private commit log (`<ns>__floor_log`). Writes go through the instance's `update` method, which reads the current state, runs your reducer, computes the diff, applies it to the data namespace, and appends a commit. The instance subscribes to four chat events:

- `CHAT_CHANGED` — new chat opened; rebuild data from this chat's log
- `MESSAGE_SWIPED` — user switched swipes; rebuild data with the new active swipe
- `MESSAGE_DELETED` — chat truncated; drop commits at or beyond the new length, then rebuild
- `MESSAGE_SWIPE_DELETED` — a swipe was deleted on the chat tail; renumber the affected floor's commits, then rebuild

Each commit stores an incremental diff from the materialized state at commit time to the next state. Rebuild walks all commits in order, drops the ones whose `(floor, swipeId)` no longer matches the active swipe map, and applies the surviving patches sequentially against `{}`. Because deletions are tail-only — `MESSAGE_DELETED` truncates a suffix and `MESSAGE_SWIPE_DELETED` only fires on the chat tail — the surviving commits on the active path always form a contiguous chain, and incremental patches compose correctly.

### createFloorState

```ts
createFloorState(options: { namespace: string }): Promise<FloorStateInstance>
```

Use `getContext().createFloorState({ namespace })` from a plugin or CardApp. Each instance is bound to one namespace; create a separate instance per logical state slice.

```js
const ctx = SillyTavern.getContext();
const fs = await ctx.createFloorState({ namespace: 'my-plugin' });

// Recommended: reducer-style writes. The reducer receives the current state
// and returns the next state; the diff is computed and committed for you.
await fs.update((current) => ({ ...current, score: 10 }));
await fs.update((current) => ({ ...current, level: (current?.level ?? 0) + 1 }));
await fs.update((current) => {
    const { temp, ...rest } = current ?? {};
    return rest;
});

// Read current state:
const state = await fs.get();

// Wait for any in-flight rebuild to finish before reading:
await fs.ready();

// Detach event listeners (rarely needed; instances usually live for the page session):
fs.destroy();
```

::: warning
Reducers must return a plain object. Returning an array, primitive, `null`, or `undefined` is treated as "no change" and the call resolves without writing.
:::

### Attaching state to a non-tail floor

`update` accepts an optional second argument `{ floor, swipeId? }` that pins the commit to an explicit floor instead of the chat tail. The typical use case is a lagging write — e.g. a memory extension that summarizes at `chat.length - N` when the user has configured the last N floors to be excluded from generation.

```js
// floor only — swipeId is read from chat[floor].swipe_id
await fs.update(
    (current) => ({ ...current, summaries: { ...(current?.summaries ?? {}), 0: '...' } }),
    { floor: targetFloor },
);

// floor + swipeId pinned (e.g. backfilling state on a specific swipe)
await fs.update((current) => nextState, { floor: targetFloor, swipeId: 0 });
```

When `options` is omitted the chat tail is used. `floor` must be a valid index into the current `chat` (`0 <= floor < chat.length`); out-of-range, negative, non-integer, or negative `swipeId` overrides are rejected and the call returns `false`, so misuse fails fast instead of silently mis-attributing the commit.

::: tip
The override only changes what label this commit carries in the log — `MESSAGE_DELETED` still truncates by floor and `MESSAGE_SWIPE_DELETED` still renumbers by (floor, swipeId). Replay order is the log's insertion order; specifying a smaller `floor` does not "jump the queue" during rematerialize.
:::

### Advanced: pre-computed patches

If you already have an incremental RFC 6902 diff against the current materialized state — for example, you computed it yourself for performance reasons or you're driving a one-shot migration — you can call `instance.patch(operations, options?)` to append it directly. The operations MUST be diffed against `await fs.get()`; a snapshot-from-empty patch (one that overwrites the whole state) is not a valid commit because rebuild assumes each commit's patches compose with the prior surviving commits' patches.

For everything else, prefer `update` — it computes the right diff for you.

### When to await `ready()`

If your plugin reads floor-managed state inside an event handler that fires near the four structural events above (for example `GENERATION_STARTED` immediately after `CHAT_CHANGED`), call `await fs.ready()` first. The instance returns its currently-resolved promise when no rebuild is in flight, so the cost is minimal.

### Conventions

- One namespace, one owner. Don't mix `updateChatState(ns, ...)` and `floorState.update(...)` against the same namespace — the floor state rebuild will overwrite the raw write.
- Namespace strings ending in `__floor_log` are reserved for the private logs.
- Reducer return values must be plain objects; arrays, primitives, `null`, and `undefined` are ignored.

### Reference

- `createFloorState({ namespace })` — async factory; returns a frozen instance.
- `instance.update(reducer, options?)` — read-modify-write; reducer receives the current state and returns the next, the diff is computed and committed for you. Optional `options = { floor, swipeId? }` pins the commit to an explicit floor instead of the chat tail. **This is the recommended write API.**
- `instance.patch(operations, options?)` — advanced: append a commit whose patches you already computed yourself. Operations must be an incremental RFC 6902 diff (`buildObjectPatchOperationsAsync(prev, next)` against `await instance.get()`); not for snapshot-style overwrites. Same `options` shape as `update`.
- `instance.get()` — read the current data namespace.
- `instance.ready()` — resolves when no rebuild is in flight.
- `instance.destroy()` — detach event listeners and freeze the instance.

## Character State

Character state is persistent storage bound to the Character Card itself, shared across all chats for that character. Unlike chat state (which is scoped to a single chat), character state is suitable for storing cross-chat, character-level configuration.

### getCharacterState

```ts
getCharacterState(namespace: string): Promise<any | null>
```

Reads the character state data under the specified namespace. Returns `null` if no data has been stored for that namespace.

| Parameter | Description |
|------|------|
| `namespace` | Storage namespace, typically the plugin name (e.g., `'my-extension'`) |

### setCharacterState

```ts
setCharacterState(namespace: string, data: any): Promise<void>
```

Writes character state data under the specified namespace. Pass `null` as `data` to delete the state for that namespace.

| Parameter | Description |
|------|------|
| `namespace` | Storage namespace |
| `data` | Data to store (any serializable object); pass `null` to delete |

### Usage Example

```js
const context = Luker.getContext();

// Read character state
const state = await context.getCharacterState('my-extension');
console.log(state); // { someConfig: true } or null

// Write character state
await context.setCharacterState('my-extension', {
  someConfig: true,
  lastUpdated: Date.now(),
});

// Delete character state
await context.setCharacterState('my-extension', null);
```

### Character State vs Chat State

| | Character State | Chat State |
|------|------|------|
| Scope | Bound to Character Card, shared across all chats | Bound to a single chat |
| Typical Use | Character-level plugin config, CardApp application state | Temporary in-chat data, conversation context |
| API | `getCharacterState` / `setCharacterState` | `getChatState` / `getChatStateBatch` / `updateChatState` / `deleteChatState` |
| Storage Location | Character Card JSON file | Chat metadata |
