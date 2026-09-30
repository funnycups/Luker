# Changelog

This changelog covers every Luker release, from v1.0.0 to the current development version. Entries for released versions come from the GitHub release notes; the Unreleased section tracks the upcoming version.

## Unreleased

### Multi-Agent Orchestrator

- **Added two built-in director presets** with per-mode preset help and one-click import.
- **Skills can now be bound to orchestration presets**, and the binding survives renames, deletions, and exports.
- **Director, loop, and agenda agents can edit their own system prompts** with find-and-replace tools.
- **Custom tools can now be authored and test-run inside the iteration studio.**
- Each preset can define a world info filter that applies wherever agents read the book.
- Spec and agenda agents now read Open Notes.
- User regex now applies to what agents read and what they output.
- Raised agent round limits and removed hidden upper bounds from configurable settings.
- Reworked the orchestrator settings drawer into Agents, Tools & Skills, and General tabs, and all changes save automatically.
- Improved the run panel with per-agent timers and auto-collapsing finished rounds in simulation review.
- Stopping a run now halts immediately instead of waiting for the current round to end.
- Fixed stale preset selections after creating or renaming presets, and global iteration saves no longer resurrect deleted agents.

### Memory Graph

- **Added a graph revision studio** where the AI proposes changes as reviewable diff cards with rollback.
- **Added thread nodes** that track long-running plotlines.
- Extraction gains a crawl mode: it first explores the graph structure and starts from a rough outline, saving prompt tokens.
- Simplified recall to LLM and RAG modes, with optional rerank and query rewrite.
- Recall is now balanced across node types, so one dominant type no longer crowds out the rest.
- Always-injected nodes that age out of their window fall back to normal recall instead of being dropped.
- Event extraction now separates what a character lived through from a mere mention, and merges symmetric relations into a single edge.
- Vector search now returns concrete leaf memories only.
- User regex now applies to the text extraction reads.
- Reorganized the settings drawer into Recall, Extract, Graph, and Advanced tabs, with field help throughout.
- Fixed empty replays wiping the graph, stale vectors leaking after a chat reset, and read failures going unreported.

### Character Card Editor (CardApp Studio)

- Fixed a batch of card-editing reliability issues: applied edits no longer roll back on their own, the rollback button works again, and duplicate diff cards are gone.

### Iteration Studio

- **Sessions in all four studios now persist and replay tool calls and results across reloads.**
- **Tool calls render as diffs**, and message cards show the assistant's thinking.
- **Regenerating a step now undoes its already-applied edits first**, and every user message gains an Edit button.
- The AI now reads only the fields it needs instead of reading everything up front, and failed edits come back with a clear diagnosis.
- Failed tool calls now return the real error and reason instead of silently doing nothing.
- Session histories moved to per-character storage, and closing a popup flushes pending changes immediately.

### Presets & Prompt Manager

- **A card can now bind multiple chat completion presets**, with a default and a clear-all control.
- **Prompts can attach to an existing message** instead of only relative positions.
- Preset-scoped world info now survives export and import.
- Prompt entries can be dragged into existing groups, and sub-group rendering is fixed.
- Plugin prompt structure is reworked for prompt-cache reuse, making repeated requests faster and cheaper.
- The connection manager warns when Claude prompt caching is combined with squashing post-processing.
- Edits to a card-bound preset are saved back to the card instead of being lost.
- Deleting a preset now purges its associated state everywhere.

### Connections & Models

- **Each connection profile can now set its own request timeout and retry policy.**
- **Added an OpenAI Responses chat completion source.**
- Kimi gains partial prefill and correct reasoning forwarding.
- Added support for the newer Claude 5 and Opus 4 models, and dropped obsolete beta flags that blocked Bedrock.
- Advanced request settings fold into a collapsible drawer.
- Google AI Studio now retries when a request is blocked by safety filters instead of failing, and Vertex model listing is fixed.
- The model picker no longer picks a wrong option or fabricates options.
- Fixed profile switching overwriting the model field.

### Generation & Streaming

- **Chat completions, text completions, NovelAI, Kobold, and image generation all run through a unified pipeline**, fixing generation under Bun.
- **Claude thinking blocks persist and replay across turns**, and DeepSeek and OpenRouter reasoning content is preserved the same way.
- Stop requests reach providers immediately, so a ComfyUI image job can be interrupted mid-run.
- Token counting and token encoding are configured independently.
- Recovered generations reconnect to the live stream.
- Token counting moved off the main thread so long prompts no longer freeze the UI, and more tokenizers are bundled locally.
- Upstream errors now arrive as proper error responses instead of hanging streams, and error text is no longer truncated mid-message.
- Empty responses are retried automatically, while Gemini safety blocks are not retried.
- WebSocket delivery no longer duplicates streamed text after reconnects, and large payloads are no longer capped.

### Chat & Characters

- **Card replacement now shows a structured full-screen diff overview.**
- **Chats can be merged in a chosen order or split at chosen points.**
- Streaming token usage is reported and normalized across providers.
- Chat search now covers older messages that are not loaded yet.
- Pending chat saves now flush on page unload, save conflicts recover automatically, and save failures show the server error.
- Chat file names no longer accumulate duplicate extensions.
- Rapid character switching no longer writes to the wrong chat.
- Reasoning blocks are saved or discarded cleanly when editing a message.
- Character saves surface real errors, and embedded lorebooks survive edits and world deletion.

### World Info

- **Reworked mobile World Info editing** with a cleaner layout that survives viewport switches.
- Lorebooks embedded in a card stay bound across reloads, and deleted entries stop leaking into exports.
- World books with array-form entries import and edit correctly.

### Request Inspector

- **Reasoning content, thinking blocks, and signatures now render as styled blocks** in the request and response views.
- The upstream native finish reason is displayed alongside the normalized one.
- Vector embedding and rerank requests are captured alongside chat requests.
- Non-streaming requests and early failures are captured too, and streamed responses are inspected chunk by chunk.

### Storage & Sync

- **Added SQLite, MySQL, and PostgreSQL storage engines** with an admin migration panel and resumable migrations.
- **The Backup Manager now converts backups between storage modes.**
- Added server-side and browser-side storage inspectors with subdirectory browsing.
- Restore archives upload in chunks with retry and resume.
- LAN Sync streams data directly.
- Migrations between file-system and database backends preserve chat integrity and timestamps.
- Deleting a chat or character now reclaims its media files.
- Unsafe file names are now rejected before being written to storage.

### TTS

- NPC dialogue lines are now attributed to their speaking character, with per-quote playback.

### Search Tools

- The pre-request agent no longer collides with world info operations.
- Injection depth and role fields now hide when the entry position is not At Chat Depth.

### UI & Mobile

- **Android gains shareable crash diagnostics and an automatic safe mode** that disables third-party extensions after a crash loop.
- Android cold start is faster, and debug builds can upgrade in place over release builds.
- The iOS keyboard no longer breaks the viewport layout.
- Fixed Android viewport-height and full-width layout quirks.

### Authentication & Users

- New OAuth accounts start with the provider profile picture, OAuth-only accounts reject password login, and debug export details are admin-only.

### Internationalization

- The lazy-load media setting, admin panel values, and the swipe picker now ship with Simplified and Traditional Chinese translations.

### Platform

- Now tracks SillyTavern 1.19.0.

### Completion Preset Assistant

- **The iteration workbench can import an existing chat to work from.**
- Edit conflicts and already-applied operations are now reported instead of being silently dropped.

### Background Keep-Alive

- Added a mobile keep-alive toggle using picture-in-picture or audio so off-screen generations keep running, with audio playing only while generating.

### Extension API

- Added character state read, patch, and batch-get helpers, saveChatDebounced, and lookup APIs for recall results and inline memory-graph UI.
- Character replacement world book decisions now run in the core replace flow.

## v2.7.0 (2026-06-13)

### Multi-Agent Orchestration

- Added preset libraries — each mode (spec / agenda / loop / director) can hold multiple presets across global and per-character scopes, and legacy single-slot config migrates into the default preset on first open.
- Added a run panel that slides in beside the chat (or up from the bottom on mobile) the moment a run starts, streams reasoning, text, tool calls, and sub-agent activity in real time, can be reopened from a floating pill after dismissal, and shows accumulated token totals in the header.
- Retired the old runtime-trace popup — the run panel takes over everywhere.
- Sub-agents can now use regex to precisely locate matches and get line-level output across chat history, world-info entries, SKILL files, and the director's in-progress draft.
- Iteration studio in the global scope can now read and write world info.
- The completion-preset assistant's orchestrator-adaptation mode now performs a structural sanity check that flags agent-identity content, SKILL references, and jailbreak response-shape verbs landing on the wrong layer.
- Fixed the director-mode stop button so clicking it halts between tools and during sub-agent waits instead of waiting for round boundaries; a fast stop followed by regenerate no longer starts two agents writing to the same slot.
- Improved text-selection marker performance in the simulation popup.
- Fixed the Clear Character Override and Reset to Defaults buttons.

### Character Editor Assistant

- Unless the user explicitly names them, the AI no longer writes into the scenario, system prompt, or post-history instructions fields — content is steered into world info instead.

### Iteration Studio

- Diff cards for individual changes now render consistently across every popup.
- Brighter palette closer to GitHub's.
- Improved iteration studio prompts.

### Memory Graph

- Memory Graph commits are now correctly anchored at the operation's trigger floor.

### Performance

- Long-prompt token counting no longer blocks the UI.
- Improved chat-view and prompt-manager performance.
- Made the startup version check non-blocking so a slow network can't freeze startup (thanks to @1362278443 for the PR).

### Fixes

- The one-click debug export bundle now ships the full request-inspector history.
- Floor state no longer gets stuck on a broken history log — the broken floor and its sibling commits are truncated, the bad portion is archived as an orphan log, and earlier floor state is preserved intact.
- Fixed the world-info drawer resetting after toggling entries.
- Fixed the Claude backend prompt cache when system content is merged into the first user message by post-processing.
- If the uploads directory is deleted after startup, uploads no longer fail permanently; the directory is recreated when needed.

### Default SKILL

- Anti-cliché SKILL adds a new numeral + classifier ban.

### Documentation

- Added agent preset documentation.
- Added documentation on authoring custom orchestration tools.
- Added a recipe "Customize per-card orchestration" walking through three actions — generate a card-specific orchestration from one sentence, use simulation and annotation to mark clichés and unexpected output so the studio can refine the orchestration, and have the AI write a custom tool that validates output format.

### New Contributors
* @1362278443 made their first contribution in https://github.com/funnycups/Luker/pull/12

**Full Changelog**: https://github.com/funnycups/Luker/compare/v2.6.1...v2.7.0

## v2.6.1 (2026-06-07)

### Search

- Stop gating orchestration tools on plugin enabled/preRequestEnabled flags

**Full Changelog**: https://github.com/funnycups/Luker/compare/v2.6.0...v2.6.1

## v2.6.0 (2026-06-07)

### Highlights

- Added a new Skill subsystem: capture reusable writing methods, character voices, anti-trope rules, and curation playbooks as SKILL.md files, save them per global / character / preset scope, mount them per sub-agent as chips inside the orchestrator, and have the runtime inject the matched skill directory into the agent's context; ships with 21 bundled Chinese-language creation skills (character voice, story brainstorming, anti-trope, memory curation, and more), can be authored interactively from the iteration studio or the completion-preset assistant dialog, and is included when characters or presets are exported and imported.
- Added a custom-tools system for the orchestrator: register your own tools for the AI to call across all four modes (Agenda, Spec, Director, Loop), with the built-in memory, web search, and preset management exposed as opt-in tools, per-agent override panels for selecting which tools are enabled, and an inline review flow for tools embedded in imported character cards.
- Added a simulation review popup: clicking "simulate" in the orchestrator or in the character / preset assistants now actually runs a real quiet generation and shows the full agent chain, the final output, and the world-info entries that fired; you can highlight text to add inline annotations, re-run with one click, and the annotations flow back into the studio AI as guidance for the next iteration. Write tools are sandboxed during simulation so nothing leaks into real data.

### Multi-Agent Orchestration

- Added lorebook write tools inside the iteration studio: the AI can disable or rewrite world-info entries on the active character, every change lands as a diff card you approve or reject one by one, and only the approved set is committed when you press Apply.
- Added a per-sub-agent cap on tool-call rounds in Director mode: critic-style sub-agents can stay tight at one or two rounds while memory-scout-style sub-agents get a wider budget.
- Added an enable / disable toggle next to each mode's character-override config, so you can temporarily fall back to the global config without deleting the whole override.
- Extended the reasoning trace to Spec, Agenda, and Loop modes, so Claude thinking, OpenAI o1, and similar reasoning content now show up there too.
- Runtime trace now pairs each tool call with its result inline under args / result / error labels instead of scattering them across the timeline.
- Hardened sub-agent identity framing: sub-agent prompts are reshuffled into a four-section meta frame so they stop drifting into "let me continue the scene as the character" because of trailing role directives.
- Fixed character-override config in Director mode silently appearing not to save.
- Fixed sub-agents not seeing the in-flight draft on round one, which caused critics to give feedback against the wrong revision.
- Fixed memory-graph write rejections being swallowed: the AI now sees the actual failure reason instead of retrying forever.
- Fixed memory entries extracted from a deleted message lingering and being re-injected after a regenerate.
- Fixed the orchestrator not forwarding the in-flight floor when writing to memory-graph, which caused commits to land on empty placeholders.

### Character / preset assistants (CEA / CPA)

- The preset assistant's "orchestrator optimize" pass now moves rewritten guidance entries before the Chat History prompt by default, leaving only the jailbreak / unlock-style ones at the tail.
- Refined the preset assistant's guidance on managing prompt order inside presets, giving the AI better control over RP output shaping when revising a preset.
- Fixed the iteration dialog's Stop button giving no feedback on slow connections — it now turns disabled immediately and surfaces the abort state.

### Client-side tokenizers

- Moved the JSON tokenizers for OpenAI, Claude, and the HuggingFace family fully to the browser, so the live token counter next to the chat input responds without a server round-trip.
- Extended client-side tokenization to more sentencepiece model families: gemma, gemini, llama, mistral, yi, jamba.
- Arbitrary custom model names (OpenRouter IDs, private-deployment aliases, and so on) are matched to the right tokenizer, falling back to the server only when nothing matches.
- Inactive per-chat token caches are evicted on chat switch, keeping memory flat across long sessions.

### Immersive mode & mobile

- Immersive mode state now persists across reloads and restarts, syncing with the account between the web client and the Android app.
- Added a "Keep top bar in immersive mode" toggle in user settings; with it on, the chat area resizes to leave room for the bar instead of overlapping it.
- Added a floating exit button in the top-right when immersive mode is on and the top bar is hidden, primarily so iOS users without Esc / a back key can still leave immersive mode.
- Improved Android back-button behavior: a user-toggled immersive mode no longer gets forced off by the back key; the back key now closes open popovers and dialogs first; inside a chat, the back key first closes the current chat back to the welcome page, and a second press is required to actually exit the app.
- Fixed the Android app flagging a user-initiated exit as a previous-session crash and showing the crash report dialog on next launch.
- Improved Android crash capture so JVM uncaught exceptions and WebView renderer crashes actually carry a stack trace into the next-launch crash report.
- Replaced the system DownloadManager with in-app streaming for same-origin downloads in the Android client, with a progress notification and a failure-reason toast, fixing the case where the logged-in session was isolated from DownloadManager and the backup download failed.

### Third-party extensions

- Installing extensions from github.com/funnycups/ no longer triggers the "third-party extension" security warning.
- Translated the full third-party extension install confirmation dialog (title, "Yes, install" / "No, cancel" buttons, "don't show again" option) into Simplified and Traditional Chinese.
- Fixed cross-load-order regressions when multiple extensions are enabled together — combinations like ST-Prompt-Template alongside JS-Slash-Runner now render correctly.

### Backup & files

- The user-backup restore dialog now streams progress through analyze, snapshot, and per-file extract phases (file X / Y with a percent) instead of sitting on a static "restoring" message.
- Fixed imports of character-card world-info whose names had leading or trailing whitespace: they no longer open an empty editor or show misaligned entries.

### Interface polish

- The regex extension panel now lets you collapse and expand the Preset, Global, Character, Chat, and Scoped sections independently.
- The prompt manager and the regex script list no longer accumulate memory from leftover drag bindings during long sessions.

### Other fixes

- Fixed streaming replies from multiple OpenAI-compatible sources being parsed against shared global state when several chat completion sources were active.
- Fixed the Takeover plugin carrying the previous swipe's text and reasoning into a regenerated reply.
- Fixed the Takeover plugin losing reasoning and other extras when an over-swipe past the last slot was regenerated.
- Fixed the per-message variables feature not recognizing variable shorthand: <span v-pre>`{{.x = v}}`</span>, <span v-pre>`{{.x++}}`</span>, <span v-pre>`{{$g}}`</span>, <span v-pre>`{{.x ??= 1}}`</span> now leave no literal in the message and are logged as reads or writes.
- Fixed memory-graph failing to load when its data was corrupted: orphan nodes are now auto-pruned, state can recover from the backup snapshot, and the obsolete "chat change detected, will re-sync on next generation" toast was removed.
- Fixed the connection manager attempting to sync a field that no longer exists.

### Documentation

- Added trilingual extension-API docs under docs/development/extension-api/ covering character-overrides, the Skill iteration-studio surface, and the full character-editor-assistant API; the repo also picked up a lint that forbids plugins from importing each other or the core directly — they must go through the three-layer getContext() / getExtensionApi() surface.

**Full Changelog**: https://github.com/funnycups/Luker/compare/v2.5.1...v2.6.0

## v2.5.1 (2026-05-27)

### Multi-Agent Orchestration

- Improved the default prompts for agents recalling from the memory graph in Director mode.

### Fixes

- Fixed the model remaining unchanged after switching OpenRouter API connection configurations.

**Full Changelog**: https://github.com/funnycups/Luker/compare/v2.5.0...v2.5.1

## v2.5.0 (2026-05-27)

### Presets & help guides

- Added "Plugin Only" presets, separating role-playing settings (character design, character cards, scenes, worldbook, dialogue examples) and plugin task channels into two independent sections. Plugin commands are no longer treated as part of the AI's plot.
- Added a "?" help button next to all preset selectors: Plugin and Iterative AI presets can be imported into "Plugin Only" presets with one click; Multi-Agent presets will redirect to the Multi-Agent Getting Started Guide.
- The preset assistant's jailbreak mode also teaches the AI this section division, and generated jailbreak presets follow the new conventions.

### Preset iteration

- Expanded the range of fields that the Iterative AI can directly modify. Fields such as tool calls, agent-related switches, sampling, and multimodal can now be adjusted by the AI according to user intent.
- Added a "?" help button next to the "Reference Preset" selector, explaining what a reference preset is and when to select "None".

### Memory Graph

- Rewrote the event summary writing guidelines with a numbered outline format, category grouping by action type, and no quotation marks or repeated details, producing significantly shorter and more focused summaries.
- Event compression now merges different objects that share the same subject and action into one topic, eliminating mechanical item stacking. <!-- banned-words-allow --> <!-- banned-words-allow -->
- Extraction now requires the AI to check existing nodes in the graph one by one before creating or editing characters and locations, reducing redundant creation. <!-- banned-words-allow -->
- Fixed the issue of the memory graph following when creating branch chats.

### Multi-Agent Orchestration

- The memory curation module now uses the new event summary guidelines and topic merging rules, keeping its quality consistent with the memory graph.
- Fixed the issue where the Director orchestration panel displayed "No running track in the current chat" after switching chats.

### Documentation

- Improved the Agent Getting Started Guide.

### Platform & experience

- User settings now show the compatible SillyTavern version, making it easy to check version differences.
- Status bar and navigation bar colors in the Android app now follow the theme color scheme instead of clashing with it.
- Data backup import now displays the upload progress percentage and processing status.

### Fixes

- Fixed an issue where the send button was truncated on mobile devices in the AI iteration popups (Chat Completion Preset Assistant, Character Card Editor, Orchestrator, Memory Graph).
- Diff cards in AI iteration popups now collapse by default, long history entries no longer vertically fill the page, and mobile devices no longer hit the WebView drawing layer limit.

### Performance

- Fixed long stuttering when STscript parses long parameters (extremely long base64, commands containing many pipes).

**Full Changelog**: https://github.com/funnycups/Luker/compare/v2.4.1...v2.5.0

## v2.4.1 (2026-05-26)

- Fixed loading of the completion preset assistant.
- Gate agent dispatcher for orchestrator
- Fixed an issue in orchestrator sub-agents.

**Full Changelog**: https://github.com/funnycups/Luker/compare/v2.4.0...v2.4.1

## v2.4.0 (2026-05-25)

### Documentation

- Added a trilingual Recipes section, whose first walkthrough takes a new user end-to-end through a full multi-agent writing workflow: spinning up an agent-only preset, splitting main-writing and iteration onto separate API routes, handing memory-graph extraction/recall/compression off to sub-agents, wiring in a search engine, and finally fine-tuning everything in the AI iteration studio, with a companion minimal starter preset and step-by-step screenshots.

### Multi-Agent Orchestration

- Each agent (main agent plus the 12 built-in sub-agents) can now have its own tool permissions, inherit-or-override per agent, with default tool sets tailored to each sub-agent's role (the memory curator gets memory-write permission, the voice critic gets read-only chat access, and so on).
- Polished the runtime trace popup so you can now read each agent's reasoning per round / per dispatch, the director panel is now a two-column layout, and the overview cards report main-agent rounds and sub-agent dispatch counts.

### AI iteration popup (shared by CardApp Studio, Memory Graph, and the Orchestrator)

- Fixed the popup stalling after you reviewed a batch of pending AI changes — Apply / Discard now resumes the loop automatically, so the AI sees which changes you accepted or rejected and adjusts its next move accordingly.
- Fixed the AI not seeing whether the previous round's changes actually landed; feedback now reports how many succeeded, how many failed and why, and which fields on which entries actually moved, so the AI stops re-proposing the same failed change.
- Fixed inline code snippets being unreadable against tinted message bubbles.
- Fixed diff cards flashing large white blocks on narrow / mobile viewports when a round proposed many changes.

### Memory Graph

- Fixed the severe data loss introduced in v2.3.0: auto extraction, auto compression, manual Fill Missing / Rebuild Recent / manual compression, and every editor add/edit/delete all looked successful in the UI but silently rolled back to an earlier state on the next refresh or message regenerate.
- Fixed silent save failures — a failed save now raises a trilingual toast with the full context so you can screenshot and report it.
- Fixed the vector recall index re-embedding 50 nodes from scratch every time you switched chats or refreshed; incremental sync now actually stays incremental across reloads.

### Preset assistant

- Added identifier-keyed tools for precisely editing prompt entries inside a preset (replace / insert / delete on content, plus enable / disable toggles), so the AI no longer mis-edits the wrong entry from index drift or retries the same dead toggle because it was writing to the wrong field.
- Rewrote the orchestrator-optimize mode guidance to split "process coercion that poisons the agent's tool-call channel" from "safe final-output decoration", producing sharper suggestions, and removed the director-preset warning banner that was a false positive.
- Fixed the "clone current preset to a new preset" tool silently failing; the clone now goes through and switches to the new preset.

### Other

- Fixed the Luker update banner showing the English source string regardless of UI language.
- Fixed an occasional "Chat patch conflict" on chat save that previously needed an auto-retry to go through.
- Fixed the CardApp third-party `sendMessage` silent option not actually being silent — messages still entered chat history; it now genuinely runs quietly and returns the AI's reply as a string to the caller.

**Full Changelog**: https://github.com/funnycups/Luker/compare/v2.3.0...v2.4.0

## v2.3.0 (2026-05-25)

### AI iteration popup

- Add a unified AI iteration popup across the five plugins — Completion Preset Assistant, Memory Graph schema, agent orchestrator, character editor, and CardApp Studio — letting the AI rework the draft right inside the popup, with split-pane live preview, multi-round dialogue, per-message tool-call visibility toggle, regenerate and rollback, inline apply with diff, auto-continue keyed to whether the AI is still calling tools, lorebook read tools, and an extension-settings entry for viewing and editing each popup's AI system prompt.

### Documentation

- Rewrite a large batch of docs covering orchestrator notes, the iteration-studio framework dev guide, and the new memory-graph API chapters, with terminology unified and CJK punctuation normalized.
- Add per-page social-card metadata to every page on the docs site.
- Round out localization for the admin panel and the AI iteration popups.

### Multi-Agent Orchestration

- Redesign orchestrator notes as an author-voice plot-thread tracker for the AI.
- Add an intent-scout sub-agent that cross-references user intent and emits lorebook-authoring directives.
- Tighten director and memory-related sub-agent prompts so they coordinate better, follow field discipline, drill the right hierarchy, and now hard-fail on platform-frame leakage like meta-narration, substrate names, or "previous round" references.
- Rework the character-override editing flow and drop the old AI quick-build entry.
- Raise the per-task max rounds for sub-agents from 8 to 16.
- Drop the hard auto-continue cap so it follows the active context scope, and persist the finalize state.

### Memory Graph

- Add a memory-graph read-only API and a session-style extension API, so third-party extensions can read and write in one call with automatic version commit.
- Add memory-graph write and compaction APIs, a memory-curator sub-agent, and improve the built-in extraction quality.
- Improve event-summary extraction by unifying it under a 7-step reasoning template with a self-check fallback.
- Tighten the memory-generation prompts to ban author-voice tails and made-up psycho-state labels, and strengthen alias collection, relation normalization, and location-state field discipline.
- Adjust per-batch event policy so an event is required per batch, with default-skip only for stable-fact types.
- Speed up large-graph import on mobile.
- Decouple the main-context injection window from the recall candidate pool.

### CardApp & character editor

- Extend the variable system with path-based set/delete and push/pop ops, wired through slash commands, macros, the JS API, and Studio AI.
- Improve CardApp Studio file ops by batching them through a unified edit channel with per-round approval.
- Add a lorebook viewer, paging, search, and a mobile tab layout to the character editor.
- Let the character editor's AI tools read and write lorebook recursion fields directly.

### In-app announcements

- Add an in-app announcement system that admins can publish through, with the bell auto-hidden in single-user mode and tri-lingual usage docs included.

### Stability & observability

- Significantly improve chat-save reliability, fixing several intermittent message-loss, missing-event, and post-edit/delete save-conflict issues.
- Add automatic request retry with per-profile retry counts, benefiting both text and image generation.
- Dump in-flight requests on process exit and emit diagnostic reports on native aborts.
- Show each request's upstream endpoint and key fingerprint in the request inspector, and surface the outbound wire payload alongside source messages.
- Capture all console levels into the frontend log buffer regardless of debug mode, so the exported debug log is complete.
- Improve the takeover flow with three explicit terminal states — committed, aborted, discarded — and a live timer plus final token count on the bubble.

### Security & access

- Add an opt-in self-service registration entry.

### Other experience

- Expose Claude and Gemini prompt-cache toggles in the connection profile.
- Add a manual entry manager popup to the search tools for maintaining stored entries.
- Allow role-scoped filtering in the advanced lorebook keyword search.
- Default lazy character loading on for new users for a faster startup.
- Polish preset wording in the "Model request" labels and drop legacy "Single Agent" framing.
- Fix unreadable detail small-text in toast notifications on colored backgrounds.
- Fix CJK button labels being stacked vertically.
- Fix the preset manager left drawer losing scroll position on preset switch.
- Fix the extension manager popup overriding live toggle state on refresh.
- Fix backdrop bleed-through making popup content blurry while scrolling.
- Fix script-set reverse proxy being overridden by the base URL.

**Full Changelog**: https://github.com/funnycups/Luker/compare/v2.2.2...v2.3.0

## v2.2.2 (2026-05-18)

- Fixed an issue where orchestrator director mode could not read the mind map.

**Full Changelog**: https://github.com/funnycups/Luker/compare/v2.2.1...v2.2.2

## v2.2.1 (2026-05-18)

- Improve the prompt structure for Director Mode.
- Hide and reorganize instruction-injection settings in Director Mode.
- Fix text not wrapping naturally in the CardApp Studio and character card editor pop-ups.
- Improve the input box size for the character card editor pop-up.

**Full Changelog**: https://github.com/funnycups/Luker/compare/v2.2.0...v2.2.1

## v2.2.0 (2026-05-17)

### Multi-Agent Orchestrator

- **New Director mode.** An eight-agent ensemble — chat / memory / lorebook / epistemic / canon scouts, a plot brainstormer, and voice / continuity critics — produces the assistant message body directly through the takeover hook, bypassing the main LLM dispatch entirely. Director carries its own bundled `pure-preset` snapshot that is swapped in for the duration of each run so Main Prompt / NSFW / jailbreak / anti-cliché text from your active preset cannot leak into sub-agent context, with snapshot + restore mirroring the LittleWhiteBox pattern. Profiles can be exported and re-imported as JSON. The two critics were rewritten: `voice_critic` now hunts "data-person" prose (cold observation verbs, reporting-style dialogue, archetype mishandling, with a bilingual banned-term list aimed at Chinese RP); `continuity_critic` trusts the draft by default and only flags hard contradictions and knowledge-boundary violations.
- **New tools cascade.** The loop toolset (chat / memory / lorebook / note / search) can now be enabled on every orchestration node — loop mode itself, spec nodes, agenda agents, and director's main agent + sub-agents — all sharing the same `profile.tools.<ns>.<verb>` flag shape. Resolution is three-tier: per-node override → profile-root `defaultTools` → built-in. The UI exposes a profile-wide panel above the workflow board plus a per-node "Tools (override profile default)" collapsible at the bottom of every node body, with Enable-all / Clear-all quick actions.
- **Runtime trace panel expanded.** The existing trace popup now also exposes the full message thread of every node attempt and the loop agent — system / user / assistant / tool turns rendered as role-styled bubbles with collapsible tool_call and tool_result blocks. Agenda mode additionally gains a kanban-style todo board and per-round dispatch cards; the loop panel updates live, so messages added during rounds show up in real time.
- Fix: Anthropic's tool-name regex `^[a-zA-Z0-9_-]{1,128}$` rejects dots, so loop mode failed immediately when paired with Claude. The eleven loop tool names (`chat_read_range`, `chat_search`, `lorebook_search/get`, `memory_search/list_recent/get`, `note_add/delete`, `search_search/visit`) were renamed to underscore form, with a migration shim that normalises dotted names from older history so saved profiles and persisted tool-call payloads keep working.
- Fix: the global mode-selector dropdown was being overridden by `character.savedMode` inside dispatch, so a character with a spec override forced spec even after the user clicked loop. Dispatch now honours the most recent mode-selector click, matching what the UI scope label already showed.
- Fix: the orchestrator settings panel only subscribed to `CHAT_CHANGED`, so replacing a character card or AI-driven field writes left the panel showing the previous character's override-source label. It now also listens for `CHARACTER_REPLACED`, `CHARACTER_FIELDS_UPDATED`, and `CHARACTER_EDITED`.
- Docs: every mode opens with a default-flow diagram (loop / spec / agenda / director), default agents are tabulated with concrete RP examples carried through a shared Lin Wan / Luoyang scenario, and the trace-panel sections in each mode page include real-run screenshots.

### Memory Graph

- **Per-type extraction cadence and instructions.** Node types now carry two new fields: `extractEveryN` (default 1) gates the type to every Nth pass via `currentSeq % N == 0`, and `extractionInstructions` is appended to the extraction system prompt only when the type is active for the current round. When a type sits out a pass, its create / edit / delete tools are not exposed to the LLM at all — the model literally cannot output that table this round, so slow-changing tables like `location_state` save LLM calls without confusing the extraction agent.
- Fix: `isExtractableAssistantMessage` treated `is_system` as a permanent exclusion, but `/hide` flips that flag on existing assistant turns — so every hide/unhide shifted the extractable-seq rank, drifting stored node seqs against chat. Hidden turns now contribute the same memory weight as visible ones, matching the community convention that `/hide` controls prompt visibility, not memory.
- Fix: hybrid recall (vector + diffusion + optional rerank) kept running when `recallEnabled` was off, while the LLM recall path short-circuited via its internal guard. The recallEnabled check is now lifted above both branches so disabled-recall is uniform; `alwaysInjectNodes` ownership was also moved out of the recall functions so persistent lorebook injection still publishes the right id set to orchestrator dedup.
- Fix: manual `/delete` + immediate regenerate could run `MESSAGE_DELETED`'s cache refresh and the regenerate's WI-scan recall on two interleaved click stacks, so the recall read stale store cache. Mutation invalidation is now serialised through a module-level promise chain and the recall listener awaits the in-flight task.
- Fix: the edge editor was throwing "Edge form not found" because `openEdgeEditor` read form values via `jQuery` after `callGenericPopup` resolved — but `Popup#hide()` removes the dialog from the DOM before the promise resolves. Values are now captured inside the `onClosing` handler. The built-in edge-type preset list was also realigned to the canonical schema (added `involved_in / occurred_at / evidence / updates / advances`, dropped non-canonical `involves`, removed forbidden `located_at`).

### Request Inspector

- Tool calls returned by the model are now visible in the Response Body. Each `tool_call` renders as a card with a badge, name, id, and pretty-printed argument JSON, with a count surfaced in the section header. OpenAI `tool_calls`, Claude `tool_use` content blocks, and Gemini `functionCall` parts are all parsed (including streaming reassembly: index-merged OpenAI deltas, Claude `content_block_*` walks, Gemini interleaved text-and-function parts). Detail-level search now matches tool names and argument JSON too.

### Connection Manager

- **Reverse Proxy settings have been folded into a new "API Endpoint" drawer.** The drawer manages base URL and reverse-proxy password together — previously these lived in separate panels with overlapping semantics and ambiguous precedence. This refactor uncovered three follow-on issues, all fixed in the same release: cross-source plugin reuse let the main API's `base_url` bleed into the sub-profile (Claude main API with `base_url` ending in `/v1` carried over into a Gemini sub-profile, producing `https://claude-proxy/v1/v1beta/models/...:generateContent`); `ConnectionManagerRequestService.sendRequest` never forwarded `profile['base-url']` to the backend, so Gemini through an OAI-compatible proxy ending in `/v1` composed `/v1/v1beta/...:generateContent` and threw "Invalid URL"; and the proxy-password migration to the secret store made `readProviderSecret(...) || body.proxy_password || ''` short-circuit on any stale stored provider secret, silently overriding an explicit `proxy_password` shipped in the body — JS-Slash-Runner third-party scripts that supplied their own keys through `custom_api.key` had them replaced by a stale stored MAKERSUITE secret.
- **New per-profile RPM limit with a wait toast.** A sliding-window throttler gates both the plugin path (`ConnectionManagerRequestService.sendRequest`) and the main chat-completion path; bucket key is the profile id, so a profile reused across plugin and main chat shares the same window. A persistent toast shows a live "queued · next in Ns" countdown while waiting; `AbortSignal` cancels cleanly; `0` or unset = unlimited; text-completion paths are not gated.
- **New Embedding / Rerank tab inside the Connection Profile drawer.** Embedding and rerank profile management has been pulled out of Vector Storage and Memory Graph into a unified, inline-editing UI. The chat API panel auto-hides on those tabs to keep the visible source / url / key from suggesting it relates to the embedding profile being edited. Plugin pages keep only the profile-picker dropdown with a sync that clears the persisted id when the underlying profile is removed elsewhere. The deprecated SillyTavern Extras embedding source is dropped.
- **Unified input-driven model picker across reverse-proxy-capable sources** (OpenAI / Claude / Mistral / DeepSeek / xAI / Moonshot / Makersuite / VertexAI / ZAI plus the existing Custom). The text input is now the source of truth, the sibling `<select>` is a one-shot picker that mirrors it, and a `<datalist>` provides typeahead. The previous select-only flow forced `oai_settings.<X>_model` back to `model_list[0]` whenever the saved id was missing from a freshly fetched `/v1/models` response, silently overwriting custom ids that ship through reverse proxies whose listings don't enumerate them.
- Fix: `normalizeOpenAIBaseUrl` only checked the path's tail for `/vN`. Vendors that nest a category after the version (e.g. Baidu Qianfan's `/v2/coding`) had `/v1` wrongly appended, turning every request into a 404. Match `/vN` anywhere in the path now.
- Fix: refreshing the model list could re-insert the currently selected model into the dropdown even when it wasn't part of the freshly fetched list, leaving a non-listed entry pinned to the selector.

### Characters / CardApp / Studio

- **New data-driven character update API (`updateCharacterData`).** Character-field writes used to go through jQuery DOM (`$('#description_textarea').val(x)`) and rely on a synthetic click of the popup's save button; when the editor popup was closed the DOM elements didn't exist, so writes silently no-op'd while `saveCharacterDebounced` still fired (sometimes leaving ghost state, like a `data.character_book` mirror after a primary-world rebind that never actually rebound). The new API patches `characters[charId].data` with a dot-path map, emits `CHARACTER_FIELDS_UPDATED`, and persists via the same multipart shape `/api/characters/edit` already expects. Studio AI's `character_update_fields`, CardApp's `ctx.updateCharacterFields`, world-info's `charUpdatePrimaryWorld`, and orchestrator's persistence path all route through it now, so binding a world to a card works whether the editor popup is open or not.
- **New extension-field write semantics (`writeExtensionField` / `writeExtensionFieldBulk`).** These now opt into a `replacePaths` flag on `/api/characters/merge-attributes`: the full value becomes `data.extensions[key]` verbatim — sibling subkeys that the previous deep-merge silently preserved are no longer carried over. `updateCharacterData` now throws synchronously on `extensions.*` paths and points callers at `writeExtensionField`, so the silent-merge footgun is impossible to trip by accident.
- **New auto-apply toggle.** Both the iteration-studio shell (reused by the orchestrator AI iteration popup, the memory-graph schema editor, and any third-party plugin that adopts the shell) and the CardApp Studio composer now ship an auto-apply toggle: when on, write / patch tools land immediately instead of rendering the inline Approve / Reject card. Preference persists per extension.
- **CardApps can read character auxiliary world books.** `ctx.getCharacterAuxWorldBooks()` and an extended `ctx.getWorldBooks()` surface books bound via `world_info.charLore[].extraBooks` alongside the primary book. Pass `{ withSource: true }` to `getWorldBooks` to receive tagged entries with `source: 'character' | 'character_aux' | 'chat' | 'global'`.
- **Authoring vs runtime scope was split across the three exposure layers.** CardApp `ctx` no longer leaks `.jsonl` / `sidecar` filesystem terms, and chat lifecycle methods (`closeCurrentChat`, `doNewChat`, `getPastCharacterChats`, `deleteCharacterChat`) are now properly exposed via `getContext()` so third-party extensions can manage chats without reaching into private internals.
- Studio AI's world-book tools were unified around an explicit `book_name` argument. `list / query / get / upsert / delete_lorebook_entry` no longer fall back to the implicit primary-book; the new `luker_card_list_world_books` is the discovery entry point. Studio's `worldinfo_list_books` gains a `character_aux` source, and a new `worldinfo_search_entries` provides keyword search inside one book without loading the full entry set.
- Fix: when Studio AI returned prose + tool_calls in the same response, the chat showed the approval dialog (or tool result in auto-apply mode) before the explanatory text. `onAssistantText` now fires immediately after parsing, so UI order matches generation order.
- Fix: CardApp Studio's static reads (`fetchFileList`, `fetchFileContent`) and the runtime's `style.css` fetch hit the browser HTTP cache silently — the editor and AI's `read_file` could see stale content even after server-side `no-store` middleware was in place. Client-side `cache: 'no-cache'` is now explicit for these calls.
- Fix: `charaFormatData` invoked `syncCharacterBookFromWorldInfo` on every character save, serialising the bound world's full content into `data.character_book` — meant for sharing a card via PNG / JSON, not as a runtime mirror. The stale mirror later tripped `checkEmbeddedWorld` into popping the "import embedded lorebook" dialog for content the user manages elsewhere. Saves no longer write the mirror.
- Fix: three bugs in the post-character-replace lorebook sync popup conspired to turn the buttons into vertical "send" labels and let the AI-fallback path destructively replace both the old and new world books on failure. CSS scope is now anchored to `.luker-studio` so menu-button rules apply, and the destructive replace path was salvaged so failure no longer loses content.
- Fix: bulk filesystem operations (delete + recreate same-named cards, rename, import) didn't invalidate the in-memory recent-chat index, so the welcome screen's "Recent Chats" surfaced stale entries — including chats that no longer existed on disk, returning 400 when the user tried to delete them. Index is now invalidated at the same three call sites that already handle bulk fs changes for characters / groups.
- Fix: after a programmatic write to `characters[chid].data.extensions.world` via `updateCharacterData`, the hidden `#character_world` input still held the old value (the editor popup is a `display:none` div, not a dynamically mounted modal, so its 13 form-attribute associations are always live). A later form-based save would round-trip the stale value back. The form is now kept in sync after data-driven writes.

### Chat-Save / Floor Sync

- **409 chat-write conflicts are now visible to users.** Previously these were silently auto-recovered via rebuild-diff-retry (patch path) or refresh-retry (append path) — users and tests had no way to see drift happening, and the rebuild path itself recomputed a JSON Patch diff against fresh server state, producing wrong sub-replaces when messages shifted. A 409 now fires a "Chat write conflict" warning toast with endpoint name + first-three-ops summary + sent integrity slug, emits `CHAT_WRITE_CONFLICT` for instrumentation, dumps the client / server / live three-way comparison for each divergent index to the console, and resolves divergent fields down to nested paths rather than coarse top-level names — then routes to the full-save fallback every caller already had as a backup.
- Fix: the in-snapshot integrity slug was captured synchronously at queue time, so a queued save could ship with stale integrity if another save advanced the server in the meantime — the auto-illustrator plugin hit this on every image generation. Each send now refreshes integrity from the live `chat_metadata` immediately before transmitting (both single-chat and three group-save paths).
- Fix: the divergence diagnostic was reporting false positives when the client-side snapshot carried a `Date` object and the server fetch carried the equivalent ISO string for the same position — the underlying values serialise to the same JSON literal, so the server's `test` op accepts them as equal. The diagnostic now uses the same JSON-shape comparison the server applies, so identical-on-the-wire fields no longer get flagged.
- Fix: aborting a generation right before flush and then clicking regenerate produced a benign 409 (snapshot ≡ server, both diverged from the now-corrected client). The fallback full-save corrected it cleanly, but the user saw a misleading "chat write conflict" toast. This specific shape (`kind === 'snapshot'` and `divergence === null`) is now suppressed at the toast layer; the diagnostic event and console.warn still fire.
- The `luker_generation_id` retry-dedup token moved from `chat[N].extra` into an in-memory map keyed by chat path with a 60-second TTL per entry. The field no longer pollutes the persisted jsonl and no longer drives `mutated:[extra.luker_generation_id]` false positives in the 409 diagnostic.
- Perf: external-script variable updates triggered the full save chain on every write. `saveMetadata` now skips the chat clone in its metadata-only path (relying on the existing live-slice fallback), and `saveTokenCache` / `saveItemizedPrompts` coalesce via 1-second debounce with a dirty flag, flushed on `beforeunload`, on chat reload, and when a different chat takes ownership of itemizedPrompts.
- Fix: an upstream merge re-added `saveChatConditional` to the push-to-tail branch of `sendMessageAsUser`, but the previous `appendChatMessages` call was still in place. Every user message was being written twice (patch from a snapshot taken before `MESSAGE_SENT` / `USER_MESSAGE_RENDERED`, then again via append after those emits), and any listener that touched `message.extra` between the emits broke the dedup and produced a duplicate user message at the tail. The duplicate call is removed; the fallback design is restored.

### Generation / Task Stream

- **New `generateTaskStream` split-stream API for OpenAI-family streaming.** Returns `{ stream, result }`: an `AsyncIterable` of text / reasoning delta chunks alongside a Promise of the same normalised terminal result shape `generateTask` returns. `jsonSchema` works under streaming (chunks carry partial JSON, `result.jsonData` holds the parsed object); `tools+jsonSchema` mutex still throws synchronously; non-OpenAI providers throw `stream_unavailable` synchronously to enforce the user's explicit opt-in. Exposed at `getContext().generateTaskStream`.
- **New "Use streaming transport" toggle in five built-in plugins** (search-tools, completion-preset-assistant, orchestrator, memory-graph, character-editor-assistant; default OFF). When on, the plugin's `generateTask` calls wrap to `generateTaskStream(opts).result`, keeping the HTTP connection alive on long generations to avoid idle timeout on slow APIs. Non-OpenAI providers throw `stream_unavailable` rather than silently falling back, since silent fallback would violate the explicit opt-in.
- **`generateTask` now substitutes macros in caller-supplied `taskMessages` by default.** <span v-pre>`{{user}}`</span> / <span v-pre>`{{char}}`</span> / <span v-pre>`{{datetime}}`</span> / <span v-pre>`{{getvar::}}`</span> and any other shared-engine macro resolve at request time, with side-effect macros (`setvar` / `addvar` / ...) stripped via `skipSideEffects:true` so per-call substitution can't mutate `chat_metadata.variables`. Authoring flows (character editor, lorebook diff analysis, preset editor, CardApp Studio AI) opt out with `substituteMacros:false` because their job is to read or edit text containing literal <span v-pre>`{{...}}`</span> markers.
- Thinking activation is now driven by `reasoning_effort` instead of `show_thoughts`. Previously `show_thoughts` doubled as the on/off switch for thinking on DeepSeek / Moonshot / Z.AI, contradicting its "visibility only" UI label. Now `auto` omits all thinking parameters (let the provider default decide), any explicit tier sends `thinking.type='enabled'`, and `show_thoughts` retains visibility-only semantics across all providers. Gemini 2.5 Flash / Flash-Lite / Pro `auto` returns `null` instead of `-1` so `thinkingBudget` is also omitted.
- The Prompt-Post-Processing dropdown was collapsed from 7 options to 4 (`Merge` / `Semi` / `Strict` / `Single`). The `_TOOLS` variants only differed by 8 lines stripping tool role / tool_calls — legacy compat for backends that no longer apply. Old preset values (`merge_tools` / `semi_tools` / `strict_tools`) auto-migrate on load, and the misleading "no tools" warning on the function-calling toggle is rewritten to point precisely at `Single` (the only truly incompatible option).
- Fix: when upstream 1.17.0 split `generateRaw` into `generateRaw` + `generateRawData` (PR #5249), the openai-source branch's references to `llmPresetName` / `apiPresetName` / `apiSettingsOverride` ended up inside `generateRawData`, but the parameter list those three were added to stayed on `generateRaw`. Any caller hitting the openai path through `ctx.generateRaw` threw `ReferenceError: llmPresetName is not defined`. The parameter list now matches the shared typedef on both functions.
- Fix: non-streaming responses from Claude, Gemini, and Cohere weren't lifted to the chat-completion shape `generateTask` and friends expect. Claude only wrapped `content[0].text`, silently dropping `tool_use` and thinking blocks; Gemini detected `functionCall` on candidates but never emitted it into the reply; Cohere was forwarded as-is and had no `choices[]` at all, so `normalizeResponse` threw "openai sender returned no choices". `generateTask` callers (character editor, orchestrator task nodes, memory-graph) now work with all three providers in non-streaming mode.
- Fix: `ToolManager.parseToolCalls` short-circuits on the global `function_calling` toggle. The wip director branch added a `force` parameter to bypass that gate for extension callers that explicitly supplied tools (director-runtime, `generateTaskStream`), but the call site wiring was missing — so Claude `tool_use` content blocks were silently dropped from the streaming pipeline whenever the user kept the toggle off. The streaming sender now passes `force: normalizedTools.length > 0`, gating the bypass to requests that actually opted into tool calling.
- Fix: <span v-pre>`\{{...}}`</span> escapes in world book / extension prompts (teaching examples for side-effect macros like `setvar` / `addvar`) were leaking the leading backslash into the LLM's prompt, so the model would copy <span v-pre>`\{{setvar::a::1}}`</span> back into its reply and both the macro engine and op-log scanner honoured the escape — chat variables silently never updated. Brace-escape stripping is now confined to the generation request boundary.

### Message Takeover (Public Extension API)

- **New `createMessageEditorHandle` API plus `GENERATE_TAKEOVER_DISPATCH` event.** Plugins can now produce the assistant message body directly, bypassing the main LLM dispatch for the turn. The kernel owns chat-array mutation, DOM redraw, `MESSAGE_UPDATED` emission, placeholder push, post-generation pipeline (regex AI_OUTPUT, chat-save, tool-call detection), and `saveReply` routing — plugins focus on content generation. Director mode is the in-tree consumer; the kernel itself is plugin-agnostic.

### Variables

- **`setVariable(name, value, { floor? })`** is exposed on `script.js`, `getContext()`, and CardApp `ctx`. Without `floor` it writes straight to `chat_metadata.variables` (chat-scoped, persists for the rest of the chat). With `floor` it pushes a synthetic setvar op into `chat[floor].extra.var_ops` via the variable op-log, mirrored to that floor's current swipe — so deletion, swipe-out, swipe-back, and branching all reconcile through the rebuilder and roll back the same way an AI-written <span v-pre>`{{setvar}}`</span> literal would. The floor-bound path coerces value to string (op-log carries strings only); for structured per-floor state with its own commit log, use `ctx.lukerContext.createFloorState({ namespace })` instead.

### Iteration Studio (Developer API)

- **The AI iteration popup framework was extracted out of orchestrator into a reusable `iteration-studio` shell** at `public/scripts/iteration-studio/`. Adapters declare what an artifact looks like (`cloneWorkingProfile` + `getInitialProfile`), which tools edit it, how prompts are built, and how it persists. The shell owns popup lifecycle, conversation, history, abort, auto-continue, the auto-apply toggle, the LLM round-trip, and diff rendering (object recursion + inline line / word diff with zoom + splitter overlay). Two reference adapters ship: `orchestrator/iteration-adapter.js` (the existing AI iteration UI, now 47 lines instead of 480) and `memory-graph/schema-adapter.js` (new — an AI-edited node-type schema, opened from a new "AI Iterate Schema" button next to the schema editor). Third-party plugins consume it through `getContext().iterationStudio.{ open, defineAdapter, createSettingsBackedHistoryStore, ... }`.

### World Info

- Fix: the editor's `<select>` change handler treated every fire as a book switch and wiped the active search / filter, but two paths fired it on data-only updates — `reloadEditor` (via `WORLDINFO_UPDATED`, entry toggles, slash commands) and `deleteWorldInfo`'s post-list refresh. `reloadEditor` now reloads via `showWorldEditor` directly when the same book is selected, and `deleteWorldInfo` only re-fires change when the edited book actually changed, so deleting an unrelated book no longer clears the user's active search.

### Presets

- Fix: `persistPreset` diffed `existingPreset` against `preset` to compute a JSON Patch, but extensions like JS-Slash-Runner take a reference from `preset_list.presets[i]`, mutate it in place, then call `savePreset(name, sameRef)`. Both diff inputs aliased the same object, the patch was always empty, and `persistPreset` returned `mode='noop'` without hitting the server — so script deletions / toggles silently reverted on refresh. The patch path is dropped entirely; saves always POST the full preset to `/api/presets/save`.

### User Backup

- **Overwrite-mode restore is now snapshot-and-rollback.** Previously a restore deleted all selected category directories upfront (`rm -rf`), then streamed the archive into newly recreated empty ones — any failure during extraction (corrupted zip entry, disk full, process kill) left users with deleted old data and a partial new state, permanently losing whatever didn't get extracted. The upfront delete is replaced with a rename to `<path>.restore-snapshot-<ts>-<hex>`; on success the snapshots are discarded, on extraction failure the partial writes are cleared and the snapshots are renamed back into place. Disk usage briefly doubles for the duration of extraction, but renames are O(1) inode operations and the safety margin is now non-negotiable.
- Fix: after a successful `restoreUserBackupArchive` (or `/lan-migration/import` or `/import/data-zip`), the in-memory `recentChatIndexCache` still pointed at the pre-restore filesystem snapshot, so the welcome screen's recent-chats list looked stale even though opening a character card showed the freshly imported chats. The index is now invalidated at the same three endpoints right after the restore completes.
- Fix: the blue "Please wait..." progress toast lingered behind the success + warning toasts and the diagnostic report modal whenever a restore finished with warnings, because `toastr.clear` was only called from the finally block and `await showRestoreDiagnosticReport` kept the try block alive until the user dismissed the modal. The toast is now cleared inline as soon as the restore promise resolves, in both the Backup-and-Restore and LAN-Migration-import paths.
- The "Import Data ZIP" button in the Backup and Restore panel was a functional duplicate of "Select All + Restore Backup" (both POSTed to `/api/users/restore-backup`; the only difference was that this button ignored checkboxes and hard-coded `BACKUP_FULL_SELECTION`). Removed from the panel; the migration-from-Termux docs were updated across three languages to describe the six-step Backup and Restore flow. The same-named onboarding-wizard button targets a different endpoint and is preserved.

### Generation Recovery

- The in-flight recovery preview is now rendered as an **inline assistant-message bubble at the end of the chat** instead of a separate banner, using the same `.mes` layout (avatar + ch_name + mes_text) so it visually reads as the message that's currently being generated. A dashed-border status chip makes the recovering state explicit; the bubble is pure DOM and never touches `chat[]`, so the placeholder disappears cleanly when `reloadCurrentChat()` draws the persisted message in its place. It scrolls into view on first render.
- The client now streams recovery events over SSE (`/jobs/events-stream`) instead of polling `/jobs/status` at 1Hz. Server-side: a per-job listener set notifies subscribers on each `appendGenerationEvent` plus every terminal status transition (`awaiting_ack` / `persisting` / `completed` / `failed` / `cancelled`); the endpoint emits an initial replay-from-after_seq and then live `event` / `status` frames until terminal status. Client-side: `EventSource` auto-reconnects on transient errors; only a `CLOSED` ready state falls back to reload. Older clients or restrictive proxies that lack `EventSource` automatically use the 1Hz poll fallback.

### Admin Console

- Saves and imports of the server config that would prevent the next startup are now rejected pre-flight, with a localised message explaining what to fix. The two checked invariants are: (a) with `listen` on you must enable one of `whitelistMode` / `basicAuthMode` / `enableUserAccounts` (or set `securityOverride: true`), and (b) at least one of `protocol.ipv4` / `protocol.ipv6` must be enabled or set to `"auto"`. Changing the config no longer leaves you discovering at next launch that the server refuses to start.

### Server

- Fix: two paths could terminate the backend with empty stderr. The console wrapper installed for `backendLogBuffer` ran `JSON.stringify` on every non-string argument without a try-catch, so a circular reference or BigInt in any `console.*` argument made the wrapper throw `TypeError`; inside `process.on('uncaughtException')` the re-entered wrapper threw again and Node aborted, with the trailing `original(...args)` never reached. And Express 4 does not forward async route handler rejections to `next(err)`, so with no `unhandledRejection` listener Node 20+ promoted the rejection to `uncaughtException` and fed straight into the hijack-abort path. Both are now defensive: the wrapper falls back to `util.inspect` then `String()` and isolates buffer bookkeeping; an explicit `unhandledRejection` listener keeps a single failing request from killing the process.

### Android App

- WebView render-process death, native crashes, OOM kills, and ANRs all tear down the activity before `MainActivity` can write anything, so users used to see a loading spinner and a silent exit. `LukerCrashCapture` now reads the most recent abnormal exit via `ApplicationExitInfo` (API 30+) on next launch — `CRASH`, `CRASH_NATIVE`, `ANR`, `LOW_MEMORY`, `DEPENDENCY_DIED`, `SIGNALED`, `EXCESSIVE_RESOURCE_USAGE`, `INITIALIZATION_FAILURE` — pulls the full `traceInputStream` for ANR / native cases, persists to `filesDir/luker-last-crash-report.txt`, and shows it in a dialog with copy / share buttons. A per-package timestamp keeps the same report from re-popping. Below API 30 the poll silently no-ops.

### Updater

- Fix: Node 20.12+ rejects spawning `.cmd` / `.bat` directly without `shell: true` (CVE-2024-27980 hardening), so the post-pull `npm install` step failed with `spawn EINVAL` on Windows even though the `git pull` itself succeeded. `shell: true` is now set on win32; args remain hardcoded literals, so no shell-injection surface is added.

### Extensions Platform

- Extension activation is now actually parallel: previously the inner per-extension `await` chain inside the `for` loop made the trailing `Promise.allSettled(promises)` effectively a no-op, and the local `promise` var only held the pre-activate stages anyway. The `.then(activate)` and `.catch` are now folded into the chain stored in `promise` and the in-loop `await` is dropped, so `Promise.allSettled` at the end of the loop genuinely waits for activation to finish in parallel. The `manifest.dependencies` presence check is preserved.

### Miscellaneous

- The system avatar and welcome assistant now use the Luker logo (`img/logo.png`) instead of the SillyTavern logo; the `/echo` help example was updated and the orphaned `img/five.png` removed.
- Documentation: five new extension-API reference pages (World Info, Characters, Slash Commands, Macros & Variables, UI & Popups), with existing pages expanded across chat lifecycle, swipe API, extension prompts, media helpers, prompt envelope inspection, reasoning helpers, settings views, low-level generation primitives, service classes, i18n, settings storage, debug and scraper registration, tokenization, utilities, and symbols / constants. A new basics/macros guide ships across en / zh-CN / zh-TW. All changes mirrored to all three locales.
- Documentation: clicking the top nav on a zh-CN / zh-TW docs page no longer drops the reader on the English version — nav, sidebar, doc footer, outline, search labels, footer, and UI strings now live in per-locale `themeConfig`. A full triple-language audit also caught and fixed `changelog.md` being entirely zh-CN under an English title, plus four cross-language internal links in `memory-graph.md`.

**Full Changelog**: https://github.com/funnycups/Luker/compare/v2.1.2...v2.2.0

## v2.1.2 (2026-05-10)

- Fixed the issue where CardApp Studio failed to read character card information
- Improved CardApp Studio prompts.
- Fixed web update conflict handling

**Full Changelog**: https://github.com/funnycups/Luker/compare/v2.1.1...v2.1.2

## v2.1.1 (2026-05-09)

- Corrected and expanded the CardApp Studio documentation.

**Full Changelog**: https://github.com/funnycups/Luker/compare/v2.1.0...v2.1.1

## v2.1.0 (2026-05-09)

- **Variable macros support iterating over objects**
- **CardApp Studio allows operations on regex, memory-graph data, and multi-agent orchestration at the character card level.**
- Text output by CardApp Studio before each tool call is now correctly preserved and rendered
- CardApp Studio now displays CardApp error logs for easier debugging
- CardApp API provides interfaces for chat worldbook operations
- Fixed an issue where preset groups could not be opened on mobile devices
- Added configurations for Embedding API and Retrieval API in the API drawer
- Vector and Memory Graph plugins now uniformly reuse the Vector API configuration from the API drawer.
- Fixed an issue where plaintext function calls were not effective within built-in plugins
- Reduced data usage from extension update checks.
- Improved CardApp Studio prompts.
- Fixed an issue where CardApp Studio did not display session history
- The Memory Graph now supports manually recalculating vectors or computing missing ones.
- Reduced lag when modifying presets.
- Fixed rendering issues on some mobile devices
- Fixed issues with multi-agent orchestration in loop mode
- Loop orchestration mode can now call search tools from the search plugin
- Added a front-end token estimation feature

**Full Changelog**: https://github.com/funnycups/Luker/compare/v2.0.0...v2.1.0

## v2.0.0 (2026-05-07)

### ★ Documentation

https://luker.cups.moe

The official Luker documentation, covering most of Luker's improvements, built-in plugin usage guides, plugin development specs, and more — kept in sync across Simplified Chinese, Traditional Chinese, and English.

- Add a tri-lingual (zh-CN, zh-TW, EN) doc site as the single entry point for plugins, extension APIs, the CardApp spec, the memory graph, and more
- Add usage guides for the orchestrator, memory graph, CardApp, Studio, Floor State, per-message variables, auto-migration notes, and more, with screenshots and flow diagrams
- Add a server-plugin development guide and a preset API reference
- Add configuration/startup docs

### ★ CardApp & CardApp Studio

https://luker.cups.moe/features/cardapp.html
https://luker.cups.moe/features/card-editor/studio.html
https://luker.cups.moe/features/card-editor/walkthrough.html
https://luker.cups.moe/development/card-developers.html

CardApp is Luker's standardized form for "frontend character cards"; Studio is an AI-assisted code editor for CardApp authors — write, edit, and run all in one place.

- Add CardApp frontend character cards: a full kit covering server + frontend, CSS auto-isolation, the message render pipeline, chat/character-field/world-info APIs, AI tool definitions and an execution loop
- Add CardApp Studio: code editor, change-approval + diff view, multi-session, code autocomplete, one-click Git rollback, hot reload, full tri-lingual UI
- Iterate on Studio's prompt and toolset so AI-written code holds up
- Add world-binding: AI inside Studio can write AI-facing text straight into bound world-info entries.
- Mobile layout for Studio: bottom tab bar and responsive layout.

### ★ Multi-Agent Orchestration

https://luker.cups.moe/features/orchestrator/

- Add loop mode: a single agent runs its own tool loop, with a default loop prompt and a "delete note" tool
- Dispatch an event when orchestration succeeds so other plugins can pick up from there
- Loop mode can read and write the memory graph directly
- Persist iteration sessions
- Drop the hard iteration limit
- Add RPM rate limiting

### ★ Completion Preset Assistant

https://luker.cups.moe/features/preset-assistant.html

Add the Chat Completion Preset Assistant: an AI helper for editing presets, prompts, and world-info, with step-by-step previews — preset maintenance in one place.

- Rich toolset: default-preset creation, field readers, world-info toggles, assembled-prompt preview, etc.
- Persist session history and tool-call traces so you can step back through them
- Preset edits can be rolled back through change history

### Memory Graph

https://luker.cups.moe/features/memory-graph.html

- Add the hybrid recall pipeline (graph diffusion + cognitive operators)
- Add HTML-table rendering for the injection preview, plus responsive node-detail and injection-viewer layouts with copy support and collapsible search
- Automatic schema migration: legacy chats upgrade on load, with cycle protection and fallback, so nothing gets stuck
- Add two import modes (restore to original floor / bind to current floor)
- Rewrite event-compression rules: tighter summaries, rollup gets its own ruleset, flat compression across depths is supported
- Migrate onto the new Floor State core service so memory commits along floor-aligned diffs with cleaner semantics
- Add RPM rate limiting
- Improve the recall prompt structure to reduce token consumption.
- Remove legacy schemas and unused code paths; the prompt is leaner.

### Floor state

https://luker.cups.moe/features/state-system.html

Add Floor State — state that naturally rolls back and forward with the message floor; a win for plugin authors.

- Instance API for plugin authors, targeting specific floors or branches
- Branch chats inherit the commit log
- Orchestrator, search tools, and memory graph all migrated onto it

### Per-message variables

https://luker.cups.moe/features/variable-op-log.html

- Add the per-message variables feature: variable changes contributed by each message can be inspected and managed individually
- All variables involved in a chat automatically roll back or update as messages are deleted, swiped, or regenerated

### Unified message API

https://luker.cups.moe/improvements/generation-layer.html

- Add a unified message API replacing fragmented legacy interfaces — a clean LLM entry point for plugins

### Preset manager

https://luker.cups.moe/features/preset-groups.html

- Add the grouping system: collapsible panels, context menus, grouping by API
- Support nested sub-groups; expand/collapse in edit mode
- Fully decouple chat-completion presets from connection profiles
- Enhance import for preset built-in regex scripts

### Prompt manager

https://luker.cups.moe/features/prompt-groups.html

- Add the grouping system: collapsible sections, bulk toggle, batch toggle/set-as-extra/remove
- Support nested sub-groups
- Add advanced prompt search

### World info

https://luker.cups.moe/basics/world-info.html
https://luker.cups.moe/features/world-info-trace.html

- Add multi-worldbook binding: each chat can bind multiple worldbooks at once
- Add a bulk field-edit toolbar across every editable field, with single-field, composite (Trigger Strategy), tri-state (Matched Fields), and Injection Depth dialogs; one-click rollback
- Add configurable editor-field visibility so seldom-used fields can be hidden
- Expanded bulk entry actions
- Improve the search experience and add advanced search
- Full tri-lingual; mobile layout improved

### Extension API

https://luker.cups.moe/development/frontend-plugin.html
https://luker.cups.moe/development/server-plugin.html
https://luker.cups.moe/development/extension-api/

- Add an extension-API registry and lookup
- Add character-state read/write so state operations don't go through metadata calls
- Add a one-stop request API: connection profile, preset, message assembly, streaming — handled in one shot
- Add local Git capabilities for Studio and other upper-layer plugins
- Expose preset APIs to plugins
- Drop the old extras API

### WebSocket proxy

https://luker.cups.moe/improvements/ws-proxy.html

- Add the WebSocket proxy tunnel: LLM and image-generation requests forward over WS, with auto-retry on disconnect, for stable remote use

### Rerank & vectors

- Add reranking: visible similarity scores, a rerank endpoint, UI integration, full tri-lingual.
- Add Jina AI as a native embedding source
- Vector query endpoint can return raw vectors

### Request Inspector

https://luker.cups.moe/improvements/request-inspector.html

- Add the Request Inspector: per-user tracking of LLM and image-generation requests for diagnostics
- Tracks requests across all image-generation backends

### Image generation

- ComfyUI switches to WebSocket instead of HTTP polling, with polling as a fallback if WS fails

### Regex

- Add ReDoS and long-running regex detection so bad patterns can't freeze the session
- Drag-and-drop improvements; long-press on mobile no longer mis-triggers
- Fix the missing event firing after a regex is edited
- Handle invalid preset built-in regex script entries

### Undo

https://luker.cups.moe/improvements/other.html

- Add undo toasts for prompt and worldbook entry deletes — accidental deletes are recoverable

### UI modernization

- Refresh drawer panels with performance optimizations and updated styling
- Unify popup styles with the Studio design system
- Redesign orchestrator and memory-graph view popups

### Performance & experience

- Add a frontend self-profiling toggle so stalls can be captured and pinpointed
- Disable autocomplete by default to stop layout thrashing in long chats; when enabled, throttle more efficiently
- Trim unnecessary object clones — preset editing feels noticeably smoother.
- Reposition context menus inside viewport bounds so they no longer clip off-screen
- Adaptive chat width in Android WebView
- Batch OpenAI token counting in long chats
- Batch worldbook entry-title autosize on render

### Mobile

- Fix the mobile virtual-keyboard auto-popup and a handful of related input bugs
- Better touch spacing on preset and worldbook controls
- Adapt popups for small screens; small-screen popups no longer overflow
- Android app: WebView custom fullscreen, prefer system file chooser intents, broader JSON import, no restart on system theme change

### i18n

- Translation pass across many spots: the variable-op panel, SD generation toasts, worldbook bulk-edit, prompt grouping, rerank settings, etc.

### Logs & debugging

- Timestamps on all frontend and backend console logs
- Add one-click debug-log export with auto key redaction so it can be sent back as feedback directly
- Enhanced logging for Luker persistence

### Security & authentication

https://luker.cups.moe/guide/authentication.html

- Auto-provision a random password for unprotected admin accounts on boot instead of leaving them open
- Fix the built-in updater being unable to run in some scenarios
- Bypass basic auth for the LAN migration path; Android WebView handles Basic Auth prompts

### Model channels

- Custom additional parameters supported for DeepSeek and Claude
- Handle DeepSeek V4 reasoning content in tool-call paths
- Normalize native tool schemas for Claude and Gemini
- Normalize OpenAI-compatible endpoint URLs to accept flexible input formats
- Server-side message-transport persistence extended to more chat providers
- Function-calling prompt enhancements, including improved plain-text function-call prompting

### Fixes

- Fix RPM rate-limit semantics in the orchestrator and memory graph
- Fix memory-graph node ordering, injection-record updates, toast overwriting, persistence clobbering, and advanced-settings dialog scrolling
- Fix multiple prompt-manager and worldbook-entry styling issues
- Fix the chat-bound worldbook selector being unable to pick a worldbook
- Fix ComfyUI WS reconnection retry and the connection-manager API-add flow
- Stop the character-card editor from registering tools in main chat context
- Stop dropdown-search clicks from accidentally closing the drawer
- Fix SD generation toasts being undismissable, competing toasts, and broken generation.
- Fix the missing persistence integrity check that let stale data overwrite the chat record
- Fix WS-Proxy being incorrectly rejected by IP validation
- Fix WS-Proxy aborting requests due to bad close timing (the rc.2 root cause for "cannot send messages in the app")
- Fix the upstream-chat data-loss bug on load failure (now distinguishes "new chat" from "corrupted data" before any write)
- Fix the stream endpoint silently dropping errors — now logs full details and returns a 500
- Fix bootstrap responses carrying PNG data, which made the payload huge
- Fix reasoning slash commands not being registered during initialization
- Fix OpenAI error handling and prompt referencing, prompt-token-limit miscalculation, and SD exception handling
- Fix blob/iframe download handling
- Preserve custom fields when saving the character form (no longer dropped on save)
- Fix macro escapes: escapes are preserved across multiple paths; side-effect macros no longer re-fire during prompt assembly.
- Fix branch chats being saved to the wrong target file when switching branches
- Fix persona unbind state not persisting and migrated avatar filenames not being preserved
- Fix OpenAI freezing when bound presets are cleared
- Fix dropdown delete buttons being unresponsive on WebView touch
- Fix character-card validation kicking in before merged cards were normalized
- Fix several connection-profile switching bugs

### Refactoring & upstream sync

- Sync up to upstream SillyTavern 1.18
- Make character-card runtime and storage use the v2 format (drop the v1 fallback); legacy cards migrate automatically.
- Drop the built-in summarize extension (replaced by the memory graph)
- Drop legacy redirect routes and dead compatibility shims
- Drop the world-info string fallback in favor of entry arrays
- Split monolithic extensions into internal modules

### New Contributors

* @Youzini-afk made their first contribution in https://github.com/funnycups/Luker/pull/1
* @1432647 made their first contribution in https://github.com/funnycups/Luker/pull/3
* @atonal519 made their first contribution in https://github.com/funnycups/Luker/pull/5

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.32.1...v2.0.0

## v1.32.1 (2026-03-21)

- Update toggle icons for active state in manager

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.32.0...v1.32.1

## v1.32.0 (2026-03-21)

- Move global lorebook management into a drawer with pinned lorebooks, active summary, tag search, and bulk controls
- Add batch lorebook entry transfer and safer custom ordering via dedicated drag indicators
- Improve lorebook manager performance and rendering stability
- Add chat persona change reminders and stabilize chat/character persona bindings across chat switches
- Improve Character Editor Assistant with persistent conversation history
- Improve Orchestrator with persistent iteration history and diff-based change tracking.
- Allow safe chat switching and chat file actions during active saves, while keeping delete and new-chat actions correctly scoped and reducing accidental mobile swipe triggers.
- Improve search guidance for creating lorebook entries, including source-work handling, always-inject entries, and cache refresh after message edits
- Preserve regex extensions in character-bound presets and improve prompt/regex editor responsiveness

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.31.0...v1.32.0

## v1.31.0 (2026-03-20)

- Save pure text function calling retry settings to specific API preset
- Prefer Jina Reader for web visits in the search plugin.
- Avoid chat folder collisions on rename
- Fix gallery retrieval
- Guard editor rendering for invalid scripts
- Stop trimming graph on hidden messages
- Restore send controls after aborting generation
- Prevent welcome screen mixing with restored chats
- Improve preset switching performance
- Cap log viewer rendering budget
- Add log viewer search
- Restrict preset and regex reordering to actual drag handles
- Preserve UTF-8 across proxied chunks.
- Handle lorebook filenames with trailing spaces
- Add spacing between preset action buttons

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.30.1...v1.31.0

## v1.30.1 (2026-03-18)

- Fix startup loading issues
- Improve the documentation on plain text function call parameters.

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.30.0...v1.30.1

## v1.30.0 (2026-03-18)

- Improve the development documentation on clearing World Book data when plugins reuse presets.
- Memory Graph, orchestrator, and search plugins can now manually disable the feature that includes World Book data in requests.
- Require World Book entries generated by the search plugin to use standard YAML format, improving entry quality.
- Add a frontend log toggle in user settings (disabled by default) to prevent plugins from printing excessive logs; enable during debugging to view error messages.
- Optimize preset saving performance.

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.29.1...v1.30.0

## v1.29.1 (2026-03-18)

- Persist compression progress incrementally for memory graph
- Stop memory-graph runtime work before reset or import.
- Prevent overlapping scheduled memory graph updates.
- Avoid fixed background rendering on phones
- Improve the default memory graph schema and prompt.
- Prevent app restart on orientation change

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.29.0...v1.29.1

## v1.29.0 (2026-03-17)

- Add regeneration for plugin popup
- Persist popup tool turns across rounds
- Support greeting fields for character editor

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.28.0...v1.29.0

## v1.28.0 (2026-03-17)

- Add per-agent chat preset routing for orchestrator
- Add optional auto retry for pure text function calling
- Add event time field defaults to memory graph
- Refresh regex list on app launch
- Speed up app startup.
- Restore message_updated event on edit cancel
- Avoid clearing translations on edit cancel

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.27.1...v1.28.0

## v1.27.1 (2026-03-16)

- Fix error in quick response
- An API preset can now be set for the planner in orchestrator agenda mode.
- Fix regex state update

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.27.0...v1.27.1

## v1.27.0 (2026-03-16)

- Add plugin-only regex
- Restore UI state on startup.
- Improve dev docs
- Fix secret popup
- Use file import and export for memory graph
- Add node search for memory graph
- Support per-agent api presets for orchestrator
- Correct startup github icon link
- Improve the orchestrator generator prompt.
- Use XML model for pure text function calling
- Invalidate stale cached reads after writes

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.26.1...v1.27.0

## v1.26.1 (2026-03-16)

- Fix preset switching.
- Improve the pure-text function calling model.

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.26.0...v1.26.1

## v1.26.0 (2026-03-15)

- Front-end and back-end performance and cache improvements: World Book rendering, first-screen startup, recent chat caching, the diff backend, front-end settings caching, and maximized concurrent requests.
- Improve the search plugin prompts; click Reset in the plugin settings.
- Improve the search plugin's execution logic.
- Reset the default injection depth for multi-agent orchestration to 0
- Add an interrupt button to the character card editor popup
- Introduce agenda mode for multi-agent orchestration: a planner dynamically decides which agents to invoke, free from the constraints of a fixed orchestration sequence.
- Orchestrator can now persist the orchestration type (agenda/spec/single) at the character card level
- Fix an issue where the character card editor triggered an error after updating a character card
- Improve the handling of emoji names.
- Add time and quantity filters to the front-end log display
- Immediately stop ongoing updates when the memory graph is disabled
- Search plugin results now roll back alongside user chat history.
- Fix an issue where the reverse proxy failed to load automatically when switching API presets.
- Redesign plain text function calls to align with Toolify's universal function calling model.

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.25.3...v1.26.0

## v1.25.3 (2026-03-13)

- Fix assistant message duplication when regenerating.

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.25.2...v1.25.3

## v1.25.2 (2026-03-12)

- Honor recall lorebook injection settings
- Optimize orchestrator generation prompt
- Sync persistent lorebook on inject setting changes
- Add swipe metadata in the event
- Fix issues in memory graph during swipe
- Move immersive mode toggle into user settings
- Ensure editor closes after saving
- Fix jsonl and regex selection in the app.
- Fix third-party extension issues related to hook order.
- Add more events for hook order

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.25.1...v1.25.2

## v1.25.1 (2026-03-11)

- Improve i18n coverage for Simplified and Traditional Chinese
- Fix an issue where apps could not import images
- Preserve the stop string when switching presets
- Fix occasional UI glitches in message editing.
- TTS now logs request details and catches errors on the backend
- Fix an issue where apps on some devices could not export files

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.25.0...v1.25.1

## v1.25.0 (2026-03-11)

- Inject critic feedback in the orchestrator.
- Add i18n for the app.
- Fix saving of messages influenced by regex.
- Preserve lorebook activation on undo
- Add undo for character cards

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.24.0...v1.25.0

## v1.24.0 (2026-03-10)

- Allow modifying function calling mode without selecting an API preset
- The character card editor now provides Lorebook search and retrieval tools instead of directly embedding the entire Lorebook
- Fix drawer UI display
- Correct overriding of memory graph advanced settings at the character card scope.
- Add a critic node type to orchestration—this node can review previous nodes and trigger retries for unsatisfactory parts
- Deleting chats, presets, or Lorebooks now provides a brief undo toast as a safety measure
- Character card exports now include the latest bound lorebook.
- Reduce stuttering when the IME opens or closes.
- Add visual flowcharts to orchestration so you can follow the entire process.
- Orchestration results can now be viewed in single-agent orchestration mode
- The app allows customizing endpoints in status bar notifications; non-local endpoints will not start local services
- Message editing events provide more detailed metadata
- Orchestration results now roll back with user message changes and deletions.
- Improve incremental update endpoints to reduce unnecessary full saves.
- Error and warning toasts for the memory graph will now be displayed persistently

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.23.0...v1.24.0

## v1.23.0 (2026-03-09)

- Manage backend plugins in frontend
- Improve plugin-scope regex handling and API.
- Fix orchestrator result injection.
- Fix author's-note injection for plugins.
- Expose search API for plugins
- Add SearXNG and Brave as search providers
- Continue the search agent loop even when a web fetch fails.
- Return detailed errors when a search fetch fails.

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.22.0...v1.23.0

## v1.22.0 (2026-03-08)

- Switching chats now synchronously updates the status of the memory graph and search tools.
- Interrupting memory graph updates no longer results in graph data loss, and partially processed changes are saved.
- Fixed several callback issues with plain text function calls.
- Optimized the parsing of DuckDuckGo search results.
- Canceling message editing will no longer erroneously trigger message update events.
- A toast notification will appear if a memory graph update is interrupted.
- Optimized the prompts for the search plugin.
- Optimized prompts related to memory graph nodes and updates; these can be manually reset to the latest default values in schema and advanced settings.
- Added chat branching events.
- Chat branching will synchronize memory graph data to the new chat.
- The prompt manager can now search runtime prompts, such as messages within the chat history.
- Editing messages will no longer interrupt memory graph updates.
- Fixed and unified the injection settings for the memory graph, orchestration, and search plugins.
- Luker can now be started by specifying paths for frontend and backend plugins.
- Frontend and backend plugins for the app are now read and used directly from Android/data.
- Fixed an issue where messages were incorrectly hidden after the memory graph was turned off.
- The search plugin now incorporates two-stage queries and corresponding prompts like orchestration.
- Fixed the workflow for plugins requesting a rescan of the Worldbook.
- Fixed an issue where the search plugin could not inject search results.

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.21.0...v1.22.0

## v1.21.0 (2026-03-07)

- Refresh regex script list when opening the drawer
- Stabilize image generation tracking and clear the generation toast after the last active job stops.
- Keep API profile stable when switching chat presets
- Support plugin post-activation world-info rewrite hooks
- Normalize runtime world-info payload handling for orchestrator and memory graph, including Quick Build context
- Unify function-call runtime across core and extensions with Toolify-style flow
- Add main-chat plain-text function-calling toggle in API drawer
- Support caller-owned no-tool handling, text-only prompt_json responses, and clearer multi-tool plain-text prompts
- Preserve assistant text extraction for array/parts payloads and normalize streaming plain-text tool calls
- Standardize tool-result replay as assistant/tool messages
- Add node search and knowledge iteration with chat-state persistence in orchestrator
- Fold long orchestration iteration messages and hide auto simulation payloads
- Simplify default orchestrator prompt templates
- Add orchestration research records viewer popup
- Rename capsule wording to orchestration result
- Allow editing the latest orchestration result
- Decouple web search from orchestrator
- Add integrated web-search tool flow in character editor assistant
- Add DDG provider and decouple search-tools API from global tool registration
- Clarify search-tools main-model visibility toggle, support preset-based agent selectors, add cancellable search toast, and reuse pre-request results on regenerate
- Add default traits column for memory graph character schema
- Add configurable recall injection placement in memory graph
- Exclude recent assistant turns from memory graph extraction
- Import memory graph as chat baseline
- Stabilize memory graph around chat mutation rollback, recall aborts, regenerate reuse, and stale follow-up cleanup
- Persist incremental op log in memory graph
- Use shared plugin lorebooks and refresh lorebook list after runtime creation
- Add a safe LAN migration flow for user backup, and clear the progress toast before download.
- Continue generation after plugin aborts and abort in-flight backend requests on client cancel

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.20.0...v1.21.0

## v1.20.0 (2026-03-02)

- Persistent nodes are now saved for the memory graph.

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.19.0...v1.20.0

## v1.19.0 (2026-03-02)

- Clear generation toast for last image generation
- Improve the orchestration prompt.
- Stabilize state after bulk message deletion in memory graph
- Save additional parameters in the API preset.
- Fix preset deletion in character scope of orchestrator
- Support preset-linked lorebooks
- Add prompt search
- Always strip connection fields from preset import/export

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.18.0...v1.19.0

## v1.18.0 (2026-03-01)

- Avoid orchestrator agent timeout being applied to agent generation
- JSON parsing errors in agent generation now trigger a retry.
- Correct preset removal of orchestrator
- Clear the image generation toast when generation is aborted.
- Fix regex list rendering.
- Prevent duplicate message inserts under retry races

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.17.0...v1.18.0

## v1.17.0 (2026-02-28)

- Image generation toast now adds a button to interrupt generation
- The orchestrator generation model can see the global orchestration for reference.
- Reverse proxies of API presets are now saved with the preset itself
- Regex plugin now has regex for plugins. Any plugin/script can be added through the Luker interface
- Orchestrator now uses the plugin regex function to handle message hiding

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.16.1...v1.17.0

## v1.16.1 (2026-02-27)

- Save config.yaml to external storage

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.16.0...v1.16.1

## v1.16.0 (2026-02-27)

- Orchestrator now injects pure responses from the latest node.
- Add placeholder usage guide for orchestrator generation
- Stabilize regenerate cache reuse for orchestrator
- Add chain-of-thought reasoning for the orchestrator.
- Support Discord OAuth scope
- Migrate data to external storage for APP

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.15.0...v1.16.0

## v1.15.0 (2026-02-26)

- Fix issues when sending messages
- Add chat messages management
- Add warn before closing/reloading this page

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.14.0...v1.15.0

## v1.14.0 (2026-02-25)

- Fix an issue where author notes, dialogue examples, and other content could not be reused by plugin requests.
- Remove the 'thread' from the default schema of the memory graph.
- When switching presets, if changes are not saved, you will be prompted to save.
- Operations such as toggling presets or removing them from prompt order will now trigger an undo toast, allowing you to revert changes within a short period.
- Preset configurations such as temperature are now collapsed by default to prevent accidental modifications.
- Fix IME issues in full-screen mode.
- Fix the chat floor cropping feature in the memory graph.

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.13.1...v1.14.0

## v1.13.1 (2026-02-24)

- Improve the memory graph prompt.
- Improve Luker API documentation

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.13.0...v1.13.1

## v1.13.0 (2026-02-24)

- Allow deleting nodes in graph inspector
- Update default event schema and compression prompt
- Preserve schema fields in compressed rollups
- Show dynamic recall content in last injection view
- Add schema compression rules and thread default filter for memory graph
- Fix regeneration
- Harden app immersive layout
- Fix big backup files issues in APP
- Compute diffs asynchronously for heavy operations.

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.12.1...v1.13.0

## v1.12.1 (2026-02-23)

- Fix memory-graph auto compaction.

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.12.0...v1.12.1

## v1.12.0 (2026-02-23)

- Improve orchestrator character-scope handling.
- Stay compatible with scripts and plugins that rely on the old timing.
- Fix authentication issues in API preset used by plugins
- Follow upstream SillyTavern at 7ffb28f.

### Highlights
- Improve chat rendering performance in large chats (`printMessages`, batch prepend, edit replacement path).
- Migrate Macros 2.0 core and follow-up runtime/autocomplete fixes.
- Upgrade media pipeline with `/api/image-metadata`, background metadata, and sorting support.
- Expand SD/media capabilities: Z.AI GLM-Image, Pollinations API update, stable-diffusion.cpp backend, better generation progress/abort UX.
- Sync model/provider updates across OpenRouter, NanoGPT, Moonshot, Z.AI, and caption tooling.
- Add vector slash controls and improve World Info command diagnostics.

### Luker-Native Changes
- `b9dc9c278` Add Z.AI GLM-Image model support and sizing rules.
- `917c25564` Add SD generation progress indicator and abort UX improvements.
- `5ae4d365b` Migrate Pollinations image API (auth + response format).
- `f26567c97` Add stable-diffusion.cpp backend support.
- `7befcdf23` Avoid duplicate media append during swipe.
- `d804ee975` Add Minimal Prompt Processing option.
- `a57a1d68b` Add NanoGPT reasoning effort control.
- `33a7eca6d` Add OpenRouter headers for image generation requests.
- `e023ea2b1` Add vector storage slash commands.
- `a2b0cefb2` Add configurable Gemini thought signature injection.
- `c6451e254` Map Moonshot and NanoGPT reasoning controls.
- `b854572e2` Improve World Info slash warnings and duplicate naming.
- `dabd9bd23` / `c8fca6e4f` / `424c118e7` / `17d87e939` Complete Macros 2.0 migration track.
- `564d1d84e` / `c175e43c3` / `e95f192a4` Improve message rendering/edit/index behavior.

### Upstream Sync
- Fix HTTP Basic Auth with colon-containing passwords.  
  Upstream: https://github.com/SillyTavern/SillyTavern/commit/df0e1256e67276f203bb2dc93ba747bb18df8f26
- Make CORS middleware configurable.  
  Upstream: https://github.com/SillyTavern/SillyTavern/commit/10e08f0e3df3bd22a00a017db772cd8b0258ecc3
- Prevent accidental chat overwrite when switching characters/groups.  
  Upstream: https://github.com/SillyTavern/SillyTavern/commit/4e5cb9c44f99f6ecd886a7c4a26defb6b8ed06f6
- Add pinned recent chats.  
  Upstream: https://github.com/SillyTavern/SillyTavern/commit/1ff98e76f8a80f0d9025b2cc288bab8045c25335
- Preserve user input on tool-call recursion.  
  Upstream: https://github.com/SillyTavern/SillyTavern/commit/9714374749b0bf1193f10af1b83695ab38147b7c
- Expose character update APIs for extensions.  
  Upstream: https://github.com/SillyTavern/SillyTavern/commit/ef25a0365014fe7c298e34b207907f390647d0d8
- Guard `isValidImageUrl` for nullish avatar values.  
  Upstream: https://github.com/SillyTavern/SillyTavern/commit/3efe809d274f71c8b34e58b97255ea1d6a319f57
- Fix NanoGPT Claude cache detection with prefixed IDs.  
  Upstream: https://github.com/SillyTavern/SillyTavern/commit/4672647293b616ba99a87bfe3dbeeb76d5f3ad7d
- Set HTML `lang` attribute from app locale.  
  Upstream: https://github.com/SillyTavern/SillyTavern/commit/50e566ee0dde408065d2b05a1c0c0eedb019052e
- Sync OpenRouter providers list.  
  Upstream: https://github.com/SillyTavern/SillyTavern/commit/300912237d0e53ae3725685b79eccc7b22765bf2
- Add `clearData` option for `clearChat`.  
  Upstream: https://github.com/SillyTavern/SillyTavern/commit/b64c279473be4b17be16b52caf3ce9dbf65b8eeb
- Improve search parsing and restore cross-message text search.  
  Upstream: https://github.com/SillyTavern/SillyTavern/commit/3f8acaad4e2ac6251e9b714726eed180c2de7fb7  
  Upstream: https://github.com/SillyTavern/SillyTavern/commit/5c62cf4a6ef7d3b73d9ac746c2b08e1ab026e8a9
- Improve welcome screen scroll behavior.  
  Upstream: https://github.com/SillyTavern/SillyTavern/commit/e5c14af76d4d4d99638414f7a09ad71587549610
- Improve swipe sync guard for macro resolution.  
  Upstream: https://github.com/SillyTavern/SillyTavern/commit/bee4d9a8183f4aecf326b8d6e2b1d9cfdca96dd3
- Add NanoGPT embeddings support for vector storage.  
  Upstream: https://github.com/SillyTavern/SillyTavern/commit/5832cb8b07f8e7c62880b77be49b765dccb6fe49
- Add ComfyUI rename UX and style-save default behavior.  
  Upstream: https://github.com/SillyTavern/SillyTavern/commit/23ba3e5bb2e7aad59d0912b2b026a14052936f1b  
  Upstream: https://github.com/SillyTavern/SillyTavern/commit/8e911af031d2ac609b9f6f1acee72810aa5521e4
- Add Claude Opus 4.6 option.  
  Upstream: https://github.com/SillyTavern/SillyTavern/commit/39c8eb343c279b8e1293caff7c357caa3ba93b07
- Add null matcher optimization for empty queries.  
  Upstream: https://github.com/SillyTavern/SillyTavern/commit/ad88acc9805a14bf67987f9018b9dd83ff906c27
- Add background metadata population, sort, and thumbnail fixes.  
  Upstream: https://github.com/SillyTavern/SillyTavern/commit/4550afd4cce9de4129af66495d6e56f35f5381f0  
  Upstream: https://github.com/SillyTavern/SillyTavern/commit/788ed3d32cf2f2698ea84f189f70f8df3ba359ed  
  Upstream: https://github.com/SillyTavern/SillyTavern/commit/1e49f3d4f84cf855cf7406ff3e146f27427b6ee0  
  Upstream: https://github.com/SillyTavern/SillyTavern/commit/266f3ade0effd08a45448f93fda0f54e1fca11aa
- Improve `printMessages` and `getGroupPastChats` performance; replace jQuery AJAX with fetch.  
  Upstream: https://github.com/SillyTavern/SillyTavern/commit/2d1a96f91d675c618e7fc9832cda3bea5c2ac8d4  
  Upstream: https://github.com/SillyTavern/SillyTavern/commit/68d4da1c83d74a53f77a28ca0e0aae5c26aa9d7b  
  Upstream: https://github.com/SillyTavern/SillyTavern/commit/8a32b72dfea21a678864c561cd74ae3c4caab82e

### Macros 2.0 Upstream Reference Set
- https://github.com/SillyTavern/SillyTavern/commit/e9bedadc0
- https://github.com/SillyTavern/SillyTavern/commit/0dcd9906b
- https://github.com/SillyTavern/SillyTavern/commit/dbc4fe611
- https://github.com/SillyTavern/SillyTavern/commit/81414724b
- https://github.com/SillyTavern/SillyTavern/commit/cd0627bfe
- https://github.com/SillyTavern/SillyTavern/commit/b453fdc5d
- https://github.com/SillyTavern/SillyTavern/commit/e40b31b06
- https://github.com/SillyTavern/SillyTavern/commit/7331dba05
- https://github.com/SillyTavern/SillyTavern/commit/3047045d3
- https://github.com/SillyTavern/SillyTavern/commit/5c2a02a12
- https://github.com/SillyTavern/SillyTavern/commit/f8c373f55
- https://github.com/SillyTavern/SillyTavern/commit/0b529290a
- https://github.com/SillyTavern/SillyTavern/commit/42155eceb
- https://github.com/SillyTavern/SillyTavern/commit/ca60ba148
- https://github.com/SillyTavern/SillyTavern/commit/9ff9d5967
- https://github.com/SillyTavern/SillyTavern/commit/9f4449973
- https://github.com/SillyTavern/SillyTavern/commit/953d9f34c
- https://github.com/SillyTavern/SillyTavern/commit/06b77ec94
- https://github.com/SillyTavern/SillyTavern/commit/26d495f45
- https://github.com/SillyTavern/SillyTavern/commit/6f5032f20
- https://github.com/SillyTavern/SillyTavern/commit/bee4d9a81

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.11.0...v1.12.0

## v1.11.0 (2026-02-23)

- Add forced updates for conflicting plugins.
- Prompt for lorebook deletion only when it exists during character deletion.
- Fix issues in lorebook analysis during character update

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.10.0...v1.11.0

## v1.10.0 (2026-02-22)

- Add mobile model metadata tooltip
- Clarify descriptions for memory-graph and orchestrator.
- Fix the logic that shows the latest run for memory-graph and orchestrator.
- Fix extension upgrade on APP

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.9.2...v1.10.0

## v1.9.2 (2026-02-22)

- Fix global extension backup and restore.

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.9.1...v1.9.2

## v1.9.1 (2026-02-22)

- Avoid losing ephemeral injection prompts.

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.9.0...v1.9.1

## v1.9.0 (2026-02-22)

- Fix lorebook activation in some plugins
- Plugins can now reuse prompts from `/inject` command
- Memory graph can now hide early messages
- Improve onboarding SillyTavern data migration.
- Admin can now backup global extensions in Restore & Backup
- Fix admin panel missing
- Add automatic model fetching for the Claude and Vertex endpoints.
- Add custom models for Chat Completions

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.8.2...v1.9.0

## v1.8.2 (2026-02-22)

- Enhance memory graph prompt

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.8.1...v1.8.2

## v1.8.1 (2026-02-22)

- Fix function definitions in the memory graph.

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.8.0...v1.8.1

## v1.8.0 (2026-02-21)

- Allow frontend scripts to call the fullscreen API in the app.

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.7.0...v1.8.0

## v1.7.0 (2026-02-21)

- Fix error in memory graph
- Add character scope advanced settings in memory graph
- Add generation-related notifications
- Fix patch error related to integrity changes
- Preserve world-info injections in preset-aware requests
- Optimize regex reloading strategy
- Add native immersive fullscreen

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.6.1...v1.7.0

## v1.6.1 (2026-02-20)

- Fix error in memory graph

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.6.0...v1.6.1

## v1.6.0 (2026-02-20)

- Automatically probe for an available port when the app launches.

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.5.1...v1.6.0

## v1.5.1 (2026-02-20)

- Avoid snapshots being lost when regenerating.
- Make extension installation more robust.

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.5.0...v1.5.1

## v1.5.0 (2026-02-20)

- Fix unexpected reloading of chat
- Add runtime notifications for the app.

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.4.0...v1.5.0

## v1.4.0 (2026-02-20)

- Enhance SillyTavern data migration guide.
- Avoid messages disappearing in the app.
- Reuse results from orchestrator and memory graph extensions for the same messages and on regeneration.

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.3.1...v1.4.0

## v1.3.1 (2026-02-20)

- Enhance boundary condition handling of regex extension.

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.3.0...v1.3.1

## v1.3.0 (2026-02-20)

- Fix error on mobile.
- Admin can now edit config.yaml on admin panel.
- Prevent extensions being lost on mobile app upgrade.

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.2.0...v1.3.0

## v1.2.0 (2026-02-20)

- Luker now upgrades automatically via git or downloads the APK once you permit it in the reminder popup.
- You can view frontend logs in Log settings now.

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.1.0...v1.2.0

## v1.1.0 (2026-02-20)

- You can now migrate data directly from ST data zip in Backup & Restore settings.
- Backend logs are now available for admin.

**Full Changelog**: https://github.com/funnycups/Luker/compare/v1.0.0...v1.1.0

## v1.0.0 (2026-02-20)

### Core optimizations

- Switched major save flows to a patch-first model (RFC 6902), significantly reducing repeated full-file rewrites and network traffic usage.
- Improved incremental save conflict handling and runtime stability.
- Decoupled chat preset and API selection for more flexible model routing.
- Added character-scoped bindings for user personas and presets without polluting global defaults.
- Character-scoped persona/preset bindings are exported and imported together with character cards.
- Added OAuth login support for GitHub and Discord.
- Added per-user storage quota controls and default user quota assignment.

### World info

- Added a traceable World Info activation chain, so you can inspect why an entry was activated and what triggered it.
- World Info writes now follow patch-first incremental updates.

### Built-in features

- Orchestrator (Multi-Agent): supports serial/parallel stages, AI-generated orchestration profiles, character-scoped configuration, profile import/export, and human-readable diff-based approval workflow.
- Memory Graph: improved graph-based memory extraction/linking, iterative recall, partial rebuild for recent turns, character-scoped schema settings, graph import/export for current chat, and better graph presentation.
- Character Editor Assistant: AI-assisted editing for character fields and lorebook content, with diff review, approval, and rollback history.
- During Character Card Replace/Update, a guided panel now asks whether to keep the current worldbook, replace it with the new worldbook, or use the AI to compare the old and new worldbooks and apply an updated version.
- Diff UX has been improved, including a zoomable line-by-line diff view.

### Android app

- Added Android app support for Luker runtime usage.
- Improved WebView interoperability for file/media flows (SAF picker, blob/data download handling, permission bridge).
- Supports extension installation in the Android app.

### Backup & restore

- Added built-in Backup/Restore with selectable data categories.
