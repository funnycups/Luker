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

A floor state instance owns one chat-state namespace (`<ns>`) and a private commit log (`<ns>__floor_log`). Writes go through the instance's `update` method, which reads the current state, runs your reducer, computes the diff, applies it to the data namespace, and appends a commit. Each instance is registered into a module-level registry inside `floor-state.js`; whenever the chat structure changes, core code drives every registered instance through the matching handler **before** the corresponding `eventSource` event fires to plugin subscribers, guaranteeing that any plugin handler observes a fully settled floor state. The four structural transitions are:

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

// Wait for any in-flight rebuild or write to finish before reading:
await fs.ready();

// Detach from the registry (rarely needed; instances usually live for the page session):
fs.destroy();

// Wipe this namespace's state from disk and detach:
await fs.destroy({ purge: true });
```

::: warning
Reducers must return a plain object. Returning an array, primitive, `null`, or `undefined` is treated as "no change" and the call resolves without writing.
:::

### Replacing the entire log (import / rebuild)

`update` and `patch` are append-only — every call adds one commit on top of the existing history. When you need to install a fresh history wholesale (import a backup, rebuild from chat, reset to a known baseline), use `reset(commits)`:

```js
// Atomically replace the log with this exact set of commits.
const ok = await fs.reset([
    { floor: 0, swipeId: 0, patches: [{ op: 'add', path: '/intro', value: '...' }] },
    { floor: 3, swipeId: 0, patches: [{ op: 'add', path: '/scene', value: '...' }] },
]);
if (!ok) {
    // Validation failed (malformed commit, floor out of chat range) or the
    // underlying write was rejected. The log is left in its prior state.
}

// Empty list clears the log entirely.
await fs.reset([]);
```

Every commit is validated against the same structural checks `patch` uses (positive integer `floor` and `swipeId`, non-empty `patches` array), plus a chat-range check on `floor` (must be `< chat.length`). The whole batch is rejected if any commit fails — the log never lands in a partly-valid state. There is no separate data namespace to keep in sync; the next `get()` re-replays the new log and the in-memory cache is invalidated for you.

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

The four structural transitions are settled by core synchronously before the matching `eventSource` event fires, so plugin handlers reading the floor state from inside `MESSAGE_DELETED` / `MESSAGE_SWIPED` / `MESSAGE_SWIPE_DELETED` / `CHAT_CHANGED` / `CHAT_BRANCH_CREATED` listeners always observe a settled state — no `ready()` is needed there.

`ready()` is still useful for serializing against in-flight `update` / `patch` calls when concurrent writes might overlap. The instance returns its currently-resolved promise when no rebuild or write is in flight, so the cost is minimal.

### Conventions

- One namespace, one owner. Don't mix `updateChatState(ns, ...)` and `floorState.update(...)` against the same namespace — the floor state rebuild will overwrite the raw write.
- Namespace strings ending in `__floor_log` are reserved for the private logs.
- Reducer return values must be plain objects; arrays, primitives, `null`, and `undefined` are ignored.

### Reference

- `createFloorState({ namespace })` — async factory; returns a frozen instance.
- `instance.update(reducer, options?)` — read-modify-write; reducer receives the current state and returns the next, the diff is computed and committed for you. Optional `options = { floor, swipeId? }` pins the commit to an explicit floor instead of the chat tail. **This is the recommended write API.**
- `instance.patch(operations, options?)` — advanced: append a commit whose patches you already computed yourself. Operations must be an incremental RFC 6902 diff (`buildObjectPatchOperationsAsync(prev, next)` against `await instance.get()`); not for snapshot-style overwrites. Same `options` shape as `update`.
- `instance.reset(commits)` — atomically replace the log with a fresh commit list. Use for import / rebuild / reset workflows. Every commit is validated; the whole batch is rejected if any commit is malformed or its `floor` is out of chat range.
- `instance.get()` — read the current materialized state. Derived on demand by replaying the log against the current swipe map; never reads a separate data namespace.
- `instance.ready()` — resolves when no in-flight write is pending.
- `instance.destroy(options?)` — detach the instance from the registry. Pass `{ purge: true }` to additionally delete this namespace's state from disk (use for permanent reset / wipe workflows).

## Character State

Character state is persistent storage bound to the Character Card itself, shared across all chats for that character. Unlike chat state (which is scoped to a single chat), character state is suitable for storing cross-chat, character-level configuration.

### getCharacterState

```ts
getCharacterState(avatar: string, namespace: string): Promise<any | null>
```

Reads the character state for the specified avatar and namespace. Returns `null` if no data has been stored for that namespace.

| Parameter | Description |
|------|------|
| `avatar` | Character avatar filename (e.g. `'tavernkeeper.png'`) |
| `namespace` | Storage namespace, typically the plugin name (e.g., `'my-extension'`) |

### setCharacterState

```ts
setCharacterState(avatar: string, namespace: string, data: any): Promise<void>
```

Writes character state under the specified namespace. Pass `null` as `data` to delete the state for that namespace.

| Parameter | Description |
|------|------|
| `avatar` | Character avatar filename |
| `namespace` | Storage namespace |
| `data` | Data to store (any serializable object); pass `null` to delete |

### Usage Example

```js
const context = Luker.getContext();
const character = context.characters[context.characterId];

// Read character state
const state = await context.getCharacterState(character.avatar, 'my-extension');
console.log(state); // { someConfig: true } or null

// Write character state
await context.setCharacterState(character.avatar, 'my-extension', {
  someConfig: true,
  lastUpdated: Date.now(),
});

// Delete character state
await context.setCharacterState(character.avatar, 'my-extension', null);
```

### Character State vs Chat State

| | Character State | Chat State |
|------|------|------|
| Scope | Bound to Character Card, shared across all chats | Bound to a single chat |
| Typical Use | Character-level plugin config, CardApp application state | Temporary in-chat data, conversation context |
| API | `getCharacterState` / `setCharacterState` | `getChatState` / `getChatStateBatch` / `updateChatState` / `deleteChatState` |
| Storage Location | Character state file (next to the card) | Chat metadata |

## Chat Lifecycle

### getCurrentChatId

```ts
getCurrentChatId(): string | undefined
```

Returns the current chat's filename (without `.jsonl`). Returns the group's `chat_id` for groups, or `characters[characterId].chat` for solo. `undefined` when no character or group is selected.

### reloadCurrentChat

```ts
reloadCurrentChat(): Promise<void>
```

Reloads the current chat from disk. Mutex-bound — concurrent calls serialize, so it's safe to call from multiple event handlers.

### renameChat

```ts
renameChat(oldFileName: string, newName: string): Promise<void>
```

Renames the chat file. `newName` should be passed without the `.jsonl` extension.

### openCharacterChat

```ts
openCharacterChat(fileName: string): Promise<void>
```

Switches to a different chat for the current character. Clears the current chat data first.

### closeCurrentChat

```ts
closeCurrentChat(): Promise<boolean>
```

Closes the active chat and returns the user to the character list. Returns `true` on success, `false` if a generation is in progress and the user declined to stop it.

### doNewChat

```ts
doNewChat(options?: { deleteCurrentChat?: boolean }): Promise<void>
```

Creates a fresh chat for the active character. With `deleteCurrentChat: true`, the previously active chat file is removed (use sparingly — destructive).

### getPastCharacterChats

```ts
getPastCharacterChats(characterId?: number): Promise<Array<{
    file_name: string,    // includes ".jsonl" — strip via path.parse(name).name if you want the chat id
    file_id: string,      // basename without ".jsonl"; this is the form openCharacterChat expects
    file_size: string,    // formatted size (e.g. "12.3 KB")
    mes: string,          // first message preview
    last_mes: number,     // last-modified timestamp (ms)
}>>
```

List all chats stored for a character. Defaults to the current character (`this_chid`) when `characterId` is omitted. The `file_id` field is the application-level chat identifier — pass it back into `openCharacterChat` / `deleteCharacterChat` / `renameChat` (those expect names without the `.jsonl` extension).

### deleteCharacterChat

```ts
deleteCharacterChat(characterId: string, fileName: string): Promise<void>
```

Permanently delete a past chat for the named character. `fileName` is the chat id (no extension); a trailing `.jsonl` is tolerated and stripped.

### openGroupChat

```ts
openGroupChat(groupId: string, chatId: string): Promise<void>
```

Switches to a specific chat within a group.

### saveChat

```ts
saveChat(): Promise<void>
```

Writes the current chat to disk if it's not already being saved. Waits up to a short window for any in-progress save to complete before triggering its own. Most plugins should not need to call this — the [Messages API](#messages-api) persists automatically.

### printMessages

```ts
printMessages(options?: { clear?: boolean }): Promise<void>
```

Re-renders the chat DOM from the in-memory `chat` array. Use after large chat mutations performed outside the Messages API.

### clearChat

```ts
clearChat(options?: { clearData?: boolean }): Promise<void>
```

Clears the rendered messages. With `clearData: true`, also empties the in-memory `chat` array and resets `extensionPrompts`.

### sendSystemMessage

```ts
sendSystemMessage(type: string, text?: string, extra?: object): void
```

Inserts a system message into the chat. `type` must be one of the system message types (`HELP`, `WELCOME`, `EMPTY`, `GENERIC`, `NARRATOR`, `COMMENT`, `SLASH_COMMANDS`, `FORMATTING`, `HOTKEYS`, `MACROS`, `WELCOME_PROMPT`, `ASSISTANT_NOTE`, `ASSISTANT_MESSAGE`).

```js
ctx.sendSystemMessage('GENERIC', 'Plugin loaded successfully.');
```

## Extension Prompts (Depth Injection)

Extension prompts let plugins inject text into the prompt at a specific position and depth. These are evaluated during prompt assembly and apply to every generation request.

### setExtensionPrompt

```ts
setExtensionPrompt(
    key: string,
    value: string,
    position: number,
    depth: number,
    scan?: boolean,
    role?: number,
    filter?: () => boolean | Promise<boolean>,
): void
```

| Parameter | Description |
|------|------|
| `key` | Unique identifier for this prompt slot. Re-using the key overwrites |
| `value` | The text to inject. Pass `''` to remove |
| `position` | `0` = after story string (BEFORE_PROMPT), `1` = in-chat at `depth` (IN_CHAT), `2` = after chat (IN_PROMPT) |
| `depth` | When `position === 1`, distance from the chat tail. `0` = after the last message |
| `scan` | When `true`, the prompt's text contributes to the World Info scan |
| `role` | Speaker role (`0` = system, `1` = user, `2` = assistant) |
| `filter` | Optional gate; when present and resolves falsy, the prompt is skipped |

```js
const ctx = Luker.getContext();

ctx.setExtensionPrompt(
    'my-plugin-context',
    'You have access to a calculator tool.',
    1,                  // IN_CHAT
    0,                  // depth: insert after the last message
    false,              // do not scan as WI source
    0,                  // SYSTEM role
);

// Remove the prompt
ctx.setExtensionPrompt('my-plugin-context', '');
```

### extensionPrompts

```ts
context.extensionPrompts: Record<string, ExtensionPrompt>
```

Read-only view of currently registered extension prompts. The map is reset to `{}` on every `clearChat` call.

## Swipe API

Plugins can drive swipe navigation programmatically and inspect swipe state.

```ts
context.swipe.left(event?, options?): Promise<void>
context.swipe.right(event?, options?): Promise<void>
context.swipe.to(event, direction, options?): Promise<void>
context.swipe.show(): void
context.swipe.hide(options?: { hideCounters?: boolean }): void
context.swipe.refresh(updateCounters?: boolean, fade?: boolean): void
context.swipe.isAllowed(): boolean
context.swipe.state(): SwipeState
```

| Method | Description |
|------|------|
| `left` / `right` | Swipe in the named direction (event arg is optional and only matters for UI integration) |
| `to` | General swipe; `direction` is `SWIPE_DIRECTION.LEFT` / `RIGHT`. Supports `forceMesId`, `forceSwipeId`, `forceDuration` overrides |
| `show` / `hide` | Toggle swipe button visibility |
| `refresh` | Recompute per-message swipe controls |
| `isAllowed` | Whether swipes are currently permitted (chat exists, not generating, not animating) |
| `state` | Current `SWIPE_STATE` (`NONE`, plus animating states) |

```js
const ctx = Luker.getContext();

if (ctx.swipe.isAllowed()) {
    await ctx.swipe.right();
}
```

## Message Media Helpers

Helpers for managing image/file attachments on messages. These operate on the `extra.media` and `extra.files` arrays of a message object.

### appendMediaToMessage

```ts
appendMediaToMessage(messageObj: ChatMessage, messageElement: JQuery, scrollBehavior?: string): void
```

Renders all media referenced in `messageObj.extra.media[]` and `messageObj.extra.files[]` into the given message element. Honors `media_display` and `inline_image` flags. Useful when re-rendering a message that has had media added.

### ensureMessageMediaIsArray

```ts
ensureMessageMediaIsArray(messageObj: ChatMessage): void
```

Migrates legacy single-item `extra.media` / `extra.image` properties to arrays in-place. Call before reading `extra.media` if you need to handle messages that may have been written by older code.

### getMediaDisplay

```ts
getMediaDisplay(messageObj: ChatMessage): string
```

Returns the active `MEDIA_DISPLAY` mode for the message (defaults to the global setting).

### getMediaIndex

```ts
getMediaIndex(messageObj: ChatMessage): number
```

Returns the currently selected media index, clamped to a valid `0..media.length-1` range. Returns `0` when the index is out of range.

### scrollChatToBottom

```ts
scrollChatToBottom(options?: { waitForFrame?: boolean }): void
```

Scrolls the chat to the bottom. No-op when the user has scrolled up and `auto_scroll_chat_to_bottom` is off. With `waitForFrame: true`, waits for `requestAnimationFrame` first to let layout settle.

### scrollOnMediaLoad

```ts
scrollOnMediaLoad(): Promise<void>
```

Awaits the load events of all chat `<img>`/`<video>`/`<audio>` elements (with a timeout) and re-anchors scroll position once they finalize layout. Call after appending media so the chat doesn't jump.
