# Improvements Overview

Luker changes how SillyTavern saves data, organizes presets, handles generation requests and supports extensions. This page explains what those changes solve and how they affect everyday use. Configuration steps live on their own pages.

## At a glance

| Area | Improvement | Problem it solves |
| --- | --- | --- |
| Architecture | [Preset decoupling](/improvements/preset-decoupling) | Switching presets no longer swaps the API connection |
| Architecture | [Incremental sync](/improvements/incremental-sync) | Saves send only what changed, reducing traffic and conflicts |
| Architecture | [Backend storage](/improvements/backend-storage) | Changes reach disk immediately; a browser crash does not lose them |
| Feature | [Function-call runtime](/improvements/function-call-runtime) | Native and text-only models can both call tools |
| Feature | [Card-bound presets and personas](/improvements/card-bound-presets) | A card carries the generation setup its author recommends |
| Feature | [Request inspector](/improvements/request-inspector) | See each request's input, output and token usage |
| Feature | [Preset-associated World Info](/improvements/preset-world-info) | Switching a preset activates its world book |
| Feature | [Skills](/features/skills/) | Long prompts become knowledge packs read on demand |
| Infrastructure | [Unified generation layer](/improvements/generation-layer) | Every backend shares one request pipeline |
| Infrastructure | [Performance](/improvements/performance) | Faster startup, loading and daily use |
| Infrastructure | [WebSocket proxy](/improvements/ws-proxy) | Generation survives unstable networks |
| Infrastructure | [Auth and quotas](/improvements/auth-and-quota) | Login and capacity management for shared instances |
| Infrastructure | [Other improvements](/improvements/other) | Connection management, grouping, live model lists and more |

Memory Graph, multi-agent orchestration, the Character Editor Assistant, Search Tools and CardApp are Luker-specific features; see [Unique Features](/features/memory-graph).

## Architecture

### Preset decoupling

SillyTavern keeps API connection settings and generation presets in one object. Switching model or provider also changes sampling and prompt settings; adjusting sampling can affect the connection.

Luker separates them: a **connection profile** decides where requests go, and a **preset** decides how they are generated. Any preset can pair with any connection, and the reverse. Card-bound presets and the Connection Manager build on this split.

See [Preset decoupling](/improvements/preset-decoupling).

### Incremental sync

Traditional saves send the whole object. The longer the chat, the more data each save carries, and concurrent writes are more likely to overwrite each other.

Luker sends only what changed: appended messages, patched messages and merged metadata. After writing, the server verifies integrity and refuses to overwrite a concurrent change. Settings use the same incremental approach with conflict detection.

See [Incremental sync](/improvements/incremental-sync).

### Backend storage

Some SillyTavern data is saved only when the frontend triggers it, leaving a window where an action has happened but is not on disk. If the process exits unexpectedly, those changes are lost.

Luker moves saving to the server: data is persisted when it arrives, and the frontend no longer decides when to save. Chat writes are serialized, so group chats and concurrent edits do not corrupt each other, and generation results are acknowledged after they are recorded. Automatic chat backups can be configured.

See [Backend storage](/improvements/backend-storage).

## Features

### Function-call runtime

Models differ in tool support. Some return structured calls natively; others can only write the intent in text.

Luker provides one runtime for both: native tool calling where available, and prompt-guided parsing where it is not. Plugins and users see the same tools either way, and text mode has its own toggle and retry settings per connection.

See [Function-call runtime](/improvements/function-call-runtime).

### Card-bound presets and personas

A card author knows which settings make the character perform best. A card can carry a recommended preset and a default persona; loading the card applies them, and leaving restores the previous setup. Bound presets are marked in the selector and travel with the card.

See [Card-bound presets and personas](/improvements/card-bound-presets).

### Request inspector

To see what a generation actually sent and how many tokens it used, open the request inspector. It records input, output, duration and token usage for streaming replies, image generation, embeddings and reranking. Token accounting is separate from storage quotas.

See [Request inspector](/improvements/request-inspector).

### Skills

Orchestrator system prompts grow as rules accumulate. Skills split reusable writing rules, review methods and workflows into knowledge packs that agents read by name when needed.

Skills can ship with a card or preset, so the recipient does not install them separately. Director's default profile already uses them. See [Skills overview](/features/skills/) and [Authoring Skills](/features/skills/authoring).

## Infrastructure

### Unified generation layer

Each AI backend used to implement its own request path, so feature support differed. The unified layer centralizes request handling, giving every backend the same token accounting, streaming, error handling and generation acknowledgement. The request inspector and usage figures behave the same regardless of provider.

See [Unified generation layer](/improvements/generation-layer).

### Auth and quotas

On a shared instance, an administrator can enable GitHub or Discord login, set storage quotas per user, and review server activity in the logs. OAuth is configured in the admin panel, not by editing files.

See [Auth and quotas](/improvements/auth-and-quota).

### Other improvements

Connection management, the WebSocket proxy, HTTP proxy, preset and prompt grouping, undo toasts, live model lists, extension hook ordering, character and preset state, and startup performance are collected in [Other improvements](/improvements/other).
