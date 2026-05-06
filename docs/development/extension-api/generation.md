# Generation

APIs for sending LLM requests, registering tools into the global tool registry, and resolving connection configuration.

## Sending LLM Requests

The recommended API is `context.generateTask` — a one-stop function that handles profile resolution, world-info activation, prompt assembly, dispatch, and response normalization in a single call. Built-in extensions (search-tools, completion-preset-assistant, character-editor-assistant, memory-graph, orchestrator) all route through it. Third-party extensions should use it too instead of stitching together `sendOpenAIRequest` + `buildPresetAwarePromptMessages` + `connectionProfiles.resolve` themselves.

::: info Why one API
Manual stitching means every extension reimplements profile resolution, world-info activation, family dispatch (openai vs kobold/novel/textgen), and response parsing. `generateTask` consolidates all of that and returns a normalized result shape regardless of the underlying API family.
:::

### Quick Start

For a plain text request that respects the active prompt preset, character card, and chat world info:

```js
const context = Luker.getContext();

const result = await context.generateTask({
    taskMessages: [
        { role: 'system', content: 'You are a translation assistant.' },
        { role: 'user', content: 'Translate this text into French: hello world.' },
    ],
    worldInfoSource: 'chat',  // activate WI from current chat history
    abortSignal: controller.signal,
});

console.log(result.assistantText);
```

### Option Reference

```ts
context.generateTask({
    taskMessages: Array<{role, content, ...}>,   // required: system / user / assistant / tool turns
    includeCharacterCard?: boolean = true,        // include character card in the envelope
    worldInfoSource?: 'none' | 'task' | 'chat' | 'custom' = 'none',
    customWorldInfoMessages?: Array | null = null, // required when worldInfoSource is 'custom'
    runtimeWorldInfo?: object | null = null,      // pre-resolved snapshot; short-circuits resolution
    forceWorldInfoResimulate?: boolean = false,
    worldInfoType?: string = 'quiet',
    apiPresetName?: string = '',                  // connection profile name (e.g. 'claude')
    llmPresetName?: string = '',                  // chat completion preset name (e.g. 'low-temp')
    tools?: Array | null = null,                  // OpenAI-style tool definitions
    toolChoice?: 'auto' | 'none' | object = 'auto',
    jsonSchema?: object | null = null,            // for structured-output mode (mutually exclusive with tools)
    functionCallMode?: 'auto' | 'native' | 'prompt_xml' | 'prompt_json' = 'auto',
    functionCallOptions?: object | null = null,   // e.g. { protocolStyle, requiredFunctionName }
    abortSignal?: AbortSignal | null = null,
}): Promise<{
    assistantText: string,
    toolCalls: Array<{ name, args, raw }>,
    jsonData: any,                  // populated when jsonSchema mode succeeds
    reasoning: string | null,
    finishReason: string | null,
    usage: object | null,
    raw: any,                       // sender-specific raw response (for advanced inspection)
}>
```

### `worldInfoSource` modes

| Value | Meaning |
|-------|---------|
| `'none'` (default) | Skip world-info activation. Use this when you've already pre-resolved `runtimeWorldInfo`, or your task doesn't need WI at all. |
| `'task'` | Activate WI based on `taskMessages`. Use when the task itself drives WI matching. |
| `'chat'` | Activate WI based on the current chat history (uses `fallbackToCurrentChat: true` internally). |
| `'custom'` | Activate WI based on `customWorldInfoMessages` you supply explicitly. |

If you already have a resolved WI snapshot (e.g., cached across retries), pass `runtimeWorldInfo` directly with `worldInfoSource: 'none'` to skip re-resolution.

### Tool Calls

```js
const result = await context.generateTask({
    taskMessages: [
        { role: 'system', content: 'Use tool calls only.' },
        { role: 'user', content: 'Search the web for: claude opus 4 release notes.' },
    ],
    worldInfoSource: 'none',
    tools: [{
        type: 'function',
        function: {
            name: 'search_web',
            description: 'Search the web for information.',
            parameters: {
                type: 'object',
                properties: { query: { type: 'string' } },
                required: ['query'],
            },
        },
    }],
    toolChoice: 'auto',
    functionCallMode: 'auto',
});

for (const call of result.toolCalls) {
    console.log(call.name, call.args);  // args is already parsed (object)
}
```

`result.toolCalls` is always an array of `{ name, args, raw }`. `args` is the parsed arguments object — you don't need to `JSON.parse` it. `raw` is the original tool-call object from the sender (useful when you need the original `id`).

#### Forced single function

When you want the model to invoke exactly one specific function:

```js
toolChoice: { type: 'function', function: { name: 'my_fn' } },
functionCallOptions: { requiredFunctionName: 'my_fn' },
```

#### Function call mode

| Mode | When to pick it |
|------|-----------------|
| `'auto'` (default) | Let the runtime decide based on the active connection profile. |
| `'native'` | Force native tool-calling (e.g., OpenAI tools / Anthropic tool_use). |
| `'prompt_xml'` | Embed tool definitions in the system prompt as XML — useful for models without native tool calling. |
| `'prompt_json'` | Embed tool definitions as JSON in the prompt. |

### Structured Output (JSON Schema)

For non-tool structured output:

```js
const result = await context.generateTask({
    taskMessages: [
        { role: 'system', content: 'Return user demographics as JSON.' },
        { role: 'user', content: 'Alice, 32, software engineer.' },
    ],
    worldInfoSource: 'none',
    jsonSchema: {
        type: 'object',
        properties: {
            name: { type: 'string' },
            age: { type: 'integer' },
            occupation: { type: 'string' },
        },
        required: ['name', 'age', 'occupation'],
        additionalProperties: false,
    },
});

console.log(result.jsonData);  // { name: 'Alice', age: 32, occupation: 'software engineer' }
```

`tools` and `jsonSchema` are mutually exclusive — pass one or the other, never both.

### Errors

All failures throw `GenerateTaskError`, exposed at `context.GenerateTaskError`:

```js
try {
    await context.generateTask({ ... });
} catch (error) {
    if (error instanceof context.GenerateTaskError) {
        console.warn('generateTask failed:', error.code, error.message);
        if (error.code === 'rate_limit') {
            // back off and retry
        }
    }
    throw error;
}
```

| `code` | Meaning |
|--------|---------|
| `aborted` | Request was aborted via `abortSignal`. |
| `network` | Network-level failure (DNS, ECONNREFUSED, etc.). |
| `auth_missing` | Authentication error (401, missing API key). |
| `rate_limit` | Rate limited (429). |
| `invalid_input` | The options object is malformed (e.g., `tools` and `jsonSchema` both set, `worldInfoSource:'custom'` without `customWorldInfoMessages`). |
| `unsupported_api` | The resolved request API isn't supported by the runtime. |
| `tool_call_parse` | Model returned a tool call whose `arguments` failed `JSON.parse`. |
| `json_schema_violation` | `jsonSchema` mode failed validation. |
| `no_response` | Sender returned no usable content. |
| `unknown` | Catch-all for unclassified failures. |

`error.cause` carries the original underlying error when available; `error.details` carries diagnostic context (e.g., the rejected `rawArgs` for `tool_call_parse`).

### End-to-End Example

A search agent that respects the user-selected connection profile, runs tool calls until the model finalizes, and aborts cleanly:

```js
const context = Luker.getContext();
const settings = extension_settings.my_search_agent;

const result = await context.generateTask({
    taskMessages: [
        { role: 'system', content: 'You are a search agent. Use search_web only.' },
        { role: 'user', content: userQuery },
    ],
    worldInfoSource: 'chat',          // activate WI from current chat
    apiPresetName: settings.connectionProfileName,  // user-selected, e.g. 'claude'
    llmPresetName: settings.presetName,             // user-selected, e.g. 'low-temp'
    tools: [searchWebTool],
    toolChoice: 'auto',
    functionCallMode: 'auto',
    abortSignal: controller.signal,
});

if (result.toolCalls.length === 0) {
    return { text: result.assistantText, calls: [] };
}
return {
    text: result.assistantText,
    calls: result.toolCalls.map(c => ({ name: c.name, args: c.args })),
};
```

## Migration Cookbook

If your extension was previously calling `sendOpenAIRequest` directly, here's how to translate.

### Mapping

| Old | New |
|-----|-----|
| `import { sendOpenAIRequest } from '../../openai.js'` | use `context.generateTask` (no import needed) |
| `import { resolveChatCompletionRequestProfile } from '../connection-manager/profile-resolver.js'` | drop — pass `apiPresetName` to `generateTask` |
| `import { extractAllFunctionCalls, getResponseMessageContent } from '../function-call-runtime.js'` | drop — read `result.toolCalls` and `result.assistantText` |
| `context.buildPresetAwarePromptMessages({ messages, envelopeOptions, runtimeWorldInfo })` | drop — `generateTask` assembles internally |
| `responseData = await sendOpenAIRequest('quiet', msgs, signal, { llmPresetName, apiSettingsOverride, tools, toolChoice, requestScope: 'extension_internal', functionCallOptions })` | `result = await context.generateTask({ taskMessages, llmPresetName, apiPresetName, tools, toolChoice, functionCallOptions, abortSignal })` |
| `calls = extractAllFunctionCalls(responseData, allowedNames)` | `calls = result.toolCalls.filter(c => allowedNames.has(c.name))` |
| `assistantText = getResponseMessageContent(responseData)` | `assistantText = result.assistantText` |

### Before / After

**Before** (manual stitching):

```js
import { sendOpenAIRequest } from '../../openai.js';
import { resolveChatCompletionRequestProfile } from '../connection-manager/profile-resolver.js';
import { extractAllFunctionCalls } from '../function-call-runtime.js';

const { apiSettingsOverride, requestApi } = resolveChatCompletionRequestProfile({
    profileName: settings.connectionProfileName,
    defaultApi: context.mainApi || 'openai',
    defaultSource: context.chatCompletionSettings?.chat_completion_source || '',
});

const worldInfo = await context.resolveWorldInfoForMessages(messages, {
    type: 'quiet',
    fallbackToCurrentChat: true,
});

const promptMessages = context.buildPresetAwarePromptMessages({
    messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ],
    envelopeOptions: {
        includeCharacterCard: true,
        api: settings.presetName ? 'openai' : requestApi,
        promptPresetName: settings.presetName,
    },
    promptPresetName: settings.presetName,
    runtimeWorldInfo: worldInfo,
});

const responseData = await sendOpenAIRequest('quiet', promptMessages, abortSignal, {
    tools,
    toolChoice: 'auto',
    replaceTools: true,
    llmPresetName: settings.presetName,
    apiSettingsOverride,
    requestScope: 'extension_internal',
    functionCallOptions: { protocolStyle: TOOL_PROTOCOL_STYLE.JSON_SCHEMA },
});

const calls = extractAllFunctionCalls(responseData, allowedNames);
```

**After** (`generateTask`):

```js
const result = await context.generateTask({
    taskMessages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ],
    includeCharacterCard: true,
    worldInfoSource: 'chat',
    apiPresetName: settings.connectionProfileName,
    llmPresetName: settings.presetName,
    tools,
    toolChoice: 'auto',
    functionCallMode: 'auto',
    functionCallOptions: { protocolStyle: TOOL_PROTOCOL_STYLE.JSON_SCHEMA },
    abortSignal,
});

const calls = result.toolCalls.filter(c => allowedNames.has(c.name));
```

### Caveats

- `generateTask` always sets `requestScope: 'extension_internal'` internally — you no longer need to pass it.
- `replaceTools: true` is implied when you pass `tools`. There's no separate flag.
- The old `apiSettingsOverride` path is gone from the recommended API. If you still need raw override (advanced), use `connectionProfiles.resolve` and the low-level dispatcher (see [Low-Level Reference](#low-level-reference)).

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
        return `Result for: ${args.input}`;
    },
    formatMessage: (args) => {
        return `Used my tool with input: ${args.input}`;
    },
    shouldRegister: async () => {
        return true;
    },
    stealth: false,
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
`registerFunctionTool` adds tools to the **global registry** — they are available in the main chat for the model to call. The `tools` parameter in `generateTask` provides tools for **that specific request only** and does not affect the global registry.
:::

## Low-Level Reference

These primitives back `generateTask`. Use them directly only when `generateTask` doesn't fit — for example, when you need streaming responses, custom retry logic that mutates the request between attempts, or integration with a non-standard pipeline.

### Connection Profile Resolution

A connection profile is a bundle of **connection configuration** (API kind, model, secret, proxy, etc.) managed by Luker's Connection Manager. It's a **separate concept** from chat completion presets — profiles describe "where to connect", presets describe "how to generate". The two compose freely.

When a plugin needs to let the user pick a connection profile (e.g., a "which API config to use" dropdown), use `context.connectionProfiles.list()` to populate the UI:

```js
context.connectionProfiles.list(): ConnectionProfile[]
```

::: info `connectionProfiles.resolve` is deprecated for direct extension use
With `generateTask`, you pass the profile *name* (`apiPresetName`) and resolution happens internally. The `resolve(...)` method is kept for backwards compatibility but is no longer recommended for new code.
:::

### sendOpenAIRequest

Direct LLM dispatcher. `generateTask` calls this internally for OpenAI-family requests after handling envelope assembly, world-info activation, and profile resolution.

```js
import { sendOpenAIRequest } from '../../../openai.js';

const result = await sendOpenAIRequest('quiet', messages, signal, {
    tools,
    toolChoice: 'auto',
    replaceTools: true,
    llmPresetName,
    apiSettingsOverride,
    requestScope: 'extension_internal',
    functionCallOptions: { protocolStyle: 'json_schema' },
});
```

The first argument `'quiet'` means this is a background request that won't appear in the chat UI.

| Parameter | Purpose |
|-----------|---------|
| `llmPresetName` | Load a chat completion preset to override **generation parameters** (temperature, top_p, frequency_penalty, max_tokens, etc.). Does not affect connection fields. |
| `apiPresetName` | Connection profile name. Resolved internally. If both this and `apiSettingsOverride` are provided, the explicit override wins. |
| `apiSettingsOverride` | Directly override connection settings with an object (typically from `connectionProfiles.resolve`). Takes precedence over `apiPresetName`. |
| `requestScope` | Set to `'extension_internal'` to skip main chat CHAT_COMPLETION hooks. |

### buildPresetAwarePromptMessages

Envelope assembly only — no dispatch. Useful when you need to **inspect** the assembled prompt without sending it (e.g., a "show me what would be sent" preview tool).

```js
const messages = context.buildPresetAwarePromptMessages({
    messages: [
        { role: 'system', content: taskSystemPrompt },
        { role: 'user', content: taskUserPrompt },
    ],
    envelopeOptions: {
        includeCharacterCard: true,
        api: 'openai',
        promptPresetName: llmPresetName,
    },
    promptPresetName: llmPresetName,
    runtimeWorldInfo: preResolvedWorldInfo,
});
```

It arranges your messages according to the active prompt preset's `prompt_order`, optionally injecting the character card and world info entries. See [Presets & Prompts](/development/extension-api/presets-and-prompts) for assembly details.
