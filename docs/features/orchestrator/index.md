# Multi-Agent Orchestration

A carefully built scene can still be spoiled by one reply: it skips a beat you just established, forgets a world rule from earlier, breaks character to summarize, or resolves a thread that should have waited. A single generation has to satisfy character consistency, context, world rules, plot progression and prose at once, and each of them competes for the same attention.

The Orchestrator runs a team of agents before the main model writes: it extracts the important state from the recent chat, determines which world rules apply, plans what the turn should accomplish, and reviews the plan. The output depends on the execution mode: most modes produce a short orchestration result injected into the main prompt, while Director has the main agent inside the orchestrator write the reply directly.

**The orchestrator ships with a working default Spec workflow; enable it and it runs.** Every execution mode also has its own editor for a different shape.

::: info When does it run?
The Orchestrator runs on ordinary replies, continue, regenerate, swipe and impersonate, after World Info parsing and before the main reply. The Run Panel lives in memory only and is cleared when you switch chats.
:::

## Walkthrough (using the default workflow)

The default Spec is already configured; enable it and it runs.

### Step 0 — Prerequisites {#step-0}

- The main chat already generates replies through a chat-completion connection.
- The current chat has several turns of dialogue.

### Step 1 — Enable Orchestrator {#step-1}

Open the Extensions drawer (top bar) and find the **Multi-Agent Orchestration** section. Toggle **Enable** on.

![Orchestrator enable toggle](/images/orchestrator/orch-toggle.png)

### Step 2 — Pick a model for the agents {#step-2}

In the same panel, **LLM Node API Preset** and **AI Generation API Preset** set the API connection and chat-completion preset for each agent. The question-mark button beside a preset dropdown explains the expected preset type and imports a bundled one in a click: `agent-non-director` for modes other than Director, `agent-director` for Director.

::: tip Cost
Every node in the orchestrator makes a model call. When the main chat uses a high-cost model, give the orchestrator a smaller one; for higher quality, assign a connection and preset per node.
:::

### Step 3 — Just send a message {#step-3}

Send a message in the chat and leave the other settings at their defaults. Before the main model replies, the default Spec workflow runs in the background.

### Step 4 — Review the run {#step-4}

As soon as a run starts, the **Run Panel** slides in beside the chat (or rises from the bottom on narrow screens). It updates in real time: rounds are collapsible cards; expand one to see what the model thought, which tools it called, and what they returned.

![The Run Panel as a director run begins](/images/run-panel/01-panel-initial.png)

As the model streams output, the panel updates in place:

![Streaming progress: reasoning, text, and tool sections fill in real time](/images/run-panel/02-panel-streaming.png)

Expand any tool call to see its inputs and outputs:

![A tool call expanded — arguments and results](/images/run-panel/03-panel-tool-expanded.png)

On narrow screens, the panel becomes a bottom drawer you can drag up or dismiss:

![Run Panel on a phone-sized viewport](/images/run-panel/05-panel-drawer.png)

The panel is kept in memory only. Switching chats or refreshing clears it; the chat keeps only the final reply. Available actions:

- **Stop** the run while it is in progress
- **Copy** the raw content of any section
- **Export** the full run as JSON (useful for bug reports)
- **Collapse all** to fold every card at once

When a reply falls short, the panel shows where the problem entered.

The orchestrator is now active. Choose an execution mode:

- A fixed, repeatable flow → [Spec mode](/features/orchestrator/spec)
- One call that injects a piece of guidance → [Single Agent mode](/features/orchestrator/single)
- The set of agents must be decided from intermediate results → [Agenda mode](/features/orchestrator/agenda)
- One agent should call tools and decide when to stop → [Loop mode](/features/orchestrator/loop)
- The team inside the orchestrator should write the reply → [Director mode](/features/orchestrator/director)

::: tip Customization entry point
**[AI Iteration Studio](/features/orchestrator/iteration-studio)** supports every mode: describe the goal, and the AI returns a proposal for approval. Spec and Agenda submit changes as diffs; Loop and Director modify the configuration directly.
:::

## Pick your execution mode

| Mode | What it is | When to use | Skills | Detailed docs |
|---|---|---|---|---|
| **Spec** (default) | A fixed sequence of stages and nodes | Default. You want a predictable pipeline | Choose visible skills per node | [Spec mode](/features/orchestrator/spec) |
| **Single Agent** | A Spec with one node | Low cost, high speed. No multi-agent coordination needed | Choose skills on that node | [Single Agent mode](/features/orchestrator/single) |
| **Agenda** | A planner agent dispatches other agents as the situation requires | The flow cannot be fixed in advance | Choose separately for the planner and each dispatched agent | [Agenda mode](/features/orchestrator/agenda) |
| **Loop** | One agent calls tools in a conversation and decides when to stop | Exploratory research, dynamic decisions | Choose skills on the Loop agent | [Loop mode](/features/orchestrator/loop) |
| **Director** | A main agent with a sub-agent team explores context and writes the reply | High-quality long-form roleplay | Choose separately for the main agent and sub-agents; default skills are bundled | [Director mode](/features/orchestrator/director) |

Switch modes from the **Execution mode** dropdown in the extension drawer. Spec and Agenda can convert into each other from the editor; Loop has a different structure and no equivalent conversion.

::: tip Customization entry point
**[AI Iteration Studio](/features/orchestrator/iteration-studio)** supports every mode: describe the goal, and the AI returns a proposal for approval. Spec and Agenda submit changes as diffs; Loop and Director modify the configuration directly.
:::

::: info Skills
Every mode can restrict which skills each agent sees. Director ships with default skills bound; agents in other modes see every installed skill by default. How skills are applied is covered in [Orchestrator integration](/features/skills/orchestrator-integration).
:::

## Common configuration

These settings are shared across modes.

### Result injection

The orchestrator's final output is injected into the prompt sent to the main model.

| Setting | Default | Description |
|---|---|---|
| Injection Position | `atDepth` | Where in the prompt to insert the result |
| Injection Depth | `0` | Depth at the chosen position |
| Injection Role | `SYSTEM` | One of `SYSTEM` / `USER` / `ASSISTANT` |
| Custom Instruction Prefix | One default sentence | Prepended to the result text |

The result is bound to the user-message floor that triggered orchestration. When you swipe on the same floor, the orchestrator reuses the existing result instead of re-running. When you change the configuration, the system reapplies the latest result.

### Character card binding

Orchestration configurations can be bound to a character card. When bound:

- The configuration exports with the card, so whoever imports it receives the recommended workflow.
- Card creators can ship a workflow tuned for their character.
- Switching to the card auto-applies its workflow.
- The card can specify its own execution mode: Spec, Agenda, Loop, or Director.
- Selecting a preset in the card's dropdown switches the current chat immediately; the card library stays in place.
- "Clear presets from this card" reverts to the global configuration.
- Personal adjustments can be layered on top of a card-bound configuration.

Card presets work in every mode.

### Import / Export

Spec and Agenda configurations export as JSON and can be imported into the global config or a specific card. The file's mode must match your current execution mode. Loop configurations are reused through [AI Iteration Studio](/features/orchestrator/iteration-studio); Loop has no separate file import or export.

### Common configuration reference

The shared settings cover the execution mode, where the orchestration result is injected and at what depth, the injection role, a custom instruction prefix, the request rate limit, tool-call retries, the default API connection and chat-completion preset, whether nodes see World Info, and the message folding threshold in the Run Panel.

Mode-specific parameters are documented on each mode's page.

## Related

- [AI Iteration Studio](/features/orchestrator/iteration-studio) — the orchestrator's primary customization tool, shared across modes
- [Spec mode](/features/orchestrator/spec) — fixed workflow
- [Single Agent mode](/features/orchestrator/single) — one-node workflow
- [Agenda mode](/features/orchestrator/agenda) — planner-driven dispatch
- [Loop mode](/features/orchestrator/loop) — single-agent tool loop
- [Director mode](/features/orchestrator/director) — multi-agent takeover with bundled skills
- [Skills overview](/features/skills/) — knowledge packs shared across modes
- [Notes](/features/orchestrator/notes) — plot-thread tracking for the current chat
- [Character Card Editor](/features/card-editor/) — shares diff approval with Iteration Studio
- [Card-Bound Presets and Personas](/improvements/card-bound-presets) — how orchestration configuration travels with a card
