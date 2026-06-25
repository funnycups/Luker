# Luker

Luker is a SillyTavern fork focused on cleaner API behavior, stronger extension hooks, and production-grade generation lifecycle handling.

## Why Luker

- Reliable generation lifecycle: backend-owned generation jobs keep running and persisting even if the frontend disconnects/reloads, and active output can be recovered after reconnect.
- Incremental persistence: chat/message and settings changes are patch-first instead of repeated full-save payloads.
- Better plugin ergonomics: prompt-preset-aware message assembly, world-info simulation/finalization hooks, and chat-bound plugin state helpers.
- Built-in advanced plugins: `Orchestrator` (multi-agent planning) and `Memory` (graph memory + recall).

## Developer Quick Start (Plugins)

Use `getContext()` as the primary integration surface.

- Authoring guide:
  - `docs/luker-plugin-authoring-guide.md`

- Persistence helpers:
  - `appendChatMessages(messages)`
  - `patchChatMessages(operations)`
  - `saveChatMetadata(withMetadata?)`
  - `getChatStateBatch(namespaces, options?)`
  - `getChatState(namespace, options?)`
  - `patchChatState(namespace, operations, options?)`
  - `updateChatState(namespace, updater, options?)`
  - `deleteChatState(namespace, options?)`
- Prompt/world-info helpers:
  - `buildPresetAwarePromptMessages(options)`
  - `simulateWorldInfoActivation(options?)`
  - WI helper payloads are entries-first: use `worldInfoBeforeEntries` / `worldInfoAfterEntries`
  - For preset/world-info assembly semantics (including popup/plugin flows), see `docs/luker-api-migration.md`.
- Generation lifecycle hooks (`context.eventSource.on(context.eventTypes.*)`):
  - `GENERATION_BEFORE_WORLD_INFO_SCAN`
  - `GENERATION_AFTER_WORLD_INFO_SCAN`
  - `GENERATION_WORLD_INFO_FINALIZED`
  - `GENERATION_BEFORE_API_REQUEST`
  - `GENERATION_STARTED` / `GENERATION_STOPPED` / `GENERATION_ENDED`
  - `MESSAGE_EDITED` → `(messageId, meta?)`
  - `MESSAGE_UPDATED` → `(messageId)`
  - `MESSAGE_DELETED` → `(chatLength, meta?)`

Detailed plugin docs:
- [`docs/luker-plugin-authoring-guide.md`](docs/luker-plugin-authoring-guide.md)
- [`docs/luker-api-migration.md`](docs/luker-api-migration.md)

## Android (Backend-in-App)

Luker now includes an Android app workspace at `android-app/` that runs backend locally on the phone and opens it via WebView (`127.0.0.1`).

- Android project docs: [`android-app/README.md`](android-app/README.md)
- CI workflow: [`.github/workflows/android-apk.yml`](.github/workflows/android-apk.yml)

Release model:
- Every commit/push builds debug APK artifacts.
- Tag pushes build signed release APK and publish/update a GitHub Release for that tag.

## Storage backends

Luker supports four storage backends, selectable in `config.yaml`:

- **`fs`** (default): every resource lives in per-user files on disk. Simplest for single-user installs; matches upstream SillyTavern.
- **`sqlite`**: each user gets a per-user `luker-storage.sqlite` file (WAL mode, online-backup-friendly). Same single-user shape as `fs` but with stronger consistency guarantees.
- **`mysql`** / **`postgres`**: shared-DB backends keyed by `handle` column. Designed for multi-user servers.

In db modes, **structured resources** (chats, settings, presets, world info, themes, groups, stats) live in the engine. **Binary resources** (character cards, avatars, backgrounds, user uploads, plugin extension trees, vector databases) stay on disk under `<dataRoot>/<handle>/` even in db mode — they're a poor fit for SQL columns. See `src/storage/README.md` for the full resource-vs-storage table.

Backup ZIPs in db mode include an `_engine_dump.bin` engine-side dump alongside the on-disk file tree. Restore works in-engine; switching engines requires `scripts/storage-migrate.js`.

## Upstream Resources (SillyTavern)

- GitHub: <https://github.com/SillyTavern/SillyTavern>
- Docs: <https://docs.sillytavern.app/>
- Discord: <https://discord.gg/sillytavern>
- Reddit: <https://reddit.com/r/SillyTavernAI>

## License

AGPL-3.0
