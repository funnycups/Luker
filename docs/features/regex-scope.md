# Regex Rule Scope

A regex rule can be applied in several places. The regex editor splits the choice into two groups, and options from either group can be combined freely on one rule.

## Affects

**Affects** decides which content a rule processes.

- **User Input**, **AI Output**, **Slash Commands**, **World Info**, and **Reasoning** narrow a rule to messages of that kind. A rule applies only to messages whose role matches a ticked placement. With none ticked, the rule is stored; a rule with **Plugin Replies** ticked runs.
- **Plugin Requests** makes a rule process the text going into a plugin request — chat floor text, plugin-composed messages, and world info entries. It needs at least one message type ticked under **Affects**.
- **Plugin Replies** makes a rule process the assistant text a plugin request returns. It does not use message types.
- **Min Depth** and **Max Depth** filter the messages a rule processes by their position in the chat.

## Other Options → Ephemerality

**Ephemerality** decides whether a rule acts on a single view instead of rewriting the chat file.

- **Alter Chat Display** — the rule rewrites what the Chat UI shows.
- **Alter Outgoing Prompt** — the rule rewrites the prompt the main chat sends.
- With neither ticked, and neither **Plugin Requests** nor **Plugin Replies** ticked, the rule rewrites the chat file itself when messages are edited or saved.
- **Plugin Requests** and **Plugin Replies** are independent of Ephemerality. Ticking an Ephemerality option does not turn either off.

## Notes

- A rule rewrites the stored chat only when no scope target is ticked. Ticking **Plugin Requests** or **Plugin Replies** keeps the rule off the stored chat. Message types filter which messages a rule processes when it runs on stored messages.
- To clear custom CoT tags from stored message text, leave the Ephemerality options unticked and leave **Plugin Requests** and **Plugin Replies** unticked: the rule rewrites the stored messages once, and the chat display and the prompt read the cleaned text. Message types narrow the affected messages.
- Ticking both **Alter Chat Display** and **Alter Outgoing Prompt** for custom CoT tags only adds overhead.
- To keep custom CoT tags in a collapsible section instead of deleting the text, use **Advanced Formatting** → **Reasoning Formatting**.

## Related Pages

- [Plugin-Registered Regex](/features/regex-provider) — Registering regex rules from plugin code
- [Extension API Reference — Chat and State](/development/extension-api/chat-and-state) — Regex rules from a plugin's perspective
