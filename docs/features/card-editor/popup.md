# Workbench Card Editing

Open **Workbench → AI iteration → Character card** (or click **Open Editor** under **Extensions → Character Editor Assistant**) to edit the active character card and its bound World Info books through natural-language conversation. Every edit the AI proposes is staged in the **Change list** for diff review before anything is written.

::: tip Cards with CardApp
To edit embedded CardApp UI code and state modules, open [CardApp Studio](/features/card-editor/studio) from **Extensions → Character Editor Assistant → &lt;/&gt; CardApp Studio**.
:::

## Workspace Layout

The left pane holds the session drawer, target switcher (**Character card** / **World book**), AI conversation, and composer; the right pane previews the active character card fields and bound World Info books.

![Character card AI iteration workspace](/images/card-editor-popup/cea-popup-overview.png)

## Supported Operations

The AI can perform the following operations via tool calls:

- **Modify character card fields** — Name, description, personality, scenario, first message, alternate greetings, example dialogue, system prompt, post-history instructions, creator's notes, and tags
- **Manage World Info entries** — Create, update, patch, or delete entries and book-level settings across any World Info book visible to the character, including primary, additional, chat, and global books
- **Query World Info** — List visible books, search entries by keyword or activation keys, and read entry contents
- **Inspect card-bound presets** — List the presets bound to the character card and read their contents
- **Simulate prompt** — Run a real generation with a test message as the next user turn under the current card, World Info, and preset without writing to the chat, and open a popup to review the output
- **Web search** — Search the web when [Search Tools](/features/search-tools) is enabled

## Diff Approval

After the AI stages edits, **Change list** groups the before/after diffs by field and world book entry:

![Pending diff cards in the AI reply](/images/card-editor-popup/cea-popup-diff-approval.png)

Expand any item to inspect the full line-by-line diff for longer text such as `description` or World Info `content`:

![Expanded line-by-line diff](/images/card-editor-popup/cea-popup-line-diff-zoom.png)

Tick individual items and click **Apply selected**, click **Discard everything**, or enable **Apply automatically** below the composer:

![Apply and discard controls](/images/card-editor-popup/cea-popup-diff-actions.png)

Applied edits are recorded in **Workbench → Change history** and can be undone individually.

## Session Management

The left session list stores conversations for the active character:

![Saved character-editing sessions](/images/card-editor-popup/cea-popup-sessions.png)

- Start a new conversation, switch between past conversations, or delete old ones; titles are generated from your request
- Closing and reopening Workbench preserves conversation history, tool traces, and pending diffs

## World Info Sync {#world-info-sync}

When you replace or update a character card whose embedded world book differs from the currently bound book, Luker prompts you to choose how to handle the world book:

![World Info sync popup](/images/card-editor-popup/cea-lorebook-sync.png)

- **Import new book** — Save the new card's embedded world book as a standalone file and bind it to this character.
- **Keep old book** — Keep the previously bound world book and ignore the new card's embedded book.
- **Merge in editor** — Open **Workbench → AI iteration → Character card** seeded with a structural diff between the previous and newly imported card and world book so the AI can carry your hand-curated entries forward into the new book.

![Merging card and world book changes in Workbench](/images/card-editor-popup/cea-replace-diff.png)

If you close or leave the merge session without applying any change, the pre-imported world book and character binding roll back automatically.

## Related Pages

- [Editor Assistant Overview](/features/card-editor/) — Shared capabilities and entry points
- [Workbench](/features/workbench) — Unified workspace, Q&A, and Change history
- [CardApp Studio](/features/card-editor/studio) — Full dev environment for cards with CardApp
- [Search Tools](/features/search-tools) — Web search inside Workbench AI iteration
- [State System](/features/state-system) — Character state and chat state
