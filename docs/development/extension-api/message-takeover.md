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
    // routes through the matching cleanup pipeline on terminal state.
    void (async () => {
        try {
            for await (const chunk of streamFromMyBackend(eventData)) {
                handle.setText(handle.getText() + chunk);
            }
            await handle.commit();
        } catch (err) {
            if (err.name === 'AbortError' || eventData.abortSignal.aborted) {
                // User clicked stop. Preserve the partial output but skip
                // the finalize pipeline — see "Three terminal states" below.
                await handle.abort();
            } else {
                // Hard failure with no usable partial. Restore the slot.
                await handle.discard();
            }
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

`isStreamingEnabled` is the user's *session-level* preference, sourced from `isStreamingEnabled()` (the same flag that gates the main LLM path between `sendStreamingRequest` and `sendOpenAIRequest`). Plugins driving their own LLM calls should honor it when they need to decide whether to render tokens live — pick `generateTaskStream` when streaming is on, `generateTask` when it's off. Transport selection (SSE vs one-shot POST) is handled separately by `generateTask` based on the named preset's `stream_openai` flag and is independent of this signal.

## Three terminal states

A handle reaches one of three terminal states; each triggers a different kernel cleanup path. Picking the right one matters because the kernel runs different downstream work for each — and using the wrong one (e.g. `commit()` on a user-stop) opens up race conditions with the next turn.

| Method | When the plugin calls it | Kernel response | `outcome.status` |
|--------|--------------------------|------------------|------------------|
| `commit()` | Natural completion — the plugin produced its final output | Full finalize pipeline: emit `MESSAGE_RECEIVED` / `CHARACTER_MESSAGE_RENDERED`, run regex / cleanup post-processing, persist via `appendChatMessages` / `saveChatConditional`, trigger auto-features (autoContinue, swipe init), unblock UI | `committed` |
| `abort()` | User-driven cancel mid-turn — preserve whatever was streamed but don't persist | Sync writes the partial into the chat slot and redraws; **skips** the finalize pipeline (no emit, no save, no autoContinue); conditionally unblocks UI (only if no follow-up generation has claimed the lock). The partial lives in local chat until the user's next action overwrites it — same trade-off ST core's streaming path makes when `streamingProcessor.isStopped` is true | `aborted` |
| `discard()` | Explicit rollback — the partial output is unusable, revert to pre-takeover state | Rollback: splice the placeholder out of `chat` (for `normal` / `regenerate`) or restore the original `mes` / `reasoning` (for `continue` / `swipe`); emit `GENERATION_STOPPED`; unblock UI | `discarded` |

The three states are mutually exclusive — once a handle settles into any of them, calling either of the other two throws (`editor_committed` / `editor_aborted` / `editor_discarded`). Re-calling the same terminal is a no-op.

**Picking the right one when the user stops:** prefer `abort()`. A user clicking stop wants the partial preserved so they can read what was produced before the cancel, but does NOT want it crystallised — running the full finalize pipeline (emit, save, autoContinue) on aborted partial output races against any follow-up regenerate the user clicks, because the finalize pipeline contains multiple `await` yields during which the next `Generate()` can start. Use `discard()` only when the partial would be actively misleading (e.g. the plugin produced a malformed body it would rather throw away than show).

## Responsibility split

The plugin owns:

- Listening for the dispatch event and deciding whether to claim takeover.
- Constructing the handle with appropriate `originalText` / `originalReasoning` for the generation type.
- Writing the final text and reasoning into the buffer via `setText` / `setReasoning`.
- Calling exactly one of `commit()` / `abort()` / `discard()` to settle the handle.

The kernel owns:

- Pushing the placeholder message into `chat` (for `normal`) or reusing the existing slot (for `regenerate` / `swipe` / `continue`).
- Rendering the placeholder via `addOneMessage` and persisting via `appendChatMessages`.
- Subscribing to the handle's throttled `onUpdate` for live redraws while the plugin streams output.
- Routing through the matching cleanup pipeline once the handle settles (see the table in "Three terminal states" above).

The kernel does NOT time-trigger an abort. When the user clicks stop, the abort signal propagates via `eventData.abortSignal`; plugins should honor it (typically: catch the rejection from an aborted stream call and call `abort()`). A plugin that ignores the abort signal will leave the handle pending indefinitely — that is a plugin bug, not a kernel concern.

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
    abort(): Promise<void>;
    discard(): Promise<void>;
    readonly complete: Promise<{
        status: 'committed' | 'aborted' | 'discarded';
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
| `setText(text)` | Replaces the text buffer. Schedules a coalesced flush (default 33 ms) that calls the kernel's onUpdate callback for live redraw. Throws `invalid_argument` if `text` is not a string, `editor_committed` / `editor_aborted` / `editor_discarded` after the terminal state, or `invalid_op_for_continue` when `generationType === 'continue'` and the new text would discard the original prefix. |
| `setReasoning(text)` | Same semantics for the reasoning buffer. No prefix invariant. |
| `commit()` | Settles the handle as committed, force-flushes any pending update, and resolves `complete` with `{ status: 'committed', finalText, finalReasoning }`. Idempotent on a committed handle (second call is a no-op). Throws on an already-aborted or already-discarded handle. |
| `abort()` | Settles the handle as aborted, force-flushes any pending update (so the kernel sees the latest streamed buffer), and resolves `complete` with `{ status: 'aborted', finalText, finalReasoning }`. Idempotent on an aborted handle. Throws on an already-committed or already-discarded handle. |
| `discard()` | Settles the handle as discarded, cancels any pending flush, and resolves `complete` with `{ status: 'discarded', finalText: originalText, finalReasoning: originalReasoning }`. Idempotent on a discarded handle. Throws on an already-committed or already-aborted handle. |
| `complete` | Resolves once any of the three terminals settles the handle. The kernel awaits this to know when the turn is over. |
| `abortSignal` | Returns the same signal passed in `opts.abortSignal`. The kernel does not auto-settle on abort — plugins decide policy (typically: catch the rejection from an aborted stream call and call `abort()`). |
| `setOnUpdate(fn)` | Kernel uses this to subscribe to throttled buffer updates. Setting `null` unsubscribes. A pending update flushes immediately when a callback is attached. |

### `continue` prefix invariant

When `opts.generationType === 'continue'`, `setText(newText)` is rejected with `invalid_op_for_continue` if `newText` does not start with `opts.originalText`. This catches the obvious footgun where a plugin would inadvertently erase the prefix the user asked to continue from. Plugins doing `continue` must accumulate atop the prefix.

### Error codes

`TakeoverError` carries `code`, `message`, and optional `cause` / `details`:

| Code | When |
|------|------|
| `invalid_generation_type` | `opts.generationType` is missing or not one of the four valid values. |
| `invalid_argument` | `setText` / `setReasoning` called with a non-string value. |
| `editor_committed` | Mutation called after `commit()` resolved, or `abort()` / `discard()` called on a committed handle. |
| `editor_aborted` | Mutation called after `abort()` resolved, or `commit()` / `discard()` called on an aborted handle. |
| `editor_discarded` | Mutation called after `discard()` resolved, or `commit()` / `abort()` called on a discarded handle. |
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
