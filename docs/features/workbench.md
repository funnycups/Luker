# Workbench

Workbench is Luker's unified workspace for inspecting prompts, diagnosing issues, visualizing Memory Graph, Orchestrator, and Image Generation activity, and tuning presets, character cards, world books, memory structures, orchestration profiles, and image generation profiles with AI.

## Opening Workbench

- Click the wand menu next to the message input box and select **Workbench**.
- Click the corner entry pill in the bottom-right corner, which displays the current prompt token count and pending suggestion count.
- Press `Alt+W` to open or collapse the window.
- Click **Open in Workbench** inside **Extensions → Memory**, **Extensions → Orchestrator**, or **Extensions → Image Generation**, or select **Image iteration studio** in the wand menu.

Drag the title bar to move the floating window, drag the bottom-right corner to resize, or double-click the title bar to maximize.

## Tabs

### Overview

Shows a token breakdown of the latest prompt across preset, character card, world books, memory graph, and chat history, alongside local rule-based **Suggestions** and status cards for every registered workbench.

![Workbench Overview](/images/workbench/01-overview.png)

Local suggestions check memory graph, orchestration, preset, and character card data on your device without calling an AI model. Each suggestion explains the numbers behind it and provides an action button to inspect or jump straight to the relevant AI editor.

### Q&A

A read-only diagnostic assistant. Ask questions in natural language—for example why a reply was written a certain way, why a request failed, or which part consumes the most tokens.

![Workbench Q&A](/images/workbench/02-qa.png)

Q&A reads local data on demand: recent chat floors, character card, bound world books, chat completion preset, prompt token breakdown, request inspector history, frontend logs, server logs, memory graph, and orchestration records. API keys and endpoint addresses are redacted before anything leaves your device, and **Show me before sending to the AI** lets you review the overview first. You can edit an earlier question in a new branch or branch from any answer.

### AI iteration

A single conversational workspace for editing Luker artifacts with diff review and rollback. Choose what to edit at the top:

- **Memory graph** — inspect and repair nodes, fields, and relationships in the current chat's graph.
- **Memory structure** — add, edit, reorder, or remove memory types, record items, extraction rules, and injection settings, either globally or for the active character.
- **Orchestration** — tune Spec, Agenda, Loop, and Director profiles, test changes with simulation, diagnose slow or failing runs, author skills, and create custom tools.
- **Preset** — edit the active Chat Completion preset's parameters and prompt entries, compare against a reference preset, adapt a preset for orchestration or tool tasks, and extract reusable skills.
- **Character card** — edit the active character card's fields and bound world books.
- **World book** — edit globally active world books or the books bound to the current character and chat.
- **Image Generation** — edit illustration prompt presets, exploration prompts, archived character visual profiles, and ComfyUI API-format workflows with live node introspection and draft test generation.

Proposed changes appear in a **Change list** with before/after diffs. Tick the changes to apply, discard them, or enable **Apply automatically** to apply edits immediately while keeping every step undoable.

![Workbench AI iteration](/images/workbench/03-ai-iteration.png)

### Change history

Lists every change applied through AI iteration or a suggestion button during the current session, filterable by workbench. Each entry can be undone individually.

![Workbench Change history](/images/workbench/04-change-history.png)

### Memory graph

Embeds the full Memory Lens workspace directly inside Workbench:

- **Graph** — interactive relationship web and chronological layout with node/relation filters and a detail inspector.
- **Timeline** — chronological story view grouped by summary tiers.
- **Data table** — tabular view with inline field editing.
- **Memory structure** — type and field editor, starter templates, import/export, persistent injection controls, and tag filtering.
- **Settings** — extraction cadence, LLM or RAG recall, compression, token trace, and iteration AI selection.

### Orchestration

Embeds the full Orchestra Lens workspace directly inside Workbench:

- **Flow** — visual workflow graph across **Pipeline** (Spec), **Single assistant** (Single Agent), **Dispatch** (Agenda), **Research loop** (Loop), and **Director team** (Director) modes; select any agent to inspect or edit its role prompt, task template, model, and tools.
- **Run** — live and recent run trace with step timeline, tool arguments and results, final output, JSON trace export, and one-click AI diagnosis.
- **History** — past runs recorded in this browser.
- **Stats** — per-agent duration and error breakdown with one-click bottleneck diagnosis.
- **Setup** — preset library management, global vs. character scope switching, skill management, and custom tools.
- **Settings** — execution mode, shared runtime limits, injection position and depth, and iteration AI selection.
- **Notes** — open and closed plot threads for the current chat.

### Image Generation

Embeds the Image Generation workspace directly inside Workbench:

- **Image Studio** — conversational workspace for **Free image generation** and **Character reference design**, with session branching, gallery history, single-image regeneration, and staged character profile review.
- **Character Archive** — global library of character appearance tags, outfits, and reference sheets, with a per-launch choice between **Fanwork exploration** and **OC design in studio**.
- **Run Traces** — live and recent illustration and exploration run traces with round timelines, prompts, JSON export, and one-click AI diagnosis.

### Settings

Configure one shared **AI connection** and **Generation preset** for Q&A and every AI iteration target, or set a target individually.

![Workbench Settings](/images/workbench/05-settings.png)

- **Shared** — the connection profile and generation preset used by targets that follow shared settings.
- **Set individually** — settings rows for Q&A and each AI iteration target. **Follow plugin setting** uses the iteration AI configured in the plugin; **Follow shared settings** uses the shared block. The **Current source** column resolves each value through target, plugin, shared settings, and the bundled example.
- **Example actions** — **Import example** installs the bundled `plugin-only` example, **Re-import example** overwrites an installed copy after confirmation, and **Derive from an existing preset** opens the preset workspace with the matching editing mode.
- **Confirmation** — toggle whether AI iteration shows changes in a review list before applying.
- **Read** — choose which local sources Q&A may access, how many surrounding chat floors to include, whether to redact secrets, and whether to preview before sending.
- **Window** — toggle the corner entry pill, toggle the `Alt+W` shortcut, and reset window position.
- **Suggestions** — enable or disable individual local check rules.
- **Prompts** — inspect the system prompts used by Q&A and each AI iteration target, and toggle the workbench instruction prefix.

## Related pages

- [Memory Graph](/features/memory-graph) — long-term memory extraction, recall, and structure
- [Multi-Agent Orchestration](/features/orchestrator/) — workflow modes, presets, and skills
- [Completion Preset Assistant](/features/preset-assistant) — preset editing modes and skill extraction
- [Character Card Editor Assistant](/features/card-editor/) — character card editing and CardApp Studio
- [Image Generation & AI Illustration](/features/image-generation) — image backends, reference images, character archive, and Studio workflows
- [Workbench Extension API](/development/extension-api/workbench) — register custom workspaces, iteration targets, Q&A providers, and suggestion rules
