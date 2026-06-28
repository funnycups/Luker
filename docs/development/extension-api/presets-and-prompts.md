# Presets & Prompts

APIs for managing presets and assembling prompt messages with character cards and World Info.

## Preset API

`context.presets` provides a unified preset management interface, replacing direct imports of the `PresetManager` internal module.

### presets.list

```ts
presets.list(collection?: string): Array<PresetRef>
```

Lists all saved presets in the specified collection. `collection` is the preset collection name (e.g., `'openai'`).

### presets.getSelected

```ts
presets.getSelected(collection?: string): PresetRef | null
```

Gets the currently selected preset reference. Returns `null` if the current selection is a runtime preset bound to a Character Card.

### presets.getLive

```ts
presets.getLive(collection?: string): PresetBody | null
```

Gets the preset content currently being edited in the UI (including unsaved changes). Useful when you need to read the currently effective configuration.

### presets.getStored

```ts
presets.getStored(ref: { collection: string, name: string }): PresetBody | null
```

Gets the saved content of a specific preset. Useful for cross-preset comparison or copying content.

### presets.save

```ts
presets.save(
  ref: { collection: string, name: string },
  body: PresetBody
): Promise<void>
```

Saves preset content.

### presets.resolve

```ts
presets.resolve(
  target?: PresetRef | string,
  options?: { collection?: string, defaultCollection?: string, allowMissingName?: boolean }
): { collection: string, name: string } | null
```

Normalizes a preset reference into a canonical `{ collection, name }` object. This is purely a name-resolution helper — it does not return connection information. Pass an existing `PresetRef`, a collection name as a string (resolves to that collection's currently selected preset), or `null` (resolves to the current preset of `options.collection`). Returns `null` when the collection or name can't be determined.

::: tip Looking for connection profile resolution?
This function does **not** return API endpoint, model, or secret information. To resolve a Connection Manager profile into the connection settings that `sendOpenAIRequest` consumes, use [`context.connectionProfiles.resolve`](/development/extension-api/generation#connection-profile-resolution) instead.
:::

### presets.state

Plugin runtime/session data bound to a preset. State sidecars live next to the preset on disk and are NOT exported with the preset itself — they are strictly for plugin-side runtime state (e.g., the orchestrator's per-preset agent override, the preset assistant's last-used template). Do not stuff plugin data into the preset body; use `presets.state.*` instead.

All methods accept `options.target` (a `PresetRef`) and `options.collection` for cross-preset reads/writes; both default to the currently selected preset.

::: warning Behavior change (2026-06-28)
Preset state read/write APIs (`get`, `getBatch`, `update`, `patch`, `delete`, `deleteAll`) no longer throw on HTTP failures. They now return a `{ok, ...}` envelope (matching the chat-state pattern). If your plugin previously wrote `try { await ctx.presets.state.get(...) } catch (e) { ... }`, switch to `if (!result.ok) { ... }`.
:::

#### presets.state.get

```ts
presets.state.get(
  namespace: string,
  options?: { target?: PresetRef, collection?: string }
): Promise<
  | { ok: true, state: object | null }
  | { ok: false, state: null, reason: string, hint: string }
>
```

Reads the preset state for a given namespace. On success returns `{ok: true, state}` where `state` is the stored value or `null` if no data exists for that namespace. On failure returns `{ok: false, state: null, reason, hint}` — see [Error reasons](#error-reasons-1) below.

#### presets.state.getBatch

```ts
presets.state.getBatch(
  namespaces: string[],
  options?: { target?: PresetRef, collection?: string }
): Promise<
  | { ok: true, results: Map<string, { ok: true, state: object | null }> }
  | { ok: false, results: Map<string, never>, reason: string, hint: string }
>
```

Reads preset state for multiple namespaces in batch. On success returns `{ok: true, results}` where `results` is a `Map` keyed by namespace; each entry is `{ok: true, state}` and missing namespaces map to `{ok: true, state: null}`. On failure (no active preset, transport error, HTTP error) returns `{ok: false, results: <empty Map>, reason, hint}`.

#### presets.state.update

```ts
presets.state.update(
  namespace: string,
  updater: (current: any) => any,
  options?: { target?: PresetRef, collection?: string, maxOperations?: number, maxRetries?: number }
): Promise<
  | { ok: true, state: object | null, updated: boolean }
  | { ok: false, reason: string, hint: string }
>
```

**Recommended read-modify-write approach.** The `updater` function receives the current state (`{}` when none exists) and returns the new state. The system computes the minimal incremental patch under the hood, so only the changed slice crosses the wire. Returning `null` / `undefined` is treated as "no change" and resolves with `{ok: true, updated: false}`. 409 conflicts (concurrent edit) are retried automatically; the retry budget is controlled by `options.maxRetries` (default 1). On failure returns `{ok: false, reason, hint}` — see [Error reasons](#error-reasons-1) below. This function never throws; exceptions inside the reducer are caught and surfaced as `reason: 'VALIDATION_ARGS'`.

```js
await context.presets.state.update('my-plugin', (current = {}) => ({
  ...current,
  lastUsedTemplate: 'compact',
  updatedAt: Date.now(),
}));
```

#### presets.state.patch

```ts
presets.state.patch(
  namespace: string,
  operations: object[],
  options?: { target?: PresetRef, collection?: string }
): Promise<
  | { ok: true }
  | { ok: false, reason: string, hint: string }
>
```

Applies RFC 6902 patch operations directly. Prefer `update()` for typical read-modify-write flows; reach for `patch()` only when you already have the operation list (e.g., re-applying a previously computed diff). On success returns `{ok: true}`; on failure returns `{ok: false, reason, hint}` — see [Error reasons](#error-reasons-1) below.

#### presets.state.delete

```ts
presets.state.delete(
  namespace: string,
  options?: { target?: PresetRef, collection?: string }
): Promise<
  | { ok: true }
  | { ok: false, reason: string, hint: string }
>
```

Deletes the preset state for a given namespace. Idempotent — succeeds when the sidecar does not exist. On success returns `{ok: true}`; on failure returns `{ok: false, reason, hint}` — see [Error reasons](#error-reasons-1) below.

#### presets.state.deleteAll

```ts
presets.state.deleteAll(target?: PresetRef | string | null): Promise<
  | { ok: true }
  | { ok: false, reason: string, hint: string }
>
```

Wipes every namespace under the given preset. Use sparingly — typically only when the preset itself is being deleted or reset. On success returns `{ok: true}`; on failure returns `{ok: false, reason, hint}` — see [Error reasons](#error-reasons-1) below.

#### Best Practices

- Use `presets.state.update()` for read-modify-write instead of manually chaining `get()` + a full overwrite — the helper ships only the diff and handles the 409 retry for you.
- Keep payloads as JSON-serializable plain objects; arrays and primitives at the top level are not supported.
- One namespace per logical state slice; don't pack unrelated data under a single namespace.
- Handle `ok: false` return values to keep your plugin UI resilient — switch on `reason` rather than translating `hint` (see [Error reasons](#error-reasons-1)).

#### Error reasons

Preset state read/write methods (`get`, `getBatch`, `update`, `patch`, `delete`, `deleteAll`) return `{ok: false, reason, hint}` on failure. The `reason` field uses the same vocabulary as [Chat State](/development/extension-api/chat-and-state#error-reasons):

| Reason | When it fires | Suggested handling |
|---|---|---|
| `VALIDATION_ARGS` | Bad arguments (empty namespace, non-function updater, non-array operations, reducer threw) | Fix caller — this is a programmer bug |
| `VALIDATION_TARGET` | No active preset (apiId/name resolution failed) | Skip the write, retry once a preset is selected |
| `VALIDATION_COMMIT` | floor-state only (not applicable to preset state) | — |
| `INSTANCE_DESTROYED` | floor-state only (not applicable to preset state) | — |
| `CONFLICT` | HTTP 409 even after retry | Re-read current state and try again |
| `HTTP_ERROR` | Other non-2xx response | Inspect `hint` for the status code, user-visible toast acceptable |
| `TRANSPORT_ERROR` | fetch threw (network, CORS, abort) | Retry or surface network error to user |
| `REPLAY_BROKEN` | floor-state only (not applicable to preset state) | — |
| `LOG_WRITE_FAILED` | floor-state only (not applicable to preset state) | — |

The `hint` field is English, no longer than 120 characters, and contains actionable diagnostic info. It is not localized — surface a localized message to users by switching on `reason`, not by translating `hint`.

### Usage Rules

- `list()` and `getSelected()` only return saved presets
- Use `getLive()` for the preset currently being edited
- Runtime presets bound to a Character Card are not considered "saved" — `getSelected()` returns `null`, but `getLive()` can still read them
- Do not stuff plugin runtime data into the preset body; use `presets.state.*` instead

## Prompt and World Info Assembly

### buildPresetAwarePromptMessages

```ts
buildPresetAwarePromptMessages(options: {
  messages: Array<{ role: string, content: string }>,
  envelopeOptions?: {
    includeCharacterCard?: boolean,
    api?: string,
    promptPresetName?: string,
  },
  promptPresetName?: string,
  runtimeWorldInfo?: object,
}): PromptMessage[]
```

Assembles plugin messages into a prompt message list ready to be sent to an API, arranged according to the prompt preset's ordering. This is an **optional** assembly tool — simple LLM calls don't need it. You only need it when you want to reuse character cards, world info, or prompt templates.

**Parameters:**

| Parameter | Description |
|------|------|
| `messages` | Array of messages to send, each containing `role` (`'system'`/`'user'`/`'assistant'`) and `content` |
| `envelopeOptions.includeCharacterCard` | Whether to include the current Character Card's definitions in the prompt (default `true`) |
| `envelopeOptions.api` | Specifies the API type to use (e.g., `'openai'`); uses the current connection if not specified |
| `envelopeOptions.promptPresetName` | Specifies the preset name to use; uses the current preset if not specified |
| `promptPresetName` | Same as `envelopeOptions.promptPresetName`; top-level shortcut |
| `runtimeWorldInfo` | Pre-resolved World Info activation results (obtained via `resolveWorldInfoForMessages`) |

**Key Behaviors:**

- Preserves content from the active preset outside of chat history (system prompt, character description, etc.)
- Only replaces the chat history portion with the `messages` you provide
- If `runtimeWorldInfo` is provided, World Info entries are injected at the corresponding positions
- If `promptPresetName` is specified, that preset's prompt template is used instead of the current preset

**Practical Example** (based on the Memory Graph plugin's recall flow):

```js
// 1. First resolve World Info activation results
const runtimeWorldInfo = await context.resolveWorldInfoForMessages(
  resolverMessages,
  {
    type: 'quiet',
    fallbackToCurrentChat: false,
    postActivationHook: rewriteDepthWorldInfoToAfter, // Rewrite directive: move depth-type World Info entries to the after position
  }
);

// 2. Assemble the prompt
const promptMessages = context.buildPresetAwarePromptMessages({
  messages: [
    { role: 'system', content: 'You are a memory analysis assistant...' },
    { role: 'user', content: 'Please analyze the key information in the following conversation...' },
  ],
  envelopeOptions: {
    includeCharacterCard: true,
    api: envelopeApi,
    promptPresetName: selectedPromptPresetName,
  },
  promptPresetName: selectedPromptPresetName,
  runtimeWorldInfo: runtimeWorldInfo,
});

// 3. Send to the LLM
import { sendOpenAIRequest } from '../../../openai.js';
const response = await sendOpenAIRequest('quiet', promptMessages, signal, {
 requestScope: 'extension_internal',
});
```

::: tip About the Post-Activation Hook (postActivationHook)
The `postActivationHook` parameter of `resolveWorldInfoForMessages` allows you to make arbitrary modifications to entries after World Info activation but before injection — including modifying content, adjusting injection positions and depth, or even adding/removing entries. The hook receives the fully normalized World Info payload and returns the modified version. For example, the Memory Graph plugin uses this hook to rewrite depth-type World Info entries to the after position, preventing them from being inserted into the chat depth and interfering with the plugin's own instructions.
:::

### resolveWorldInfoForMessages

```ts
resolveWorldInfoForMessages(
  messages: Array<{ role: string, content: string }>,
  options?: {
    type?: string,
    fallbackToCurrentChat?: boolean,
    postActivationHook?: (entries: object) => object,
  }
): Promise<object>
```

Performs a World Info activation scan against the specified messages and returns the activation results. This is essentially a World Info "rescan" against custom messages.

**Parameters:**

| Parameter | Description |
|------|------|
| `messages` | Message list used to trigger World Info keyword matching |
| `options.type` | Activation type (e.g., `'quiet'` for silent scan that does not affect the main conversation) |
| `options.fallbackToCurrentChat` | Whether to fall back to current chat messages if `messages` is empty |
| `options.postActivationHook` | Post-activation hook function that receives the full World Info payload; can modify entry content, positions, depth, or add/remove entries |

The returned object contains fields such as `worldInfoBeforeEntries`, `worldInfoAfterEntries`, and `worldInfoDepth`, which can be passed directly to the `runtimeWorldInfo` parameter of `buildPresetAwarePromptMessages`.

::: tip World Info Rescan
`resolveWorldInfoForMessages` is essentially a World Info rescan against custom messages. Plugins can use it to:
- Obtain relevant World Info entries for independent LLM calls
- Test which World Info entries a specific message would trigger
- Simulate World Info activation without affecting the main conversation
:::

### Recommended Independent LLM Call Pattern

When a plugin needs to make independent LLM calls (e.g., AI-assisted features in a popup), the following pattern is recommended:

```js
import { sendOpenAIRequest } from '../../../openai.js';
const context = Luker.getContext();

// 1. Resolve World Info activation results
const wi = await context.resolveWorldInfoForMessages(myCustomMessages, {
 type: 'quiet',
 fallbackToCurrentChat: false,
});

// 2. Assemble the prompt (inject character card, world info, arrange by prompt_order)
const requestMessages = context.buildPresetAwarePromptMessages({
 messages: myCustomMessages,
 runtimeWorldInfo: wi,
});

// 3. Send the request
const result = await sendOpenAIRequest('quiet', requestMessages, signal, {
 requestScope: 'extension_internal',
});
```

If you don't need character cards or world info, you can skip steps 1-2 and pass messages directly to `sendOpenAIRequest`. See [Generation](/development/extension-api/generation) for `sendOpenAIRequest` details.

## Prompt Envelope Inspection

For diagnostic UIs and "preview what would be sent" tooling, plugins can read the assembled prompt envelope and layout without dispatching a request.

### getActivePromptPresetEnvelope

```ts
getActivePromptPresetEnvelope(options?: {
    includeCharacterCard?: boolean,
    api?: string,
    promptPresetName?: string,
    completionPresetName?: string,
    contextPresetName?: string,
    instructPresetName?: string,
    syspromptPresetName?: string,
    reasoningPresetName?: string,
}): PromptPresetEnvelope
```

Returns a snapshot of the resolved prompt configuration including:

- `mainApi` / `completionApi` — active API identifiers
- `presetRefs` — names of resolved completion / context / instruct / sysprompt / reasoning presets
- `promptCore` — extracted prompt-affecting fields per preset
- `promptLayout` — the merged Luker layout (from `extensions.luker.prompt_layout`)
- `promptCatalog` — map of `prompt.identifier` → `{ name, role, content, marker, systemPrompt }`
- `characterCard` — current character fields (when `includeCharacterCard !== false`)

This is the same data that `buildPresetAwarePromptMessages` consumes internally. Useful for showing users what their plugin's request will look like before sending.

### getActivePromptLayout

```ts
getActivePromptLayout(options?: object): PromptLayoutEntry[]
```

Convenience accessor returning just the merged prompt layout. Each entry has `id`, `enabled`, `order`, `role`, `phase`, `source`, `content`, `path`, `promptIdentifier`, `tags`.

### formatPromptPresetEnvelope

```ts
formatPromptPresetEnvelope(envelope?: object, options?: { label?: string }): string
```

Formats an envelope as `[[LABEL]]\n<json>` for embedding into another prompt (e.g., when delegating to a meta-LLM that needs to reason about the user's prompt config). Defaults to the current envelope when none is supplied.

```js
const ctx = Luker.getContext();
const envelope = ctx.getActivePromptPresetEnvelope({ includeCharacterCard: true });
const serialized = ctx.formatPromptPresetEnvelope(envelope);
console.log(serialized);
```

## Reasoning

Reasoning helpers parse and render the `<thinking>...</thinking>` style blocks emitted by reasoning models (Claude reasoning, DeepSeek-R1, o1, etc.).

### parseReasoningFromString

```ts
parseReasoningFromString(
    text: string,
    options?: { strict?: boolean },
    template?: ReasoningTemplate | null,
): { reasoning: string, content: string } | null
```

Splits a model output string into `reasoning` and `content` based on the `prefix` and `suffix` of a reasoning template (or the active `power_user.reasoning` template). Returns `null` if the template lacks prefix/suffix or the parse fails.

| Option | Description |
|------|------|
| `strict` | When `true` (default), the prefix must appear at the start (after whitespace). When `false`, finds it anywhere |

### getReasoningTemplateByName

```ts
getReasoningTemplateByName(name: string): ReasoningTemplate
```

Looks up a reasoning template by name. Throws `Error('Unknown reasoning template name: "<name>"')` when not found. The returned template should be treated as read-only.

### updateReasoningUI

```ts
updateReasoningUI(
    messageIdOrElement: number | HTMLElement | JQuery,
    options?: { reset?: boolean },
): void
```

Triggers a UI refresh of the reasoning block on a message. Pass a chat index, a raw DOM element, or a JQuery wrapper. `reset: true` skips reading the message's current reasoning state — used during swipes when the new reasoning hasn't been written yet.

### removeReasoningFromString

```ts
removeReasoningFromString(str: string): string
```

Strips the reasoning prefix/suffix block from a string using the active reasoning template. Returns the input unchanged when no template is configured or no reasoning span is found. Use when you need just the user-facing answer text from a model output that may include `<thinking>...</thinking>`-style sections.

```js
const ctx = Luker.getContext();
const parsed = ctx.parseReasoningFromString(modelOutput);
if (parsed) {
    console.log('Reasoning:', parsed.reasoning);
    console.log('Final answer:', parsed.content);
}
```

## Settings Views (Read-Only)

The following properties expose live settings objects. They are mutable references — write through them only through their canonical APIs (`presets.save`, `saveSettingsDebounced`, etc.). Direct mutation may not persist correctly.

### chatCompletionSettings

```ts
context.chatCompletionSettings: object
```

Reference to `oai_settings`. Read-only views useful for inspecting the active chat completion source, model, and parameters.

### textCompletionSettings

```ts
context.textCompletionSettings: object
```

Reference to `textgenerationwebui_settings`. Read-only views for the active text completion backend.

### powerUserSettings

```ts
context.powerUserSettings: object
```

Reference to `power_user`. Holds tokenizer choice, reasoning template selection, message-display preferences, and other user-level configuration.

::: warning Mutate via APIs, not directly
These views are exposed for inspection only. Writing to them directly may bypass debounced save logic. To change connection or model, use the user-facing UI or [`presets.save`](#presets-save). To change generation parameters, use a chat completion preset.
:::

## Connection Helpers

### context.openai

```ts
context.openai: {
    proxies: Array<{ name: string, url: string, ... }>,
    ZAI_ENDPOINT: Record<string, string>,
    stripPresetConnectionFields(preset: object): object,
}
```

Helpers for working with chat-completion connection state. `proxies` is the live list of user-configured reverse proxies. `ZAI_ENDPOINT` enumerates the well-known Zhipu / Z.AI endpoint URLs. `stripPresetConnectionFields` returns a clone of a preset with connection-specific fields (api source, model, proxy, etc.) removed — used when exporting a preset that should be portable across user setups.

```js
const ctx = Luker.getContext();
const portable = ctx.openai.stripPresetConnectionFields(preset);
const json = JSON.stringify(portable, null, 2);
```

### context.textCompletion

```ts
context.textCompletion: {
    types: Record<string, string>,
}
```

`textCompletion.types` enumerates supported text-completion backend identifiers (`OOBA`, `MANCER`, `APHRODITE`, `KOBOLDCPP`, …). Use when branching behavior on which text-completion provider is active.
