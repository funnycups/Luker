# Character Card Basics

Character cards are one of the most fundamental concepts in Luker. A character card defines everything about an AI character — from name and appearance to personality, speech patterns, and even the world they inhabit. Each time you chat with the AI, the information in the character card is sent to the AI model, guiding it to roleplay as that character.

## What is a Character Card

Think of a character card as a "character spec sheet." It tells the AI:

- Who to roleplay as
- What kind of person this character is
- What scenario the conversation takes place in
- How the conversation should begin

A character card can be very simple (just a name and a few lines of description) or very complex (with detailed world-building, multiple example dialogues, bound world info, etc.).

## V2 Format

Luker uses character cards that follow the **Character Card V2** specification, a widely adopted community standard. V2 character cards typically exist as `.png` files — the character's portrait image with JSON character data embedded inside. You can also use plain JSON files (`.json`) for import and export.

## Core Fields

### Name

The character's name. The AI will use this name to refer to itself during conversation, and it will be displayed in the chat interface.

### Description

A detailed description of the character, typically including appearance, backstory, identity, and other information. This is the most content-rich field in a character card — the AI uses it to understand who the character is.

### Personality

A summary of the character's personality traits. You can use keywords or short phrases to outline the character's personality, such as "gentle, introverted, loves reading."

### Scenario

The background setting for the conversation. Describes the relationship between the character and the user, and the current environment or situation. For example, "You are an adventurer who encounters this mysterious traveler in a tavern."

### First Message

The first message the character sends in a new chat. This message sets the opening atmosphere and scene. A well-crafted first message helps the AI quickly get into character.

Character cards can have multiple first messages (Alternate Greetings), providing different opening lines. When starting a new chat, users can swipe between these different greetings to choose their preferred starting scenario.

::: tip
The first message has a significant impact on conversation quality. It's not just an opening line — it also sets the benchmark for the AI's response style and length.
:::

### Example Dialogue

A set of example conversations demonstrating the character's speech style and behavior patterns. The typical format is:

```text
<START>
{{user}}: Hey, the weather is really nice today.
{{char}}: *glances up at the sky* Mm... it really is a good day to go out.
```

Example dialogues help the AI learn the character's tone, word choices, and behavioral traits. `<START>` is a conversation separator, and <code v-pre>{{user}}</code> and <code v-pre>{{char}}</code> are placeholders that get replaced with the user's and character's names during actual conversation.

## Import and Export

### Importing Character Cards

You can import character cards in the following ways:

- **From file**: Supports `.png` (images with embedded data) and `.json` formats
- **From URL**: Paste a direct download link to a character card

### Exporting Character Cards

When exporting, you can choose PNG or JSON format. PNG format embeds the character data into the portrait image, making it convenient to share.

::: info
Exported character cards include all core field data. If the character card has bound Luker extension data (such as bound presets, orchestration configs), that data is exported as well.
:::

## Luker's Character Card Extensions

Building on the standard V2 format, Luker adds several practical extensions to character cards. This extension data is stored in the `data.extensions.luker` field and doesn't affect compatibility with other tools.

### Card-Bound Presets and Personas

Character cards can bind dedicated **chat completion presets** and **user personas**. When you open a chat with this character, Luker automatically switches to the bound preset and persona; when you leave, it restores the previous settings.

This solves a common pain point: card creators no longer need to ask users to manually import specific presets, nor do they need to put user personas in world info. Bound presets and personas are independent — they won't pollute your global preset or persona lists.

See [Preset System](/basics/presets) and [Card-Bound Presets and Personas](/improvements/card-bound-presets) for details.

### Orchestration Config

Character cards can carry dedicated multi-agent orchestration configurations. The orchestrator runs multiple AI agents for plot analysis and planning before each response generation, producing orchestration guidance that's injected into the creative AI's context.

Card creators can design custom orchestration workflows for specific characters and export them along with the character card. Users can use these orchestration configs immediately after importing the card.

### Memory Graph Schema Override

If you use Luker's Memory Graph plugin, character cards can override the default Memory Graph schema (node types and structure definitions). This allows card creators to customize how memories are stored and recalled for specific characters.

## Next Steps

- Learn how [World Info](/basics/world-info) supplements character world-building
- Learn how the [Preset System](/basics/presets) controls AI response behavior
- Learn the basics of [Chat Management](/basics/chat-management)
