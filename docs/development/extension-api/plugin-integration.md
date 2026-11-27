# Plugin Integration

APIs that connect plugins to Luker's pipelines and to each other: regex processing, search tools, the cross-plugin API registry, the event system, and the background activity guard.

## Regex Runtime API

Plugins register in-memory regex rules, run regex passes, and inspect or persist scoped regex scripts through `Luker.getContext().regex` without importing the regex extension's internal files. Runtime rules participate in every regex pass alongside user rules and are never written to the user's regex list.

### `context.regex` methods and enums

| Property | Kind | Description |
|----------|------|-------------|
| `applyRegex(rawString, placement, params?)` | Function | Runs all matching regex rules for the given placement and pass flags. |
| `runRegexScript(regexScript, rawString, options?)` | Function | Executes a single regex script object against `rawString`. |
| `placement` | Enum | Placement constants: `USER_INPUT`, `AI_OUTPUT`, `SLASH_COMMAND`, `WORLD_INFO`, `REASONING`. |
| `substituteFindRegex` | Enum | Macro substitution modes for `findRegex`: `NONE`, `RAW`, `ESCAPED`. |
| `SCRIPT_TYPES` | Enum | Persisted script scopes: `GLOBAL`, `PRESET`, `SCOPED`. |
| `registerRegexProvider(owner, provider, options?)` | Function | Registers a callback evaluated on each regex pass and returns `{ refresh, unregister }`. |
| `registerManagedRegexProvider(owner, options?)` | Function | Registers an engine-managed script set and returns `{ upsertScript, setScripts, removeScript, clearScripts, unregister }`. |
| `unregisterRegexProvider(owner)` | Function | Removes a registered runtime or managed regex provider by owner ID. |
| `getScripts(options?)` | Function | Lists active persisted and runtime regex scripts. |
| `getScriptsByType(scriptType, options?)` | Function | Lists persisted regex scripts in a single `SCRIPT_TYPES` scope without invoking runtime providers. |
| `saveScriptsByType(scripts, scriptType)` | Function | Persists an updated script array to the specified `SCRIPT_TYPES` scope. |
| `getPluginLanes(script)` | Function | Extracts normalized `'request'` and `'reply'` plugin lanes from a script record. |
| `omitLegacyPluginScope(script)` | Function | Returns a shallow copy with legacy `pluginOnly` fields stripped before saving. |
| `normalizePluginScriptRecord(script)` | Function | Normalizes a script record so `pluginLanes` is populated consistently. |

### registerRegexProvider

Use this when the rule set is derived from current state and recomputed on demand. The callback runs on every regex pass and always sees the current chat, character, and settings.

```js
const { regex } = Luker.getContext();

const registration = regex.registerRegexProvider('my-plugin', () => [
  {
    id: 'my-rule-1',
    scriptName: 'My Regex Rule',
    findRegex: '/foo/g',
    replaceString: 'bar',
    trimStrings: [],
    placement: [regex.placement.USER_INPUT, regex.placement.AI_OUTPUT],
  },
]);

// Recomputation is automatic. refresh() also reloads already rendered chats.
registration.refresh({ requestReload: true });

// Teardown
registration.unregister();
```

### registerManagedRegexProvider

Use this when the engine owns the script storage. The returned handle manages one script set per plugin.

```js
const { regex } = Luker.getContext();

const handle = regex.registerManagedRegexProvider('my-plugin', {
  reloadOnChange: true,
});

handle.upsertScript({
  id: 'my-rule-1',
  scriptName: 'My Regex Rule',
  findRegex: '/foo/g',
  replaceString: 'bar',
  trimStrings: [],
  placement: [regex.placement.USER_INPUT, regex.placement.AI_OUTPUT],
});
handle.setScripts([ /* full replacement */ ]);
handle.removeScript('my-rule-1');
handle.clearScripts();

// Teardown
handle.unregister();
```

### Script fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Managed entry only | Stable identifier. `registerManagedRegexProvider` keys its storage by this value. |
| `scriptName` | string | Yes | Display name shown in the regex editor's plugin section. |
| `findRegex` | string | Yes | Pattern in `/pattern/flags` form. |
| `replaceString` | string | Yes | Replacement text. `$1` and `$<name>` reference capture groups. |
| `trimStrings` | string[] | No | Strings removed from each captured group before substitution. Defaults to an empty list. |
| `placement` | number[] | No | Where the rule applies. `1` is user input, `2` is AI output. A rule needs at least one placement unless it uses only the plugin reply lane. |
| `pluginLanes` | string[] | No | Plugin application points. `request` covers text going into a plugin request and needs at least one `placement`; `reply` covers the assistant text a plugin request returns and ignores `placement`. |
| `disabled` | boolean | No | Skips the rule when true. |
| `markdownOnly` | boolean | No | Applies the rule to rendered chat text. |
| `promptOnly` | boolean | No | Applies the rule to outgoing prompts. |
| `runOnEdit` | boolean | No | Runs the rule when a message is edited. |
| `substituteRegex` | number | No | Macro substitution mode for `findRegex`. `0` disables substitution. |
| `minDepth` | number \| null | No | Applies the rule only when the message depth is at least this value. Depth 0 is the newest message. |
| `maxDepth` | number \| null | No | Applies the rule only when the message depth is at most this value. |

`placement` and `pluginLanes` select message targets. `markdownOnly` and `promptOnly` select ephemeral views. The two groups are independent: a rule can combine them, and each selected option adds only its own pass. Runtime scripts run after the persisted rules of every scope.

## Search Tools API

The search plugin publishes a cross-extension service via `context.registerExtensionApi('search-tools', ...)` and also exposes `Luker.searchTools` for function-calling tool metadata:

```js
const searchApi = Luker.getContext().getExtensionApi('search-tools');
if (searchApi) {
  const caps = searchApi.getActiveProviderCapabilities();
  const webResults = await searchApi.search({ query: 'character setting' });
  if (caps.supportsImageSearch) {
    const images = await searchApi.searchImages({ query: 'character reference sheet' });
  }
  const pageImages = await searchApi.extractPageImages({ url: 'https://example.com/wiki/Character' });
}

if (globalThis?.Luker?.searchTools) {
  const toolNames = Luker.searchTools.toolNames;
  const toolDefs = Luker.searchTools.getToolDefs();
  const isSearchTool = Luker.searchTools.isToolName('luker_web_image_search');
}
```

See [Search Tools](/features/search-tools) and [Image Generation API](/development/extension-api/image-generation) for full method signatures.

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

## Background Activity Guard

`context.activityGuard` (also published on `lukerContext.activityGuard`) provides a lease-based registry that unifies browser `beforeunload` warnings, mobile background keep-alive, and in-app chat-switch confirmation prompts. Register long-running extension tasks as activity leases instead of adding custom `beforeunload` listeners or manipulating keep-alive internals directly.

### `context.activityGuard`

```ts
interface ActivityLeaseOptions {
    source: string;                      // required non-empty identifier, e.g. 'my-plugin:sync'
    label?: string;                      // display label shown in chat-switch confirmation dialogs
    scope?: 'global' | 'chat';           // default: 'global'
    guardUnload?: boolean;               // default: true
    guardChatSwitch?: boolean;           // default: scope === 'chat'
    keepAlive?: boolean;                 // default: true
    ambient?: boolean;                   // default: false
    onCancel?: (() => void) | null;      // invoked only on confirmed in-app chat switch
}

interface ActivitySnapshot {
    readonly source: string;
    readonly label: string;
    readonly scope: 'global' | 'chat';
    readonly guardUnload: boolean;
    readonly guardChatSwitch: boolean;
    readonly keepAlive: boolean;
    readonly ambient: boolean;
    readonly startedAt: number;
}

context.activityGuard: {
    acquire(options: ActivityLeaseOptions): () => void;
    run<T>(options: ActivityLeaseOptions, fn: () => T | Promise<T>): Promise<T>;
    hasUnloadGuard(): boolean;
    hasChatSwitchGuard(): boolean;
    hasKeepAliveHold(options?: {
        excludeAmbient?: boolean;
        excludeSources?: Iterable<string>;
    }): boolean;
    list(): Array<Readonly<ActivitySnapshot>>;
    subscribe(listener: () => void): () => void;
}
```

### Lease options and methods

| Field / Method | Default / Return | Behavior |
|---|---|---|
| `source` | Required string | Non-empty trimmed identifier; throws `TypeError` if missing or blank. |
| `label` | `''` | Localized task description listed in the chat-switch confirmation dialog when `guardChatSwitch` is true and non-empty. |
| `scope` | `'global'` | `'chat'` for work tied to the active chat; `'global'` for workspace, file, or account-level tasks that survive chat switches. |
| `guardUnload` | `true` | Contributes to `hasUnloadGuard()` and triggers the browser `beforeunload` warning while active. |
| `guardChatSwitch` | `scope === 'chat'` | Contributes to `hasChatSwitchGuard()` and triggers the in-app chat-switch confirmation dialog when opening, creating, closing, branching, or deleting a chat. |
| `keepAlive` | `true` | Contributes to `hasKeepAliveHold()` to hold mobile background keep-alive while active. |
| `ambient` | `false` | Marks implicit request-level leases. `hasKeepAliveHold({ excludeAmbient: true })` skips ambient leases, and chat-switch dialogs suppress ambient labels whenever a non-ambient chat-switch lease is active. |
| `onCancel` | `null` | Called only when the user confirms an in-app chat switch — never on `beforeunload`. Abort controllers or cancel chat-bound work here. |
| `acquire(options)` | `() => void` | Registers a lease and returns an idempotent `release()` callback. |
| `run(options, fn)` | `Promise<T>` | Acquires a lease, awaits `fn()`, and guarantees release in `finally`. |
| `list()` | `Readonly<ActivitySnapshot>[]` | Returns shallow-frozen snapshots of active leases without internal tokens or `onCancel`. |
| `subscribe(listener)` | `() => void` | Fires `listener()` on every acquire or release and returns an idempotent `unsubscribe()` callback. |

```js
const ctx = Luker.getContext();
const controller = new AbortController();

const summary = await ctx.activityGuard.run({
    source: 'my-plugin:summarize',
    label: ctx.translate('Chat summary'),
    scope: 'chat',
    onCancel: () => controller.abort(),
}, async () => {
    return await ctx.generateTask({
        taskMessages: [{ role: 'user', content: 'Summarize the latest scene.' }],
        abortSignal: controller.signal,
    });
});
```

Core LLM request helpers (`generateTask`, `generateTaskStream`, `generateRaw`, `generateRawData`, `ChatCompletionService`, and `TextCompletionService`) acquire an ambient global lease automatically unless you pass `activity: false` or an override object. See [Generation → Background Activity Guard](/development/extension-api/generation#background-activity-guard).

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

Merges plugin-supplied translations into the loaded locale data. Call after the i18n system has booted (e.g., on `APP_READY`). When `localeId` is the primary locale, entries always overwrite; when it's a fallback locale, entries only fill missing keys. Merged entries are global: they replace the translation of the same key in the core UI and in every other plugin. To translate only your own plugin's text, use [`createScopedI18n`](#createscopedi18n).

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

### createScopedI18n

```ts
createScopedI18n(tables: Record<string, Record<string, string>>): {
    t(strings: TemplateStringsArray, ...values: unknown[]): string;
    translate(text: string, key?: string | null): string;
    format(template: string, ...values: unknown[]): string;
    has(key: string): boolean;
}
```

Creates a translator bound to your plugin's own translation tables. `tables` maps locale IDs such as `'zh-cn'` and `'zh-tw'` to key → translation objects. A lookup reads the plugin tables first, merged in the core locale order: entries of the fallback locale first, entries of the active locale replacing them. When the merged entry for the key is missing or empty, the lookup falls back to `translate`. An empty entry in the active-locale table also replaces the fallback-locale entry, so the lookup goes to `translate`, not to the plugin's fallback-locale translation. The tables never enter the global locale data, so the core UI and other plugins keep their own text. Prefer it over `addLocaleData` for new plugins.

- `t` — template tag with the same key format as `t`.
- `translate(text, key?)` — same signature as `translate`.
- `format(template, ...values)` — translates `template`, then fills `${0}`, `${1}`, … with `values`.
- `has(key)` — whether the plugin tables provide a non-empty translation for `key` in the active locale order.

The translator copies `tables` when it is created; later changes to those objects are ignored. Elements with a `data-i18n` attribute are translated by the core from the global locale data, so render plugin text with the translator instead.

```js
const ctx = Luker.getContext();
const i18n = ctx.createScopedI18n({
    'zh-cn': { 'My Plugin': '我的插件', 'Saved ${0} items': '已保存 ${0} 项' },
    'zh-tw': { 'My Plugin': '我的外掛', 'Saved ${0} items': '已儲存 ${0} 項' },
});

const title = i18n.translate('My Plugin');
const status = i18n.t`Saved ${count} items`;
const sameStatus = i18n.format('Saved ${0} items', count);
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
context.saveSettings(loopCounter?: number, options?: object): Promise<SettingsSaveOutcome>
```

Captures the current settings at invocation and serializes persistence attempts. Inspect the returned outcome before reporting success:

- `{ ok: true, status: 'saved', payload }` acknowledges that captured JSON payload. An unchanged payload needs no request only when a complete stored baseline is known. Initialization defaults and unsaved supplied settings are not storage acknowledgements. `directSave: true` always sends the full captured payload. The acknowledged snapshot is updated before `SETTINGS_UPDATED`, and the caller resolves after its listeners finish.
- `{ ok: false, status: 'failed', error }` reports capture, transport or HTTP failure. Other queued attempts still execute and have their own outcomes.
- `{ ok: false, status: 'deferred', reason }` schedules a debounced retry because settings are not ready or generation temporarily overrides response length. This does not acknowledge persistence. The retry captures the live state when it executes.

After a failed persistence attempt, the stored baseline and cached settings read are invalidated. Without a fresh complete server read, the next attempt sends a full replacement before acknowledging its payload, including when the desired settings equal the last acknowledged settings.

A server `world_deleted` ownership refusal means conditional world cleanup overtook an auxiliary-reference write. `world_deletion_unknown` means the overlapping deletion's transaction outcome is unconfirmed. Either refusal terminates the captured attempt without retrying a full payload, retains its valid acknowledged snapshot and cached read, and emits no save-success event. Earlier full reads lose permission to replace the live draft even though the stored settings remain unchanged. Reload the world-book list before retrying the reference change.

Queued calls retain their own captured payloads and options. A result does not acknowledge later edits or later queued attempts. Mutating a returned payload or exported settings does not change the stored baseline. Event listeners may await another save because event delivery does not hold the persistence lock. Ignoring the result remains safe for fire-and-forget callers. `saveSettingsDebounced` remains scheduling-only and provides no persistence acknowledgement.

A server settings read is not applied when persistence is pending at its start or completion, or settles during the read. The discarded `getSettings()` resolves to `undefined` without changing snapshot authority or live settings and without emitting `SETTINGS_LOADED`. Read again after pending saves settle to load a fresh source.

`SETTINGS_UPDATED` receives `{ cardPresetSave }`. The record captures the selected card, slot, runtime-cache entry and intended preset body when the save is invoked. Treat it as read-only. Ordinary saves synchronize that captured body through conditional queued changes. Preset-manager extension writes reserve their captured field operation and synchronize acknowledged non-extension changes in the same card write after their prerequisites succeed. They refresh only the captured runtime-cache entry after card acknowledgement. Changing selection or mutating the caller's options while a save is pending does not retarget synchronization. `cardPresetOwner` is reserved for the preset manager, not an extension opt-out from card synchronization.

Conditional changes compare captured old values and missing keys with the queued current source. Arrays are compared as complete values. Overlapping external changes refuse the card mutation, while disjoint changes remain intact. A nested extension write reserves only its requested path and also synchronizes unrelated acknowledged extension changes. A root extension replacement owns the extension root. Matching desired values are accepted as prior work only for acknowledged writes from the same captured ownership lineage. Lineage identities contain no preset bodies or historical payload chain.

`getPresetManager(...).writePresetExtensionField(...)` rejects when its captured global name, collection or source is replaced during persistence. The error can follow an acknowledged HTTP commit. Earlier settings or preset-file commits remain stored, but the stale operation does not publish an obsolete cache entry or continue to its card stage. Queued field edits compose only with acknowledged predecessors from that field-write queue.

Preset extension writes capture the settings JSON-wire representation for acknowledgement, card continuation and read-cache publication. Undefined object fields are omitted, sparse or undefined array entries become `null`, and non-finite numbers become `null`. Captured source ownership and unrelated fields remain part of the conditional write.

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
