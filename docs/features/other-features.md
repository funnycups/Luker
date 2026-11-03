# Other Features

## World Info Activation Trace

Luker records each World Info entry from match to injection, for debugging complex configurations. See [World Info Activation Trace](/features/world-info-trace).

## Card-Bound Personas

A Character Card can carry a recommended persona and export it with the card. Opening the card switches to that persona if none is chosen; if the current one differs, Luker asks before switching. See [Card-Bound Presets & Personas](/improvements/card-bound-presets).

## Chat Tools Panel

A tools panel in the chat interface, with the current chat's tools on hand while you talk.

## Popup Updater

When a new version is available, a popup walks through the update. It detects Docker deployments and shows the matching steps.

## Image Generation Enhancements

Luker talks to ComfyUI over WebSocket instead of polling HTTP endpoints, with reconnection when the connection drops.

## Plugin Regex Provider

Plugins can register regex rules into the regex pipeline. See [Plugin Regex Provider](/features/regex-provider).

## Onboarding Config Import

The first-run setup can import an existing app settings file and extension configurations, for migrating from another instance or restoring a setup on a new device.

## Related Features

- [User Settings Additions](/features/user-settings-additions) — the Luker-only controls inside User Settings, plus backup, migration and storage tools
- [Search Tools](/features/search-tools) — AI web search capabilities
- [Character Card Editor Assistant](/features/card-editor/) — Enhanced character card editing experience
- [Memory Graph](/features/memory-graph) — Knowledge graph-based memory system
