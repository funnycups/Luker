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

All event types are accessed via `context.eventTypes`. For the complete event list and callback parameters, see [Frontend Plugin Development](/development/frontend-plugin#event-system).
