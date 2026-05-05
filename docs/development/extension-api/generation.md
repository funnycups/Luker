# Generation

APIs for sending LLM requests, registering tools into the global tool registry, and resolving connection configuration.

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
| `llmPresetName` | Load a chat completion preset to override **generation parameters** (temperature, top_p, frequency_penalty, max_tokens, etc.). Does not affect connection fields. |
| `apiPresetName` | Connection profile name. Resolved internally to the corresponding connection-field override and applied to the request — equivalent to calling `context.connectionProfiles.resolve(...)` yourself, just terser at the call site. If both this and `apiSettingsOverride` are provided, the explicit override wins. |
| `apiSettingsOverride` | Directly override connection settings with an object (typically from `context.connectionProfiles.resolve(...)`). Takes precedence over `apiPresetName`. |
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

`buildPresetAwarePromptMessages` arranges your messages according to the active prompt preset's `prompt_order`, optionally injecting the character card and world info entries. It controls **what to send**; `sendOpenAIRequest`'s preset parameters control **how to send it** (model, temperature, connection). See [Presets & Prompts](/development/extension-api/presets-and-prompts) for assembly details.

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

## Connection Profile Resolution

A connection profile is a bundle of **connection configuration** (API kind, model, secret, proxy, etc.) managed by Luker's Connection Manager. It's a **separate concept** from chat completion presets — profiles describe "where to connect", presets describe "how to generate". The two compose freely.

When a plugin needs to let the user pick a connection profile to send a request through (e.g. exposing a "which API config to use" dropdown), use `context.connectionProfiles`:

```ts
context.connectionProfiles.list(): ConnectionProfile[]

context.connectionProfiles.resolve({
  profileName?: string,    // The user-selected profile name; empty string means "no override"
  defaultApi?: string,     // Fallback when the profile doesn't specify an api, defaults to 'openai'
  defaultSource?: string,  // Fallback chat_completion_source when it can't be inferred from profile.api
}): {
  profile: object | null,            // Raw profile object, null if not found
  requestApi: string,                 // 'openai' / 'kobold' / 'novel' / 'textgenerationwebui'
  apiSettingsOverride: object | null  // Pass directly to sendOpenAIRequest
}
```

Use `list()` to populate UI dropdowns. Use `resolve(...)` to convert a profile name into the `apiSettingsOverride` object that `sendOpenAIRequest` expects — this is the **only correct path** from "user-selected profile name" to "an actual outgoing request".

### End-to-End Example

```js
import { sendOpenAIRequest } from '../../../openai.js';
const context = Luker.getContext();

const { apiSettingsOverride } = context.connectionProfiles.resolve({
    profileName: userSelectedProfileName,                                   // e.g. 'claude'
    defaultApi: context.mainApi || 'openai',
    defaultSource: context.chatCompletionSettings?.chat_completion_source || '',
});

const result = await sendOpenAIRequest('quiet', messages, signal, {
    llmPresetName: userSelectedPresetName,  // overrides generation params only, e.g. 'Default'
    apiSettingsOverride,                     // resolved above, overrides connection fields
    requestScope: 'extension_internal',
});
```

`secret_id` request override: In the chat-completions request body, you can use the `secret_id` field to specify which API key to use, overriding the global selection. The `apiSettingsOverride` returned by `connectionProfiles.resolve` already includes the profile's associated `secret_id`, so you usually don't need to set this manually.
