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
 "html": "string",
 "script": "string",
 "style": "string"
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
| `card_app.html` | string | Application HTML template |
| `card_app.script` | string | Application JavaScript code |
| `card_app.style` | string | Application CSS styles |

> [!NOTE]
> Bound presets and personas are stored in the character card's state file, not within `data.extensions`. This design avoids modifying the character card's own JSON data.

## Binding Presets and Personas

Luker supports binding recommended presets and user personas to character cards. When a user loads the card, they can apply the creator's recommended configuration with one click, ensuring the best roleplay experience.

Binding information is stored in the character card's state file:

- **Recommended Preset**: Specifies the preset best suited for this character (temperature, sampling parameters, etc.)
- **Recommended Persona**: Specifies the suggested user persona for interacting with this character

These bindings are configured through the "Bind Preset" panel in the [Character Card Editor Assistant](/features/card-editor).

## Configuring Orchestration Workflows

The [Orchestrator](/features/orchestrator) allows character card creators to define complex prompt orchestration workflows. With the orchestrator, you can:

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

CardApp is defined in the `data.extensions.card_app` field of the character card:

```json
{
 "data": {
 "extensions": {
 "card_app": {
 "enabled": true,
 "html": "<div id='fav-tracker'><span id='fav-value'>0</span></div>",
 "script": "export default function(ctx) { ... }",
 "style": "#fav-tracker { padding: 10px; }"
 }
 }
 }
}
```

### Entry Function

The CardApp `script` field should export a default function that receives a context object `ctx`:

```javascript
export default function (ctx) {
 const container = ctx.container;

 // Initialize: read persisted state
 async function init() {
 const state = ctx.getChatState('my_app');
 render(state);
 }

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

 init();
}
```

### Context API (ctx)

The CardApp context object provides the following APIs:

#### Messages & Generation

| API | Description |
|-----|-------------|
| `ctx.container` | The application's DOM container element |
| `ctx.charId` | Current character ID |
| `ctx.sendMessage(text, options?)` | Send a message |
| `ctx.stopGeneration()` | Stop current generation |
| `ctx.continueGeneration()` | Continue generation |

#### Data & State

| API | Description |
|-----|-------------|
| `ctx.getCharacterData()` | Get current character data (read-only) |
| `ctx.updateCharacterFields(fields)` | Update character fields and save. Supports name, description, personality, scenario, first_mes, mes_example, system_prompt, post_history_instructions, creator_notes, creator, character_version, tags (comma-separated string), talkativeness (number), depth_prompt fields |
| `ctx.getChatState(namespace)` | Read chat-bound persisted state |
| `ctx.setChatState(namespace, key, value)` | Set chat state |
| `ctx.getVariable(key)` | Get chat variable |
| `ctx.setVariable(key, value)` | Set chat variable |
| `ctx.getChatList()` | Get the chat list for the current character |

#### World Info Operations

| API | Description |
|-----|-------------|
| `ctx.getWorldBooks()` | Get world book names associated with the current character (character-bound + globally activated) |
| `ctx.getWorldBookEntries(bookName)` | Get all entries from a world book |
| `ctx.createWorldBookEntry(bookName, fields?)` | Create a world book entry, returns the new entry object (with uid) |
| `ctx.updateWorldBookEntry(bookName, uid, patch)` | Update a world book entry (shallow merge) |
| `ctx.deleteWorldBookEntry(bookName, uid)` | Delete a world book entry |

### Security Guidelines

When developing CardApp, follow these best practices:

- ✅ Operate DOM within `ctx.container`
- ✅ Read/write chat state through `ctx` API
- ✅ Send messages and control generation
- ❌ Avoid directly manipulating DOM outside the container
- ❌ Avoid making direct network requests
- ❌ Avoid directly accessing other extensions' data

### CardApp Studio

The [Character Card Editor Assistant](/features/card-editor) includes CardApp Studio, featuring a CodeMirror 6-based code editor with live preview and debugging support. It is recommended to use Studio for CardApp development rather than manually editing JSON.

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

- [Character Card Editor Assistant](/features/card-editor) — Card editing and CardApp Studio
- [Memory Graph](/features/memory-graph) — Long-term memory system
- [Orchestrator](/features/orchestrator) — Prompt orchestration workflows
- [CardApp](/features/cardapp) — Detailed CardApp documentation
- [Extension API Reference](/development/extension-api) — Detailed API documentation
