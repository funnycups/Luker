# Multi-Agent Orchestration

A carefully built scene can still be spoiled by one reply: it skips a beat you just established, forgets a world rule from earlier, breaks character to summarize, or resolves a thread that should have waited. A single generation has to satisfy character consistency, context, world rules, plot progression, and prose at once.

The Orchestrator runs a team of agents before the main model writes: it extracts important state from the recent chat, determines which world rules apply, plans what the turn should accomplish, and reviews the plan. The output depends on the execution mode: most modes produce a compact orchestration result injected into the main prompt, while Director has the lead writer inside the orchestrator draft and submit the reply directly.

**The orchestrator ships with a working default Spec workflow; enable it and it runs.** Every execution mode can be inspected and customized inside **Workbench → Orchestration** or through **Workbench → AI iteration → Orchestration**.

::: info When does it run?
The Orchestrator runs on ordinary replies, continue, regenerate, swipe, and impersonate, after World Info parsing and before the main reply. Live run traces stay in the Run panel and browser run history.
:::

## Walkthrough (using the default workflow)

The default Spec is already configured; enable it and it runs.

### Step 0 — Prerequisites {#step-0}

- The main chat already generates replies through a chat-completion connection.
- The current chat has several turns of dialogue.

### Step 1 — Enable Orchestrator {#step-1}

Open **Workbench** (wand menu → **Workbench**, corner pill, `Alt+W`, or **Extensions → Orchestrator → Open in Workbench**), switch to the **Orchestration** workspace tab, and turn on **Enable orchestration**.

![Orchestrator enable toggle](/images/orchestrator/orch-toggle.png)

### Step 2 — Pick a model for the agents {#step-2}

In **Orchestration → Settings**, choose the **Connection profile** and **Generation preset** under **Default API and prompt preset**. For higher quality or lower cost, assign a connection and preset per agent inside **Flow**.

::: tip Cost
Every node in the orchestrator makes a model call. When the main chat uses a high-cost model, give the orchestrator a smaller one; for higher quality, assign a connection and preset per agent.
:::

### Step 3 — Just send a message {#step-3}

Send a message in the chat and leave the other settings at their defaults. Before the main model replies, the default Spec workflow runs in the background.

### Step 4 — Review the run {#step-4}

As soon as a run starts, the floating **Run panel** dock opens automatically in your chosen default window size (`Small window` or `Large window`). It updates live as rounds progress; expand any agent row to inspect model thinking, tool calls, and results.

![The Run Panel as a director run begins](/images/run-panel/01-panel-initial.png)

As the model streams output, the panel updates in place:

![Streaming progress: reasoning, text, and tool sections fill in real time](/images/run-panel/02-panel-streaming.png)

Expand any tool call to see its inputs and outputs:

![A tool call expanded — arguments and results](/images/run-panel/03-panel-tool-expanded.png)

On narrow mobile screens (`<= 640px`), the dock stays a compact rounded floating window above the input bar—drag the header to reposition it, double-tap the header or tap Enlarge/Shrink to switch between small and large views, or collapse it into a draggable corner pill:

![Run Panel floating on a phone-sized viewport](/images/run-panel/05-panel-mobile.png)

From the Run panel dock you can:

- **Stop run** while it is in progress
- **Inspect run** to jump into **Workbench → Orchestration → Run** for the full timeline and segment view
- **Export trace** to download the full run as JSON
- **Not happy with the result? AI diagnosis** to jump into **Workbench → AI iteration → Orchestration** with the run context pre-filled

Configure **Open automatically on run** and **Run panel default size** (`Small window` / `Large window`) in the Run panel menu, Orchestrator settings, or Workbench settings, or reopen the dock anytime from the wand menu → **Run panel**.

The orchestrator is now active. Choose an execution mode:

- A fixed, repeatable flow → [Spec mode](/features/orchestrator/spec)
- One call that injects a piece of guidance → [Single Agent mode](/features/orchestrator/single)
- The set of agents must be decided from intermediate results → [Agenda mode](/features/orchestrator/agenda)
- One agent should call tools and decide when to stop → [Loop mode](/features/orchestrator/loop)
- The team inside the orchestrator should write the reply → [Director mode](/features/orchestrator/director)

::: tip Customization entry point
**[AI Iteration in Workbench](/features/orchestrator/iteration-studio)** supports every mode: describe the goal in plain language, review proposed changes in the **Change list**, and apply or undo them at any time.
:::

## Pick your execution mode

| Mode | Workbench label | What it is | When to use | Skills | Detailed docs |
|---|---|---|---|---|---|
| **Spec** (default) | **Pipeline** | A fixed sequence of stages and nodes | Default. You want a predictable pipeline | Choose visible skills per node | [Spec mode](/features/orchestrator/spec) |
| **Single Agent** | **Single assistant** | A single standalone agent node | Low cost, high speed. No multi-agent coordination needed | Choose skills on that node | [Single Agent mode](/features/orchestrator/single) |
| **Agenda** | **Dispatch** | A dispatcher agent selects workers dynamically | The flow cannot be fixed in advance | Choose separately for dispatcher and workers | [Agenda mode](/features/orchestrator/agenda) |
| **Loop** | **Research loop** | One agent calls tools in a conversation until done | Exploratory research, dynamic decisions | Choose skills on the Loop agent | [Loop mode](/features/orchestrator/loop) |
| **Director** | **Director team** | A lead writer with a sub-agent team writes the reply | High-quality long-form roleplay | Choose separately for lead writer and sub-agents; default skills bundled | [Director mode](/features/orchestrator/director) |

Switch modes from the mode selector in the **Orchestration** workspace topbar. Under **Setup**, Spec and Agenda can copy agents between modes.

::: info Skills
Every mode can restrict which skills each agent sees. Director ships with default skills bound; agents in other modes see every installed skill by default. How skills are applied is covered in [Orchestrator integration](/features/skills/orchestrator-integration).
:::

## Common configuration

These settings live in **Workbench → Orchestration → Settings** and are shared across modes.

### Result injection

The orchestrator's final output is injected into the prompt sent to the main model (except in Director mode, where the lead writer writes the reply directly).

| Setting | Default | Description |
|---|---|---|
| Injection position | `At Chat Depth` | Where in the prompt to insert the result |
| Injection depth | `0` | Depth at the chosen position |
| Injection role | `System` | One of `System` / `User` / `Assistant` |
| Custom instruction | One default sentence | Prepended to the result text |

The result is bound to the user-message floor that triggered orchestration. When you swipe on the same floor, the orchestrator reuses the existing result. When you change the configuration, the system reapplies the latest result.

### Character card binding

Orchestration profiles can be saved on a character card under **Orchestration → Setup** (or applied to the character scope in **AI iteration**):

- The profile exports with the card, so recipients receive the recommended workflow.
- Switching to the card applies its profile automatically.
- **Mode pinned to this card** lets a card lock its preferred execution mode (`Pipeline`, `Dispatch`, `Research loop`, or `Director team`).
- **Clear presets from this card** reverts to the global profile.

### Import / Export

Spec, Agenda, Loop, and Director profiles can be imported and exported as JSON from the preset bar under **Orchestration → Setup**, or reused across scopes with **Save To Global** / **Save To Character Override**.

### Common configuration reference

**Orchestration → Settings** covers the default API connection and generation preset, mode-specific runtime limits, cross-mode limits (recent assistant turns, tool-call retries, RPM limit), result injection settings, and the iteration AI settings.

## Related

- [Workbench](/features/workbench) — unified workspace, Q&A, AI iteration, and change history
- [AI Iteration for Orchestration](/features/orchestrator/iteration-studio) — natural-language customization and run diagnosis
- [Spec mode](/features/orchestrator/spec) — fixed workflow
- [Single Agent mode](/features/orchestrator/single) — one-node workflow
- [Agenda mode](/features/orchestrator/agenda) — planner-driven dispatch
- [Loop mode](/features/orchestrator/loop) — single-agent tool loop
- [Director mode](/features/orchestrator/director) — multi-agent takeover with bundled skills
- [Skills overview](/features/skills/) — knowledge packs shared across modes
- [Notes](/features/orchestrator/notes) — plot-thread tracking for the current chat
- [Card-Bound Presets and Personas](/improvements/card-bound-presets) — how orchestration configuration travels with a card
