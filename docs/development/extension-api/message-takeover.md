# Message Takeover

APIs for plugins to **produce the assistant message text directly** instead of guiding the main LLM. When a plugin claims takeover for a turn, the main LLM is not invoked at all — the plugin writes text and reasoning into a buffer-only editor handle, and the kernel takes care of placing the result into chat, persisting it, running regex / cleanup post-processing, emitting lifecycle events, and rolling back if the plugin discards.

::: warning Buffer-only kernel
The handle is a pure text / reasoning buffer. It does not touch `chat`, emit ST events, or render anything — those are kernel responsibilities driven off the handle's lifecycle. Higher-level editing helpers (incremental append, structured patches, stream pipes) live in plugin code. The orchestrator extension ships a reference implementation at `public/scripts/extensions/orchestrator/editor-ops.js` — copy / depend / replace as fits your plugin.
:::

## The hook event

The core `Generate()` path emits `event_types.GENERATE_TAKEOVER_DISPATCH` after the LLM payload is fully assembled but before any dispatch. Subscribers claim takeover by filling `eventData.takeoverHandle`:

```js
const context = Luker.getContext();

context.eventSource.on(context.eventTypes.GENERATE_TAKEOVER_DISPATCH, async (eventData) => {
    if (!shouldTakeover(eventData)) return;

    // For continue / swipe / regenerate, read originals from the existing
    // chat slot so the kernel can roll back on discard.
    const { originalText, originalReasoning } = resolveOriginals(eventData.type, context.chat);

    const handle = context.createMessageEditorHandle({
        generationType: eventData.type,
        originalText,
        originalReasoning,
        abortSignal: eventData.abortSignal,
        owner: 'my-plugin',
    });
    eventData.takeoverHandle = handle;

    // Drive the editor asynchronously. The kernel awaits handle.complete,
    // pushes the placeholder, subscribes to onUpdate for live redraw, and
    // routes through saveReply / patchChatMessages on terminal state.
    void (async () => {
        try {
            handle.setText('Plugin-produced message body.');
            await handle.commit();
        } catch (err) {
            await handle.discard();
        }
    })();
});

function resolveOriginals(type, chat) {
    if (type === 'normal') return { originalText: '', originalReasoning: '' };
    const slot = chat[chat.length - 1];
    return {
        originalText: String(slot?.mes ?? ''),
        originalReasoning: String(slot?.extra?.reasoning ?? ''),
    };
}
```

### Event payload

```ts
type DispatchEventData = {
    type: 'normal' | 'regenerate' | 'swipe' | 'continue';   // Other types skip the event.
    isContinue: boolean;                                     // true if this is a Continue (preserve prefix)
    forceName2: boolean;                                     // pass to your prompt if relevant
    isStreamingEnabled: boolean;                             // user has streaming ON for this session
    finalPrompt: unknown;                                    // the prompt that *would* have gone to the LLM
    generateData: unknown;                                   // raw generate-data envelope (same as GENERATE_AFTER_DATA payload)
    takeoverHandle: MessageEditorHandle | null;              // subscriber fills this to claim
    abortSignal: AbortSignal;                                // honored by both takeover and normal paths
};
```

If no subscriber claims, the normal LLM dispatch proceeds. If multiple subscribers try to claim, the first claim wins; subsequent assignments are logged with a warning. `quiet` and `impersonate` generation types do NOT emit this event.

`isStreamingEnabled` is the user's *session-level* preference, sourced from `isStreamingEnabled()` (the same flag that gates the main LLM path between `sendStreamingRequest` and `sendOpenAIRequest`). Plugins that drive their own LLM calls — e.g. via `generateTask` vs `generateTaskStream` — should honor it for consistency with the rest of the UI. Plugins that ship their own streaming-transport setting may further override this (the orchestrator's "Use streaming transport" profile checkbox is one example).

## Responsibility split

The plugin owns:

- Listening for the dispatch event and deciding whether to claim takeover.
- Constructing the handle with appropriate `originalText` / `originalReasoning` for the generation type.
- Writing the final text and reasoning into the buffer via `setText` / `setReasoning`.
- Calling `commit()` on success or `discard()` on hard failure.

The kernel owns:

- Pushing the placeholder message into `chat` (for `normal`) or reusing the existing slot (for `regenerate` / `swipe` / `continue`).
- Rendering the placeholder via `addOneMessage` and persisting via `appendChatMessages`.
- Subscribing to the handle's throttled `onUpdate` for live redraws while the plugin streams output.
- On `commit`: routing through `saveReply` so swipes init, regex / cleanup post-processing, `MESSAGE_RECEIVED`, `CHARACTER_MESSAGE_RENDERED`, token counts, statistics, auto-features, and other generation side effects all run normally.
- On `discard`: rolling back the chat slot via `patchChatMessages` (`op:remove` for `normal`; `op:replace` for `continue` / `swipe` / `regenerate` to restore originals) and emitting `GENERATION_STOPPED`.

The kernel does NOT time-trigger an abort. When the user clicks stop, the abort signal propagates via `eventData.abortSignal`; plugins should honor it (typically: catch the rejection from an aborted stream call and call `discard()`). A plugin that ignores the abort signal will leave the handle pending indefinitely — that is a plugin bug, not a kernel concern.

## The editor handle

```ts
interface CreateOpts {
    generationType: 'normal' | 'regenerate' | 'swipe' | 'continue';
    originalText?: string;            // default '' — used for discard rollback and continue prefix check
    originalReasoning?: string;       // default ''
    abortSignal?: AbortSignal;        // pass the dispatch event's signal
    flushIntervalMs?: number;         // default 33 — onUpdate throttle window
    owner?: string;                   // default 'unknown' — diagnostic identifier
}

interface MessageEditorHandle {
    getText(): string;
    getReasoning(): string;

    setText(text: string): void;
    setReasoning(text: string): void;

    commit(): Promise<void>;
    discard(): Promise<void>;
    readonly complete: Promise<{
        status: 'committed' | 'discarded';
        finalText: string;
        finalReasoning: string;
    }>;

    readonly abortSignal: AbortSignal;

    // Kernel-facing — plugins normally don't need this.
    setOnUpdate(fn: ((text: string, reasoning: string) => void) | null): void;
}
```

| Operation | Behavior |
|-----------|----------|
| `setText(text)` | Replaces the text buffer. Schedules a coalesced flush (default 33 ms) that calls the kernel's onUpdate callback for live redraw. Throws `invalid_argument` if `text` is not a string, `editor_committed` / `editor_discarded` after the terminal state, or `invalid_op_for_continue` when `generationType === 'continue'` and the new text would discard the original prefix. |
| `setReasoning(text)` | Same semantics for the reasoning buffer. No prefix invariant. |
| `commit()` | Marks the handle as committed, force-flushes any pending update, and resolves `complete` with `{ status: 'committed', finalText, finalReasoning }`. Idempotent on a committed handle (second call is a no-op). Throws `editor_discarded` if called on a discarded handle. |
| `discard()` | Marks the handle as discarded, cancels any pending flush, and resolves `complete` with `{ status: 'discarded', finalText: originalText, finalReasoning: originalReasoning }`. Idempotent on both terminal states. |
| `complete` | Resolves once `commit` or `discard` finishes. The kernel awaits this to know when the turn is over. |
| `abortSignal` | Returns the same signal passed in `opts.abortSignal`. The kernel does not auto-discard on abort — plugins decide policy (typically: catch the rejection from an aborted stream call and call `discard()`). |
| `setOnUpdate(fn)` | Kernel uses this to subscribe to throttled buffer updates. Setting `null` unsubscribes. A pending update flushes immediately when a callback is attached. |

### `continue` prefix invariant

When `opts.generationType === 'continue'`, `setText(newText)` is rejected with `invalid_op_for_continue` if `newText` does not start with `opts.originalText`. This catches the obvious footgun where a plugin would inadvertently erase the prefix the user asked to continue from. Plugins doing `continue` must accumulate atop the prefix.

### Error codes

`TakeoverError` carries `code`, `message`, and optional `cause` / `details`:

| Code | When |
|------|------|
| `invalid_generation_type` | `opts.generationType` is missing or not one of the four valid values. |
| `invalid_argument` | `setText` / `setReasoning` called with a non-string value. |
| `editor_committed` | Mutation called after `commit()` resolved. |
| `editor_discarded` | Mutation called after `discard()` resolved, or `commit()` called on a discarded handle. |
| `invalid_op_for_continue` | `setText` during `continue` would erase the original prefix. |

## Higher-level editing patterns

The kernel deliberately does not provide incremental append, character-offset slicing, structured patch application, or stream piping — those are *strategies*, not state management. The orchestrator extension implements them in `public/scripts/extensions/orchestrator/editor-ops.js`:

- `appendText(handle, text)` / `appendReasoning(handle, text)` — concatenate onto the current value.
- `insertAt(handle, offset, text)` / `replaceRange(handle, start, end, text)` / `deleteRange(handle, start, end)` — character-offset slicing.
- `applyPatch(handle, patch | patch[])` — apply structured patches (kinds: `replace_range`, `insert_at`, `delete_range`, `context_replace`).
- `patchBySemantic(handle, { find, replaceWith, occurrence? })` — git-style context_replace (Aider / Claude Code / Cursor style), byte-exact match, no heuristic recovery.
- `pipeFrom(handle, stream, opts?)` — consume an `AsyncIterable<StreamChunk>` (e.g. from `generateTaskStream`) into the editor with `mode: 'append'` or `mode: 'replace'`.

Other plugins are free to depend on `orchestrator/editor-ops.js` or implement their own; the kernel does not care.

## Three-layer exposure

| Layer | Access |
|-------|--------|
| Layer 1 | `import { createMessageEditorHandle, GENERATE_TAKEOVER_DISPATCH, TakeoverError } from 'public/scripts/message-takeover.js'` |
| `getContext()` | `Luker.getContext().createMessageEditorHandle(...)` + `Luker.getContext().eventTypes.GENERATE_TAKEOVER_DISPATCH` |
| ext `ctx` | `ctx.lukerContext.createMessageEditorHandle(...)` + `ctx.lukerContext.eventTypes.GENERATE_TAKEOVER_DISPATCH` |
