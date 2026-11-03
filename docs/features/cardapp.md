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

- [Card Editor Assistant](/features/card-editor/) — the editor entry point for cards with a CardApp
- [CardApp Studio](/features/card-editor/studio) — the workbench for building and debugging a CardApp
- [State System](/features/state-system) — how CardApp data is saved with the chat
