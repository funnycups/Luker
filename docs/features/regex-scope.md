# Regex Rule Scope

Every regex rule in Luker runs in one lane. The **Affects** group in the regex editor decides which lane a rule runs in, and the plugin lane runs in two directions.

## Lanes

- **Stored chat history** — a rule with no scope option ticked rewrites the chat file itself when messages are edited or saved.
- **Chat display** — **Alter Chat Display** rewrites what the Chat UI shows without changing the stored messages. It never affects what is sent to the model.
- **Main outgoing prompt** — **Alter Outgoing Prompt** rewrites the prompt the main chat sends, without touching the stored messages.
- **Plugin channel** — **Alter Plugin Messages** rewrites the text of plugin-driven LLM requests and the text those requests return.

## Placement

**User Input**, **AI Output**, **Slash Commands**, **World Info**, and **Reasoning** narrow a rule to messages of that kind. A rule runs only on messages whose role matches a ticked placement. With no placement ticked, it runs on none of them.

## Direction in the plugin channel

The plugin channel runs in two directions:

- **Alter Plugin Messages** with **Alter Outgoing Prompt** rewrites the text going into a plugin request: the chat floor text, plugin-composed messages, and world info entries.
- **Alter Plugin Messages** on its own rewrites the assistant text a plugin request returns.

The two directions are disjoint, so one rule never runs twice on the same text. Tool call payloads are never rewritten; when a plugin request returns tool calls, only the response text is processed.

## Notes

- **Alter Chat Display** is disabled while **Alter Plugin Messages** is ticked, because the plugin channel never alters chat display.
- **Min Depth** and **Max Depth** filter the messages a rule processes by their position in the chat.

## Related Pages

- [Plugin-Registered Regex](/features/regex-provider) — Registering regex rules from plugin code
- [Extension API Reference — Chat and State](/development/extension-api/chat-and-state) — Regex lanes from a plugin's perspective
