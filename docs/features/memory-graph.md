# Memory Graph

In a long conversation, the context window fills up and early events, relationship changes and world rules fall out of view. The character starts to forget. Memory Graph collects the important facts from the conversation into memory nodes in the background, then recalls the relevant ones into the prompt, so a character can remember the same things you do hundreds of turns later.

Memory Graph is built for long-form roleplay, serialized stories and worlds that need stable continuity. Short chats and one-off scenes do not need it.

## How it works

Memory Graph runs three jobs in the background.

**Extraction.** After an AI reply, Memory Graph reviews the turn and writes the facts worth keeping into nodes. Four types are defined by default: characters (identity, relationships, goals, inventory), locations (who controls them, how dangerous they are), events, and ongoing threads. Types and fields can be adjusted per card.

**Recall.** When you send a message, Memory Graph selects the nodes relevant to the current scene and injects them into the prompt. By default an LLM judges relevance; vector retrieval is also available.

**Compression.** When events pile up, older events roll up into higher-level summaries. The details stay in the graph, can be expanded, and are recalled again when relevant.

Extraction can run built in or be handled by the memory-curator agent in multi-agent orchestration.

## Getting started

1. Open **Extensions → Memory** and turn on Memory Graph.
2. In the same panel, choose the API connection and chat-completion preset used for recall and extraction. The question-mark button beside the preset dropdown explains what kind of preset the slot expects and imports a bundled one in a click. Memory Graph does not need the same model as the main chat; extraction is structured bookkeeping, so a smaller model can handle it.
3. Chat normally. After a few turns, open the Memory panel to inspect the result.

The panel has three views: the graph view shows nodes and links, the node view lists content by type, and the recall view shows what was last injected into the prompt.

## Reviewing and editing memories

The node view lets you edit fields, titles and links directly; changes are saved to the current chat.

For broader repairs, use AI revision. It opens from two places:

- the robot button in the graph viewer toolbar
- **Memory panel → Advanced → AI revise**

Describe the problem in plain language, for example "Eileen and Elena are the same person; merge the duplicate nodes" or "the protagonist has left the Northern Reach; update the location state." The workbench reads the current graph, consults the chat and world book when needed, and turns the changes into reviewable cards. Approve to apply, reject to discard, and roll back applied changes if needed. Sessions are saved per chat, so you can close the panel and continue later.

Before the first use, choose the iteration API connection and preset under **Advanced**. To replace the built-in instructions, edit the **Graph revision prompt**.

## Fitting the graph to your world

The default types cover common roleplay, while fantasy, science fiction and mystery settings often need their own structure. In the **Advanced** section of the Memory panel, click **Open Schema Editor** to add types and fields.

For example:

- Magic system: name, source, limits
- Faction: name, leader, goals
- Case clue: content, points to, reliability

Custom types are saved with the character card and exported with it. Each type can carry extraction instructions describing how its information should be recorded, and an extraction interval for types that change slowly.

You can also configure the graph in natural language. Open **Advanced → AI configure Memory Graph**, describe the types, fields or extraction rules you want, and confirm each proposed change.

### Keep rules in the prompt

World laws, inviolable character traits and narrative prohibitions should not depend on recall. Mark the corresponding type as **persistent injection** and its nodes appear in the prompt every turn. Persistent nodes leave the recall pool, so they do not take up context twice.

## Common questions

### Memories are wrong or duplicated

Describe the problem to AI revision, which merges duplicate nodes, deletes entries, and changes fields and links.

### What happens when I edit or delete a message

Memory Graph follows the chat history. Editing or deleting a message, or switching a swipe, rolls memory back to the state before the affected message.

### Moving to another device or sharing memories

Export JSON from the Memory panel and import it into the target chat. Import can keep the original floor numbers, bind every node to the latest floor, or bind to a chosen floor. Importing a long campaign's memory into an empty chat lets you continue from floor 0 with the existing world and relationships.

### Does regenerating the same floor recall twice

No. Swipes and regeneration on the same floor reuse the previous recall result, keeping the context consistent and avoiding a duplicate call.

## Settings

The settings panel is grouped by job:

- **Extraction**: enable, extraction interval, and the model used for extraction. An interval of 2 extracts every second AI reply, halving the cost.
- **Recall**: LLM recall or RAG recall, result count, injection position and depth. RAG recall requires an embedding profile first; rerank and query rewrite improve results at the cost of extra calls and latency.
- **Compression**: automatic compression and its frequency. Turn it on when events accumulate.
- **Persistent injection**: configured per node type. Suited to world rules and core character facts.
- **Advanced**: presets for AI revision and AI configuration, import and export, and vector index rebuild.

RAG recall uses vector search. Before enabling it, create an embedding profile under the Embedding tab of the API connection panel, choose an embedding model and connection, then select that profile in the Memory panel and build the vector index. Once indexing finishes, switch recall to RAG.

## Related pages

- [Multi-agent orchestration](/features/orchestrator/) — hand memory curation to an orchestration agent
- [World Info basics](/basics/world-info) — how generated memories coexist with hand-written entries
- [Character card basics](/basics/character-cards) — custom memory types travel with the card
