# Spec Mode

Spec is the orchestrator's default mode and the baseline that other modes are compared against. It splits the workflow into a sequence of **Stages**, each with one or more **Nodes** running serially or in parallel; stages run strictly serially — Stage 2 cannot start until every node in Stage 1 has finished. One node = one LLM call + one prompt template. The final stage produces the briefing that's injected into the main model; everything upstream is preparation for it.

::: tip You're already using it
When you toggle the orchestrator on, Spec is the default — and it ships with a working multi-stage workflow (distiller, planner, constraint, review, synthesizer…). This page is about **modifying the default workflow, building a new one, and understanding why the default is shaped the way it is**.
:::

::: warning 99% of the time, don't hand-edit
Before you hand-edit stages and nodes, take a look at the [AI Iteration Studio](/features/orchestrator/iteration-studio) — describe what you want in one sentence, the AI returns a proposal, you approve change-by-change. Hand-editing is reserved for the corner cases the Studio can't reach.
:::

## Concept refresher

A few terms become useful once you start customizing:

- **Stage** — a horizontal slice of the workflow. Stages run strictly serial; Stage 2 cannot start until Stage 1 finishes.
- **Node** — an execution unit inside a stage. **One node = one LLM call + one prompt template**.
- **DAG** — directed acyclic graph. In plain English: "a flowchart with order, no loops."

Each stage has one of two execution modes:

- **Serial** — nodes run one after another within the stage.
- **Parallel** — nodes run concurrently with `Promise.all`.

Each node is either a **worker** (does work) or a **review** node (validates the previous stage's outputs).

## Manual: Spec workflow editor

For fine-grained customization that the Studio can't reach, edit stages and nodes directly. From the orchestrator panel: **Open Orchestration Editor**.

![Spec editor](/images/orchestrator/orch-spec-editor.png)

Left panel is the workflow (stages and their nodes). Right panel is the agent preset library. Each node references one preset, which carries the system prompt, user prompt template, optional API/Chat-Completion preset overrides, and execution flags.

### Template variables

User prompt templates support these placeholders:

| Variable | Meaning |
|---|---|
| <span v-pre>`{{recent_chat}}`</span> | Recent chat messages |
| <span v-pre>`{{last_user}}`</span> | The most recent user message |
| <span v-pre>`{{previous_outputs}}`</span> | Outputs from preceding stages |
| <span v-pre>`{{distiller}}`</span> | The distiller node's output specifically |
| <span v-pre>`{{previous_orchestration}}`</span> | Previous turn's orchestration result. **Auto-prepended at runtime — you typically don't need to reference it.** |

### Review nodes

A review node checks the previous worker stage's outputs and uses two dedicated tool calls:

| Tool | Purpose |
|---|---|
| `luker_orch_review_approve` | The work is good; advance to the next stage. |
| `luker_orch_request_rerun` | One or more nodes need to redo their work; suggests changes. |

Constraints:

- A review node only sees and re-runs nodes from the **immediately preceding** worker stage.
- Reruns are scoped to specific node IDs, not the whole stage.
- Rerun count is bounded by **Review Rerun Max Rounds** (default 2, max 20). When set to 0, the review node decides only "approve or fail" — no reruns.
- After rerun, the review node runs again, forming an "execute → review → rerun → re-review" loop until approved or the limit is hit.
- Review nodes must emit review feedback.

## Common Recipes

| I want… | Do this |
|---|---|
| AI to plan its scene before writing | In the [AI Iteration Studio](/features/orchestrator/iteration-studio), ask for "two stages — first plans the next beat, then writes the prose" |
| AI to stop breaking character | Enable Anti-Data Guard; in the [AI Iteration Studio](/features/orchestrator/iteration-studio), ask for "a Constraint Agent that hard-blocks meta-commentary" |
| Same workflow across all cards | Apply at global scope (don't bind to a card) |
| Different workflows per card | Open the Studio with the target card selected, then **Apply to Character Card** |
| Cheaper / faster | See [overview → Step 2](/features/orchestrator/#step-2-pick-a-model-for-the-agents); or switch to [Single Agent mode](/features/orchestrator/single) (one node, one call) |
| Tweak a workflow I built | Studio session — they persist |
| Migrate to another machine | See [overview → Import / Export](/features/orchestrator/#import--export) |
| Reset everything | The orchestration editor has a **Reset to Default** button |

## Trace panel

Once the main reply lands, click **View runtime trace** in the orchestrator panel. Spec's trace popup splits the run into a few blocks — meta header + flow diagram, execution timeline, event timeline, and conversation + raw data.

### Panel overview + flow diagram

The status header carries two Spec-specific counters: **Node execution count** (how many times any worker ran) and **REVIEW rerun count** (reruns driven by review nodes, default capped at 2 — bumpable to 0 to disable or up to 20 in the configuration reference).

Below the header, the "Flow diagram" visualises the whole DAG: each stage is a coloured block, with worker cards inside listed by node id. Click any card to jump to that worker's detail in the "Execution timeline" panel on the right.

![Spec trace panel: meta header + flow diagram + execution timeline on the right showing one worker's detail](/images/orchestrator/real-spec-meta.png)

### Execution timeline

"Execution timeline" is the right-hand detail panel — it shows the selected worker's full output. The output shape is set by that node's prompt template; in this example the distiller node produced a `summary` followed by an `xml_guidance` block (with `<story_state>` / `<location>` / `<key_items>` tags) that downstream stages can parse for structured fields.

![Spec execution timeline: expanding a worker's detail to see summary and xml_guidance](/images/orchestrator/real-spec-timeline.png)

### Event timeline

The "Event timeline" lays out the DAG's execution rhythm in order: `Run started` → each stage's `stage_started` → each worker's `worker_started` / `worker_completed` (parallel workers within a stage land back-to-back) → `stage_completed` → next stage, finishing with `Run completed`.

![Spec event timeline: stage_started → worker_started/completed → stage_completed, marching through the whole DAG](/images/orchestrator/real-spec-events.png)

If a stage triggers a review rerun, you'll see the same worker fire `worker_started` / `worker_completed` multiple times — cross-reference that count with the top-row **REVIEW rerun count** to see how many times the review node sent it back.

### Raw trace

At the bottom, "Latest injected text" is the final stage's output — the capsule injected into the main model. The "Raw runtime trace" beneath it dumps the run as JSON, with `runId`, `chatKey`, `generationType`, `capsuleText` and other top-level fields.

![Spec raw trace JSON and latest injected text](/images/orchestrator/real-spec-rawtrace.png)

When filing a bug, **Export this run** downloads this JSON as a JSONL file you can hand to the developer.

## Spec configuration reference

<details>
<summary>Spec-specific settings</summary>

| Setting | Description |
|---|---|
| Node Iteration Max Rounds | Iteration cap for a single node |
| Review Rerun Max Rounds | 0 disables review-driven reruns; max 20 |
| Anti-Data Guard | A built-in node in the default Spec workflow that blocks data-fication / report-style prose (terms like 观察 / 分析 / 评估 / 监测 / observation / analyze / metric / probability that turn RP into stat blocks). Hard-coded ~18-term lexicon. Remove the node from your workflow if you don't want it. |
| Node API Preset | Per-node override; empty = global |
| Node Chat Completion Preset | Per-node override; empty = global |

Each node can use a different API and Chat Completion preset, so you can route distillers to a cheap model and the synthesizer to a high-quality one.

</details>

## Related

- [Orchestrator overview](/features/orchestrator/) — common configuration / triggers / character card binding
- [AI Iteration Studio](/features/orchestrator/iteration-studio) — let AI customize Spec for you (recommended for 99% of cases)
- [Single Agent mode](/features/orchestrator/single) — degenerate Spec, single node
- [Agenda mode](/features/orchestrator/agenda) — Planner-driven dynamic dispatch
- [Loop mode](/features/orchestrator/loop) — single-agent tool loop
- [Character Card Editor](/features/card-editor/) — shares the diff engine with Iteration Studio
