# State System

Luker introduces a state system that allows character cards, chats, and presets to carry persistent state data. Extensions and CardApps can use this system to store and read custom data without modifying the character card or chat history itself.

## Character State

Each character can have independent state data, isolated by namespace. Different extensions or CardApps use their own namespaces without interfering with each other.

For example, a memory extension can store memory summaries for a character in the character state, while a CardApp can store game progress on the same character — both operate independently through different namespaces.

### How It Works

- **Read state**: Retrieve state data for a character under a specific namespace using the character identifier and namespace
- **Write state**: Save data to a specified namespace for a specified character
- **Auto-persistence**: State data is automatically saved to disk and survives server restarts

The lifecycle of character state is bound to the character itself — when a character is deleted, its associated state data is also cleaned up.

## Chat State

Luker stores chat state in namespace sidecar files next to each chat file, using the pattern `<chatFileBase>.luker-state.<namespace>.json`.

### State File Characteristics

- Stored as sidecar files in the same directory as the chat file (not a single global state file)
- One chat can have multiple state sidecars (one per namespace), created lazily on first write
- Lifecycle is bound to the chat file: when a chat is renamed, bound sidecars are renamed accordingly; when a chat is deleted, bound sidecars are deleted as well
- Supports incremental updates — no need to write the complete data every time

### Stored Content

Chat state files can store various auxiliary information related to the chat, such as:

- Confirmation status of generation tasks
- Custom data saved by extensions for that chat
- Other metadata not suitable for writing directly into chat history

::: tip
Chat state files are automatically managed by Luker — you typically don't need to edit them manually. If you're migrating data from SillyTavern, these files will be created automatically on first use.
:::

## Preset State

Luker also supports attaching state data to presets. Preset state allows extensions to store configuration or runtime information on specific presets. When users switch presets, the associated state data switches accordingly.

## Persistence and Lifecycle

The state system follows these principles:

| State Type | Storage Location | Lifecycle |
| --- | --- | --- |
| Character State | Sidecar files next to character cards (`<character>.state.<namespace>.json`) | Created on first namespace write; renamed/deleted with the character |
| Chat State | Sidecar files next to chat files (`<chat>.luker-state.<namespace>.json`) | Created on first namespace write; renamed/deleted with the chat |
| Preset State | Sidecar files next to preset files (`<preset>.luker-state.<namespace>.json`) | Created on first namespace write; renamed/deleted with the preset |

All state data is persisted to disk and will not be lost due to server restarts. State file cleanup is automatic — when the associated character, chat, or preset is deleted, the corresponding state file is automatically cleaned up.

## Use Cases

### CardApp State Tracking

CardApp is the most typical user of the state system. In-card applications can save game progress, user preferences, interaction history, and other data through the state system. For example, an RPG-type CardApp can save character level, equipment, quest progress, and other information in the character state.

See [CardApp](/features/cardapp) for details.

### Extension Data Storage

Third-party extensions can use the state system to store custom data for each character or chat without managing file I/O themselves. This simplifies extension development and ensures correct lifecycle management of data.

See [Extension API](/development/extension-api) for details.

### Memory System

[Memory Graph](/features/memory-graph) and other memory-type extensions can use character state to store memory summaries and index data, enabling per-character isolated memory management.

## Floor State (chat state with rewind)

Plain chat state is overwrite-only — when a user swipes, deletes a message, or switches chats, plugins must reload the namespace and reconcile their data manually. Floor state is a thin layer on top of chat state that handles this for you: every write is logged at the chat tail (floor index + swipe id) and replayed automatically when the chat structure changes.

### How it works

A floor state instance owns one chat-state namespace (`<ns>`) and a private commit log (`<ns>__floor_log`). Writes go through the instance's `update` method, which reads the current state, runs your reducer, computes the diff, applies it to the data namespace, and appends a commit. The instance subscribes to four chat events:

- `CHAT_CHANGED` — new chat opened; rebuild data from this chat's log
- `MESSAGE_SWIPED` — user switched swipes; rebuild data with the new active swipe
- `MESSAGE_DELETED` — chat truncated; drop commits at or beyond the new length, then rebuild
- `MESSAGE_SWIPE_DELETED` — a swipe was deleted on the chat tail; renumber the affected floor's commits, then rebuild

Each commit stores an incremental diff from the materialized state at commit time to the next state. Rebuild walks all commits in order, drops the ones whose `(floor, swipeId)` no longer matches the active swipe map, and applies the surviving patches sequentially against `{}`. Because deletions are tail-only — `MESSAGE_DELETED` truncates a suffix and `MESSAGE_SWIPE_DELETED` only fires on the chat tail — the surviving commits on the active path always form a contiguous chain, and incremental patches compose correctly.

### Creating an instance

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

- One namespace, one owner. Don't mix `patchChatState(ns, ...)` and `floorState.update(...)` against the same namespace — the floor state rebuild will overwrite the raw write.
- Namespace strings ending in `__floor_log` are reserved for the private logs.
- Reducer return values must be plain objects; arrays, primitives, `null`, and `undefined` are ignored.

### Reference

- `createFloorState({ namespace })` — async factory; returns a frozen instance.
- `instance.update(reducer, options?)` — read-modify-write; reducer receives the current state and returns the next, the diff is computed and committed for you. Optional `options = { floor, swipeId? }` pins the commit to an explicit floor instead of the chat tail. **This is the recommended write API.**
- `instance.patch(operations, options?)` — advanced: append a commit whose patches you already computed yourself. Operations must be an incremental RFC 6902 diff (`buildObjectPatchOperationsAsync(prev, next)` against `await instance.get()`); not for snapshot-style overwrites. Same `options` shape as `update`.
- `instance.get()` — read the current data namespace.
- `instance.ready()` — resolves when no rebuild is in flight.
- `instance.destroy()` — detach event listeners and freeze the instance.

## Related Pages

- [CardApp](/features/cardapp) — In-card application system
- [Extension API](/development/extension-api) — Extension development interface
