# Plugin Integration

APIs that connect plugins to Luker's pipelines and to each other: regex processing, search tools, the cross-plugin API registry, and the event system.

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

The search plugin exposes its API through the `Luker.searchTools` global object so other plugins can leverage search capabilities:

```js
// Check whether the search plugin is available
if (globalThis?.Luker?.searchTools) {
  // Get the list of available search tool names
  const toolNames = Luker.searchTools.toolNames;
  // Get tool definitions (for function calling)
  const toolDefs = Luker.searchTools.getToolDefs();
  // Check whether a tool name belongs to search tools
  const isSearchTool = Luker.searchTools.isToolName('web_search');
}
```

`Luker.searchTools` exposes tool definition metadata; actual search execution happens via the internal tool-calling loop. See [Search Tools](/features/search-tools) for details.

## Inter-Extension Communication

### registerExtensionApi

```js
context.registerExtensionApi('my-plugin', {
  doSomething: () => { /* ... */ },
  getData: () => myData,
});
```

Registers an API object under a given name so other extensions can retrieve it via `getExtensionApi`. If the name is already registered, a warning is logged to the console and the existing entry is overwritten.

### getExtensionApi

```js
const api = context.getExtensionApi('other-plugin');
if (api) {
  api.doSomething();
}
```

Retrieves an API object registered by another extension. Returns `undefined` if no API is registered under that name.

### Typical Usage

The most common use case is decoupling: one extension provides a capability, another consumes it, without a hard-coded import dependency. For example, CardApp Studio exposes its editor API via `registerExtensionApi`, and other extensions can call it directly once Studio is ready.

The orchestrator extension follows the same convention — it publishes `'orchestrator'` with `registerOrchestrationTool` / `unregisterOrchestrationTool` / `listExtensionTools` (and SillyTavern-bridge helpers) so any other extension can contribute tools that orchestration agents can call. See [Orchestrator Tools API](./orchestrator-tools.md).

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

All event types are accessed via `context.eventTypes`. The full set covers chat lifecycle, message events, generation hooks, and app-level signals.

| Group | Examples |
|------|------|
| Chat lifecycle | `CHAT_CHANGED`, `CHAT_LOADED`, `CHAT_BRANCH_CREATED` |
| Message events | `MESSAGE_SENT`, `MESSAGE_RECEIVED`, `MESSAGE_RENDERED`, `MESSAGE_EDITED`, `MESSAGE_UPDATED`, `MESSAGE_DELETED`, `MESSAGE_SWIPED`, `MESSAGE_SWIPE_DELETED` |
| Generation hooks | `GENERATION_STARTED`, `GENERATION_CONTEXT_READY`, `GENERATION_BEFORE_WORLD_INFO_SCAN`, `GENERATION_BEFORE_API_REQUEST`, `GENERATION_ENDED`, `GENERATION_STOPPED`, `WORLD_INFO_ACTIVATED` |
| Image generation | `IMAGE_GENERATION_STARTED`, `IMAGE_GENERATION_ENDED` |
| App-level | `APP_READY`, `SETTINGS_LOADED_AFTER`, `EXTENSIONS_FIRST_LOAD` |

For full event payload shapes, see [Frontend Plugin Development → Event System](/development/frontend-plugin#event-system).

## Internationalization (i18n)

Plugins should localize user-visible strings using the i18n helpers. Locale data falls back across `zh-CN ↔ zh-TW`.

### t (template tag)

```ts
t`Tag ${name} not found`
```

Tagged template literal that uses the templated form `'Tag ${0} not found'` as the lookup key, then substitutes `name` back into the result. The most ergonomic API for runtime translations.

### translate

```ts
translate(text: string, key?: string | null): string
```

Looks up `text` (or `key` when provided) in the loaded locale data. When no entry is found, returns `text` unchanged. Use when you have a static string without interpolation.

### getCurrentLocale

```ts
getCurrentLocale(): string
```

Returns the lowercase locale identifier resolved at boot — typically `'en'`, `'zh-cn'`, `'zh-tw'`, `'ja-jp'`, etc. Read this if you need to branch behavior by locale.

### addLocaleData

```ts
addLocaleData(localeId: string, data: Record<string, string>): void
```

Merges plugin-supplied translations into the loaded locale data. Call after the i18n system has booted (e.g., on `APP_READY`). When `localeId` is the primary locale, entries always overwrite; when it's a fallback locale, entries only fill missing keys.

```js
const ctx = Luker.getContext();

ctx.eventSource.on(ctx.eventTypes.APP_READY, () => {
    ctx.addLocaleData('zh-cn', {
        'My Plugin': '我的插件',
        'Settings saved': '设置已保存',
    });
    ctx.addLocaleData('en', {
        'My Plugin': 'My Plugin',
        'Settings saved': 'Settings saved',
    });
});
```

## Settings & Storage

### extensionSettings

```ts
context.extensionSettings: object
```

Global plain object where extensions store their configuration. Each extension typically uses its own namespace key:

```js
const ctx = Luker.getContext();

if (!ctx.extensionSettings.my_extension) {
    ctx.extensionSettings.my_extension = { enabled: true, level: 1 };
}

ctx.extensionSettings.my_extension.level += 1;
ctx.saveSettingsDebounced();
```

### saveSettingsDebounced

```ts
context.saveSettingsDebounced(): void
```

Debounced persistence trigger. Call after mutating `extensionSettings` or any settings object. Multiple rapid calls coalesce into a single save.

### saveSettings

```ts
context.saveSettings(loopCounter?: number, options?: object): Promise<void>
```

Awaitable version of `saveSettingsDebounced`. Bypasses the debounce queue and resolves once the network round-trip completes. Use this when subsequent logic depends on settings already being persisted (rare — almost all call sites should prefer the debounced form).

### saveMetadataDebounced

```ts
context.saveMetadataDebounced(): void
```

Debounced wrapper around `saveMetadata` for `chat_metadata` mutations.

### getExtensionManifest

```ts
getExtensionManifest(name: string): ExtensionManifest | null
```

Returns a structured clone of the manifest for the named extension. Accepts either the short name (`SillyTavern-MyExt`) or the internal key (`third-party/SillyTavern-MyExt`); lookup is case- and accent-insensitive. Returns `null` when not found.

### openThirdPartyExtensionMenu

```ts
openThirdPartyExtensionMenu(suggestUrl?: string): Promise<void>
```

Opens the install dialog for third-party extensions. Pre-fills the URL field when `suggestUrl` is supplied.

### accountStorage

```ts
context.accountStorage: {
    getItem(key: string): string | null,
    setItem(key: string, value: any): void,
    removeItem(key: string): void,
    getState(): object,
}
```

Account-scoped key/value store. Values are coerced to strings. Persists through `saveSettingsDebounced`. Use this for user-specific settings that should survive across chats but not be exported with character cards.

```js
const ctx = Luker.getContext();
ctx.accountStorage.setItem('my-extension:last-seen', String(Date.now()));
const lastSeen = ctx.accountStorage.getItem('my-extension:last-seen');
```

## Debug Functions

### registerDebugFunction

```ts
registerDebugFunction(
    functionId: string,
    name: string,
    description: string,
    func: () => void | Promise<void>,
): void
```

Adds a button to the user-settings debug menu. The button calls `func` when clicked. Useful for plugin maintenance actions (clear cache, dump state, force reload, etc.).

```js
const ctx = Luker.getContext();
ctx.registerDebugFunction(
    'my-plugin-clear-cache',
    'Clear my-plugin cache',
    'Removes all cached data stored by my-plugin.',
    () => {
        ctx.extensionSettings.my_plugin.cache = {};
        ctx.saveSettingsDebounced();
        toastr.success('Cache cleared');
    },
);
```

## Data Bank Scrapers

### registerDataBankScraper

```ts
registerDataBankScraper(scraper: {
    id: string,
    name: string,
    description: string,
    iconClass: string,
    iconAvailable: boolean,
    init?: () => Promise<void>,
    isAvailable: () => Promise<boolean>,
    scrape: () => Promise<File[]>,
}): void
```

Registers a custom Data Bank source. When the user selects the scraper in the Data Bank UI, `scrape()` is invoked and the returned `File[]` is added to the bank.

| Field | Description |
|------|------|
| `id` | Unique identifier; duplicate registrations are rejected |
| `name` / `description` | Shown in the scraper picker |
| `iconClass` | FontAwesome class (e.g., `'fa-solid fa-globe'`) |
| `iconAvailable` | Whether the icon is renderable |
| `init` | Optional one-time setup; called lazily |
| `isAvailable` | Whether the scraper can run right now (preconditions met) |
| `scrape` | Performs the scrape; returns the new files |

## Tokenization

For token-counting tasks (budgeting, context-window calculations).

### getTokenCountAsync

```ts
getTokenCountAsync(text: string, padding?: number): Promise<number>
```

Returns the token count of `text` using the active tokenizer. Cached by `${tokenizerType}-${hash}${modelHash}+${padding}`. Returns `0` for empty input.

### getTextTokens

```ts
getTextTokens(tokenizerType: number, text: string): Promise<number[]>
```

Returns the token IDs. `tokenizerType` is one of `context.tokenizers.*` (e.g., `context.tokenizers.OPENAI`, `context.tokenizers.LLAMA3`). Returns `[]` for tokenizers that don't support encoding.

### getTokenizerModel

```ts
getTokenizerModel(): string
```

Returns the model identifier the tokenizer is configured for (e.g., `'gpt-4o'`, `'claude'`, `'llama3'`).

### tokenizers

```ts
context.tokenizers: { NONE, GPT2, OPENAI, LLAMA, LLAMA3, MISTRAL, GEMMA, CLAUDE, ... }
```

Numeric enum of supported tokenizer types. Pass these as the first argument to `getTextTokens`.

## Utility Helpers

### uuidv4

```ts
uuidv4(): string
```

Returns an RFC 4122 UUID v4. Uses `crypto.randomUUID()` when available, otherwise a hex-string fallback.

### timestampToMoment

```ts
timestampToMoment(timestamp: string | number): moment.Moment
```

Returns a `moment` object localized via `getCurrentLocale()`. Returns `moment.invalid()` if the input cannot be parsed.

### humanizedDateTime

```ts
humanizedDateTime(timestamp?: number): string
```

Returns a filename-friendly timestamp string in the form `YYYY-MM-DD@HHhMMmSSsMSms`. Defaults to `Date.now()`.

### isMobile

```ts
isMobile(): boolean
```

Returns `true` for mobile or tablet platforms (UA-parsed).

### shouldSendOnEnter

```ts
shouldSendOnEnter(): boolean
```

Whether pressing Enter should send (vs. insert a newline) based on the user's preference and platform.

### escapeHtml

```ts
context.escapeHtml(str: string): string
```

Escapes `&`, `<`, `>`, `"`, `'` for safe insertion into HTML. Prefer this over hand-rolled escaping when emitting plain text into a template.

### download

```ts
context.download(content: string | Blob, fileName: string, contentType: string): void
```

Triggers a browser download with the given filename and MIME type. `content` may be a string or a `Blob`.

### getFileText

```ts
context.getFileText(file: File): Promise<string>
```

Reads a `File` (from a `<input type="file">` change event) as text. Rejects on read error.

### getStringHash

```ts
context.getStringHash(str: string, seed?: number): number
```

Stable 32-bit FNV-like hash. Useful for cache keys, debounce-by-content identifiers, and "did this change since last time" checks. Not cryptographic.

### createThumbnail

```ts
context.createThumbnail(dataUrl: string, maxWidth?: number, maxHeight?: number, type?: string): Promise<string>
```

Decodes a data URL into an image and returns a downsized version as a new data URL. Type defaults to `'image/jpeg'`. Pass `null` for either dimension to constrain by the other only.

### isValidUrl

```ts
context.isValidUrl(value: string): boolean
```

Returns `true` iff `value` parses as a URL via `new URL()`. Used for input validation before issuing fetches.

### performFuzzySearch

```ts
context.performFuzzySearch(
    type: string,
    data: object[],
    keys: Array<string | { name: string, weight?: number }>,
    searchValue: string,
    fuzzySearchCaches?: object | null,
): Array<{ item: object, score: number, refIndex: number }>
```

Runs a Fuse.js fuzzy match scoped to one of the platform's named indexes (`'characters'`, `'groups'`, `'tags'`, etc.). Returns Fuse-style result objects sorted by relevance. Pass an out-cache object to reuse the built index across calls.

## Lib Bundle

Plugins occasionally need a third-party library that's already bundled into the core (`lib.core.bundle.js`). Rather than re-bundling per plugin or relying on globals, consume them through `context.lib`.

### context.lib

```ts
context.lib: {
    DOMPurify,
    lodash,
    DiffMatchPatch,
    showdown,
    yaml,
}
```

| Field | Library |
|------|------|
| `DOMPurify` | HTML sanitizer ([DOMPurify](https://github.com/cure53/DOMPurify)) |
| `lodash` | Utility belt ([lodash](https://lodash.com/)) |
| `DiffMatchPatch` | Diff/patch engine ([diff-match-patch](https://github.com/google/diff-match-patch)) |
| `showdown` | Markdown → HTML ([showdown](https://github.com/showdownjs/showdown)) |
| `yaml` | YAML parse/stringify ([yaml](https://eemeli.org/yaml/)) |

```js
const ctx = Luker.getContext();
const safe = ctx.lib.DOMPurify.sanitize(userHtml);
const md = new ctx.lib.showdown.Converter().makeHtml(text);
```

## Secrets

For plugins that need to check or list connection-secret state (API keys, credentials). Read-only via the context surface — actual key values live behind the secrets backend.

### context.secrets.KEYS

```ts
context.secrets.KEYS: Record<string, string>
```

Catalog of well-known secret-slot identifiers (`OPENAI`, `CLAUDE`, `MISTRALAI`, …). Use as the key into `context.secrets.state`.

### context.secrets.state

```ts
context.secrets.state: Record<string, boolean>
```

Live boolean map indicating whether each secret slot is currently populated. Read-only snapshot — mutations are not persisted.

```js
const ctx = Luker.getContext();
if (!ctx.secrets.state[ctx.secrets.KEYS.OPENAI]) {
    toastr.warning('OpenAI API key not set.');
}
```

## Embedding Service

### context.embeddingService

```ts
context.embeddingService: {
    embed(items: string[], options?: object): Promise<number[][]>,
    // ...full EmbeddingService surface
}
```

Shared vector-embedding service used by the vectors / memory-graph subsystems. Routes through the configured embedding provider. Use when a plugin needs to embed text for similarity search but should not duplicate provider plumbing.

## Symbols & Constants

### context.symbols.ignore

```ts
context.symbols.ignore: typeof IGNORE_SYMBOL
```

Sentinel symbol used to signal "leave this value alone" in patch contexts where `null` and `undefined` have other meanings.

### context.constants.unset

```ts
context.constants.unset: typeof UNSET_VALUE
```

Sentinel value passed to `writeExtensionField` / `writeExtensionFieldBulk` to **delete** a key rather than setting it to `null`:

```js
await ctx.writeExtensionField(chid, 'my_field', ctx.constants.unset);  // deletes
await ctx.writeExtensionField(chid, 'my_field', null);                  // sets to null
```

### context.constants.promptRoles / promptTypes

```ts
context.constants.promptRoles: { SYSTEM, USER, ASSISTANT }
context.constants.promptTypes: { NONE, IN_PROMPT, IN_CHAT, BEFORE_PROMPT }
```

Numeric enums for `setExtensionPrompt` and related injection paths. `promptRoles` selects the message role of the injected prompt; `promptTypes` selects its insertion slot.

```js
const ctx = Luker.getContext();
ctx.setExtensionPrompt(
    'my-plugin-pre',
    'Pre-context note.',
    ctx.constants.promptTypes.BEFORE_PROMPT,
    0,
    false,
    ctx.constants.promptRoles.SYSTEM,
);
```

For `wiAnchor` / `wiPosition` see [World Info → Position Constants](/development/extension-api/world-info#position-constants).

### CONNECT_API_MAP

```ts
context.CONNECT_API_MAP: Record<string, ConnectApiEntry>
```

Read-only catalog of supported API source identifiers (e.g., `'openai'`, `'claude'`, `'novel'`) and their UI metadata. Useful when populating connection-related dropdowns.

### createModelIcon

```ts
context.createModelIcon(apiName: string, modelName?: string): string
```

Returns the inline-SVG markup for a provider's brand icon, sized for embedding alongside a model name in a dropdown or chip. Pass the API identifier (one of `CONNECT_API_MAP`'s keys); the optional `modelName` lets the helper pick a model-specific variant (e.g., Claude vs Claude reasoning).

### mainApi / maxContext / menuType

```ts
context.mainApi: 'openai' | 'kobold' | 'novel' | 'textgenerationwebui'
context.maxContext: number
context.menuType: 'characters' | 'character_edit' | 'create' | 'group_create' | 'group_edit' | ''
```

Live read-only views of the active main API, the configured max context size, and the currently open right-panel menu type.
