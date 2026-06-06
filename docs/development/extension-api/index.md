# Extension API Reference

This is the complete reference for the Luker Extension API, intended for plugin developers. All APIs are exposed through `Luker.getContext()`. The reference is split into the following pages:

| Page | What's covered |
| --- | --- |
| [Chat & State](/development/extension-api/chat-and-state) | Chat data, the unified Messages API, chat persistence, Chat State, Floor State, Character State, chat lifecycle, swipe API, extension prompts, media helpers |
| [Characters](/development/extension-api/characters) | Character cards, V2/legacy Proxy semantics, tags, import / export, per-character state |
| [World Info](/development/extension-api/world-info) | Lorebook CRUD, activation scanning, character auxiliary world books |
| [Presets & Prompts](/development/extension-api/presets-and-prompts) | `context.presets.*`, `buildPresetAwarePromptMessages`, `resolveWorldInfoForMessages`, envelope inspection, reasoning helpers, settings views |
| [Generation](/development/extension-api/generation) | `generateTask`, tool registration, `generateRaw` / `generateQuietPrompt`, service classes, connection profiles |
| [Slash Commands](/development/extension-api/slash-commands) | Registering and executing slash commands, named/unnamed arguments, enums |
| [Macros & Variables](/development/extension-api/macros-and-variables) | Macro registration, built-in macro reference, `substituteParams`, local & global variables |
| [Skills](/development/extension-api/skills) | `context.skills.*` — install, read, write, search, scope migration, embed pack/extract; CardApp ctx parity |
| [UI & Popups](/development/extension-api/ui-and-popups) | Popups, loaders, templates, message formatting |
| [IterationStudio](/development/extension-api/iteration-studio) | Shared popup framework for AI-driven iterative editing — conversation, sessions, diff preview, approve/reject lifecycle. Adapters supply the artifact shape + tools |
| [Plugin Integration](/development/extension-api/plugin-integration) | Regex runtime, search tools, extension API registry, event system, i18n, settings storage, debug & scraper registration, tokenization, utilities, symbols & constants |
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

## Namespace Quick Reference

For quickly finding where an API lives, the context object groups related APIs into namespaces:

| Namespace | Contents |
|------|------|
| `context.presets` | `list`, `getSelected`, `getLive`, `getStored`, `save`, `resolve`, `readExtensions`, `writeExtensions`, `state.*` |
| `context.connectionProfiles` | `list`, `resolve` (deprecated for direct use) |
| `context.variables.local` | `get`, `set`, `add`, `inc`, `dec`, `del`, `has` |
| `context.variables.global` | `get`, `set`, `add`, `inc`, `dec`, `del`, `has` |
| `context.swipe` | `left`, `right`, `to`, `show`, `hide`, `refresh`, `isAllowed`, `state` |
| `context.symbols` | `ignore` (the `IGNORE_SYMBOL` sentinel) |
| `context.constants` | `unset`, `promptRoles`, `promptTypes`, `wiAnchor`, `wiPosition` |
| `context.macros` | `register`, `registerAlias`, `registry`, `engine`, `category`, `envBuilder` |
| `context.loader` | `show`, `hide`, `active`, `get`, `isBlocking`, `ToastMode`, `Handle` |
| `context.skills` | `list`, `get`, `readFile`, `listFiles`, `search`, `writeFile`, `editFile`, `deleteFile`, `install`, `delete`, `rename`, `moveScope`, `importBundled`, `listBundledManifest`, `packForEmbed`, `previewExtractEmbed`, `executeExtractEmbed`, `importFromUrl` |
| `context.worldInfoEntry` | `template`, `create`, `setButtonClass`, `setGlobalSelection` |
| `context.openai` | `proxies`, `ZAI_ENDPOINT`, `stripPresetConnectionFields` |
| `context.textCompletion` | `types` |
| `context.secrets` | `KEYS`, `state` |
| `context.lib` | `DOMPurify`, `lodash`, `DiffMatchPatch`, `showdown`, `yaml` |

## API Differences from SillyTavern

Luker is built on SillyTavern but has the following major API-level differences:

| Area | SillyTavern | Luker |
|------|-------------|-------|
| Chat persistence | Full-file overwrite | Patch-first (RFC 6902 incremental updates) |
| Chat-bound state | `chat_metadata` only | New Chat State mechanism + Floor State |
| Per-character state | None | `getCharacterState` / `setCharacterState` (separate from card JSON) |
| Preset management | Direct import of internal modules | Unified `context.presets.*` API |
| Prompt assembly | Manual concatenation required | `buildPresetAwarePromptMessages()` |
| World Info simulation | None | `simulateWorldInfoActivation()` |
| Character auxiliary world books | None | `getCharaAuxWorlds()` |
| Generation hooks | Basic events | New fine-grained hooks such as `GENERATION_CONTEXT_READY`, `GENERATION_BEFORE_WORLD_INFO_SCAN`, etc. |
| Event ordering | Registration order | Supports `priority`, `pluginOrder`, `makeFirst`/`makeLast` |
| Regex runtime | No plugin API | `registerManagedRegexProvider()` |
| Search tools | No plugin API | `Luker.searchTools` global API |
| Function calling | Basic `ToolManager` | Plain-text mode support + connection-level toggle + `sendOpenAIRequest` preset override |
| Connection config | Single global config | `context.presets.resolve()` supports per-preset connection resolution |
| Macro engine | String substitution | Structured `macros.register()` with handler context, args, categories |
| Character object | Plain V1/V2 fields | Proxy with V2 canonicalization and legacy-write deprecation warnings |

> [!IMPORTANT]
> Prefer the APIs provided by `Luker.getContext()` over calling the underlying HTTP endpoints directly. The Context API encapsulates patch-first semantics, conflict handling, and retry logic; calling endpoints directly requires you to handle these details yourself.

## Related Pages

- [Frontend Plugin Development](/development/frontend-plugin) — Plugin structure, event system, UI integration
- [Character Card Development](/development/card-developers) — Character Card extension fields and CardApp
- [Incremental Sync](/improvements/incremental-sync) — Technical details of incremental saving
- [Preset Decoupling](/improvements/preset-decoupling) — Mechanism for decoupling presets from API selection
