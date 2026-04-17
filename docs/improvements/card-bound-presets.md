# Card-Bound Presets & Personas

The card-bound feature allows Character Card authors to specify recommended Chat Completion presets and default Personas for their characters, ensuring characters run under optimal conditions. This feature depends on [Preset Decoupling](/improvements/preset-decoupling) to guarantee that loading presets won't break the user's API connection configuration.

## Character Cards Carrying Recommended Presets

Character Cards can embed a complete Chat Completion preset. When a user opens the Character Card, Luker will:

1. Extract the preset content from the Character Card data
2. **Automatically strip connection fields** — Automatically filter out all connection-related fields (such as API address, keys, model name, etc.), ensuring the user's connection configuration is not affected
3. Inject a runtime option marked as "Card-Bound Preset" in the preset selector
4. Automatically switch to that preset

Luker records the preset name before switching, so it can automatically restore when leaving the character.

::: info Connection Field Safety
Card-bound preset loading always skips connection fields. Even if the Character Card author included API Keys or custom endpoints in the preset, this information will not be applied to the user's configuration. This is a direct safeguard of the [Preset Decoupling](/improvements/preset-decoupling) mechanism.
:::

## Character Cards Carrying Default Personas

Character Cards can specify one or more recommended Personas. This is a **global-level** binding — the Persona is directly associated with the Character Card itself, not just a specific chat session. When a user opens the Character Card:

- If the user currently has no Persona selected, Luker automatically switches to the Character Card's recommended Persona
- If the user already has a Persona, Luker issues a reminder that the current Persona differs from the Character Card's recommendation

Bound Personas are exported along with the Character Card. When other users import the Character Card, the recommended Persona information is imported as well, ensuring the Character Card author's recommended configuration is fully preserved.

## Auto-Switching on Load and Leave

### When Opening a Character Card

1. Detect whether the Character Card carries a bound preset
2. If yes, record the current preset name
3. Inject the card-bound preset option in the preset selector
4. Automatically switch to the bound preset (applying only generation parameters, not affecting connection configuration)

### When Leaving a Character Card

1. Detect whether there is an active card-bound preset
2. Automatically restore the previously used preset
3. Remove the card-bound option from the preset selector
4. Reset the binding state

For group chats, the restoration logic is also triggered when leaving.

## Special Identification in the Preset Selector

When a card-bound preset is active, a special badge is displayed in the preset selector, clearly indicating to the user that the current preset is the Character Card's recommendation rather than their own selection.

## Chat Persona Tracking

Luker tracks the currently used Persona in chat metadata. Each time the Persona changes, the current Persona information is written to the chat metadata and saved.

When reopening a chat, if the current Persona is detected to differ from the one recorded in the chat history, the user is notified via a prompt to avoid continuing the conversation under the wrong Persona.

## Import and Export with Character Cards

Bound presets and recommended Personas are part of the Character Card data and are automatically carried during Character Card import and export. Preset changes automatically sync to update the Character Card data, with processing executed asynchronously in the background to avoid blocking the interface.

## Dependencies

The card-bound preset feature depends on [Preset Decoupling](/improvements/preset-decoupling). Without preset decoupling's field classification mechanism, connection fields cannot be safely skipped when loading Character Card presets, making the entire feature impossible.

## Related Pages

- [Preset Decoupling](/improvements/preset-decoupling) — The prerequisite mechanism for card-bound presets
- [Improvements Overview](/improvements/overview) — Overview of all technical improvements
