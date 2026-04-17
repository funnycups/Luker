# Other Improvements

Beyond the major architecture improvements introduced earlier, Luker has also made enhancements across connection management, network proxying, UI interactions, the extension system, performance optimization, and more.

## Connection Manager Improvements

Luker enhances SillyTavern's existing Connection Profiles feature to work with the [Preset Decoupling](/improvements/preset-decoupling) system. The improved connection manager completely separates connection configurations from chat completion presets — connection configurations only manage "where to connect" (API address, keys, proxy, etc.) and no longer contain generation parameters.

Automatic migration is performed on startup, cleaning up residual preset fields and regex fields from old configurations. New additions include plain-text Function Calling toggles and retry configuration, which can be set independently per connection profile. Quick profile switching is supported via the `/profile` slash command.

## Prompt Grouping

Luker adds prompt entry grouping capability to the PromptManager. Users can organize multiple prompt entries into named groups, displayed as collapsible groups in the UI. Groups support creation, renaming, and deletion; when a group is deleted, its members become ungrouped. Group information is saved and loaded with presets.

## Preset Grouping

The preset selector also supports grouping. Users can organize presets into named groups, displayed in the dropdown selector as a hierarchical structure with group headers and members. Group headers are rendered as non-selectable visual separator rows, implemented through a custom `select2-actionable-single.js` adapter.

## Preset World Info

Luker supports associating World Info (Lorebooks) with presets. When switching presets, the system automatically activates the corresponding World Info without manual switching. When undoing a preset switch, the global World Info activation state is also restored in sync.

## Undo Toast System

Luker adds undo Toast prompts for various destructive operations, allowing users to quickly recover from accidental actions:

- Chat deletion undo
- Character Card deletion undo
- Preset deletion undo
- World Info entry deletion undo
- Prompt deletion/switching undo
- Prompt manager order switching undo

## Dynamic Model Lists

Luker supports dynamically loading model lists for multiple APIs, replacing hardcoded static lists. Currently supported APIs for dynamic loading include OpenAI, Claude, Vertex AI, and others, also applicable to various OpenAI-compatible third-party services. Custom model lists per API source are also supported, making it convenient to configure available models when using third-party compatible APIs.

## Extension Hook Ordering

Luker introduces the Hook Order extension, allowing users to customize the execution order of extension hooks. When multiple extensions listen to the same event, execution order can be controlled through priority settings, supporting third-party extension IDs and message events.

## Character State API

Luker provides character-level persistent state storage capabilities for extensions:

- `getCharacterState(avatar, namespace)` — Get state data for a specified character under a specified namespace
- `setCharacterState(avatar, namespace, data)` — Set character state data
- `registerExtensionApi(name, api)` — Register a named API for other extensions to discover and call

These APIs are exposed through the global context object, supporting loosely-coupled communication between extensions. Presets also support state storage with lifecycle hooks.

## Startup Performance Optimization

Luker has made multiple performance optimizations to the startup process, including parallelized resource loading, preloading recent chat snapshots, lazy-loading chat indexes, and more.

See [Startup Performance Optimization](/improvements/performance) for details.

## Mobile Adaptation

Luker has made extensive adaptation fixes for mobile and Android WebView, covering virtual keyboards, IME input, touch events, small-screen layouts, and more.

See [Android App](/guide/android) for details.

## Frontend Log Manager

Luker introduces a frontend log manager for frontend debugging and troubleshooting:

- Intercepts six levels of `console.trace/debug/log/info/warn/error`, writing to an in-memory buffer (up to 3,000 entries)
- Intercepts `fetch` requests, recording API call request/response summaries (method, path, status, duration, etc.)
- Captures `window.error` and `unhandledrejection` global errors
- Performs intelligent summarization of request bodies, extracting key information rather than recording full content
- Safely handles headers, recording only non-sensitive fields

Log snapshots can be obtained via `getFrontendLogsSnapshot()`, with support for filtering by time range and ID.

> [!TIP]
> For detailed information about the backend logging system, see the logging system section on the [Auth & Quota](/improvements/auth-and-quota) page.
