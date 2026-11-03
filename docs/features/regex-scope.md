# Regex Rule Scope

A regex rule can run in several places. The regex editor splits the choice into two groups, and options from either group combine on one rule.

## Affects

| Option | Effect |
|---|---|
| **User Input**, **AI Output**, **Slash Commands**, **World Info**, **Reasoning** | The rule processes only messages of the ticked kinds. With none ticked, the rule is stored but does not run. |
| **Plugin Requests** | The rule processes text going into a plugin request: chat floor text, plugin-composed messages, world info entries. Requires at least one message kind ticked under Affects. |
| **Plugin Replies** | The rule processes the assistant text a plugin request returns. Message kinds do not apply. |
| **Min Depth**, **Max Depth** | Limit the messages a rule processes by their position in the chat. |

A rule with **Plugin Replies** ticked runs even when no message kind is ticked.

## Ephemerality

| Options | Effect |
|---|---|
| **Alter Chat Display** | Rewrites what the chat UI shows. The chat file is untouched. |
| **Alter Outgoing Prompt** | Rewrites the prompt sent to the model. The chat file is untouched. |
| Neither, with **Plugin Requests** and **Plugin Replies** unticked | Rewrites the chat file when messages are edited or saved. |

**Plugin Requests** and **Plugin Replies** ignore Ephemerality; ticking an Ephemerality option does not disable them.

## Notes

- A rule rewrites the stored chat only when it has no scope target. Ticking **Plugin Requests** or **Plugin Replies** keeps it off the stored chat. Message kinds narrow which stored messages it touches.
- To clear custom CoT tags, leave Ephemerality, **Plugin Requests**, and **Plugin Replies** unticked. The rule rewrites the stored message once; the chat display and the prompt both read the cleaned text. Message kinds narrow the affected messages.
- Ticking both **Alter Chat Display** and **Alter Outgoing Prompt** for CoT tags adds a second pass with no extra effect.
- To keep CoT tags as a collapsible block instead of deleting them, use **Advanced Formatting** → **Reasoning Formatting**.

## Related Pages

- [Plugin-Registered Regex](/features/regex-provider) — Registering regex rules from plugin code
- [Extension API Reference — Chat and State](/development/extension-api/chat-and-state) — Regex rules from a plugin's perspective
