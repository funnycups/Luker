# CardApp

CardApp is Luker's unique in-card application system. It allows character cards to define small applications (including HTML, JavaScript, and styles) within `data.extensions.card_app`, which are loaded and rendered in the chat interface, giving character cards interactive and dynamic capabilities.

::: tip Developing CardApp
It is recommended to use [CardApp Studio](/features/card-editor/studio) to develop and debug CardApps. The Studio provides a CodeMirror 6 code editor, live preview, and AI-assisted development. For the complete API reference and development guide, see the [Card Developer Guide](/development/card-developers).
:::

::: tip Want a complete walkthrough?
[Build a CardApp from scratch](/features/card-editor/walkthrough/) takes you through the full process — from an empty character card to a runnable CardApp — using a light-novel-style Western isekai survival card as the example, with a prompting cheatsheet and an advanced section on image generation.
:::

## Lifecycle

1. **Mount** — When switching characters, the system extracts the app definition from the character card, mounts the app to the chat interface's UI container, and calls the app's `init(ctx)` function
2. **Run** — The app interacts with Luker through the `ctx` context object, responding to chat events and updating its own state
3. **Unmount** — When switching to another character or closing the chat, the system cleans up the app instance, automatically releasing all timers, event listeners, and dispose callbacks registered through `ctx`

## Use Cases

- **In-card interactive elements** — Status panels, mood indicators, custom buttons, etc.
- **Mini games** — Text-adventure choice interfaces, dice rollers, card-game components, etc.
- **State tracking** — Persist affection levels, quest progress, item inventories, etc. via chat variables (`ctx.getVariable` / `ctx.setVariable`); reach for the chat-state sidecar (`ctx.getChatState` / `ctx.updateChatState`) only for structured CardApp-owned namespaces that don't fit a flat variable.

## Related Pages

- [Character Card Editor Assistant](/features/card-editor/) — Editing entry for cards with CardApp (auto-opens Studio)
- [CardApp Studio](/features/card-editor/studio) — Full environment for developing and debugging CardApps
- [Card Developer Guide](/development/card-developers) — Complete CardApp API reference and development docs
- [State System](/features/state-system) — Character state and chat state
