# Multi-Agent Orchestration

Multi-Agent Orchestration (Orchestrator) is one of Luker's core exclusive features, providing a flexible multi-AI Agent collaboration framework. It allows users to define multiple Agents with different responsibilities — distillers, constraint agents, planners, memory analyzers, reviewers, synthesizers, etc. — that collaboratively process each AI response generation according to a preset workflow. The Orchestrator automatically triggers after WorldInfo parsing is complete, injecting the collaborative results of multiple Agents into the final prompt to guide the main model in generating higher-quality responses.

The Orchestrator runs entirely on the frontend with no backend code. Character card-level orchestration configurations are saved and exported with the character card.

The Orchestrator supports triggering on five generation types: `normal`, `continue`, `regenerate`, `swipe`, and `impersonate`. Other generation types do not trigger the orchestration process.

## Three Execution Modes

The Orchestrator provides three execution modes, adapting from simple to complex scenarios:

```
spec    → Stage→Node DAG, the most flexible static workflow
single  → Single-node simplified mode
agenda  → Planner dynamic scheduling, the most flexible dynamic workflow
```

### Spec Workflow

Spec Workflow is the most flexible static mode, using a **Stage → Node** DAG (Directed Acyclic Graph) structure:

- **Stages**: Top-level organizational units of the workflow; stages execute strictly in serial order
- **Nodes**: Execution units within a stage; each node references an LLM Preset and is responsible for a specific task
- **Execution method**: Nodes within a stage support `serial` and `parallel` (using `Promise.all`) execution
- **Node types**: `worker` (work nodes) and `review` (review nodes)

When each node executes, the system builds a message list (system prompt + user prompt template + context) to call the LLM, with support for node iteration (controlled by "Node Iteration Max Rounds"). Stage outputs are aggregated and automatically passed to the next stage.

The default Spec workflow includes the following stage structure:

1. **Distiller** → **Constraint Agent** (parallel execution)
2. **Planner** + **Memory Analyzer** (parallel execution)
3. **Reviewer**
4. **Synthesizer**

#### Template Variables

Node user prompt templates support the following placeholder variables:

| Variable | Description |
|----------|-------------|
| <span v-pre>`{{recent_chat}}`</span> | Recent chat messages |
| <span v-pre>`{{last_user}}`</span> | Last user message |
| <span v-pre>`{{previous_outputs}}`</span> | Outputs from preceding stages |
| <span v-pre>`{{distiller}}`</span> | Distiller output |
| <span v-pre>`{{previous_orchestration}}`</span> | Previous orchestration result (auto-injected, no manual writing needed) |

The <span v-pre>`{{previous_orchestration}}`</span> is an auto-injected variable — the system automatically inserts the previous orchestration result before the template text, without users needing to explicitly reference it in the template.

### Single Agent Mode

Single Agent Mode is a simplified version of the Spec workflow. The system internally auto-builds a Spec containing only a single node, then follows the unified execution flow. Suitable for simple scenarios that don't require multi-Agent collaboration, while retaining all configuration capabilities of Spec mode (such as custom system prompts, API routing, etc.).

### Agenda Planner

Agenda Planner is the most dynamic mode. A Planner Agent dynamically schedules other Agents through Function Calling:

- The Planner maintains a todo list and dynamically decides which Agent to call next based on task progress
- Each Agent can independently configure system prompts, API routing, and Chat Completion presets
- Runtime boundaries are limited by three parameters:
  - Planner Max Rounds: Maximum scheduling rounds for the Planner
  - Max Concurrent Agents: Upper limit of simultaneously running Agents
  - Max Total Executions: Upper limit of total executions across all Agents

Agenda mode relies on Luker's [Function Call Runtime](/improvements/function-call-runtime) framework for the Planner's tool calling capabilities.

::: info Agenda ↔ Spec Conversion
The Orchestrator supports configuration conversion between Agenda and Spec modes:

- Best-effort conversion of Agent sets defined in Agenda mode to Spec workflow structure
- Copy Spec presets to the Agenda editor
- Copy Agenda Agents to the Spec editor

Note: Conversion is best-effort and does not guarantee perfect reproduction. For example, Agenda mode's dynamic scheduling logic cannot be fully mapped to Spec's static DAG structure, and manual adjustments may be needed after conversion.
:::

## Workflow Editor

The Orchestrator provides a visual workflow editor (supports opening in a standalone popup), where users can:

- Add, delete, and reorder stages
- Add, delete, and reorder nodes within stages
- Configure independent LLM presets and API presets for each node
- Set node system prompts and user prompt templates
- Configure stage execution method (serial / parallel)
- Mark nodes as review nodes

Each preset can independently configure API routing, meaning different Agents can use different LLM backends. For example: the distiller uses a low-cost model to reduce overhead, while the synthesizer uses a high-quality model to ensure output quality. Empty API presets fall back to the global orchestration API preset; empty Chat Completion presets fall back to the global orchestration preset.

Agenda mode also has a corresponding editor panel for managing the Agent list and Planner configuration.

## Review Nodes

Review Nodes are a special node type in Spec workflows, used for quality control of preceding work nodes' outputs. Review nodes interact with the workflow engine through two dedicated tools:

| Tool | Purpose |
|------|--------|
| `luker_orch_review_approve` | Approve preceding work nodes' output; workflow continues to the next stage |
| `luker_orch_request_rerun` | Request rerun of specified preceding work nodes, with modification suggestions |

Key constraints for review nodes:

- Can only review nodes from the **directly adjacent preceding work stage**
- Reruns only the specified node IDs, not the entire stage
- Rerun count is limited by "Review Rerun Max Rounds" (default 0, max 20)
- After rerun, the review node runs again, forming an "execute → review → rerun → re-review" loop until approved or round limit is reached
- Review nodes must output review feedback

The system includes multiple built-in review node prompt engineering rules to ensure consistency and reliability of review behavior. These rules define the check gates that review nodes must include, used as constraints when AI generates review node configurations.

## AI-Generated Configuration

The Orchestrator provides two AI-assisted configuration generation methods, lowering the barrier for manual configuration.

### AI Quick Build

One-click generation of complete orchestration configuration. Users describe requirements in natural language, and AI automatically generates a complete workflow including stages, nodes, and preset assignments. The generation process considers knowledge book read nodes and Anti-Data Guard nodes, ensuring the generated configuration includes necessary protection mechanisms.

### AI Iteration Studio

AI Iteration Studio provides multi-round conversational fine-grained editing capabilities, a more powerful AI-assisted tool than Quick Build:

- **Session Persistence**: Iteration sessions are saved to the character card or global settings, supporting up to **24 sessions**. Sessions can be loaded, deleted, and managed
- **Simulation Testing**: Simulate workflow execution without actually running orchestration, verifying configuration correctness. For example, you can input "Please simulate the current user's latest input as 'I walked into the tavern and looked around'" to test orchestration behavior in specific scenarios
- **Auto-Continue**: Supports AI automatically advancing the iteration process without users manually triggering each step
- **Diff Approval**: Each AI modification generates a diff; users can approve or reject item by item
- **Rollback**: Supports undoing applied AI modifications
- **Regenerate**: Supports regenerating AI responses
- **`<thought>` Tag Stripping**: Thinking processes in AI responses (`<thought>` tag content) are automatically removed during display
- **Message Folding**: Long messages exceeding 1200 characters or 18 lines are automatically folded; simulation context is also auto-folded

AI Iteration Studio session history is persisted to the character card or global settings. This is a different concept from runtime traces (which are only saved in memory).

## Diff Engine

The Orchestrator includes a complete built-in Diff engine for modification visualization in AI Iteration Studio:

- **LCS Line-level Diff**: Precise difference calculation based on the Longest Common Subsequence algorithm
- **Inline View (Inline Diff)**: Displays additions, deletions, and modifications with color markers in the same column
- **Side-by-Side View (Side-by-Side Diff)**: Left-right comparison showing content before and after modification
- **Draggable Splitter**: Freely adjustable left-right panel width in side-by-side view
- **Expand Diff**: Supports expanding collapsed diff blocks to view full context
- **Rollback Support**: Can undo applied modifications, restoring to the pre-modification state

This Diff engine is shared with the [Character Card Editor](/features/card-editor).

## Result Injection and Reuse

Orchestration results are automatically injected into SillyTavern's prompt construction pipeline. Injection behavior can be controlled through the following settings:

| Setting | Description | Default |
|---------|-------------|--------|
| Injection Position | Where orchestration results are inserted in the prompt | `IN_CHAT` |
| Injection Depth | Injection depth of orchestration results | `1` |
| Injection Role | Which role identity orchestration results are injected as | `SYSTEM` (also supports `USER` / `ASSISTANT`) |
| Custom Instruction Prefix | Custom instruction prefix before injected text | `"Follow the orchestration guidance below and prioritize it when drafting the next in-character reply."` |

Orchestration results are bound to the user message floor that triggered orchestration. When users perform swipes on the same floor, the system reuses existing orchestration results, avoiding re-execution of the entire workflow. When configuration changes, the system automatically re-applies the latest orchestration results.

Runtime traces (each node's input/output, execution time, etc.) are only saved in memory, automatically cleared when switching chats, and not persisted to disk.

## Import/Export

Orchestration configurations support JSON file import/export, using two format identifiers:

| Format | Identifier | Applicable Mode |
|--------|-----------|----------------|
| V1 | `luker_orchestrator_profile_v1` | Spec Workflow Mode |
| V2 | `luker_orchestrator_profile_v2` | Agenda Planner Mode |

Export filename format is `luker-orchestrator-[agenda-][global|character-{name}].json`, supporting both global and character card-level export.

During import, the system automatically detects the file's mode (Spec / Agenda) and requires it to match the current execution mode. Users can choose to apply imported configuration to global or a specific character card.

## Configuration Reference

The following are the Orchestrator's main configuration options:

| Setting | Description | Default / Range |
|---------|-------------|----------------|
| Execution Mode | Spec / Single Agent / Agenda | `spec` |
| Injection Position | Where orchestration results are inserted in the prompt | `IN_CHAT` |
| Injection Depth | Injection depth of orchestration results | `1` |
| Injection Role | Which role identity orchestration results are injected as | `SYSTEM` / `USER` / `ASSISTANT` |
| Custom Instruction Prefix | Custom instruction prefix for orchestration results | See above |
| Planner Max Rounds | Agenda mode Planner maximum scheduling rounds | — |
| Max Concurrent Agents | Agenda mode maximum concurrent Agents | — |
| Max Total Executions | Agenda mode maximum total executions | — |
| Requests Per Minute Limit | Requests per minute limit (parallel node throttling) | — |
| Agent Timeout | Single Agent execution timeout (seconds) | — |
| Tool Call Retries | Retry count for failed LLM tool calls | — |
| Node Iteration Max Rounds | Iteration round control for a single node | — |
| Review Rerun Max Rounds | Maximum rerun rounds for review nodes | `0` (max 20) |
| Global API Preset | Global default API connection preset | — |
| Global Chat Completion Preset | Global default Chat Completion preset | — |
| Include World Info | Whether to include World Info in orchestration nodes | — |
| Anti-Data Guard | Block specific terms (e.g., `OOC`, `meta`, `system note`, `author`) | Enabled |
| `<thought>` Tag Stripping | Whether to remove thinking tags from AI output | — |
| Message Folding Threshold | Characters 1200 / Lines 18 | — |
| Node API Preset | Node-level API preset override | Empty (falls back to global) |
| Node Chat Completion Preset | Node-level Chat Completion preset override | Empty (falls back to global) |

::: tip
Each node in the Orchestrator can independently configure API presets and Chat Completion presets, overriding global defaults. This allows you to assign different models and parameters to different Agents — for example, using a low-cost model for distillation and constraint tasks, and a high-quality model for final synthesis.
:::

## Integration with Character Cards

Orchestration configurations can be bound to character cards and saved with them. After binding:

- Orchestration configurations are exported with the character card; other users automatically get the recommended orchestration workflow when importing the card
- Card creators can customize the optimal multi-Agent collaboration scheme for their characters
- Character cards can specify independent execution modes, automatically applied when switching characters
- Character card overrides can be independently enabled or disabled
- Supports clearing character card overrides (reverting to global configuration)
- Users can make personalized adjustments on top of character card-bound configurations

## Related Pages

- [Function Call Runtime](/improvements/function-call-runtime) — Agenda mode's Planner relies on this framework for tool calling
- [Character Card Editor](/features/card-editor) — Shares the Diff engine with the Orchestrator
- [Card-Bound Presets and Personas](/improvements/card-bound-presets) — Orchestration configuration's character card binding mechanism
