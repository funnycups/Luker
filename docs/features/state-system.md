# State System

Luker introduces a state system that allows character cards, chats, and presets to carry persistent state data. Extensions and CardApps can use this system to store and read custom data without modifying the character card or chat history itself.

## Character State

Each character can have independent state data, isolated by namespace. Different extensions or CardApps use their own namespaces without interfering with each other.

For example, a memory extension can store memory summaries for a character in the character state, while a CardApp can store game progress on the same character — both operate independently through different namespaces.

### How It Works

- **Read state**: Retrieve state data for a character under a specific namespace using the character identifier and namespace
- **Write state**: Save data to a specified namespace for a specified character
- **Auto-persistence**: State data is automatically saved to disk and survives server restarts

The lifecycle of character state is bound to the character itself — when a character is deleted, its associated state data is also cleaned up.

## Chat State

Luker stores chat state in namespace sidecar files next to each chat file, using the pattern `<chatFileBase>.luker-state.<namespace>.json`.

### State File Characteristics

- Stored as sidecar files in the same directory as the chat file (not a single global state file)
- One chat can have multiple state sidecars (one per namespace), created lazily on first write
- Lifecycle is bound to the chat file: when a chat is renamed, bound sidecars are renamed accordingly; when a chat is deleted, bound sidecars are deleted as well
- Supports incremental updates — no need to write the complete data every time

### Stored Content

Chat state files can store various auxiliary information related to the chat, such as:

- Confirmation status of generation tasks
- Custom data saved by extensions for that chat
- Other metadata not suitable for writing directly into chat history

::: tip
Chat state files are automatically managed by Luker — you typically don't need to edit them manually. If you're migrating data from SillyTavern, these files will be created automatically on first use.
:::

## Preset State

Luker also supports attaching state data to presets. Preset state allows extensions to store configuration or runtime information on specific presets. When users switch presets, the associated state data switches accordingly.

## Persistence and Lifecycle

The state system follows these principles:

| State Type | Storage Location | Lifecycle |
| --- | --- | --- |
| Character State | Sidecar files next to character cards (`<character>.state.<namespace>.json`) | Created on first namespace write; renamed/deleted with the character |
| Chat State | Sidecar files next to chat files (`<chat>.luker-state.<namespace>.json`) | Created on first namespace write; renamed/deleted with the chat |
| Preset State | Sidecar files next to preset files (`<preset>.luker-state.<namespace>.json`) | Created on first namespace write; renamed/deleted with the preset |

All state data is persisted to disk and will not be lost due to server restarts. State file cleanup is automatic — when the associated character, chat, or preset is deleted, the corresponding state file is automatically cleaned up.

## Use Cases

### CardApp State Tracking

CardApp is the most typical user of the state system. In-card applications can save game progress, user preferences, interaction history, and other data through the state system. For example, an RPG-type CardApp can save character level, equipment, quest progress, and other information in the character state.

See [CardApp](/features/cardapp) for details.

### Extension Data Storage

Third-party extensions can use the state system to store custom data for each character or chat without managing file I/O themselves. This simplifies extension development and ensures correct lifecycle management of data.

See [Extension API](/development/extension-api) for details.

### Memory System

[Memory Graph](/features/memory-graph) and other memory-type extensions can use character state to store memory summaries and index data, enabling per-character isolated memory management.

## Related Pages

- [CardApp](/features/cardapp) — In-card application system
- [Extension API](/development/extension-api) — Extension development interface
