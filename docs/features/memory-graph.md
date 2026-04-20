# Memory Graph

Memory Graph is one of Luker's most core exclusive features, specifically designed to solve the most common pain point in roleplay — **character amnesia**.

LLM context windows are limited. After conversations exceed several hundred turns, important early information (character relationships, key events, world settings) gets truncated and lost, causing characters to "forget" what happened before. Memory Graph automatically extracts key information from conversations into structured knowledge nodes and intelligently recalls and injects them into the prompt when needed, enabling characters to consistently remember important relationships, events, and world settings across hundreds of conversation turns.

Unlike simple keyword search or vector retrieval, Memory Graph uses graph structures and multi-layer algorithms to ensure recalled memories are both semantically relevant and comprehensively covered, avoiding the pitfall of only remembering the "most similar" content while missing other important information.

## How It Works

Memory Graph's workflow can be summarized in three phases: **Auto-extraction → Intelligent Recall → Hierarchical Compression**.

### Auto-extraction

After each AI response, Memory Graph automatically analyzes the latest conversation content and extracts information worth remembering. The extraction process is performed by an LLM, outputting structured knowledge nodes.

Extracted information is divided into two major tiers and four default types:

**Semantic Layer Nodes** (persistent structured knowledge, merged and updated):

| Type | Description | Example |
|------|-------------|--------|
| Character State | Character's name, identity, goals, relationships, current state | "Eileen is a healer, currently injured" |
| Location State | Location's name, controller, danger level, resources | "Dark Forest is controlled by elves, high danger level" |
| Rule Constraint | Rules and restrictions in the world setting | "Magic cannot be used in the Holy Domain" |

**Event Layer Nodes** (plot records, new nodes created each extraction, never merged):

| Type | Description | Example |
|------|-------------|--------|
| Event Summary | Important events that occurred in the plot | "The protagonist was ambushed in the forest" |

::: info Special Nature of Event Nodes
Event nodes are fundamentally different from other types:

- **New nodes are created each extraction**: Titles auto-increment and are not merged into existing nodes like character states, because events are independent records on the timeline
- **Highest-tier timeline is always injected**: Event nodes are treated as core storyline context; the highest-tier timeline summaries are always injected into the prompt, ensuring the AI maintains awareness of the overall plot direction
- **Compressed lower-tier events are hidden**: When events accumulate too many, old events are compressed into higher-tier summaries. Compressed lower-tier event nodes are no longer permanently injected, but remain in the graph and can be rediscovered through the recall mechanism when needed

In simple terms: the AI can always see the "major events" (highest-tier summaries), but specific event details are only recalled and supplemented when the conversation touches on them.
:::

You can control extraction frequency through the "Extraction Interval" setting — for example, setting it to `2` means extraction is triggered every 2 AI responses, reducing LLM call overhead.

### Intelligent Recall

When you send a new message triggering AI generation, Memory Graph recalls the most relevant content from accumulated memories based on the current conversation context and injects it into the prompt for AI reference.

Memory Graph supports multiple recall methods:

| Recall Method | Description |
|---------------|-------------|
| LLM Recall | Let the LLM directly select relevant nodes from the memory store, supporting multi-round deep exploration |
| Hybrid Recall | Combines vector retrieval, graph diffusion, lexical matching, and other signals for comprehensive scoring |
| Hybrid + Reranking | Uses a reranking model on top of hybrid recall to further optimize results |
| Hybrid + LLM | Lets the LLM perform secondary filtering on candidate nodes on top of hybrid recall |

LLM Recall is used by default; you can switch recall methods in the Memory Graph settings panel.

### Hierarchical Compression

As conversations progress, event memories continuously accumulate. Memory Graph automatically performs hierarchical compression on old event nodes — merging multiple related events into a higher-tier summary node, preserving core information while controlling total memory volume.

Compression is recursive: when summary nodes at a certain tier also exceed the threshold, they are further compressed into even higher-tier summaries, recursing upward until node count drops below the threshold. For example, multiple battle events are first compressed into "Forest Campaign," and multiple campaigns may be further compressed into "Northern Expedition." Compressed summary nodes can still be expanded to view the original sub-events.

## Getting Started

### Basic Setup

1. Find "Memory Graph" in Luker's extension settings
2. Toggle on "Enable Memory Graph"
3. Start chatting — Memory Graph works automatically

### Configuring LLM Presets

Memory Graph's extraction and recall require LLM calls, but **can use different models and presets from the main conversation**. This means you can:

- Use a high-quality model for the main conversation (e.g., Claude Opus) and a more economical model for Memory Graph (e.g., Claude Haiku)
- Specify different API connections and Chat Completion presets for extraction and recall separately

Related settings:

| Setting | Description |
|---------|-------------|
| Extraction API Preset | API connection preset for extraction (empty = use main connection) |
| Extraction Preset | Chat Completion preset for extraction |
| Recall API Preset | API connection preset for recall |
| Recall Preset | Chat Completion preset for recall |

### Adjusting Recall Behavior

| Setting | Default | Description |
|---------|---------|-------------|
| Enable Recall | `true` | Whether to enable recall |
| Recall Method | `llm` | Recall method: `llm` / `hybrid` / `hybrid_rerank` / `hybrid_llm` |
| LLM Recall Max Iterations | `3` | Maximum iteration rounds for LLM recall |
| Recall Query Message Count | `2` | Number of recent messages referenced during recall |
| Hybrid Recall Max Results | `15` | Maximum results returned by hybrid recall |

### Extraction Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| Extraction Interval | `1` | Trigger extraction every N AI responses |
| Rounds Per Batch | `1` | Number of response rounds processed per batch |
| Extraction Context Rounds | `2` | Number of context rounds included during extraction |
| Exclude Recent Rounds | `0` | Exclude the most recent N rounds from extraction |

## Injection Methods

Memory Graph supports two injection methods — choose based on your needs:

### Persistent Injection

You can set certain memory types to persistent injection, making them **always** appear in the prompt regardless of recall triggers. For example, "Rule Constraint" type nodes are persistently injected by default, ensuring world rules are never forgotten.

Persistent injection is implemented by writing nodes as World Info entries, taking effect alongside the World Info system.

### Recall Injection

Other memory types (such as character states, event summaries, etc.) are dynamically injected through the recall mechanism by default — only memories relevant to the current conversation are injected, avoiding excessive context space usage.

::: info
Persistent and recall injection are not mutually exclusive. The same node type can have both persistent and recall injection enabled — persistent ensures baseline information is always available, while recall supplements with more details relevant to the current context.
:::

Recall injection position and role can be configured:

| Setting | Default | Description |
|---------|---------|-------------|
| Recall Injection Position | `atDepth` | Injection position |
| Recall Injection Depth | `9999` | Injection depth |
| Recall Injection Role | `SYSTEM` | Injection role (system / user / assistant) |

### Configuring Injection Methods

In the Memory Graph settings panel, you can configure persistent injection and recall enablement separately for each node type. Both can be enabled simultaneously — persistent ensures baseline information is always available, while recall supplements with context-relevant details.

::: tip How to Choose
- **Rule Constraints** and other information that doesn't change with conversation are suitable for persistent injection (enabled by default)
- **Character States, Event Summaries** and other dynamic information are suitable for recall injection (default behavior)
- If you find certain important information is frequently missed, you can set the corresponding node type to persistent injection in the Memory Graph settings panel
:::

### Result Reuse

When you perform a swipe or regeneration on the same conversation turn, Memory Graph automatically reuses the previous recall results without re-executing the recall process. This saves LLM call costs and ensures memory context consistency within the same conversation turn.

## Viewing Memories

You can view the current memory state through Memory Graph's UI panel:

- **Graph Visualization**: View all memory nodes and their relationships graphically
- **Table View**: View structured fields of all nodes by type
- **Search**: Search memory nodes by keyword, with type filtering support
- **View Recent Injection**: View the memory content most recently injected into the prompt

## Custom Memory Structure

Character cards can customize Memory Graph's node type definitions, tailoring the memory structure for specific characters. In the Memory Graph settings panel, you can add, edit, or delete node types, overriding the default type definitions. For example, a fantasy world character card can define exclusive node types like "Magic" and "Faction," making Memory Graph better fit the character's world setting. Custom node types are saved and exported with the character card.

## World Info Projection

Memory Graph can project memory nodes as [World Info](/basics/world-info) entries, participating in prompt construction through World Info's keyword matching and scan depth mechanisms. Projection comes in two forms:

- **Persistent Projection**: Writes persistently injected nodes as persistent World Info entries
- **Runtime Projection**: Writes recall results as temporary World Info entries, automatically cleaned up after generation

## Import/Export

Memory Graph data supports import/export as JSON files. Exported data contains all nodes, edges, and metadata.

Three binding modes are available during import:

| Mode | Description |
|------|-------------|
| Restore | Preserves the floor numbers from export, used for data recovery in the same chat |
| Bind to Latest Floor | Binds all imported nodes to the current latest AI response floor |
| Bind to Specified Floor | Manually enter the target floor number |

## Change Rollback

Memory Graph has a built-in complete change rollback mechanism. When you edit or delete messages or perform swipes, Memory Graph automatically rolls back to the state before the affected messages, ensuring memories remain consistent with conversation history.

## Complete Configuration Reference

<details>
<summary>Click to expand the complete configuration list</summary>

### Basic Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| Enable Memory Graph | `false` | Master switch for the plugin |
| Extraction Interval | `1` | Trigger extraction every N AI responses |
| Max Processing Rounds | `900` | Maximum processing rounds limit |

### Vector and Diffusion Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| Embedding Source | `transformers` | Embedding source from Vector Storage extension settings (`vectors.source`) |
| Embedding Model | (empty) | Embedding model from Vector Storage extension settings (source-specific model field) |
| Vector Retrieval Top-K | `20` | Top-K count for vector retrieval |
| Graph Diffusion Steps | `2` | Graph diffusion steps |
| Graph Diffusion Decay | `0.6` | Graph diffusion decay coefficient |
| Graph Diffusion Top-K | `100` | Graph diffusion Top-K |
| Graph Diffusion Teleport Probability | `0.0` | Graph diffusion teleport probability |

### Reranking Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| Enable Reranking | `false` | Whether to enable reranking |
| Reranking Service Source | `cohere` | Reranking service source |
| Reranking Model | (empty) | Reranking model name |

### Other Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| Requests Per Minute Limit | `0` | Requests per minute limit (0 = unlimited) |
| LLM Visible Recent Messages | `5` | Number of recent messages visible to LLM during generation |
| Include World Info with Preset | `true` | Whether to include World Info when using presets |
| Override World Info Name | (empty) | Override World Info name |
| World Info Entry Sort Base | `9800` | World Info entry sort base value |
| Tool Call Max Retries | `2` | Maximum retries for failed tool calls |
| Exclude Recent Rounds' Nodes | `2` | Exclude nodes from the most recent N rounds during recall |

</details>

## Technical Deep Dive

<details>
<summary>Click to expand technical details</summary>

### Multi-Stage Hybrid Recall Pipeline

In hybrid recall mode, Memory Graph executes a recall pipeline with 8 stages:

1. **Vector Pre-filtering**: Retrieve the most semantically similar Top-K nodes from the vector database
2. **Entity Anchoring**: Match known entity names and aliases from the query text
3. **Build Seeds**: Merge vector hits and entity anchors as diffusion starting points
4. **Build Adjacency List**: Construct the graph's dual-layer adjacency list
5. **PEDSA Graph Diffusion**: Starting from seed nodes, propagate energy through the graph structure to discover indirectly related memories
6. **Hybrid Scoring**: Merge vector scores, diffusion energy, lexical matching, anchor scores, recency bonuses, and other multi-dimensional signals
7. **Cognitive Pipeline (NMF / FISTA / DPP)**: Three algorithms ensure recall results are comprehensive and diverse
8. **Optional Reranking**: Use an external reranking model to further optimize results

### Cognitive Layer Algorithms

- **NMF Topic Rebalancing**: Uses Non-negative Matrix Factorization to identify underrepresented topic directions and boost scores of their representative nodes
- **FISTA Residual Discovery**: Uses the Fast Iterative Shrinkage-Thresholding Algorithm to discover semantic directions in the query not covered by the candidate set, and performs supplementary searches
- **DPP Diversity Sampling**: Uses Determinantal Point Processes to select a high-quality and mutually diverse subset from candidates, avoiding overly concentrated recall results

### PEDSA Graph Diffusion

The PEDSA (Personalized Efficient Diffusion with Sparse Approximation) algorithm enables Memory Graph to discover important memories that have no direct semantic association with the query but are indirectly related through graph structure. Starting from seed nodes, it propagates energy along graph edges over multiple rounds, supporting teleport probability (PageRank-like) and sparse approximation control.

### Vector Index

Memory Graph uses an incremental update strategy to manage vector embeddings — detecting node content changes through hash comparison and only regenerating embedding vectors when content actually changes.
In hybrid recall, embedding source and model are read from Vector Storage extension settings, so available providers follow Vector Storage capabilities (including Jina).
If Vector Storage settings are unavailable, Memory Graph falls back to its legacy local source/model fields.

For more technical implementation details, please refer to the source code.

</details>

## Related Pages

- [Function Call Runtime](/improvements/function-call-runtime) — Memory Graph's LLM interaction relies on this framework
- [World Info Basics](/basics/world-info) — Basic concepts of World Info projection
