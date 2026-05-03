# Extension API Reference

This is the complete reference for the Luker Extension API, intended for plugin developers. All APIs are exposed through `Luker.getContext()`. The reference is split into the following pages:

| Page | What's covered |
| --- | --- |
| [Chat & State](/development/extension-api/chat-and-state) | Chat data, the unified Messages API, chat persistence, Chat State, Floor State, Character State |
| [Presets & Prompts](/development/extension-api/presets-and-prompts) | `context.presets.*`, `buildPresetAwarePromptMessages`, `resolveWorldInfoForMessages` |
| [Generation](/development/extension-api/generation) | `sendOpenAIRequest`, tool registration, connection configuration resolution |
| [Plugin Integration](/development/extension-api/plugin-integration) | Regex runtime, search tools, extension API registry, event system |
| [Low-Level Endpoints](/development/extension-api/low-level-endpoints) | Raw HTTP routes (advanced / debugging only) |

## Global Entry Point

```js
const context = Luker.getContext();
```

| Alias | Description |
|------|------|
| `Luker.getContext()` | Recommended |
| `SillyTavern.getContext()` | Compatibility alias |
| `st.getContext()` | Compatibility alias |

New plugins should use `Luker.getContext()` exclusively. Compatibility aliases are retained only for the migration period.

## API Differences from SillyTavern

Luker is built on SillyTavern but has the following major API-level differences:

| Area | SillyTavern | Luker |
|------|-------------|-------|
| Chat persistence | Full-file overwrite | Patch-first (RFC 6902 incremental updates) |
| Chat-bound state | `chat_metadata` only | New Chat State mechanism |
| Preset management | Direct import of internal modules | Unified `context.presets.*` API |
| Prompt assembly | Manual concatenation required | `buildPresetAwarePromptMessages()` |
| World Info simulation | None | `simulateWorldInfoActivation()` |
| Generation hooks | Basic events | New fine-grained hooks such as `GENERATION_CONTEXT_READY`, `GENERATION_BEFORE_WORLD_INFO_SCAN`, etc. |
| Event ordering | Registration order | Supports `priority`, `pluginOrder`, `makeFirst`/`makeLast` |
| Regex runtime | No plugin API | `registerManagedRegexProvider()` |
| Search tools | No plugin API | `Luker.searchTools` global API |
| Function calling | Basic `ToolManager` | Plain-text mode support + connection-level toggle + `sendOpenAIRequest` preset override |
| Connection config | Single global config | `context.presets.resolve()` supports per-preset connection resolution |

> [!IMPORTANT]
> Prefer the APIs provided by `Luker.getContext()` over calling the underlying HTTP endpoints directly. The Context API encapsulates patch-first semantics, conflict handling, and retry logic; calling endpoints directly requires you to handle these details yourself.

## Related Pages

- [Frontend Plugin Development](/development/frontend-plugin) — Plugin structure, event system, UI integration
- [Character Card Development](/development/card-developers) — Character Card extension fields and CardApp
- [Incremental Sync](/improvements/incremental-sync) — Technical details of incremental saving
- [Preset Decoupling](/improvements/preset-decoupling) — Mechanism for decoupling presets from API selection
