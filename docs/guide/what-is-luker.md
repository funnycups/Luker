# What is Luker

Luker is a deeply refactored roleplay chat platform based on [SillyTavern](https://github.com/SillyTavern/SillyTavern). It retains SillyTavern's mature character card ecosystem and data format compatibility while introducing extensive innovations in data transfer architecture, extensibility, and built-in tooling to deliver a more efficient and powerful roleplay experience.

Luker is fully compatible with SillyTavern data — character cards, world info, and presets can be used directly with zero migration cost. If you decide to stop using Luker, you can downgrade back to SillyTavern at any time without data loss.

## Why Luker

SillyTavern is an excellent roleplay frontend with an active community and a rich character card ecosystem. Building on that foundation, Luker introduces systematic improvements in the following areas:

### More Efficient Data Transfer

Most save operations in SillyTavern use full-payload transfers — every message edit, settings toggle, or world info change sends the complete data to the backend. For cloud-deployed users, this means significant bandwidth consumption.

Luker introduces an incremental sync mechanism that uniformly uses patch endpoints compliant with the [RFC 6902](https://datatracker.ietf.org/doc/html/rfc6902) standard. Toggling a plugin setting that previously transferred 3 MB of data now takes less than 200 bytes. Save operations also support debounced triggering and conflict detection, fundamentally preventing data corruption caused by concurrent writes.

### Stronger Extensibility

Luker provides richer infrastructure for plugin developers: character/preset state APIs, managed regex providers, unified extension injection settings, a function call runtime, and more. Plugins can conveniently reuse the user's existing API and chat completion presets without redundant configuration.

### Built-in Professional Tooling

Luker ships with several professional tools designed for roleplay scenarios — Memory Graph, multi-agent orchestration, character card editing assistant, search plugins, and more — all ready to use out of the box without installing third-party extensions.

## Core Features Overview

### Memory Graph

A character memory system built on a knowledge graph. Events, characters, locations, and plotlines from roleplay sessions are distilled into typed nodes connected to each other. Before a reply is written, a recall pass finds the nodes most relevant to the current scene and injects them into the creative context. Two recall methods are available: **LLM Recall** (the default — the model selects relevant nodes from the store, with multi-round exploration) and **RAG Recall** (vector retrieval over an embedded store, with optional cross-encoder rerank and optional LLM query rewrite). Extraction runs on its own after each reply, either through the built-in pipeline or through an orchestrator sub-agent.

→ [Memory Graph Documentation](/features/memory-graph)

### Orchestrator

Before the creative LLM generates a response, a team of agents plans the scene: one distills the recent context, another drafts what this turn should accomplish, a reviewer checks the plan, and the result is packaged into a short briefing for the writer. Five execution modes are available: **Spec** (a fixed Stage → Node pipeline, the default), **Single Agent**, **Agenda** (a planner dispatches agents through tool calls), **Loop** (one agent runs an iterative tool loop until it finalizes), and **Director** (a main agent plus a sub-agent team writes the message body directly). All agent actions are retained as a runtime trace you can inspect. Orchestration configurations can be bound to character cards and imported/exported along with them.

→ [Orchestrator Documentation](/features/orchestrator/)

### Skills

Reusable knowledge packs that agents read on demand, instead of one giant system prompt. Skills support the Anthropic Claude Skills format and round-trip with Claude Code without conversion. The default Director profile ships with 24 bundled skills, and skills can travel with a character card or a preset, so distributing a card distributes the writing rules that make it work.

→ [Skills Documentation](/features/skills/)

### Character Card Editing Assistant (CEA / CardApp Studio)

An AI-assisted character card editing tool with an integrated CodeMirror 6 code editor. It edits character cards, world info, and CardApp code through natural language conversation, committing real changes via structured tool calls, with diff-based approval for every batch — rejected changes never take effect. When you replace or update a card, it detects world info changes and offers to import the new book, keep the old one, or merge them with AI help. Regular cards use the popup editor; cards with an embedded CardApp open in the more capable Studio.

→ [CEA Overview](/features/card-editor/)　·　[Popup](/features/card-editor/popup)　·　[CardApp Studio](/features/card-editor/studio)

### Preset Assistant

An AI assistant for chat completion presets. It reads the current preset's real values, explains what each parameter does, edits prompt entries as well as sampling values, and compares against a reference preset — returning every change as a diff you approve. The same workflow covers presets whose downstream consumer is the orchestrator.

→ [Preset Assistant Documentation](/features/preset-assistant)

### Search Tools

Provides web search capabilities for AI, supporting search engine backends like DuckDuckGo, SearXNG, and Brave Search. Two operating modes are available: as a callable tool for the creative LLM, or as a pre-request agent that automatically searches before generation and writes results into world info.

→ [Search Tools Documentation](/features/search-tools)

### TTS NPC Dialogue Attribution

With TTS enabled, every quoted line in a reply can play with its own speaker's voice. A background pass works out who says each quote — NPCs it discovers appear in the voice map automatically, and names you add in advance are recognized from the first playback.

→ [TTS NPC Dialogue Attribution Documentation](/features/tts-npc-attribution)

### Chat Merge and Split

Split a chat at any turn, or merge two chats into one; branch history stays consistent on both sides.

→ [Chat Merge and Split Documentation](/features/chat-merge-split)

### LAN Sync

Pair two Luker instances on the same network and keep chats, cards, world info, and settings in step between them — nothing is pushed to a cloud.

→ [LAN Sync Documentation](/improvements/lan-sync)

### Android App

The backend runs inside the Android app, so one phone serves both the server and the interface. Install the APK and start chatting — no Termux, no manual Node install, no port forwarding.

→ [Android App Guide](/guide/android)

### Change the Model, Keep Your Prompt Setup

In SillyTavern, API presets and chat completion presets are switched together, so changing the model can silently overwrite your API address, key, or prompt configuration. Luker separates the connection fields from the generation parameters, letting you freely combine different LLM backends with different prompt presets.

→ [Preset Decoupling](/improvements/preset-decoupling)

### Nothing Lost to a Closed Tab

Generation runs on the backend and streams to the UI, and saves happen on the backend as data changes reach the server. Reload the tab, close the laptop lid, or lose your Wi-Fi connection mid-reply: the generation keeps running on the server and reconnects to your UI when you return. Data changes are written with incremental patches rather than full overwrites, which also prevents concurrent writes from clobbering each other across tabs and devices.

→ [Backend Storage and Lifecycle](/improvements/backend-storage)

### Function Call Runtime

A unified function call / tool call runtime supporting two modes:

- **Native tool calls**: Compatible with native tool call formats from OpenAI, Claude, Gemini, and other APIs
- **Plain-text function calls**: Implements tool calls through a text protocol, suitable for models that don't support native tool calls

→ [Function Call Runtime](/improvements/function-call-runtime)

### CardApp

An embedded application runtime within character cards. Allows character cards to carry custom application logic, providing context APIs and lifecycle management.

→ [CardApp](/features/cardapp)

### Card-Bound Presets and Personas

Character cards can bind dedicated chat completion presets and user personas. Bound presets and personas are independent of the global list, won't pollute the user's global configuration, automatically disappear when the character card chat is closed, and can be imported/exported with the character card. Card creators no longer need to ask users to manually import dedicated presets.

→ [Card-Bound Presets and Personas](/improvements/card-bound-presets)

### Request Inspector

A per-user generation request diagnostic tool that can trace request details for all backends (including image generation and vector embedding / rerank calls), making debugging and troubleshooting easy.

→ [Request Inspector](/improvements/request-inspector)

### Authentication and Quotas

Supports GitHub / Discord OAuth login. Administrators can configure storage quotas for each user. Discord login can additionally require users to be members of a specific server or hold specific roles.

→ [Authentication and Quotas](/improvements/auth-and-quota)

::: tip More Features

- **Backups, storage, and migration** — [back up and restore](/features/user-settings-additions) by data category, inspect [server-side](/features/storage-inspector) and browser-side storage, and move a whole setup to a new device over the LAN.
- **Structured data for card authors** — [per-message variables](/features/variable-op-log) and the [state system](/features/state-system).
- **Troubleshooting** — a [log viewer](/features/logging) with frontend and server sources, plus a one-click debug export.
- **Day-to-day comforts** — [immersive mode, mobile background keep-alive, desktop notifications, lazy media loading](/features/user-settings-additions), undo toasts, per-chat persona locks, collapsible groups for presets and prompts, model lists loaded live from the provider, World Info activation tracing, preset-associated World Info, and plugin-registered regex rules.
:::

## Compatibility

Luker maintains full data format compatibility with SillyTavern:

| Data Type | Compatibility |
|---------|--------|
| Character Cards (PNG/JSON) | ✅ Fully compatible, bidirectional import/export |
| World Info / Lorebook | ✅ Fully compatible |
| Chat Logs | ✅ Fully compatible |
| Chat Completion Presets | ✅ Fully compatible |
| Third-party Extensions | ✅ Compatible, with isomorphic-git fallback support |
| User Settings | ✅ Fully compatible |

::: info Bidirectional Migration
You can migrate from SillyTavern to Luker at any time, and vice versa. Data generated by Luker-exclusive features (such as Memory Graph, orchestration configs, etc.) is stored in separate state files and won't affect SillyTavern's core data structures. However, it's still recommended to back up your data before migrating.
:::

## Next Steps

Ready to get started?

→ [Getting Started](/guide/getting-started) — Install and deploy Luker
