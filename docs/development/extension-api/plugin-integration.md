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
