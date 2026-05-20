# Changelog

> 🚧 A full changelog is still being assembled. The list below is a feature snapshot of the current Luker release.

## Current version

### Core features

- **Memory Graph** — Knowledge-graph long-term memory, 9-layer hybrid recall pipeline
- **Multi-Agent Orchestrator** — Three execution modes (Spec workflow, Single agent, Agenda planner)
- **Card Editor Assistant** — AI-driven conversational character-card editing with 7 tools
- **Search Tools** — Three-engine support: DuckDuckGo, SearXNG, Brave Search
- **Preset Assistant** — AI-assisted preset editing with IDE-style drift handling and per-message rollback; new fine-grained tools (str_replace / str_insert / list_insert / list_move) save tokens on long fields
- **Edits library** (`public/scripts/lib/edits/`) — shared op-typed structured-edit primitives with drift-aware apply + interactive conflict UI, exposed to third-party extensions (ESM / lukerContext / ctx). See `docs/development/extension-api/edits-lib.md`.
- **CardApp** — Interactive applications embedded in character cards

### Architecture improvements

- **Preset Decoupling** — Connection parameters and presets managed independently
- **Incremental Sync** — RFC 6902 incremental data transfer
- **Backend Storage** — Data changes persisted in real time
- **Function Call Runtime** — Native + plain-text dual modes
- **Unified Generation Layer** — Single envelope for multiple backends
- **Request Inspector** — Full-lifecycle generation-request tracing
- **Auth & Quotas** — GitHub / Discord OAuth + storage quota management

### User experience

- Card-bound presets and personas
- Prompt groups & preset groups
- Hook execution order
- World Info activation trace
- Chat-persona lock
- Undo-toast system
- Dynamic model lists
- Image generation enhancements
- Mobile UX refinements
- Startup performance optimization

## Recent breaking changes

- **CEA CardApp Studio rebuilt on the iteration-studio shell** (SP-2 of the adapter migration). The standalone session / popup / diff infrastructure has been replaced with the SP-1 v2 adapter contract: `live()` is the single authority, the 4 file-write tools route through `normalizeToolCallToEdit`, the 2 file-read tools through `executeControlToolCall`, and `commit()` diffs against the previous snapshot before fanning out to the existing `saveFileContent / deleteFile` helpers. The old `cardapp_studio_sessions` character-sidecar bucket is wiped once on first open after upgrade; CardApp files on disk are untouched.
- **Iteration Studio adapter contract v2 (IDE-style).** The shell no longer carries a `workingProfile` snapshot; the adapter's `live()` is the single authority. In-tree orchestrator + memory-graph adapters migrated. Out-of-tree adapters require updates (see `docs/development/extension-api/iteration-studio.md`). Old iteration-studio session data is wiped once per adapter on first open after upgrade; live artifacts (preset files, character cards, settings) are untouched. CEA and CPA adapters arrive in subsequent releases.
- **CPA conversation rollback resets on upgrade.** The journal-based session model was replaced with IDE-style live=authority + per-message `appliedEdits`. Preset files themselves are unchanged; only CPA's conversation rollback history from prior sessions is lost. New conversations rollback normally via the new mechanism.

---

Detailed per-version notes will be added later. For deeper information about a specific feature, see the corresponding documentation page.
