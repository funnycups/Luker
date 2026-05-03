# Frontend Plugin Development

Luker's plugin system is built on SillyTavern's extension architecture with additional enhancements. This document is intended for developers who want to build third-party plugins for Luker, covering file structure, lifecycle, event system, UI integration, and debugging tips.

## Terminology

In Luker, "plugin" and "extension" refer to the same concept. Built-in extensions are located in the `public/scripts/extensions/` directory, while third-party plugins are installed to `public/scripts/extensions/third-party/`.

## Plugin File Structure

A standard Luker plugin contains the following files:

```
third-party/my-plugin/
├── manifest.json      # Plugin metadata (required)
├── index.js           # Entry script (required)
├── style.css          # Stylesheet (optional)
├── settings.html      # Settings panel HTML (optional)
└── assets/            # Static assets (optional)
```

### manifest.json

`manifest.json` is the plugin's metadata file that defines its basic information and loading behavior:

```json
{
  "display_name": "My Plugin",
  "loading_order": 100,
  "requires": [],
  "optional": [],
  "js": "index.js",
  "css": "style.css",
  "author": "Your Name",
  "version": "1.0.0",
  "homePage": "https://github.com/your-repo",
  "auto_update": true
}
```

| Field | Type | Description |
|-------|------|-------------|
| `display_name` | string | The name displayed in the UI |
| `loading_order` | number | Loading order; lower numbers load first |
| `requires` | string[] | List of required dependency extensions |
| `optional` | string[] | List of optional dependency extensions |
| `js` | string | Path to the entry JavaScript file |
| `css` | string | Path to the stylesheet |
| `author` | string | Author information |
| `version` | string | Version number |
| `homePage` | string | Project homepage URL |
| `auto_update` | boolean | Whether auto-update is supported |

### index.js

The entry script is the core file of a plugin. Luker uses ES Module dynamic imports to load plugins, so the entry file should use `import`/`export` syntax.

A minimal entry script structure:

```js
import { extension_settings, getContext } from '../../../extensions.js';
import { eventSource, event_types } from '../../../../script.js';

const EXTENSION_NAME = 'my-plugin';

// Default values for plugin settings
const defaultSettings = {
  enabled: true,
  someOption: 'default',
};

// Load settings
function loadSettings() {
  extension_settings[EXTENSION_NAME] = extension_settings[EXTENSION_NAME] || {};
  Object.assign(extension_settings[EXTENSION_NAME], {
    ...defaultSettings,
    ...extension_settings[EXTENSION_NAME],
  });
}

// Plugin entry point
jQuery(async () => {
  loadSettings();

  // Load settings panel HTML
  const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
  $('#extensions_settings').append(settingsHtml);

  // Bindievents
  eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
});
```

### style.css

The stylesheet is loaded automatically. It is recommended to use CSS class names prefixed with your plugin name to avoid conflicts with other plugins or Luker's core styles:

```css
.my-plugin-container {
  padding: 10px;
}

.my-plugin-container .status {
  color: var(--SmartThemeBodyColor);
}
```

### settings.html

An HTML fragment for the settings panel, which is injected into the extension settings area. Use the `data-extension-name` attribute to identify the owning plugin:

```html
<div class="my-plugin-settings" data-extension-name="my-plugin">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>My Plugin</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
    </div>
    <div class="inline-drawer-content">
      <label>
        <input type="checkbox" id="my_plugin_enabled" />
        Enable Plugin
      </label>
    </div>
  </div>
</div>
```

## Global Objects

### Luker.getContext()

`Luker.getContext()` is the primary interface for plugins to interact with Luker. It returns a context object with a rich set of APIs:

```js
const context = Luker.getContext();
```

> [!NOTE]
> `SillyTavern.getContext()` and `st.getContext()` are compatibility aliases. New plugins should use `Luker.getContext()`.

The context object includes APIs in the following major categories:

- **Chat Data** — `context.chat`, `context.characters`, `context.groups`, etc.
- **Messages** — `addMessages()`, `updateMessages()`, `deleteMessages()`, `getMessage()`, `getMessageCount()`
- **Chat Persistence** — `saveChatMetadata()`, etc. (low-level `appendChatMessages()`, `patchChatMessages()` are deprecated — use the Messages API)
- **Chat State** — `getChatState()`, `updateChatState()`, etc.
- **Presets** — `context.presets.list()`, `context.presets.resolve()`, etc.
- **Prompt / World Info Assembly** — `buildPresetAwarePromptMessages()`, `simulateWorldInfoActivation()`, etc.
- **Event System** — `context.eventSource`, `context.eventTypes`
- **Character State** — `getCharacterState()`, `setCharacterState()`
- **Inter-Extension Communication** — `registerExtensionApi()`

For the complete API list, see the [Extension API Reference](/development/extension-api/).

## Event System

Luker's event system is the core mechanism for plugin development. Plugins respond to user actions and system state changes by listening to events.

### Basic Usage

```js
const context = Luker.getContext();

// Listen to an event
context.eventSource.on(context.eventTypes.CHAT_CHANGED, (chatId) => {
  console.log('Chat changed:', chatId);
});

// Listen with priority
context.eventSource.on(context.eventTypes.MESSAGE_RECEIVED, handler, { priority: 10 });

// Ensure a handler runs first or last
context.eventSource.makeFirst(context.eventTypes.CHAT_CHANGED, handler);
context.eventSource.makeLast(context.eventTypes.CHAT_CHANGED, handler);
```

### Listener Execution Order

Luker's event listeners execute **serially** in the following priority order (each listener is `await`ed):

1. **Explicit plugin ordering** (`pluginOrder`) — configured via `eventSource.setOrderConfig()` or the built-in Hook Order extension
2. **Listener priority** (`priority`) — the third argument to `eventSource.on()`; higher numbers execute first
3. **Registration order** — listeners registered first execute first

### Chat Lifecycle Events

| Event | Trigger Timing | Callback Arguments |
|-------|----------------|--------------------|
| `CHAT_CHANGED` | Chat switch completed | `(chatId)` |
| `CHAT_CREATED` | New chat created | `(chatId)` |
| `GROUP_CHAT_CREATED` | Group chat created | `(chatId)` |
| `CHAT_BRANCH_CREATED` | Chat branch created | `(payload)` — see below |

### Message Events

| Event | Trigger Timing | Callback Arguments |
|-------|----------------|--------------------|
| `USER_MESSAGE_RENDERED` | User message rendering completed | `(messageId)` |
| `CHARACTER_MESSAGE_RENDERED` | Character message rendering completed | `(messageId)` |
| `MESSAGE_SENT` | User message sent | `(messageId)` |
| `MESSAGE_RECEIVED` | AI reply received | `(messageId, type?)` |
| `MESSAGE_EDITED` | Message edited | `(messageId, meta?)` |
| `MESSAGE_UPDATED` | Message block refreshed | `(messageId)` |
| `MESSAGE_DELETED` | Message deleted | `(chatLength, meta?)` |
| `MESSAGE_SWIPED` | Message swiped | `(messageId, meta?)` |
| `MESSAGE_SWIPE_DELETED` | Swipe option deleted | `({ messageId, swipeId, newSwipeId })` |

### System Events

| Event | Trigger Timing | Callback Arguments |
|-------|----------------|--------------------|
| `APP_READY` | Application initialization completed | `(void)` |
| `SETTINGS_UPDATED` | Settings saved | `(void)` |
| `CHARACTER_FIRST_MESSAGE_SELECTED` | First message selected | `(payload)` |
| `WORLDINFO_UPDATED` | World Info updated | `(payload)` |

### Event Payload Details

#### MESSAGE_DELETED meta

```ts
(
  chatLength: number,
  meta?: {
    kind: 'delete',
    deletedPlayableSeqFrom: number | null,
    deletedPlayableSeqTo: number | null,
    deletedAssistantSeqFrom: number | null,
    deletedAssistantSeqTo: number | null,
  },
)
```

#### MESSAGE_SWIPED meta

```ts
(
  messageId: number,
  meta?: {
    pendingGeneration: boolean,
    previousSwipeId: number | null,
    nextSwipeId: number | null,
  },
})
```

#### CHAT_BRANCH_CREATED payload

```ts
{
  mesId: number,                  // Message index at the branch point
  branchName: string,             // New branch chat ID / filename
  assistantMessageCount: number,  // Number of assistant messages in the branch
  sourceTarget: {
    is_group: boolean,
    id?: string,
    avatar_url?: string,
    file_name?: string,
  },
  targetTarget: {
    is_group: boolean,
    id?: string,
    avatar_url?: string,
    file_name?: string,
  },
}
```

`CHAT_BRANCH_CREATED` fires after the new branch chat file is saved but before the UI switches to the new branch. If your plugin stores state data bound to a chat, you should copy or truncate that state to the new branch in this event handler.

### Generation Hook Events

Generation hooks are the key mechanism for plugins to intervene in the AI generation pipeline. They fire in the following order:

```
GENERATION_STARTED
  ↓
GENERATION_CONTEXT_READY        ← Adjust coreChat and maxContext
  ↓
GENERATION_BEFORE_WORLD_INFO_SCAN  ← Influence World Info scanning
  ↓
GENERATION_AFTER_WORLD_INFO_SCAN   ← World Info scan completed
  ↓
GENERATION_WORLD_INFO_FINALIZED    ← World Info finalized
  ↓
GENERATION_BEFORE_API_REQUEST      ← Final request inspection
  ↓
(API request sent)
  ↓
GENERATION_ENDED / GENERATION_STOPPED
```

#### Hook Selection Guide

| Hook | Good For | Not Suitable For |
|------|----------|------------------|
| `GENERATION_CONTEXT_READY` | Trimming/replacing `coreChat`, adjusting context limits | Logic that depends on World Info output |
| `GENERATION_BEFORE_WORLD_INFO_SCAN` | Temporary modifications that influence World Info scanning | Final request body editing |
| `GENERATION_WORLD_INFO_FINALIZED` | Reading final World Info results, depth injection | Rebuilding pre-scan chat slice assumptions |
| `GENERATION_BEFORE_API_REQUEST` | Final request inspection, tool injection, provider-specific additions | Modifications that need to affect World Info activation |

#### GENERATION_CONTEXT_READY payload

```ts
{
  type: string,           // normal/continue/regenerate/swipe/...
  dryRun: boolean,
  isContinue: boolean,
  isImpersonate: boolean,
  coreChat: ChatMessage[],
  maxContext: number,
}
```

### APP_READY Event

`APP_READY` is a special event with an auto-trigger behavior. If a listener is registered after the application has already started, it will immediately receive the arguments from the last `APP_READY` emission. This ensures that lazily loaded plugins can still initialize correctly.

## Chat State

Luker provides a chat state mechanism that allows plugins to bind data to a specific chat, rather than stuffing it into `chat_metadata`.

### Basic Usage

```js
const context = Luker.getContext();
const NAMESPACE = 'my-plugin';

// Read state
const state = await context.getChatState(NAMESPACE);

// Update state (recommended approach)
await context.updateChatState(NAMESPACE, (current = {}) => ({
  ...current,
  lastUpdated: Date.now(),
  counter: (current.counter || 0) + 1,
}));

// Delete state
await context.deleteChatState(NAMESPACE);
```

### Best Practices

- Use `updateChatState()` for read-modify-write operations instead of manually chaining `getChatState()` + `patchChatState()`
- Keep namespace payloads as plain JSON-serializable objects
- For large plugin data, prefer chat state over `chat_metadata`
- Handle `ok: false` return values to keep your plugin UI resilient

### Handling State During Branching

```js
context.eventSource.on(context.eventTypes.CHAT_BRANCH_CREATED, async (payload) => {
  const sourceState = await context.getChatState(NAMESPACE, {
    target: payload.sourceTarget,
  });
  if (!sourceState) return;

  await context.updateChatState(NAMESPACE, () => ({
    ...sourceState,
    branch: {
      sourceMesId: payload.mesId,
      branchName: payload.branchName,
      copiedAt: Date.now(),
    },
  }), {
    target: payload.targetTarget,
  });
});
```

## UI Integration

### Settings Panel

A plugin's settings panel is injected into the extension settings area via an HTML fragment. Use the `inline-drawer` class to create a collapsible settings panel:

```js
jQuery(async () => {
  const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
  $('#extensions_settings').append(settingsHtml);

  // Bind settings control events
  $('#my_plugin_enabled').on('change', function () {
    extension_settings[EXTENSION_NAME].enabled = $(this).prop('checked');
    saveSettingsDebounced();
  });

  // Initialize control states
  $('#my_plugin_enabled').prop('checked', extension_settings[EXTENSION_NAME].enabled);
});
```

### Popup Dialogs

Luker provides popup APIs such as `callGenericPopup` for displaying custom dialogs:

```js
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';

const result = await callGenericPopup(
  '<div>Custom content</div>',
  POPUP_TYPE.CONFIRM,
  'Title',
);
```

### Slash Commands

Plugins can register custom slash commands:

```js
import { registerSlashCommand } from '../../../slash-commands.js';

registerSlashCommand(
  'myplugin',
  async (args, value) => {
    // Command logic
    return 'Command execution result';
  },
  [],
  'Execute My Plugin action',
);
```

## Inter-Plugin Communication

### registerExtensionApi

Plugins can register named APIs via `registerExtensionApi`, allowing other plugins to discover and call them:

```js
// Provider side
const context = Luker.getContext();
context.registerExtensionApi('my-plugin', {
  doSomething: () => { /* ... */ },
  getData: () => myData,
});

// Consumer side
const myPluginApi = context.getExtensionApi('my-plugin');
if (myPluginApi) {
  myPluginApi.doSomething();
}
```

## Debugging Tips

### Browser Developer Tools

- Use `Luker.getContext()` in the browser console to directly inspect the context object
- Use `context.eventSource.getListenersMeta(eventName)` to view all listener information for a given event
- Plugin identity is inferred from the extension path during ordering/debugging, including third-party extensions (`third-party/<name>`)

### Frontend Log Manager

Luker includes a built-in frontend log manager that intercepts `console` output and `fetch` requests. Use `getFrontendLogsSnapshot()` to obtain log snapshots, with support for filtering by time range and ID. See [Logging System](/features/logging) for details.

### Common Troubleshooting

| Issue | Troubleshooting Direction |
|-------|---------------------------|
| Plugin not loading | Check that `manifest.json` is properly formatted and the `js` path exists |
| Settings not saving | Ensure `saveSettingsDebounced()` is being called |
| Event not firing | Use `getListenersMeta()` to confirm the listener is registered |
| Style conflicts | Use CSS class names prefixed with your plugin name |
| State lost | Verify the correct namespace is used and check that the chat state was written successfully |

### Hot Reload

During development, you can trigger a reload by disabling/enabling the plugin through the extension management panel. After modifying `style.css`, a full page refresh is usually required.

## Related Pages

## See Also

- [Frontend Plugin Development](/development/frontend-plugin) — Frontend extension development guide
- [Server Plugin Development](/development/server-plugin) — Server-side plugin development guide (filesystem, API proxy, credential storage)
- [Extension API Reference](/development/extension-api/) — Complete API list with detailed parameter descriptions
- [Character Card Development](/development/card-developers) — Character Card extension fields and CardApp development
- [Contributing Guide](/development/contributing) — How to submit code to Luker
