# CardApp

CardApp is Luker's unique in-card application system. It allows character cards to define small applications (including HTML, JavaScript, and styles) within `data.extensions.card_app`, which are loaded and rendered in the chat interface, giving character cards interactive and dynamic capabilities.

::: tip Developing CardApp
It is recommended to use the **CardApp Studio** in the [Character Card Editor](/features/card-editor) to develop and debug CardApps. The Studio provides a CodeMirror 6 code editor, live preview, and AI-assisted development. For the complete API reference and development guide, see the [Card Developer Guide](/development/card-developers).
:::

## Lifecycle

1. **Mount** — When switching characters, the system extracts the app definition from the character card, mounts the app to the chat interface's UI container, and calls the app's `init(ctx)` function
2. **Run** — The app interacts with Luker through the `ctx` context object, responding to chat events and updating its own state
3. **Unmount** — When switching to another character or closing the chat, the system cleans up the app instance, automatically releasing all timers, event listeners, and dispose callbacks registered through `ctx`

## Use Cases

- **In-Card Interactive Elements** — Status panels, mood indicators, custom buttons, etc.
- **Mini Games** — Text adventure choice interfaces, dice rollers, card game components, etc.
- **State Tracking** — Persistently track affection levels, quest progress, item inventories, etc. via `getChatState` / `setChatState`

## Context API

The `ctx` object passed to the CardApp's `init(ctx)` function provides the following APIs:

### Messages & Generation

| API | Description |
|-----|-------------|
| `ctx.sendMessage(text, options?)` | Send a message. Internally uses `sendTextareaMessage` (writes to the send textarea and triggers the send flow), not `Generate` |
| `ctx.stopGeneration()` | Stop current generation |
| `ctx.continueGeneration()` | Continue generation |
| `ctx.getHistory(limit?, offset?)` | Get chat message history. With `limit`, returns the most recent `limit` messages (offset from the end) |
| `ctx.editMessage(messageId, newText)` | Edit a message by index and save |
| `ctx.deleteMessage(messageId)` | Delete a message by index |
| `ctx.deleteLastMessage()` | Delete the last message in the chat |
| `ctx.swipe()` | Swipe to the next response variant |
| `ctx.regenerate()` | Regenerate the last AI message. Internally uses `Generate('regenerate')` |

### Chat Management

| API | Description |
|-----|-------------|
| `ctx.getChatList()` | Get all chats for the current character |
| `ctx.switchChat(chatName)` | Switch to a different chat |
| `ctx.newChat()` | Create a new chat |
| `ctx.closeChat()` | Close the current chat |

### Data & State

| API | Description |
|-----|-------------|
| `ctx.container` | The application's DOM container element |
| `ctx.charId` | Current character ID |
| `ctx.getCharacterData()` | Get current character data (read-only) |
| `ctx.updateCharacterFields(fields)` | Update character fields and save. Supports name, description, personality, scenario, first_mes, mes_example, system_prompt, post_history_instructions, creator_notes, creator, character_version, tags, talkativeness, depth_prompt |
| `ctx.getChatState(namespace)` | Read chat-bound persisted state |
| `ctx.setChatState(namespace, key, value)` | Set chat state |
| `ctx.getVariable(key)` | Get chat variable |
| `ctx.setVariable(key, value)` | Set chat variable |

### World Info Operations

| API | Description |
|-----|-------------|
| `ctx.getWorldBooks()` | Get world book names associated with the current character (character-bound + globally activated) |
| `ctx.getWorldBookEntries(bookName)` | Get all entries from a world book |
| `ctx.createWorldBookEntry(bookName, fields?)` | Create a world book entry, returns the new entry object (with uid) |
| `ctx.updateWorldBookEntry(bookName, uid, patch)` | Update a world book entry (shallow merge) |
| `ctx.deleteWorldBookEntry(bookName, uid)` | Delete a world book entry |

### Rendering & Events

| API | Description |
|-----|-------------|
| `ctx.renderText(rawText, messageId?)` | Render raw text through Luker's message formatting pipeline, returns `{ html }` |
| `ctx.registerRenderer(rendererObj)` | Register a custom renderer with `renderMessage` and `removeMessage` methods |
| `ctx.getRenderer()` | Get the currently registered renderer |
| `ctx.eventSource` | Direct reference to Luker's event bus for subscribing to chat and generation events |
| `ctx.on(event, handler, options?)` | Subscribe to an event (auto-cleaned on unmount) |
| `ctx.off(event, handler)` | Unsubscribe from an event |
| `ctx.setInterval(fn, ms)` | Set an interval (auto-cleaned on unmount) |
| `ctx.setTimeout(fn, ms)` | Set a timeout (auto-cleaned on unmount) |
| `ctx.onDispose(callback)` | Register a cleanup callback (auto-called on unmount) |
| `ctx.executeSlashCommand(command, args?)` | Execute a slash command |

### Automatic Cleanup

All resources registered through `ctx` (timers, event listeners, dispose callbacks) are automatically released when the CardApp is unmounted. There is no need to manually clean up — just use the `ctx` wrappers instead of `window.setInterval`, `addEventListener`, etc.

## Related Pages

- [Character Card Editor](/features/card-editor) — Use Studio to develop and debug CardApps
- [Card Developer Guide](/development/card-developers) — Complete CardApp API reference and development documentation
- [State System](/features/state-system) — Character state and chat state
