# CardApp

A CardApp is a small application that loads with a character card and places status panels, action buttons, mini-games and story choices in the chat interface. It belongs to the card: it loads when you switch to that character, unloads when you leave, and leaves other characters untouched.

## What you can build

- **Status panels** that show affinity, stamina, quest progress or inventory as the story changes.
- **Action buttons** named for the setting in place of the generic toolbar.
- **Mini-games** such as text-adventure choices, dice or card components.
- **Custom interfaces** that present information with the same layout, palette and voice as the world.

CardApp state is stored in the current chat, so it survives switching chats and reopening the character.

## How to build one

Use [CardApp Studio](/features/card-editor/studio): describe the result you want, and Studio generates the interface, writes it to the card, and shows a live preview. For a complete project from an empty card, see [Isekai Survival Log](/features/card-editor/walkthrough/isekai).

::: tip Development environment
Studio provides a code editor, live preview and AI assistance. For custom logic, the interfaces and conventions are in the [Card Developer Guide](/development/card-developers).
:::

## Related pages

## Lifecycle

1. **Mount** — When switching characters, the system extracts the app definition from the character card, mounts the app to the chat interface's UI container, and calls the app's `init(ctx)` function
2. **Run** — The app interacts with Luker through the `ctx` context object, responding to chat events and updating its own state
3. **Unmount** — When switching to another character or closing the chat, the system cleans up the app instance, automatically releasing all timers, event listeners, and dispose callbacks registered through `ctx`

## Use Cases

- **In-card interactive elements** — Status panels, mood indicators, custom buttons, etc.
- **Mini games** — Text-adventure choice interfaces, dice rollers, card-game components, etc.
- **State tracking** — Persist affection levels, quest progress, item inventories, etc. via chat variables (`ctx.getVariable` / `ctx.setVariable`); reach for chat state (`ctx.getChatState` / `ctx.updateChatState`) only for structured CardApp-owned namespaces that don't fit a flat variable.

## Related Pages

- [Character Card Editor Assistant](/features/card-editor/) — Entry point of CardApp Studio
- [CardApp Studio](/features/card-editor/studio) — Full environment for developing and debugging CardApps
- [Card Developer Guide](/development/card-developers) — Complete CardApp API reference and development docs
- [State System](/features/state-system) — Character state and chat state
