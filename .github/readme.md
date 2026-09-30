<a name="readme-top"></a>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/hero-dark.png">
  <img alt="Luker — Next-Generation Roleplay Chat Platform" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/hero-light.png">
</picture>

<div align="center">

**English** | [Deutsch](readme-de_de.md) | [简体中文](readme-zh_cn.md) | [繁體中文](readme-zh_tw.md) | [日本語](readme-ja_jp.md) | [Русский](readme-ru_ru.md) | [한국어](readme-ko_kr.md)

[![GitHub Stars](https://img.shields.io/github/stars/funnycups/Luker.svg?style=flat)](https://github.com/funnycups/Luker/stargazers)
[![GitHub Forks](https://img.shields.io/github/forks/funnycups/Luker.svg?style=flat)](https://github.com/funnycups/Luker/forks)
[![GitHub Issues](https://img.shields.io/github/issues/funnycups/Luker.svg?style=flat)](https://github.com/funnycups/Luker/issues)
[![License](https://img.shields.io/github/license/funnycups/Luker.svg?style=flat)](../LICENSE)
[![Docs](https://img.shields.io/badge/docs-luker.cups.moe-orange?style=flat)](https://luker.cups.moe)
[![Android APK](https://img.shields.io/badge/download-Android%20APK-3ddc84?style=flat&logo=android&logoColor=white)](https://github.com/funnycups/Luker/releases)

</div>

---

Luker is a next-generation roleplay chat platform. Chat with characters who remember what happened, whose scenes are planned by a director-led ensemble of agents before every reply, whose cards you edit by talking to an AI, and who can search the web mid-conversation.

## What is Luker

Luker is a purpose-built environment for roleplay with large language models. It ships a graph-based long-term memory, a multi-agent scene planner with a reusable skill library, an AI-assisted character-card studio, a preset assistant, native LAN sync, and a real Android app that runs the whole backend on your phone — all in one install, no third-party extensions required.

Luker is built on [SillyTavern](https://github.com/SillyTavern/SillyTavern) and stays **100% data-compatible** with it. Character cards, world info, presets, and chats move both ways with zero migration cost.

## Highlights

### Memory Graph — your characters actually remember

A knowledge-graph long-term memory. Every scene distills into typed nodes (characters, locations, events, plotlines) with links between them. Before each reply, a recall pass walks the graph and injects the most relevant memories — so when the user asks about "the third route to the ruined shrine" thirty turns later, the character brings up the exact conversation from earlier.

![Memory Graph demo](https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/memory-graph-demo.gif)

→ [Memory Graph documentation](https://luker.cups.moe/features/memory-graph)

### Multi-Agent Orchestrator — a director-led ensemble plans every reply

Before the writer LLM ever speaks, a configurable ensemble of agents runs first: a distiller condenses recent context, a planner sketches the next scene, a critic reviews. The final reply arrives with a runtime trace you can inspect. Choose one of five execution modes — Spec (a fixed pipeline), Single Agent, Agenda (the flow dispatches agents dynamically), Loop (a single agent iterates on tool calls until the task is complete), or Director (a main agent plus a sub-agent team writes the message body directly).

![Orchestrator demo](https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/orchestrator-demo.gif)

→ [Orchestrator documentation](https://luker.cups.moe/features/orchestrator/)

### Skills — reusable knowledge packs, loaded on demand

Reusable knowledge packs an agent reads on demand: writing rules, voice conventions, anti-cliché checklists. The format is compatible with Anthropic's Claude Skills, so a skill written for Claude Code can be moved into Luker and back without modification. The orchestrator's default Director profile ships with 24 bundled skills, and skills can be distributed with a character card or a preset.

<img alt="Skill manager with installed and bundled skills" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/_screenshots/skills/manager-installed-tab.png" width="720">

→ [Skills documentation](https://luker.cups.moe/features/skills/)

### CardApp Studio & AI Card Editor — edit cards by talking to an AI

A full IDE for character cards with a CodeMirror-6 editor, an AI chat panel, and diff-based approval for every batch of changes. Regular cards get the popup editor; cards with an embedded **CardApp** — a card-hosted mini-application — open in the full Studio with file tree, live preview, and history.

![CardApp Studio demo](https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/cardapp-studio-demo.gif)

→ [Card Editor Assistant](https://luker.cups.moe/features/card-editor/) · [CardApp Studio](https://luker.cups.moe/features/card-editor/studio)

### Preset Assistant — build a preset from a description

Tell the assistant what you want a chat-completion preset to do. It iterates on the preset with you, one diff at a time, until it matches — reading parameters, editing prompt entries, and comparing against a reference preset. The same workflow covers orchestrator presets.

<img alt="Preset Assistant" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/preset-assistant/cpa-overview.png" width="720">

→ [Preset Assistant documentation](https://luker.cups.moe/features/preset-assistant)

### Native Android APK — the full platform on your phone

The Luker backend runs *inside* an Android app. Install the APK, open it, and you get the full server plus UI on a single device — no Termux, no manual Node install, no port forwarding. Backup ZIP import in the first-run screen makes migration painless.

![Android APK demo](https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/android-apk-demo.gif)

→ [Android app guide](https://luker.cups.moe/guide/android)

### Search Tools — characters can search the web

Give the writer LLM a live web-search tool (DuckDuckGo, SearXNG, Brave), or run a pre-request search agent that writes results into world info before the reply starts. Backed by real search engines, not just a training-data lookup.

→ [Search Tools documentation](https://luker.cups.moe/features/search-tools)

### LAN Sync

Pair two Luker instances on the same network. Chats, cards, world info, and settings sync between them, so your desktop and your phone stay in step without pushing anything to a cloud.

→ [LAN Sync guide](https://luker.cups.moe/improvements/lan-sync)

### Chat merge & split

Split a long chat at any turn or merge two chats into one; branch history stays consistent. Useful when a scene got out of hand and you want to fork off the interesting parts without losing the rest.

<img alt="Chat merge & split" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/screenshots/chat-merge-split/07-split-dialog-three-segments.png" width="720">

→ [Chat management](https://luker.cups.moe/basics/chat-management)

### TTS NPC dialogue attribution

With TTS enabled, every quoted line in a reply can play with its own speaker's voice. A background pass works out who says each quote — NPCs it discovers appear in the voice map automatically, and names you add in advance are recognized from the first playback.

<img alt="Per-quote play buttons in a chat message" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/screenshots/tts-npc-attribution/03-inline-buttons-zoom.png" width="678">

→ [TTS NPC dialogue attribution](https://luker.cups.moe/features/tts-npc-attribution)

### Change the model, keep your prompt setup

In SillyTavern, API connections and chat-completion presets move together, so switching to a different model drags your prompt configuration along with it. Luker decouples the two: swap the model without rebuilding your prompt setup, swap the preset without touching your API keys.

### Close the tab — the reply keeps writing

Generation runs on the backend, streamed to the UI over WebSocket. Reload the tab, close the laptop lid, lose Wi-Fi — the reply keeps writing on the server and reconnects to your UI the moment you're back. Nothing is lost, nothing has to restart.

→ [Backend storage & lifecycle](https://luker.cups.moe/improvements/backend-storage)

---

A long tail of smaller conveniences rounds it out — grouping for presets and prompts, per-chat persona locks, undo toasts, a trace of which World Info entries fired and why, model lists fetched live from each provider. All of them are documented on the [docs site](https://luker.cups.moe).

## Screenshots

<table>
  <tr>
    <td width="50%"><img alt="Memory Graph inspector" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/memory-graph/memory-graph-view.png"></td>
    <td width="50%"><img alt="Orchestrator runtime trace" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/orchestrator/orch-runtime-trace.png"></td>
  </tr>
  <tr>
    <td width="50%"><img alt="CardApp Studio workspace" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/cardapp-studio/studio-overview.png"></td>
    <td width="50%"><img alt="Preset Assistant" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/preset-assistant/cpa-overview.png"></td>
  </tr>
</table>

## Getting Started

- **Desktop (Node.js)** — `git clone https://github.com/funnycups/Luker.git && cd Luker && npm install && node server.js`. Requires Node.js 24 or newer. → [Getting Started](https://luker.cups.moe/guide/getting-started)
- **Android APK** — grab the latest signed APK from the [Releases](https://github.com/funnycups/Luker/releases) page and install. → [Android app guide](https://luker.cups.moe/guide/android)
- **Docker** — `docker compose up` using the compose file in the repository root. → [Getting Started](https://luker.cups.moe/guide/getting-started)

## From SillyTavern?

Luker is 100% data-compatible with SillyTavern in both directions. Copy your `data/` folder over and you're done — cards, world info, presets, chats, personas, settings. Global third-party extensions are stored outside `data/`, in `public/scripts/extensions/third-party/`, so copy them separately. If you decide to go back, copy it in the other direction; Luker-exclusive data (memory graphs, orchestrator configs) sits in separate state files that SillyTavern ignores. **Back up before you migrate anyway.**

→ [Migration guide](https://luker.cups.moe/guide/migration)

## Community & Feedback

- Bug reports and feature requests: [GitHub Issues](https://github.com/funnycups/Luker/issues)
- Read the docs before opening an issue: [luker.cups.moe](https://luker.cups.moe)

## Contributing

Pull requests welcome. See [CONTRIBUTING.md](../CONTRIBUTING.md) and please search existing issues before filing a new one.

## License and Credits

Licensed under **AGPL-3.0**. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; see the [GNU Affero General Public License](../LICENSE) for details.

- Built on **SillyTavern** by Cohee, RossAscends, Wolfsblvt, and 300+ contributors: <https://github.com/SillyTavern/SillyTavern>
- [TavernAI](https://github.com/TavernAI/TavernAI-v1) 1.2.8 by Humi (MIT License)
- Portions of CncAnon's TavernAITurbo mod used with permission
- Visual Novel Mode inspired by [PepperTaco](https://github.com/peppertaco/Tavern/)
- Noto Sans font by Google (OFL license)
- Lexer/Parser by [Chevrotain](https://github.com/chevrotain/chevrotain) (Apache-2.0)
- Icon theme by [Font Awesome](https://fontawesome.com) (Icons CC BY 4.0, Fonts SIL OFL 1.1, Code MIT)
- Default character content by @OtisAlejandro (Seraphina) and @kallmeflocc
- Docker guide by [@mrguymiah](https://github.com/mrguymiah) and [@Bronya-Rand](https://github.com/Bronya-Rand)
- kokoro-js library by [@hexgrad](https://github.com/hexgrad) (Apache-2.0)

## Top Contributors

[![Contributors](https://contrib.rocks/image?repo=funnycups/Luker)](https://github.com/funnycups/Luker/graphs/contributors)
