# Character Editor Assistant Extension API

The `character-editor-assistant` (CEA) extension publishes three helpers through Luker's extension registry so other plugin-owned iteration studios can reuse CEA's helper-tool surface without importing across the plugin boundary. This is what the orchestrator's iter-studio popup and the memory-graph schema iter-studio popup both consume.

## Why this exists

CEA owns the helper tools an iteration popup needs to read and mutate a character card and its lorebook(s):

- `lorebook_query` / `lorebook_list` / `lorebook_get` — lorebook reads
- `world_book_list` — list world books visible to a character
- `simulate_prompt` — dry-run a prompt and capture the prompt + WI hits
- The card-field + entry write tools that translate AI proposals into committable edits

A sibling iter-studio (e.g. orchestrator's iter-studio popup) that needs to expose these same tools to its LLM had been pulling them in via direct ES-module import. That couples the consumer to CEA's internal file paths and breaks the plugin↔plugin boundary. The extension api below replaces that coupling.

## API surface

```js
const cea = SillyTavern.getContext().getExtensionApi('character-editor-assistant');
if (!cea) {
    // CEA is not installed; the iter-studio popup that depends on these
    // helpers should refuse to open with a clear "install CEA" error.
    return;
}

const helperApis = cea.buildCharacterEditorHelperApis(context, { avatar });
const toolResult = await cea.runCharacterEditorHelperToolCall(call, helperApis);
await cea.applyCharacterEditorLorebookProposal(context, { kind, args });
```

## Methods

### `buildCharacterEditorHelperApis(context, opts?)`

Returns the helper-tool API array the unified CEA editor's read tools dispatch through. Each entry exposes `isToolName(name)` plus `invoke(call)`, and the array is iterated by `runCharacterEditorHelperToolCall` to route a call to the matching helper.

```ts
buildCharacterEditorHelperApis(
    context: SillyTavernContext,
    opts?: { avatar?: string },
): Array<{ isToolName: (n: string) => boolean; invoke: (call) => Promise<any> }>
```

- `context` — the SillyTavern context (must expose `characters`, `loadWorldInfo`, …).
- `opts.avatar` — character avatar that scopes the lorebook / world-book-list APIs to the right card. Omit when the popup is global.

The returned array always contains four helpers (lorebook reads, lorebook writes, simulate, world-book-list) plus an optional fifth helper for web search when `globalThis.Luker.searchTools` is wired.

### `runCharacterEditorHelperToolCall(call, helperApis)`

Dispatch one helper-tool call. The caller passes the helper API array returned from `buildCharacterEditorHelperApis`; the dispatcher finds the matching helper by `isToolName` and forwards the call. Throws `Unsupported helper tool: <name>` when nothing matches.

This is the dispatcher iter-studio popups inject into the shared `iteration-library/tools/lorebook-reads.js` and `lorebook-writes.js` helpers — those modules are plugin-agnostic and receive the dispatcher per call.

### `applyCharacterEditorLorebookProposal(context, { kind, args })`

Re-derive the after-image of a lorebook proposal against the entry's CURRENT on-disk state and commit it. `kind` is `'update'` or `'str_replace'`; `args` is the proposal's original `args` payload.

This is how the iter-studio popup commits an AI-proposed lorebook edit without trusting a snapshot captured at proposal time — re-deriving against current state lets multi-proposal chains for the same `book#uid` commit correctly and surfaces parallel-session drift as a fresh validation error rather than a silent clobber.

## Resolving the api lazily

The popup should resolve the api at open-time, not at module load. CEA may register later than the consumer's module evaluation; deferring the lookup also lets the popup surface a clear "install CEA" error to the user when the dependency is missing.

```js
function getCea() {
    const api = SillyTavern.getContext().getExtensionApi('character-editor-assistant');
    if (!api) {
        throw new Error('This iteration popup requires the character-editor-assistant extension.');
    }
    return api;
}
```

## Related

- [Plugin Integration](./plugin-integration.md) — `registerExtensionApi(name, api)` / `getExtensionApi(name)` registry that publishes `'character-editor-assistant'`
- [Iteration Studio Framework](./iteration-studio.md) — the shared `iteration-library/*` surface the consumer popups use, into which the CEA dispatcher gets injected
- [Orchestrator Tools](./orchestrator-tools.md) — sibling reference consumer
- [Memory Graph Extension API](./memory-graph.md) — sibling reference consumer
