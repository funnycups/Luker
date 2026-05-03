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

If you don't need character cards or world info, you can skip steps 1-2 and pass messages directly to `sendOpenAIRequest`. See [Generation](/development/extension-api/generation) for `sendOpenAIRequest` details.
