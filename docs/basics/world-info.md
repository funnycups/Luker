# World Info Basics

World Info (also known as Lorebook) is a dynamic knowledge base system. It lets you organize large amounts of world-building, character backgrounds, item descriptions, and other lore into individual entries that are only injected into the AI's context when relevant content is mentioned in conversation. This way, the AI has access to rich lore without wasting precious context window space.

## What is World Info

Imagine you're creating a roleplay story set in a fantasy world. This world has dozens of characters, multiple locations, and a complex magic system. If you put all this information in the character card's description, it would consume a huge number of tokens, and most of it probably wouldn't be relevant to the current conversation.

World Info solves this by splitting the information into individual **entries**, each with trigger **keywords**. An entry is only activated and injected into the AI's context when its keywords appear in the conversation.

For example, if you have an entry about "Elves," its content will only be visible to the AI when the conversation mentions "elf," "elves," "Elf," or similar keywords.

## Entry Structure

Each World Info entry contains the following core components:

### Keywords

A list of words that trigger entry activation. When any keyword appears in the conversation, the entry is activated. Keywords are case-insensitive.

You can also set **Secondary Keywords**. When enabled, the entry requires both a primary keyword and a secondary keyword to match before activation, enabling more precise trigger control.

### Content

The text injected into the AI's context when the entry is activated. This can be character descriptions, location introductions, rule explanations, or any other information.

### Activation Conditions

Beyond keyword matching, each entry has several activation control options:

- **Enable/Disable**: Manually control whether the entry participates in matching
- **Injection Position**: Control where in the context the content is injected (e.g., after character description, before author's note, etc.)
- **Injection Depth**: Control the insertion depth within the chat history
- **Token Budget**: Limit the maximum tokens a single entry can consume

## Scan Depth

Scan Depth determines how many recent chat messages the World Info engine checks for keyword matches.

- Scan depth of 2: Only checks the 2 most recent messages for keywords
- Scan depth of 10: Checks the 10 most recent messages

A larger scan depth captures more keywords from the context but also activates more entries and consumes more tokens. You'll need to find the right balance for your use case.

::: tip
For important core lore, consider using Constant mode instead of relying on scan depth to ensure they're always visible.
:::

## Activation Strategies

### Keyword Matching

The most basic activation method. When message text within the scan range contains an entry's keyword, the entry is activated. Supports both exact matching and regex matching.

### Constant

Entries set to Constant are **always** injected into the AI's context, regardless of keyword triggers. Ideal for core world rules, important character relationships, and other information the AI must always be aware of.

### Probability Activation

You can set an activation probability (0–100%) for an entry. Even if a keyword matches, the entry will only activate if the probability check passes. This can be used to simulate random events or uncertain information.

### Recursive Scanning

When an entry is activated, its content is also included in the keyword scan range. This means if Entry A's content contains Entry B's keywords, Entry B will also be activated. This chain activation can build complex knowledge association networks.

## World Info Binding

World Info can be associated with characters and chats in several ways:

- **Character-bound World Info**: Bound directly to a character card, only active when chatting with that character
- **Global World Info**: Active for all characters, suitable for universal world-building
- **Chat Lorebook**: Bound to a specific chat session. A single chat can have multiple chat lorebooks bound simultaneously — they all take effect, and entries from each participate in matching

A character can use character-bound, global, and chat world info simultaneously; entries from all of them participate in matching together.

## Luker's World Info Improvements

### Activation Chain Tracing

When debugging complex world info setups, you might wonder "why was this entry activated?" Luker provides **activation chain tracing**, letting you clearly see which keyword triggered each entry and in which message.

If recursive scanning is used, you can also see the complete activation chain — for example, "keyword A in the message activated Entry 1, and keyword B in Entry 1's content then activated Entry 2."

### Search Plugin Auto-Created Entries

Luker's search plugin can automatically search the web during the pre-request phase and organize search results into World Info entries written to a dedicated shared lorebook (`__SEARCH_TOOLS__`). These entries are automatically assigned appropriate keywords and activation methods based on the nature of the information, serving as reference material injected into context during subsequent conversations.

### Memory Graph Auto-Created Entries

Luker's [Memory Graph](/features/memory-graph) plugin uses [World Info Projection](/features/memory-graph#world-info-projection) to automatically project Memory Graph nodes as World Info entries. These entries are automatically created and managed by the Memory Graph — no manual maintenance required — allowing long-term memories to participate in prompt construction through the World Info activation mechanism.

### Preset-Associated World Info

Luker supports associating World Info with presets. When switching presets, the associated World Info is automatically activated. This is very convenient when different usage scenarios require different World Info configurations.

### Undo Support

In Luker, deleting a World Info entry triggers an Undo Toast, allowing you to undo accidental deletions within a short time window.

## Next Steps

- Learn how [Character Cards](/basics/character-cards) bind World Info
- Learn how the [Preset System](/basics/presets) prompt manager works with World Info
- Learn how to configure [API Connections](/basics/connections)
