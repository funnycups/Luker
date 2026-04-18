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

## Related Pages

- [Character Card Editor](/features/card-editor) — Use Studio to develop and debug CardApps
- [Card Developer Guide](/development/card-developers) — Complete CardApp API reference and development documentation
- [State System](/features/state-system) — Character state and chat state
