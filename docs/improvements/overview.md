# Improvements Overview

Luker's improvements over SillyTavern are not simply feature additions, but a systematic refactoring across multiple dimensions including data transmission architecture, the preset system, and extensibility. These improvements work together to form a more efficient and flexible roleplay platform.

## Improvements at a Glance

| Category | Improvement | Brief Description |
| --- | --- | --- |
| Architecture | [Preset Decoupling](/improvements/preset-decoupling) | Separates connection parameters and presets into independent entities |
| Architecture | [Incremental Sync](/improvements/incremental-sync) | Incremental patch-based data transmission, replacing full overwrites |
| Architecture | [Backend Real-Time Storage](/improvements/backend-storage) | Real-time data persistence with integrity checks to prevent concurrent conflicts |
| Feature | [Function Call Runtime](/improvements/function-call-runtime) | Unified function calling support in both native and plain-text modes |
| Feature | [Card-Bound Presets & Personas](/improvements/card-bound-presets) | Character Cards can carry recommended presets and default personas |
| Feature | [Request Inspector](/improvements/request-inspector) | Tracks the complete lifecycle and token usage of generation requests |
| Feature | [Preset World Info](/improvements/preset-world-info) | Automatically activates corresponding World Info when switching presets |
| Feature | [Skills](/features/skills/) | Anthropic-compatible local knowledge packs the orchestrator agents read on demand |
| Infrastructure | [Unified Generation Layer](/improvements/generation-layer) | Unified wrapping and token metering for multi-backend generation requests |
| Infrastructure | [Performance Optimization](/improvements/performance) | Parallel loading, lazy loading, deferred initialization, and other startup/runtime optimizations |
| Infrastructure | [WebSocket Proxy](/improvements/ws-proxy) | Persistent WS tunnel transmission with heartbeat keep-alive and stream offset recovery |
| Infrastructure | [Auth & Quota](/improvements/auth-and-quota) | OAuth login, multi-user authentication, and storage quota management |
| Infrastructure | [Other Improvements](/improvements/other) | Connection manager enhancements, prompt/preset grouping, dynamic model lists, etc. |

For exclusive feature modules (Memory Graph, Orchestrator, Character Editing Assistant, Search Tools, CardApp, etc.), see the [Exclusive Features](/features/memory-graph) category.

## Architecture Improvements

### Preset Decoupling

In SillyTavern, API connection parameters (such as model name, API address, proxy settings) and presets (such as temperature, Top-P, prompt configuration) are coupled in the same configuration object. This means switching API providers forces users to reconfigure generation parameters; conversely, adjusting sampling strategies may accidentally affect connection settings.

Luker splits them into independent entities: **connection configurations** handle "where to connect," and **presets** handle "how to generate." At the code level, each setting field is classified via an `isConnection` flag, and connection fields are automatically skipped when loading presets. The two can be freely combined — the same preset can be used with different API connections, and vice versa.

This decoupling also lays the foundation for downstream features like card-bound presets and the connection manager. See [Preset Decoupling](/improvements/preset-decoupling) for details.

### Incremental Sync

Traditional frontend-backend data sync uses full overwrites: every modification sends the complete object to the server. As objects grow in size (e.g., chat histories with many messages), this approach causes significant bandwidth waste and write conflict risks.

Luker introduces three incremental endpoints:

- **`append`**: Appends new messages to the end of the `.jsonl` file instead of rewriting the entire file
- **`patch`**: Patches specific lines by message index, updating only changed messages
- **`patch-metadata`**: Uses deep merge to update chat metadata instead of replacing it

After each write, the backend computes an integrity hash and returns it to the frontend; subsequent requests carry this value for verification, returning 409 Conflict on mismatch, fundamentally preventing concurrent write conflicts. Settings data also supports incremental patch saving with conflict detection and serialized writes. See [Incremental Sync](/improvements/incremental-sync) for details.

### Backend Real-Time Storage

Some of SillyTavern's data relies on frontend-triggered saves, creating a time window where "the user has made changes but data hasn't been persisted to disk." If the process exits abnormally, these changes are lost.

Luker moves storage logic to the backend: data changes are immediately persisted to disk upon reaching the server. The frontend no longer bears the responsibility of "when to save," fundamentally eliminating the window for data loss.

Additionally, Luker introduces the following mechanisms to ensure data safety:

- **Chat state files**: `.luker-state.<chat_id>.json` files maintain additional state for each chat, with lifecycles bound to the chat file
- **Generation Acknowledge**: After AI generation completes, confirmation is sent through a dedicated endpoint to ensure generation results are properly recorded
- **Serialized chat writes**: Prevents data corruption from concurrent writes, especially for group chat scenarios
- **Configurable backup strategy**: Supports automatic backup of chat files

See [Backend Real-Time Storage](/improvements/backend-storage) for details.

## Feature Enhancements

### Function Call Runtime

Luker has a built-in unified Function Calling runtime that supports two operating modes:

- **Native mode**: Leverages the API provider's native tool calling capabilities (compatible with OpenAI, Claude, Gemini, and other formats), where the model directly outputs structured call instructions with streaming tool call normalization
- **Plain-text mode**: Guides the model to output call intentions in plain text through prompts, which the runtime then parses and executes, supporting multi-tool calls and configurable error retries

These two modes cover all scenarios from high-end commercial APIs to local small models. The plain-text function calling toggle and retry strategy can be configured independently per connection in the Connection Manager. See [Function Call Runtime](/improvements/function-call-runtime) for details.

### Card-Bound Presets & Personas

Character Card creators often know best under what parameters their characters perform optimally. Luker allows Character Cards to carry **recommended presets** (with connection fields automatically stripped) and **default personas**. When users load a Character Card, the system automatically applies the creator's recommended configuration and records the previous preset; it automatically restores when leaving the character. In the preset selector, bound presets are identified with a special badge, visually distinguishing them from regular presets.

The Chat Persona Lock feature binds user personas to specific chats, automatically restoring the corresponding persona settings when switching chats. These features are built on the foundation of preset decoupling — precisely because presets are independent entities, they can be referenced and distributed by Character Cards. See [Card-Bound Presets & Personas](/improvements/card-bound-presets) for details.

### Request Inspector

When debugging AI conversations, users often need to know "what exactly was sent to the API." Luker's Request Inspector tracks the complete lifecycle of each AI generation request from initiation to completion, recording prompt tokens, completion tokens, and total usage. It supports token statistics for streaming responses (extracting usage information from SSE events) and also covers image generation, vector embedding, and rerank request tracking. The token usage tracked by the Request Inspector is an independent statistics feature, separate from the storage quota management system. See [Request Inspector](/improvements/request-inspector) for details.

### Skills

Multi-agent orchestrator profiles tend to grow long system prompts — every reusable writing rule, every critic method, every workflow contract used to sit inline inside `systemPrompt`, often duplicated across several sub-agents. Luker introduces **skills**: Anthropic-compatible local knowledge packs (`SKILL.md` + frontmatter + optional sub-files) the agents read on demand. Skills are addressed by name (no scope prefix in references), live under three scopes (`global` / `preset` / `character`), and resolve with later-wins precedence at dispatch time.

The orchestrator's default director profile ships with 24 bundled skills covering the shared writing rules, the main-agent workflow, and one method skill per sub-agent. The same format is portable both ways with Anthropic's Claude Code — skills round-trip without conversion. Skills can ride with character cards (PNG metadata) or presets (embedded payload), so distributing a card distributes the writing rules that make it work. The skill manager subpanel handles install, edit, scope migration, and embed export; the iter-studio AI can extract reusable rules from long `systemPrompt` text into skills via dedicated tools. See [Skills overview](/features/skills/) for the conceptual model and [Authoring skills](/features/skills/authoring) for the format.

## Infrastructure

### Unified Generation Layer

In SillyTavern, different AI backends (OpenAI, Anthropic, Google, Kobold, etc.) have independent code paths for generation requests, leading to inconsistent feature support. Luker introduces a Unified Generation Layer that wraps multi-backend generation requests uniformly, sharing token metering, streaming processing, and error handling logic.

This module provides a unified processing pipeline for all AI backends, ensuring that regardless of which AI service is used, users get a consistent feature experience (such as request inspection, token statistics, generation acknowledgment, etc.). See [Unified Generation Layer](/improvements/generation-layer) for details.

### Auth & Quota

Luker adds OAuth login support (GitHub, Discord) and storage quota management:

- **OAuth login**: Configured through the frontend admin panel (stored in the `oauth` section of `admin-settings.json`), supporting authorization code exchange for access tokens, automatic creation or association of local user accounts
- **Storage quota**: Administrators can set storage space quota limits for different users, with the system automatically checking quotas before requests
- **Logging system**: See [Logging System](/features/logging) for details

This enables Luker to run safely in multi-user shared deployment scenarios. See [Auth & Quota](/improvements/auth-and-quota) for details.

### Other Improvements

Beyond the core improvements above, Luker includes numerous infrastructure optimizations:

- **Connection manager improvements**: Enhances SillyTavern's existing Connection Profiles with deep integration into preset decoupling, supporting independent plain-text function calling toggles
- **WebSocket proxy**: Transmits generation requests through persistent WS tunnels with heartbeat keep-alive and stream offset recovery
- **HTTP request proxy**: Supports SOCKS5/HTTP proxy forwarding for outbound requests
- **Preset grouping & prompt grouping**: Preset selector and prompt manager support collapsible group sections
- **Preset World Info**: Automatically activates corresponding World Info when switching presets
- **Undo Toast system**: Provides undo prompts for destructive operations
- **Dynamic model lists**: Claude and Vertex model lists are dynamically loaded
- **Extension hook ordering**: Allows users to customize extension execution priority
- **Character State API**: Extensions can store persistent state data on characters and presets
- **Startup performance optimization**: Parallelized resource loading, preloading recent chat snapshots, lazy-loading chat indexes
- **Mobile adaptation**: Extensive Android WebView and touch interaction fixes

See [Other Improvements](/improvements/other) for details.

## Relationship with SillyTavern

Luker is a downstream fork of SillyTavern, not an independent project. All improvements are designed with the premise of **not breaking upstream compatibility**:

- **Regular syncing**: Luker continuously tracks SillyTavern upstream updates, regularly merging upstream changes
- **Data compatibility**: Luker's data formats extend rather than replace SillyTavern's. New state files and configuration items all have reasonable defaults
- **Incremental features**: Luker's improvements are incremental additions on top of upstream features, not destructive rewrites. When migrating from SillyTavern to Luker, users' existing data can be used seamlessly
