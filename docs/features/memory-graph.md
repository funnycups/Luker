# Memory Graph

In a long conversation, early events, relationship changes, and world rules eventually drop out of the context window. Memory Graph collects important facts from the conversation into typed memory nodes in the background and recalls the relevant ones into the prompt, keeping long-term continuity intact hundreds of turns later.

Memory Graph is designed for long-form roleplay, serialized stories, and worlds that rely on stable continuity.

## How it works

Memory Graph runs three background tasks.

**Extraction.** After an AI reply, Memory Graph reviews the turn and records facts worth keeping into nodes. Four default types cover common roleplay: characters (identity, relationships, goals, inventory), locations (controller, danger), events, and plot threads. Types and record items can be customized globally or per character card.

**Recall.** When you send a message, Memory Graph selects nodes relevant to the current scene and injects them into the prompt. By default an LLM judges relevance; RAG vector recall is also available.

**Compression.** As events accumulate, older events merge automatically into higher-level summaries. Underlying details remain in the graph and can be expanded or recalled again when relevant.

Extraction can run built in or be delegated to the memory curator agent in [Multi-Agent Orchestration](/features/orchestrator/).

## Getting started

1. Open **Workbench** (wand menu → **Workbench**, corner pill, `Alt+W`, or **Extensions → Memory → Open in Workbench**) and switch to the **Memory graph** workspace tab.
2. Open the **Settings** view inside **Memory graph** and turn on Memory Graph.
3. Choose the API connection and chat-completion preset used for extraction and recall. If you need a clean tool-task preset, import the bundled `plugin-only` preset from **Workbench → Settings**. Extraction is structured bookkeeping, so a smaller model handles it well.
4. Chat normally, then open **Memory graph** in Workbench to inspect the generated graph.

## Views in Workbench

The **Memory graph** workspace inside Workbench provides five views:

- **Graph** — interactive Relationship web and Chronological layouts with node/relation filters, injected-text inspection, and a node details panel.
- **Timeline** — chronological story view grouped by summary tiers.
- **Data table** — tabular view of nodes with inline field editing.
- **Memory structure** — edit memory types, record items, extraction rules, persistent injection toggles, templates, import/export, and the **Tag filter** (which strips thinking blocks or status bars before extraction and recall read AI replies).
- **Settings** — extraction cadence and context window, LLM or RAG vector recall, compression thresholds, token usage trace, and iteration AI settings.

![Memory Graph view in Workbench](/images/memory-graph/memory-graph-view.png)

![Memory Timeline view](/images/memory-graph/memory-timeline-view.png)

![Memory Data table view](/images/memory-graph/memory-table-view.png)

## Reviewing and editing with AI

In **Data table** or **Graph**, you can edit fields, titles, and links directly; changes are saved to the current chat.

For broader edits, switch to **Workbench → AI iteration** and choose:

- **Memory graph** — describe repairs in plain language, such as merging duplicate character nodes, updating outdated location states, or adding missing relationships in the current chat.
- **Memory structure** — describe new memory types, record items, extraction instructions, or injection/compression adjustments globally or for the active character.

Proposed changes appear in the **Change list** with before/after diffs. Tick what to apply, or undo applied steps in **Change history**.

![Repairing Memory Graph nodes with AI](/images/memory-graph/memory-ai-revise-proposal.png)

## Fitting the structure to your world

Under **Memory graph → Memory structure**, or via **AI iteration → Memory structure**, you can add types and record items tailored to your setting—such as magic systems, factions, or investigation clues—or start from a built-in template.

![Memory structure editor](/images/memory-graph/memory-schema-editor.png)

Custom structures can be saved globally or only for the active character card (travelling with the card on export). Each type carries its own extraction instructions and optional extraction cadence.

### Persistent injection

World laws, inviolable character traits, and core plot threads belong in the prompt every turn. Enable **Always visible to the AI** on those memory types so their nodes are injected persistently. Setting a lookback floor limit moves older entries back into the on-demand recall candidate pool.

## Common questions

### Memories are wrong or duplicated

Describe the issue in **Workbench → AI iteration → Memory graph** to merge duplicate nodes, fix fields, or update links.

### What happens when I edit or delete a message

Memory Graph follows the chat history. Editing or deleting a message, or switching a swipe, rolls memory back to the state before the affected message.

### Moving to another device or sharing memories

Export graph JSON from **Memory graph → Settings** and import it into the target chat. Import supports keeping original floor numbers, binding nodes to the latest floor, or binding to a chosen floor.

### Regenerating on the same floor

Swipes and regenerations on the same floor reuse the previous recall result, keeping context consistent and avoiding duplicate model calls.

## RAG vector recall

RAG recall uses vector search. Create an embedding profile under the Embedding tab of the API connection panel, select an embedding model and connection, then select that profile in **Memory graph → Settings** and build the vector index before switching recall to RAG.

## Related pages

- [Workbench](/features/workbench) — unified workspace, Q&A, AI iteration, and change history
- [Multi-agent orchestration](/features/orchestrator/) — hand memory curation to an orchestration agent
- [World Info basics](/basics/world-info) — how generated memories coexist with hand-written entries
- [Character card basics](/basics/character-cards) — custom memory structures travel with the card
