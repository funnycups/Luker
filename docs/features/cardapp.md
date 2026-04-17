# CardApp

CardApp is Luker's unique in-card application system. It allows character cards to define small applications (including HTML, JavaScript, and styles) within `data.extensions`, which are loaded and rendered in the chat interface, giving character cards interactive and dynamic capabilities.

The CardApp system consists of four modules: entry registration, application loader, renderer, and context API.

::: tip Developing CardApp
It is recommended to use the **CardApp Studio** in the [Character Card Editor](/features/card-editor) to develop and debug CardApps. The Studio provides a CodeMirror 6 code editor, live preview, and Markdown rendering — the best tool for creating CardApps.
:::

## Architecture

```
index.js (entry/registration)
  ├── loader.js   (load app definitions)
  ├── renderer.js (render/lifecycle)
  └── context.js  (restricted API context)
```

### Entry Module (index.js)

- Registers the extension API via `registerExtensionApi('card-app', api)` for other extensions to call
- Listens for character switch events to automatically trigger app loading and unloading
- Registers extension APIs (`isActive`, `reloadCardApp`) for other extensions to call

### Loader (loader.js)

- Extracts app definitions from the character card's `data.extensions` field
- Validates app format and security
- Parses the app's HTML content, scripts, styles, and metadata

### Renderer (renderer.js)

- Renders the app into a designated container in the chat interface
- Handles isolation between apps to prevent interference

### Context API (context.js)

The Context API is the core module of CardApp. CardApps interact with the host through the Context API provided by Luker. Developers are encouraged to follow the principle of least privilege, using only the official API rather than directly manipulating the DOM:

- **Read-only data access**: Apps can read character information, chat history, and other data, but should not directly modify core state
- **Limited interaction capabilities**: Provides controlled interaction interfaces, such as sending messages
- **Principle of least privilege**: It is recommended to access only the needed functionality through the official API, avoiding direct manipulation of the host DOM

## Lifecycle Management

CardApp follows a standard component lifecycle:

1. **Mount**: When switching characters, the loader extracts the app definition from the character card, and the renderer mounts the app to the UI container
2. **Update**: While the app is running, it can respond to chat events via the Context API and update its own state
3. **Unmount**: When switching to another character or closing the chat, the renderer cleans up the app instance and releases resources

## Use Cases

### In-Card Interactive Elements

Card authors can embed custom interactive UI within cards, such as character status panels, mood indicators, or custom buttons, making user-character interactions richer.

### Mini Games

Leveraging CardApp's HTML/JS capabilities, character cards can embed simple mini games, such as text adventure choice interfaces, dice rollers, or card game components.

### State Tracking

Through the `getChatState` / `setChatState` API, CardApp can persistently track state data related to the current chat, such as affection levels, quest progress, item inventories, etc. This data persists across sessions.


## Related Features

- [Character Card Editor](/features/card-editor) — Edit character card data, including CardApp definitions
- [Multi-Agent Orchestration](/features/orchestrator) — The Orchestrator also uses the extension API mechanism
