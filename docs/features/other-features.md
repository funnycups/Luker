# Other Features

This page lists other user-facing features unique to Luker. While smaller in scope, these features significantly improve the day-to-day experience.

## World Info Activation Trace

Luker records the complete chain from matching to injection for World Info entries, helping you debug complex World Info configurations. See [World Info Activation Trace](/features/world-info-trace) for details.

## Chat Persona Lock

Chat Persona Lock allows you to bind a user persona to a specific chat session. When enabled, switching to that chat automatically restores the corresponding persona, and leaving restores the default persona.

This is particularly useful when you use different user identities for different character cards — for example, playing as an "adventurer" in one chat and a "student" in another, without needing to manually switch each time.

## Chat Tools Panel

The Current Chat Tools Panel is a non-blocking tools panel that provides quick access to tools related to the current chat within the chat interface. The panel does not obscure chat content, allowing you to use tool features at any time during conversation.

## Popup Updater

The Popup Updater provides an in-app update flow. When a new version is available, a popup guides you through the update process. The updater has Docker environment awareness and provides corresponding update instructions based on your deployment method (Docker or local installation).

## Image Generation Enhancements

Luker's improvement to image generation is ComfyUI WebSocket connection support — using WebSocket instead of frequent HTTP polling endpoints to communicate with ComfyUI, improving generation efficiency and real-time responsiveness, with smart fallback and reconnection retry support.

## Plugin Regex Provider

Plugins can dynamically register regex rules into the regex processing system. See [Plugin Regex Provider](/features/regex-provider) for details.

## Onboarding Config Import

Onboarding Config Import optimizes the first-use onboarding flow. During initial setup, you can directly import existing configuration files, including:

- Complete application settings
- Extension configurations (supports flat zip layout extension packages)

This is particularly useful for migrating from other instances or quickly restoring your working environment on a new device, avoiding the tedious process of configuring from scratch.

## Related Features

- [Search Tools](/features/search-tools) — AI web search capabilities
- [Character Card Editor](/features/card-editor) — Enhanced character card editing experience
- [Memory Graph](/features/memory-graph) — Knowledge graph-based memory system
