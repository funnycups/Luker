# Character Card Developer Guide

This guide is for character card creators, covering how to leverage Luker's extension capabilities to create richer, smarter character cards. Luker provides several enhancements while maintaining full compatibility with the SillyTavern character card format.

## Character Card Extension Fields

Luker uses multiple namespaces within `data.extensions` to store extension data. These fields do not affect the card's normal usage in SillyTavern — unrecognized fields are simply ignored.

### data.extensions Structure

```json
{
 "data": {
 "extensions": {
 "luker": {
 "memoryGraphSchema": {
 "nodeTypes": [
 { "name": "string", "label": "string", "color": "#hex" }
 ]
 }
 },
 "card_app": {
 "enabled": true,
 "entry": "index.js"
 }
 }
 }
}
```

| Field Path | Type | Description |
|-----------|------|-------------|
| `luker.memoryGraphSchema` | object | Custom node type schema for Memory Graph |
| `luker.memoryGraphSchema.nodeTypes` | array | List of node type definitions |
| `luker.memoryGraphSchema.nodeTypes[].name` | string | Node type identifier (English, used for internal reference) |
| `luker.memoryGraphSchema.nodeTypes[].label` | string | Node type display name |
| `luker.memoryGraphSchema.nodeTypes[].color` | string | Node color (hex color value) |
| `card_app.enabled` | boolean | Whether CardApp is enabled |
| `card_app.entry` | string | Entry module filename relative to the CardApp folder. Defaults to `index.js`. The entry must export an `init(ctx)` function. CSS is auto-loaded by convention from `style.css` in the same folder. |

> [!NOTE]
> Bound presets and personas are stored in the character card's state file, not within `data.extensions`. This design avoids modifying the character card's own JSON data.

## Binding Presets and Personas

Luker supports binding recommended presets and user personas to character cards. When a user loads the card, they can apply the creator's recommended configuration with one click, ensuring the best roleplay experience.

Binding information is stored in the character card's state file:

- **Recommended Preset**: Specifies the preset best suited for this character (temperature, sampling parameters, etc.)
- **Recommended Persona**: Specifies the suggested user persona for interacting with this character

These bindings are configured through the "Bind Preset" panel in the [Character Card Editor Assistant](/features/card-editor/).

## Configuring Orchestration Workflows

The [Orchestrator](/features/orchestrator/) allows character card creators to define complex prompt orchestration workflows. With the orchestrator, you can:

- Define multi-step prompt processing pipelines
- Insert custom logic before and after generation
- Dynamically adjust prompt structure based on conversation state

Orchestration workflows can be bound to character cards and automatically activated when users load the card.

## Custom Memory Graph Schema

The [Memory Graph](/features/memory-graph) supports character card-level node type schema customization. By defining `luker.memoryGraphSchema` in the card's extension data, you can create a memory structure tailored to your character.

For example, a fantasy world character card might define the following schema:

```json
{
 "data": {
 "extensions": {
 "luker": {
 "memoryGraphSchema": {
 "nodeTypes": [
 { "name": "character", "label": "Character", "color": "#4A90D9" },
 { "name": "location", "label": "Location", "color": "#7ED321" },
 { "name": "quest", "label": "Quest", "color": "#F5A623" },
 { "name": "magic", "label": "Magic", "color": "#BD10E0" },
 { "name": "faction", "label": "Faction", "color": "#D0021B" }
 ]
 }
 }
 }
 }
}
```

Custom schemas override the default node type set, making Memory Graph extraction and organization better aligned with the character's world.

## CardApp Development

[CardApp](/features/cardapp) is Luker's character card embedded application system, allowing you to embed interactive JavaScript applications within character cards.

### Use Cases

- **State Tracking**: Favorability, stamina, inventory, and other gamification elements
- **Interactive Elements**: Dice, cards, mini-games
- **Visualization**: Relationship graphs, timelines, maps
- **Custom UI**: Character-specific interface components

### Application Definition Structure

CardApp is defined in the `data.extensions.card_app` field of the character card. The card stores only the toggle and the entry filename — the actual code lives in files under the CardApp's per-character folder on disk (managed by Studio):

```json
{
 "data": {
 "extensions": {
 "card_app": {
 "enabled": true,
 "entry": "index.js"
 }
 }
 }
}
```

The runtime loads `index.js` (or whatever `entry` names) as an ES module via `/api/card-app/<charId>/<entry>`, and auto-loads `style.css` from the same folder if it exists. Studio is the recommended way to author / save / version these files.

### Entry Function

The CardApp entry module must export an `init(ctx)` function that receives the context object:

```javascript
export async function init(ctx) {
 const container = ctx.container;

 // Read persisted state — getChatState is async (server-backed sidecar)
 const state = await ctx.getChatState('my_app');
 render(state);

 // Render UI
 function render(state) {
 const fav = state?.favorability ?? 0;
 container.innerHTML = `
 <div class="fav-panel">
 <h3>Favorability</h3>
 <div class="fav-bar">
 <div class="fav-fill" style="width: ${Math.min(fav, 100)}%"></div>
 </div>
 <span>${fav} / 100</span>
 </div>
 `;
 }
}
```

### Context API (ctx)

The CardApp context object provides the following APIs:

#### Messages & Generation

| API | Description |
|-----|-------------|
| `ctx.container` | The application's DOM container element |
| `ctx.charId` | Current character ID |
| `ctx.sendMessage(text, options?)` | Send a message (internally calls `sendTextareaMessage`) |
| `ctx.stopGeneration()` | Stop current generation |
| `ctx.continueGeneration()` | Continue generation |
| `ctx.getHistory(limit?, offset?)` | Get chat message history; supports limit and offset |
| `ctx.editMessage(messageId, newText)` | Edit a specific message |
| `ctx.deleteMessage(messageId)` | Delete a specific message |
| `ctx.deleteLastMessage()` | Delete the last message |
| `ctx.swipe()` | Switch to the next response variant |
| `ctx.regenerate()` | Regenerate the last AI message (calls `Generate('regenerate')`) |

#### Data & State

| API | Description |
|-----|-------------|
| `ctx.getCharacterData()` | Get current character data (read-only) |
| `ctx.updateCharacterFields(fields)` | Update character fields and save. Supports name, description, personality, scenario, first_mes, mes_example, system_prompt, post_history_instructions, creator_notes, creator, character_version, tags (comma-separated string), talkativeness (number), depth_prompt-related fields |
| `ctx.getChatState(namespace, options?)` | **async** Read chat-bound sidecar state (server-backed via `/api/chats/state/`). For HP / gold / affinity / inventory / quest flags use chat variables instead. |
| `ctx.updateChatState(namespace, updater, options?)` | **async** Reducer-style write of chat-bound sidecar. Returns `{ ok, state, updated }`. |
| `ctx.patchChatState(namespace, operations, options?)` | **async** Apply JSON-patch operations to chat-bound sidecar. |
| `ctx.deleteChatState(namespace, options?)` | **async** Drop a chat-bound sidecar namespace. |
| `ctx.getCharacterState(namespace)` | **async** Read character-bound sidecar (avatar auto-resolved). Survives across every chat with this character. |
| `ctx.setCharacterState(namespace, data)` | **async** Write character-bound sidecar (avatar auto-resolved). Pass `null` to delete. |
| `ctx.getVariable(key)` | Get a chat variable |
| `ctx.setVariable(key, value)` | Set a chat variable and persist it |

#### Chat Management

| API | Description |
|-----|-------------|
| `ctx.getChatList()` | Get the chat list for the current character |
| `ctx.switchChat(chatName)` | Switch to the specified chat |
| `ctx.newChat()` | Create a new chat |
| `ctx.closeChat()` | Close the current chat |

#### World Info Operations

| API | Description |
|-----|-------------|
| `ctx.getWorldBooks()` | Get the list of world book names associated with the current character (character-bound + globally activated) |
| `ctx.getWorldBookEntries(bookName)` | Get all entries from the specified world book |
| `ctx.createWorldBookEntry(bookName, fields?)` | Create a world book entry, returns the new entry object (with uid) |
| `ctx.updateWorldBookEntry(bookName, uid, patch)` | Update a world book entry (shallow merge) |
| `ctx.deleteWorldBookEntry(bookName, uid)` | Delete a world book entry |

#### Events & Lifecycle

| API | Description |
|-----|-------------|
| `ctx.eventSource` | Luker's internal event bus. Subscribe with `ctx.eventSource.on(eventName, handler)` and unsubscribe with `ctx.eventSource.off(eventName, handler)`. Event names live on `ctx.lukerContext.eventTypes` (`CHAT_CHANGED`, `MESSAGE_DELETED`, `MESSAGE_SWIPED`, etc.). Pair every `.on()` with `ctx.onDispose(() => ctx.eventSource.off(eventName, handler))` so listeners are removed when the CardApp unmounts. |
| `ctx.addEventListener(target, event, handler, options?)` | Subscribe to a DOM event on a DOM element. `target` is typically `ctx.container` or a `querySelector` result; use this for in-container UI events like click, keydown, scroll. The listener is removed automatically when the CardApp disposes. |
| `ctx.setInterval(fn, ms)` | `setInterval` whose handle is cleared automatically on dispose. |
| `ctx.setTimeout(fn, ms)` | `setTimeout` whose handle is cleared automatically on dispose. |
| `ctx.onDispose(fn)` | Register a cleanup callback that runs when the CardApp unmounts (chat switch, hot reload, character switch). |

Example — refresh a panel when the chat or active swipe changes:

```javascript
export async function init(ctx) {
    const { eventTypes } = ctx.lukerContext;
    const refresh = () => render(ctx);

    ctx.eventSource.on(eventTypes.CHAT_CHANGED, refresh);
    ctx.eventSource.on(eventTypes.MESSAGE_SWIPED, refresh);
    ctx.onDispose(() => {
        ctx.eventSource.off(eventTypes.CHAT_CHANGED, refresh);
        ctx.eventSource.off(eventTypes.MESSAGE_SWIPED, refresh);
    });

    refresh();
}
```

### Security Guidelines

When developing CardApp, follow these best practices:

- ✅ Operate DOM within `ctx.container`
- ✅ Read/write chat state through `ctx` API
- ✅ Send messages and control generation
- ❌ Avoid directly manipulating DOM outside the container
- ❌ Avoid making direct network requests
- ❌ Avoid directly accessing other extensions' data

### CardApp Studio

[CardApp Studio](/features/card-editor/studio) is the full environment for developing CardApps, featuring a CodeMirror 6-based code editor, live preview, AI assistance, and Git version history. It is recommended to use Studio for CardApp development rather than manually editing JSON.

## World Info Best Practices

World Info (Lorebook) is an important component of character cards. Here are best practices for using World Info in Luker:

### 1. Organize Entries Properly

- Group by topic: character background, world settings, important events, etc.
- Use clear keyword trigger conditions
- Avoid content overlap between entries

### 2. Bind World Info to Presets

Luker supports binding World Info to presets. When users switch presets, the associated World Info is automatically activated. This is useful for scenarios requiring different world settings.

### 3. Search Tools and World Info Integration

The [Search Tools](/features/search-tools) search agent can automatically write search results into World Info entries, enabling real-time information injection. Creators can leverage this mechanism to provide characters with real-time knowledge updates.

### 4. Control Injection Depth and Order

Set appropriate injection depth and order for World Info entries to ensure critical settings are properly positioned in the prompt. Luker's search tools provide `lorebookDepth`, `lorebookRole`, and `lorebookEntryOrder` configuration options for fine-grained control.

### 5. Complement with Memory Graph

World Info provides static world settings, while Memory Graph provides dynamic conversation memory. They complement each other:

- World Info: Unchanging background settings, character relationships, world rules
- Memory Graph: Events, emotional changes, and discoveries from conversations

## Distribution Considerations

### Compatibility

- Fields in `data.extensions.luker` and `data.extensions.card_app` are ignored by SillyTavern and do not affect normal card usage
- Bound presets and personas are stored in state files, not included in the card file itself, and are not carried during distribution
- Orchestration workflows need to be manually imported or distributed through other means

### Recommendations

- Note in the card description that Luker is recommended for the full experience
- If the card depends on CardApp, specify the required Luker version
- Provide a baseline experience that doesn't depend on Luker extensions, with Luker features as enhancements

## Related Pages

- [CardApp Studio](/features/card-editor/studio) — Full environment for CardApp development
- [Character Card Editor Assistant](/features/card-editor/) — Editor assistant overview (popup / Studio modes)
- [Memory Graph](/features/memory-graph) — Long-term memory system
- [Orchestrator](/features/orchestrator/) — Prompt orchestration workflows
- [CardApp](/features/cardapp) — Detailed CardApp documentation
- [Extension API Reference](/development/extension-api/) — Detailed API documentation
