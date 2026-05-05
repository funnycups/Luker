# Multi-Agent Orchestration

Have you ever had the AI just... not get it? You set up a careful scene — a tense standoff, a delicate political negotiation, a slow-burn romance — and the reply skips past your last beat, forgets a rule you established two scenes ago, breaks character to summarize, or rushes to a resolution you didn't want. This isn't because the model is dumb. It's because the model can only think about one thing at a time, and you've asked it to do too many in one shot: stay in character, recall context, respect world rules, plan a next beat, *and* write good prose.

The Orchestrator solves this by sending in a small team before the main reply. One agent extracts the important state from your recent chat. Another checks what world rules apply right now. A third drafts a plan for what this turn should accomplish. A fourth reviews their work. A final agent packages everything the team came up with into a single short briefing. By the time the main model writes its reply, it has been handed that briefing (and only that briefing), so it can spend its budget on the prose, not on bookkeeping.

You don't have to design any of this yourself. The Orchestrator ships with a working default workflow, and the **AI Iteration Studio** lets you describe what you want in one sentence and watch — diff by diff — as it builds the workflow for you. Five minutes from open to running. The walkthrough below shows you how.

::: info When does it run?
The Orchestrator triggers on five generation types: `normal`, `continue`, `regenerate`, `swipe`, and `impersonate`. It runs **after** World Info parsing and **before** the main reply. The runtime trace is kept in memory only — it's cleared when you switch chats.
:::

## Quick Start (5 minutes)

This walkthrough uses Iteration Studio because its diff-by-diff approach lets you actually see what the AI is doing — Quick Build is faster but blackboxed. We'll cover Quick Build later.

### Step 0 — Prerequisites

- Your main chat already replies normally with a Chat Completion API.
- The current chat has at least 3 turns of dialogue (so there's something for the workflow to plan against).

### Step 1 — Enable Orchestrator

Open the Extensions drawer (top bar) and find the **Multi-Agent Orchestration** section. Toggle **Enable** on.

![Orchestrator toggle and presets](/images/orchestrator/orch-toggle.png)

### Step 2 — Pick a model for the agents

Scroll within the same panel to **LLM Node API Preset** and **AI Generation API Preset**. These tell the orchestrator agents which API and which Chat Completion preset to use.

::: tip Save money here
The orchestrator can call the LLM 5–10 times per turn (one per node). If your main chat uses an expensive model like Claude Opus, point the orchestrator at something cheaper — Haiku, Gemini Flash — and you'll cut 70%+ of the cost. If you need higher quality, route different nodes to different models (each node has its own API/preset override).
:::

### Step 3 — Open AI Iteration Studio

Scroll past the settings to the action buttons and click **Open AI Iteration Studio**.

![Quick Build and Iteration Studio buttons](/images/orchestrator/orch-quickbuild-button.png)

A new panel opens. The left side is your conversation with the Studio's AI. The right side shows the current orchestration state.

![Iteration Studio main view](/images/orchestrator/orch-iteration-studio.png)

### Step 4 — Describe what you want

In the input box, write one sentence describing what you'd like the orchestration to do. Specific is better than general.

> Example: *"I want the AI to recall recent important events before each reply, keep characters consistent, and not break the fourth wall."*

![Studio input with sample prompt](/images/orchestrator/orch-iter-input.png)

Click **Send to AI**.

### Step 5 — Watch the AI work

The AI replies with a short plan and a diff showing what it intends to change. Each change is a green-add / red-delete / yellow-modify entry. You can approve or reject each one, or wait — the Studio auto-iterates until things stabilize, with each round showing its diff.

![Pending diff review](/images/orchestrator/orch-iter-diff-inline.png)

If a change isn't obvious, click the magnifier icon next to it for a side-by-side comparison.

![Diff side-by-side detail](/images/orchestrator/orch-iter-diff-side.png)

### Step 6 — Apply

When the AI says it has nothing more to suggest, click **Apply to Global** (use everywhere) or **Apply to Character Card** (only for this card).

### Step 7 — See it run (this is the part that matters)

Send a message in the chat. Before the main model replies, the orchestrator runs its workflow. Once your reply lands, scroll to the orchestrator panel and click **View Runtime Trace**.

![Runtime trace overview](/images/orchestrator/orch-runtime-trace.png)

Each node card shows what it produced. The distiller — first stage — extracts a tight summary of the recent chat:

![Distiller node detail](/images/orchestrator/orch-runtime-trace-distiller.png)

**This text is *not* what gets injected into the main model.** It feeds the next stage. The output that becomes the actual briefing comes from the *last* stage:

![Last stage outputs](/images/orchestrator/orch-runtime-trace-laststage.png)

That final output — and only that — is packaged into a single block of text and inserted into the main model's context. Everything upstream is plumbing.

This is the physical meaning of "the AI thinks before replying." If the reply is bad, you can open the trace and see exactly which stage produced the bad signal, and feed that observation back to Iteration Studio.

## Iteration Studio in Depth

Iteration Studio is where you'll spend most of your time once you start tweaking. It's also the most teachable feature — every interaction is visible.

### What it can do

- **Multi-round dialogue.** One sentence of feedback per round, AI proposes a focused change, you review.
- **Per-change approval.** Each diff entry has its own Approve / Reject. You can take half of a proposal.
- **Simulation.** Run the workflow against your actual current chat — exactly as if you'd just sent a new message, World Info activation included — but the result only surfaces in the Studio, *not* in the real chat. Ask "will my Constraint Agent really catch the OOC-prone moments?" and the Studio shows you each node's output.
- **Sessions.** Up to 24 saved sessions per scope. Different cards or different experiments each get their own thread.
- **Rollback.** Even after Apply, you can revert.
- **Foldable thinking.** `<thought>` tags from reasoning models are folded by default; messages over ~1200 chars are folded.

### A typical iteration

> **Round 1.** You: *"Don't break the fourth wall."*
> AI: "Adding a Constraint Agent to Stage 2 with anti-meta checks; enabling Anti-Data Guard." Diff: 1 new node, 1 setting flipped. You approve.
>
> **Round 2.** You: *"Make it read the lorebook so it knows the world rules."*
> AI: "Added a `lorebook_reader` node to Stage 1 so the Constraint Agent can see the active world rules." Diff: 1 new node. Approve.
>
> **Round 3.** You: *"Simulate against an obviously-meta input — does it actually catch it?"*
> AI: Switches to Simulation mode, runs the pipeline against a fake user message that breaks the fourth wall, returns the Constraint Agent's verdict.

![Simulation result](/images/orchestrator/orch-iter-simulation.png)

> **Round 4.** Stable. You click **Apply**.

Every step is visible, interruptible, and reversible. That's the point.

### Sessions

Different cards, different experiments, all keep their own session.

![Session list](/images/orchestrator/orch-iter-sessions.png)

Sessions persist across reloads, scoped to global or to a character card.

### Sidebar — Quick Build

Quick Build is the one-shot version of Iteration Studio. You type a description into the **AI Generation Goal** field at the top of the orchestration editor and click **AI Quick Build**:

![Quick Build button](/images/orchestrator/orch-quickbuild-input.png)

After a single LLM round, you get a complete workflow:

![Quick Build result](/images/orchestrator/orch-quickbuild-result.png)

Use Quick Build when:

1. You've used Iteration Studio enough to know what you want and just need the boilerplate.
2. You want the simplest possible "make it work" path and don't care how the AI got there.

For most cases, Iteration Studio is a better deal. The 1–2 extra minutes buy you a workflow you understand.

## Common Recipes

| I want… | Do this |
|---|---|
| AI to plan its scene before writing | In Iteration Studio, ask for "two stages — first plans the next beat, then writes the prose" |
| AI to stop breaking character | Enable Anti-Data Guard; in Iteration Studio, ask for "a Constraint Agent that hard-blocks meta-commentary" (see §"A typical iteration" above) |
| Same workflow across all cards | Apply at global scope (don't bind to a card) |
| Different workflows per card | Open Iteration Studio with the target card selected, then **Apply to Character Card** |
| Cheaper / faster | See [Step 2](#step-2-pick-a-model-for-the-agents); also try switching execution mode to Single Agent (one node, one call) |
| Tweak a workflow I built | Iteration Studio session — they persist |
| Migrate to another machine | Import / Export, see below |
| Reset everything | The orchestration editor has a **Reset to Default** button |

## Custom Workflows (the manual route)

This is where the Stage / Node / DAG vocabulary starts mattering. Quick definitions:

- **Stage** — a horizontal slice of the workflow. Stages run strictly serial; Stage 2 cannot start until Stage 1 finishes.
- **Node** — an execution unit inside a stage. **One node = one LLM call + one prompt template.**
- **DAG** — directed acyclic graph. In plain English: "a flowchart with order, no loops."

### Three execution modes

| Mode | What it is | When to use |
|---|---|---|
| **Spec** (default) | A fixed Stage → Node DAG. Most flexible static workflow. | Default. You want a predictable pipeline. |
| **Single Agent** | A Spec with exactly one node — runs one LLM call, no orchestration overhead. | Cheap and fast. You don't need multi-agent coordination. |
| **Agenda** | A Planner agent dynamically dispatches other agents via tool calls. | Most adaptive. The Planner decides what runs based on what's happening, like an agent loop. |

You can convert (best-effort) between Spec and Agenda from the editor's **Copy Spec Agents to Agenda** / **Copy Agenda Agents to Spec** buttons. Conversion is approximate — Agenda's dynamic scheduling can't be fully captured in Spec's static DAG.

### Spec workflow editor

Open it from the orchestrator panel: **Open Orchestration Editor**.

![Spec editor](/images/orchestrator/orch-spec-editor.png)

Left panel is the workflow (stages and their nodes). Right panel is the agent preset library. Each node references one preset, which carries the system prompt, user prompt template, optional API/Chat-Completion preset overrides, and execution flags.

Each stage has an execution mode:

- **Serial** — nodes run one after another within the stage.
- **Parallel** — nodes run concurrently with `Promise.all`.

Each node is either a **worker** (does work) or a **review** node (validates the previous stage's outputs).

#### Template variables

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

### Agenda mode

Agenda replaces the static DAG with a Planner agent that calls other agents through tool calls.

![Agenda editor](/images/orchestrator/orch-agenda-editor.png)

The Planner maintains a todo list, reads each agent's output, and decides what to dispatch next. Three runtime bounds:

- **Planner Max Rounds** — how many scheduling rounds the Planner gets.
- **Max Concurrent Agents** — how many agents can run at once.
- **Max Total Executions** — total agent invocations across the whole run.

Agenda relies on Luker's [Function Call Runtime](/improvements/function-call-runtime) for the Planner's tool calling.

## Character Card Binding

Orchestration configurations can be bound to a character card. When bound:

- The configuration exports with the card. Anyone importing the card gets the recommended workflow automatically.
- Card creators can ship a workflow that's tuned for their character.
- Switching to the card auto-applies its workflow.
- The card can specify its own execution mode (Spec/Single/Agenda).
- Card override can be enabled/disabled independently of the global config.
- "Clear character override" reverts to the global configuration.
- You can layer personal tweaks on top of a card-bound configuration.

## Import / Export

Configurations export as JSON.

| Format | Identifier | For |
|---|---|---|
| V1 | `luker_orchestrator_profile_v1` | Spec mode |
| V2 | `luker_orchestrator_profile_v2` | Agenda mode |

Filenames look like `luker-orchestrator-[agenda-][global|character-{name}].json`. The exporter handles both global and per-card scope.

On import, the file's mode (Spec/Agenda) must match your current execution mode. You choose whether to apply to the global config or to a specific card.

## Result Injection

The orchestrator's final output (the "capsule") is injected into the prompt sent to the main model. Configuration:

| Setting | Default | Description |
|---|---|---|
| Injection Position | `atDepth` | Where in the prompt to insert the capsule |
| Injection Depth | `0` | Depth at the chosen position |
| Injection Role | `SYSTEM` | One of `SYSTEM` / `USER` / `ASSISTANT` |
| Custom Instruction Prefix | (a default sentence) | Prepended to the capsule text |

The capsule is bound to the user-message floor that triggered orchestration. When you swipe on the same floor, the orchestrator reuses the existing capsule instead of re-running. When you change the configuration, the system reapplies the latest result.

## Configuration Reference

The most common settings (covered by Quick Start) are:

| Setting | Default |
|---|---|
| Execution Mode | `spec` |
| Injection Position | `atDepth` |
| Injection Depth | `0` |
| Injection Role | `SYSTEM` |
| Node Iteration Max Rounds | — |
| Review Rerun Max Rounds | `2` (max 20) |

<details>
<summary>Full configuration reference</summary>

| Setting | Description |
|---|---|
| Execution Mode | Spec / Single Agent / Agenda |
| Injection Position | Where the capsule is inserted in the main prompt |
| Injection Depth | Depth of insertion |
| Injection Role | `SYSTEM` / `USER` / `ASSISTANT` |
| Custom Instruction Prefix | Prefix prepended to the capsule |
| Planner Max Rounds | Agenda mode only |
| Max Concurrent Agents | Agenda mode only |
| Max Total Executions | Agenda mode only |
| Requests Per Minute Limit | Throttle for parallel nodes |
| Agent Timeout | Per-agent timeout, seconds |
| Tool Call Retries | Retries for failed tool calls |
| Node Iteration Max Rounds | Iteration cap for a single node |
| Review Rerun Max Rounds | 0 disables review-driven reruns; max 20 |
| Global API Preset | Default API connection preset for all nodes |
| Global Chat Completion Preset | Default Chat Completion preset for all nodes |
| Include World Info | Whether nodes see World Info |
| Anti-Data Guard | A built-in node in the default Spec workflow that blocks data-fication / report-style prose (terms like 观察 / 分析 / 评估 / 监测 / observation / analyze / metric / probability that turn RP into stat blocks). Hard-coded ~18-term lexicon. Remove the node from your workflow if you don't want it. |
| `<thought>` Tag Stripping | Strip thinking tags from agent output |
| Message Folding Threshold | 1200 chars / 18 lines |
| Node API Preset | Per-node override; empty = global |
| Node Chat Completion Preset | Per-node override; empty = global |

Each node can use a different API and Chat Completion preset, so you can route distillers to a cheap model and the synthesizer to a high-quality one.

</details>

## Events and Plugin Integration

<details>
<summary>For other extensions and scripts</summary>

The Orchestrator dispatches a frontend event after each run, so other code can consume orchestration results without scraping the UI.

- **Event:** `luker.orchestrator.result`
- **Channel:** `getContext().eventSource`
- **When:** on `completed`, `reused`, `cancelled`, `failed`

Payload:

| Field | Type | Description |
|---|---|---|
| `module` | string | Always `orchestrator` |
| `event` | string | Always `luker.orchestrator.result` |
| `status` | string | `completed` / `reused` / `cancelled` / `failed` |
| `generationType` | string | The triggering generation type |
| `chatKey` | string | Current chat key |
| `at` | string | ISO timestamp |
| `anchorPlayableFloor` | number | Bound user turn floor (0 if unavailable) |
| `anchorHash` | string | Anchor hash for validation |
| `capsuleText` | string | Final injected guidance text |
| `stageOutputs` | array | Compact stage outputs (`completed` / `reused`) |
| `reviewRerunCount` | number | Review rerun count |
| `reason` | string | Machine-readable reason for cancellation/failure |
| `note` | string | Human-readable note |
| `error` | string | Error message when `failed` |

Subscriber example:

```js
const context = getContext();
context.eventSource.on('luker.orchestrator.result', (evt) => {
    if (evt.status === 'completed' || evt.status === 'reused') {
        console.log('Orchestrator capsule:', evt.capsuleText);
    }
});
```

</details>

## Related

- [Function Call Runtime](/improvements/function-call-runtime) — Agenda mode's Planner relies on this
- [Character Card Editor](/features/card-editor) — shares the diff engine with Iteration Studio
- [Card-Bound Presets and Personas](/improvements/card-bound-presets) — how the orchestration config rides along with character cards
