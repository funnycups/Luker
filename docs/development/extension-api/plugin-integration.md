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

### CONNECT_API_MAP

```ts
context.CONNECT_API_MAP: Record<string, ConnectApiEntry>
```

Read-only catalog of supported API source identifiers (e.g., `'openai'`, `'claude'`, `'novel'`) and their UI metadata. Useful when populating connection-related dropdowns.

### mainApi / maxContext / menuType

```ts
context.mainApi: 'openai' | 'kobold' | 'novel' | 'textgenerationwebui'
context.maxContext: number
context.menuType: 'characters' | 'character_edit' | 'create' | 'group_create' | 'group_edit' | ''
```

Live read-only views of the active main API, the configured max context size, and the currently open right-panel menu type.
