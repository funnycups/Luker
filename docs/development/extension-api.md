# Extension API Reference

This document is the complete reference for the Luker Extension API, intended for plugin developers. All APIs are exposed through `Luker.getContext()`.

## Global Entry Point

```js
const context = Luker.getContext();
```

| Alias | Description |
|------|------|
| `Luker.getContext()` | Recommended |
| `SillyTavern.getContext()` | Compatibility alias |
| `st.getContext()` | Compatibility alias |

New plugins should use `Luker.getContext()` exclusively. Compatibility aliases are retained only for the migration period.

## API Differences from SillyTavern

Luker is built on SillyTavern but has the following major API-level differences:

| Area | SillyTavern | Luker |
|------|-------------|-------|
| Chat persistence | Full-file overwrite | Patch-first (RFC 6902 incremental updates) |
| Chat-bound state | `chat_metadata` only | New Chat State mechanism |
| Preset management | Direct import of internal modules | Unified `context.presets.*` API |
| Prompt assembly | Manual concatenation required | `buildPresetAwarePromptMessages()` |
| World Info simulation | None | `simulateWorldInfoActivation()` |
| Generation hooks | Basic events | New fine-grained hooks such as `GENERATION_CONTEXT_READY`, `GENERATION_BEFORE_WORLD_INFO_SCAN`, etc. |
| Event ordering | Registration order | Supports `priority`, `pluginOrder`, `makeFirst`/`makeLast` |
| Regex runtime | No plugin API | `registerManagedRegexProvider()` |
| Search tools | No plugin API | `Luker.searchTools` global API |
| Function calling | Basic `ToolManager` | Plain-text mode support + connection-level toggle + `sendOpenAIRequest` preset override |
| Connection config | Single global config | `context.presets.resolve()` supports per-preset connection resolution |

> [!IMPORTANT]
> Prefer the APIs provided by `Luker.getContext()` over calling the underlying HTTP endpoints directly. The Context API encapsulates patch-first semantics, conflict handling, and retry logic; calling endpoints directly requires you to handle these details yourself.

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
  target?: PresetRef,
  options?: object
): ConnectionProfile
```

Resolves the connection configuration (API endpoint, model, key, etc.) for a preset. This is the recommended way for plugins to obtain connection information when making independent API calls.

The returned `ConnectionProfile` contains:

| Field | Description |
|------|------|
| `requestApi` | Normalized API type (e.g., `'openai'`) |
| `requestModel` | Model name |
| `requestUrl` | API endpoint URL |
| `secretId` | Secret key identifier |

### presets.state

```ts
presets.state.update(
  namespace: string,
  updater: (current: any) => any,
  options?: { target: PresetRef }
): Promise<void>
```

Manages plugin runtime/session data bound to a preset. This data is not exported with the preset and is only used for plugin runtime state.

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

If you don't need character cards or world info, you can skip steps 1-2 and pass messages directly to `sendOpenAIRequest`.

## Regex Runtime API

Plugins can register managed regex processors via `registerManagedRegexProvider()` to participate in Luker's regex processing pipeline. This function is exported from the regex engine module:

```js
import { registerManagedRegexProvider } from '../../extensions/regex/engine.js';

const handle = registerManagedRegexProvider('my-plugin', {
  reloadOnChange: true,
});

// Add a regex script
handle.upsertScript({
  id: 'my-rule-1',
  scriptName: 'My Regex Rule',
  findRegex: 'foo',
  replaceString: 'bar',
  // ...other regex script fields
});

// Unregister on teardown
handle.unregister();
```

The handle returned by `registerManagedRegexProvider` provides `upsertScript`, `removeScript`, `setScripts`, `clearScripts`, and `unregister` methods.

## Search Tools API

The search plugin exposes its API through the `Luker.searchTools` global object, allowing other plugins to leverage search capabilities:

```js
// Check if the search plugin is available
if (globalThis?.Luker?.searchTools) {
  // Get the list of available search tool names
  const toolNames = Luker.searchTools.toolNames;
  // Get tool definitions (for function calling)
  const toolDefs = Luker.searchTools.getToolDefs();
  // Check if a tool name belongs to search tools
  const isSearchTool = Luker.searchTools.isToolName('web_search');
}
```

`Luker.searchTools` exposes tool definition metadata; actual search execution is performed through the internal tool-calling loop. See [Search Tools](/features/search-tools) for details.

## Sending LLM Requests

Plugins can send independent LLM requests using `sendOpenAIRequest`, the core generation function exposed on `getContext()`.

### Basic Usage

For simple LLM calls that don't need character cards or world info:

```js
import { sendOpenAIRequest } from '../../../openai.js';

const result = await sendOpenAIRequest('quiet', [
    { role: 'system', content: 'You are a translation assistant.' },
    { role: 'user', content: 'Translate this text...' },
], signal, {
    requestScope: 'extension_internal',
});
```

The first argument `'quiet'` means this is a background request that won't appear in the chat UI.

### Preset Override

`sendOpenAIRequest` accepts override parameters to control which model, API endpoint, and generation settings to use:

```js
const result = await sendOpenAIRequest('quiet', messages, signal, {
    llmPresetName: 'my-low-temp',       // Override generation params (temperature, top_p, etc.)
    apiSettingsOverride: profileOverride, // Override connection settings (model, API URL, etc.)
    requestScope: 'extension_internal',
});
```

| Parameter | Purpose |
|-----------|--------|
| `llmPresetName` | Load an LLM preset to override **generation parameters** (temperature, top_p, frequency_penalty, max_tokens, etc.). Does not affect connection fields. |
| `apiPresetName` | Load an API preset to override **connection fields** (chat_completion_source, model, API URL, reverse_proxy, etc.). Does not affect generation parameters. |
| `apiSettingsOverride` | Directly override connection settings with an object (typically from Connection Manager's profile resolution). |
| `requestScope` | Set to `'extension_internal'` to skip main chat CHAT_COMPLETION hooks. |

### Tool Calls

To include tool definitions in the request:

```js
const result = await sendOpenAIRequest('quiet', messages, signal, {
    tools: [
        {
            type: 'function',
            function: {
                name: 'search_web',
                description: 'Search the web for information',
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'Search query' },
                    },
                    required: ['query'],
                },
            },
        },
    ],
    toolChoice: 'auto',
    functionCallMode: 'native',  // or 'prompt_xml' for plain-text mode
    requestScope: 'extension_internal',
});
```

Note: these `tools` are only used for this specific request. They are separate from the global tool registry (see [Tool Registration](#tool-registration) below).

### With Prompt Assembly

For requests that need to incorporate character cards, world info, or prompt templates, use `buildPresetAwarePromptMessages` to assemble the messages first:

```js
const context = Luker.getContext();

// Step 1: Resolve world info
const worldInfo = await context.resolveWorldInfoForMessages(rawMessages);

// Step 2: Assemble messages using prompt preset layout
const messages = context.buildPresetAwarePromptMessages({
    messages: [
        { role: 'system', content: taskSystemPrompt },
        { role: 'user', content: taskUserPrompt },
    ],
    envelopeOptions: {
        includeCharacterCard: true,
        api: 'openai',
    },
    runtimeWorldInfo: worldInfo,
});

// Step 3: Send the assembled messages
const result = await sendOpenAIRequest('quiet', messages, signal, {
    llmPresetName,
    apiSettingsOverride,
    requestScope: 'extension_internal',
});
```

`buildPresetAwarePromptMessages` arranges your messages according to the active prompt preset's `prompt_order`, optionally injecting the character card and world info entries. It controls **what to send**; `sendOpenAIRequest`'s preset parameters control **how to send it** (model, temperature, connection).

## Tool Registration

Plugins can register tools into the global tool registry via `getContext()`. Registered tools appear in the main chat's tool calling flow — the model can invoke them during normal conversation.

```js
const context = Luker.getContext();

context.registerFunctionTool({
    name: 'my_plugin_tool',
    displayName: 'My Tool',
    description: 'Does something useful',
    parameters: {
        type: 'object',
        properties: {
            input: { type: 'string', description: 'Input text' },
        },
        required: ['input'],
    },
    action: async (args) => {
        // Execute the tool and return a result string
        return `Result for: ${args.input}`;
    },
    formatMessage: (args) => {
        // Optional: format a human-readable message for the chat
        return `Used my tool with input: ${args.input}`;
    },
    shouldRegister: async () => {
        // Optional: return false to conditionally skip registration
        return true;
    },
    stealth: false, // Optional: if true, tool results won't show in chat
});
```

To remove a registered tool:

```js
context.unregisterFunctionTool('my_plugin_tool');
```

Utility methods:

| Method | Description |
|--------|------------|
| `context.registerFunctionTool(tool)` | Register a tool to the global registry |
| `context.unregisterFunctionTool(name)` | Remove a tool from the global registry |
| `context.isToolCallingSupported()` | Check if the current API/model supports tool calling |
| `context.canPerformToolCalls(type)` | Check if tool calls can be performed for a given request type |

::: warning Global vs Per-Request Tools
`registerFunctionTool` adds tools to the **global registry** — they are available in the main chat for the model to call. The `tools` parameter in `sendOpenAIRequest` provides tools for **that specific request only** and does not affect the global registry.
:::

## Connection Configuration Resolution

When a plugin needs to use a connection configuration other than the current preset, use `presets.resolve()`:

```js
const profile = context.presets.resolve(
  { collection: 'openai', name: 'My Preset' }
);

// profile contains:
// - requestApi: 'openai'
// - requestModel: 'gpt-4o'
// - requestUrl: 'https://api.openai.com/v1'
// - secretId: '...'
```

`secret_id` request override: In the chat-completions request body, you can use the `secret_id` field to specify which API key to use, overriding the global selection. This is particularly useful in multi-agent scenarios where different agents may use different API keys.

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

## Extension API Registry

Extensions can register public APIs and consume other extensions' APIs through the `registerExtensionApi` / `getExtensionApi` mechanism. This provides a decoupled way for extensions to expose functionality without direct module imports.

### registerExtensionApi(name, api)

Registers a public API object under a unique name. If a name is already registered, a warning is logged to the console and the existing API is overwritten.

```js
context.registerExtensionApi('my-extension', {
  doSomething: () => { /* ... */ },
  getData: () => myData,
  onEvent: (callback) => { /* ... */ },
});
```

- **name** — A unique string identifier for the API (conventionally matches the extension's package name)
- **api** — Any object that other extensions will interact with

### getExtensionApi(name)

Retrieves a previously registered API by name. Returns `undefined` if no API has been registered under that name.

```js
const api = context.getExtensionApi('my-extension');
if (api) {
  api.doSomething();
}
```

Both methods are available on the context object returned by `getContext()`:

```js
const context = Luker.getContext();
context.registerExtensionApi('name', apiObj);
context.getExtensionApi('name');
```

### Typical Usage

A common pattern is for an extension to register its API during initialization so other extensions can consume it:

```js
// In extension A's init code:
context.registerExtensionApi('card-app', {
  getActiveApp: () => activeApp,
  sendMessage: (text) => { /* ... */ },
});

// In extension B's init code:
const cardApp = context.getExtensionApi('card-app');
if (cardApp) {
  const app = cardApp.getActiveApp();
}
```

## Event System

### eventSource

```js
// Listen
context.eventSource.on(eventName, handler, options?);

// Unlisten
context.eventSource.off(eventName, handler);

// Ensure execution first
context.eventSource.makeFirst(eventName, handler);

// Ensure execution last
context.eventSource.makeLast(eventName, handler);

// Inspect listener info (for debugging)
context.eventSource.getListenersMeta(eventName);

// Configure plugin ordering
context.eventSource.setOrderConfig(config);
```

### Listener Options

```js
context.eventSource.on(eventName, handler, {
  priority: 10,  // Higher numbers execute first
});
```

### Event Types

All event types are accessed via `context.eventTypes`. For the complete event list and callback parameters, see [Frontend Plugin Development](/development/frontend-plugin#event-system).

## World Info Read/Write

Plugins can read and write World Info entries through the context API.

## Low-Level Endpoint Reference (Advanced / Debugging)

> [!WARNING]
> The following endpoints are provided only as a reference for advanced debugging and integration scenarios where `Luker.getContext()` cannot be used. They are same-origin web application routes, not the primary plugin API contract. Normal plugin development should use the Context API described above.

### Character Chats

| Method | Path | Description |
|------|------|------|
| POST | `/api/chats/save` | Save chat (patch-first) |
| POST | `/api/chats/get` | Get chat list |
| POST | `/api/chats/delete` | Delete chat |
| POST | `/api/chats/rename` | Rename chat |
| POST | `/api/chats/export` | Export chat |

### Group Chats

| Method | Path | Description |
|------|------|------|
| POST | `/api/chats/group/save` | Save group chat |
| POST | `/api/chats/group/get` | Get group chat list |
| POST | `/api/chats/group/delete` | Delete group chat |

### Chat State

| Method | Path | Description |
|------|------|------|
| POST | `/api/chats/state/get` | Batch read state |
| POST | `/api/chats/state/patch` | Incrementally update state |
| POST | `/api/chats/state/delete` | Delete state |

### Settings

| Method | Path | Description |
|------|------|------|
| POST | `/api/settings/save` | Save settings (patch-first) |
| POST | `/api/settings/get` | Get settings |

### World Info

| Method | Path | Description |
|------|------|------|
| POST | `/api/worldinfo/save` | Save World Info (patch-first) |
| POST | `/api/worldinfo/get` | Get World Info |

### Search / Visit

| Method | Path | Description |
|------|------|------|
| POST | `/api/plugins/search/search` | Execute search |
| POST | `/api/plugins/search/visit` | Visit a URL and extract content |

### Patch Operation Format

Message patches use the RFC 6902 JSON Patch format:

```json
[
  { "op": "replace", "path": "/4/mes", "value": "New content" },
  { "op": "add", "path": "/4/extra/note", "value": "Note" },
  { "op": "remove", "path": "/4/extra/old_field" }
]
```

Object patches (`meta/patch`, `state/patch`, `settings/patch`, `worldinfo/patch`) also use the same RFC 6902 format.

### Patch Conflicts and Integrity Semantics

- The server validates whether the path in a patch operation exists
- `replace` operations require the target path to already exist
- `add` operations create paths that do not exist
- On conflict, an error is returned; the client should retry or fall back to a full save

### Chat-Completions Request Body

```json
{
  "messages": [...],
  "model": "gpt-4o",
  "secret_id": "optional-override"
}
```

The `secret_id` field allows overriding the API key used at the request level, suitable for scenarios such as multi-agent orchestration that require different keys.

## Related Pages

- [Frontend Plugin Development](/development/frontend-plugin) — Plugin structure, event system, UI integration
- [Character Card Development](/development/card-developers) — Character Card extension fields and CardApp
- [Incremental Sync](/improvements/incremental-sync) — Technical details of incremental saving
- [Preset Decoupling](/improvements/preset-decoupling) — Mechanism for decoupling presets from API selection
