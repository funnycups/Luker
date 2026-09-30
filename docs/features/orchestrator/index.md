# Multi-Agent Orchestration

A carefully prepared scene — a tense standoff, a delicate political negotiation, a slow-burn romance — can still be spoiled by the reply: it skips your last beat, forgets a rule you established two scenes ago, breaks character to summarize, or rushes to a resolution you did not want. This is not because the model is weak; it is because a single pass can only focus on one thing at a time, while you are asking it to handle several at once: stay in character, recall context, respect world rules, plan the next beat, *and* write good prose.

The Orchestrator solves this by dispatching a small team before the main reply. One agent extracts the important state from the recent chat. Another determines which world rules currently apply. A third drafts a plan for what the turn should accomplish. A fourth reviews the team's work. A final agent packages the team's findings into a single short briefing. By the time the main model writes its reply, it has received that briefing (and only that briefing), so its budget can go to the prose rather than to bookkeeping.

**The orchestrator ships with a working default Spec workflow, so no design work is required to begin. Enable it and it runs.** When a different shape is needed later, every execution mode has its own dedicated editor.

::: info When does it run?
The Orchestrator triggers on five generation types: `normal`, `continue`, `regenerate`, `swipe`, and `impersonate`. It runs **after** World Info parsing and **before** the main reply. The Run Panel is kept in memory only — it's cleared when you switch chats.
:::

## 5-Minute Walkthrough (using the default workflow)

No mode selection or workflow authoring is required first — the default Spec is already configured. This section only enables it so its behavior can be observed.

### Step 0 — Prerequisites {#step-0}

- Your main chat already replies normally with a Chat Completion API.
- The current chat has at least 3 turns of dialogue (so there's something for the workflow to plan against).

### Step 1 — Enable Orchestrator {#step-1}

Open the Extensions drawer (top bar) and find the **Multi-Agent Orchestration** section. Toggle **Enable** on.

![Orchestrator enable toggle](/images/orchestrator/orch-toggle.png)

### Step 2 — Pick a model for the agents {#step-2}

Scroll within the same panel to **LLM Node API Preset** and **AI Generation API Preset**. These tell the orchestrator agents which API and which Chat Completion preset to use.

::: tip Save money here
The orchestrator can call the LLM 5–10 times per turn (one call per node). If the main chat uses an expensive model such as Claude Opus, point the orchestrator at a cheaper one — Haiku or Gemini Flash — to cut 70%+ of the cost. If higher quality is needed, route different nodes to different models (each node has its own API/preset override).
:::

### Step 3 — Just send a message {#step-3}

Send a message in the chat — no other settings are needed. Before the main model replies, the default Spec workflow runs in the background. The first run is slower than usual (5–10 agents run in sequence); subsequent runs are faster.

### Step 4 — See what it did for you {#step-4}

As soon as a run starts, the **Run Panel** slides in beside the chat (or rises from the bottom on narrow screens). It updates in real time: each round is a collapsible card; expand one to see what the model thought, which tools it called, and what they returned.

![The Run Panel as a director run begins](/_screenshots/run-panel/01-panel-initial.png)

As the model streams output, the panel updates in place — no flicker, no chat reflow:

![Streaming progress: reasoning, text, and tool sections fill in real time](/_screenshots/run-panel/02-panel-streaming.png)

Expand any tool call to see its inputs and outputs:

![A tool call expanded — arguments and results](/_screenshots/run-panel/03-panel-tool-expanded.png)

On narrow screens, the panel becomes a bottom drawer you can drag up or dismiss:

![Run Panel on a phone-sized viewport](/_screenshots/run-panel/05-panel-drawer.png)

The panel is kept in memory only. Switching chats or refreshing clears it; the chat thread keeps only the final reply, preserved verbatim. The following actions are also available:

- **Stop** the run while it is in progress
- **Copy** the raw content of any section
- **Export** the full run as JSON (useful for bug reports)
- **Collapse all** to fold every card at once

This is what "the AI thinks before replying" means in practice. If the reply is poor, open the panel and locate exactly where the problem entered.

The orchestrator is now active. From here, three directions depending on what is needed:

- The default Spec is not sufficient and needs customization (manual or AI-assisted) → [Spec mode](/features/orchestrator/spec)
- The flow must adapt to the situation and cannot be pre-written as a DAG → [Agenda mode](/features/orchestrator/agenda)
- A single agent should call tools (memory, lorebook, …) until it declares completion → [Loop mode](/features/orchestrator/loop)

::: tip Whichever mode you pick, customization starts here
**[AI Iteration Studio](/features/orchestrator/iteration-studio)** is the orchestrator's primary customization tool — describe the goal in one sentence, the AI returns a proposal, and each change is approved individually. Spec, Agenda, Loop and Director all share it, and **in 99% of cases it is preferable to manual editing**.
:::

## Pick your execution mode

| Mode | What it is | When to use | Skills | Detailed docs |
|---|---|---|---|---|
| **Spec** (default) | A fixed Stage → Node DAG | Default. You want a predictable pipeline | Catalog injected per node; per-node `skills.visible` overrides | [Spec mode](/features/orchestrator/spec) |
| **Single Agent** | A Spec with exactly one node | Low cost, high speed. No multi-agent coordination needed | Catalog injected on the single node | [Single Agent mode](/features/orchestrator/single) |
| **Agenda** | A Planner agent dispatches other agents via tool calls | Flow needs to decide who runs based on what's happening, like an agent loop | Catalog injected on planner + each dispatched worker | [Agenda mode](/features/orchestrator/agenda) |
| **Loop** | One agent calls tools in a single conversation until `finalize` | Balances speed and quality; exploratory research, dynamic decisions | Catalog injected on the loop agent | [Loop mode](/features/orchestrator/loop) |
| **Director** | A main agent + sub-agent team writes the message body directly | Takeover mode for high-quality long-form RP; ships with 24 bundled skills pre-bound | Catalog injected on main agent + each sub-agent dispatch | [Director mode](/features/orchestrator/director) |

Switch modes from the **Execution mode** dropdown in the extension drawer. Spec and Agenda can convert into each other from the editor (best-effort); Loop has a different structure, for which no analogous conversion exists.

::: tip Want to customize? Start with the Studio
After switching to any mode, the [**AI Iteration Studio**](/features/orchestrator/iteration-studio) is the first stop. Spec and Agenda present diffs for approval; Loop patches the profile directly. Both use the same panel and workflow.
:::

::: info Skills column
All five modes use the same skills policy shape (`skills.visible` / `skills.deny` at the mode level, optional `+`-inheritance overrides per agent). For the full model, see [Orchestrator integration](/features/skills/orchestrator-integration). Director is the only mode with pre-bound default skills in its bundled profile; other modes start with `visible: ["*"]` (every installed skill is visible).
:::

## Common configuration

These settings are shared across modes.

### Result injection

The orchestrator's final output (the "capsule") is injected into the prompt sent to the main model.

| Setting | Default | Description |
|---|---|---|
| Injection Position | `atDepth` | Where in the prompt to insert the capsule |
| Injection Depth | `0` | Depth at the chosen position |
| Injection Role | `SYSTEM` | One of `SYSTEM` / `USER` / `ASSISTANT` |
| Custom Instruction Prefix | (a default sentence) | Prepended to the capsule text |

The capsule is bound to the user-message floor that triggered orchestration. When you swipe on the same floor, the orchestrator reuses the existing capsule instead of re-running. When you change the configuration, the system reapplies the latest result.

### Character card binding

Orchestration configurations can be bound to a character card. When bound:

- The configuration exports with the card. Anyone importing the card gets the recommended workflow automatically.
- Card creators can ship a workflow that's tuned for their character.
- Switching to the card auto-applies its workflow.
- The card can specify its own execution mode: Spec, Agenda, Loop, or Director.
- Selecting a preset in the card's dropdown switches that chat to it immediately; the card library is preserved either way.
- "Clear presets from this card" reverts to the global configuration.
- You can layer personal tweaks on top of a card-bound configuration.

Card presets work in all four modes.

### Import / Export

Spec and Agenda configurations export as JSON.

| Format | Identifier | For |
|---|---|---|
| V1 | `luker_orchestrator_profile_v1` | Spec mode |
| V2 | `luker_orchestrator_profile_v2` | Agenda mode |

Filenames look like `luker-orchestrator-[agenda-][global|character-{name}].json`. The exporter handles both global and per-card scope.

On import, the file's mode (Spec/Agenda) must match your current execution mode. You choose whether to apply to the global config or to a specific card.

::: info Loop import/export
Loop mode does not yet provide file-level Profile import/export buttons. Use the [AI Iteration Studio](/features/orchestrator/iteration-studio) to reuse loop workflows.
:::

### Common configuration reference

The most common settings:

| Setting | Default |
|---|---|
| Execution Mode | `spec` |
| Injection Position | `atDepth` |
| Injection Depth | `0` |
| Injection Role | `SYSTEM` |

<details>
<summary>Full configuration reference</summary>

| Setting | Description |
|---|---|
| Execution Mode | Spec / Single Agent / Agenda / Loop |
| Injection Position | Where the capsule is inserted in the main prompt |
| Injection Depth | Depth of insertion |
| Injection Role | `SYSTEM` / `USER` / `ASSISTANT` |
| Custom Instruction Prefix | Prefix prepended to the capsule |
| Requests Per Minute Limit | Throttle for parallel nodes |
| Tool Call Retries | Retries for failed tool calls |
| Global API Preset | Default API connection preset |
| Global Chat Completion Preset | Default Chat Completion preset |
| Include World Info | Whether nodes see World Info |
| `<thought>` Tag Stripping | Strip thinking tags from agent output |
| Message Folding Threshold | 1200 chars / 18 lines |

Mode-specific parameters (per-node, review, planner, loop tool toggles…) are documented in the per-mode pages.

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

- [AI Iteration Studio](/features/orchestrator/iteration-studio) — the orchestrator's primary customization tool, shared across modes
- [Spec mode](/features/orchestrator/spec) — default DAG workflow
- [Single Agent mode](/features/orchestrator/single) — degenerate Spec, single node
- [Agenda mode](/features/orchestrator/agenda) — Planner-driven dynamic dispatch
- [Loop mode](/features/orchestrator/loop) — single-agent tool loop
- [Director mode](/features/orchestrator/director) — multi-agent takeover; ships with 24 bundled skills
- [Skills overview](/features/skills/) — the knowledge-pack substrate shared across all modes
- [Notes — author-side plot threads](/features/orchestrator/notes) — agent-as-author thread tracker, scoped to the current chat
- [Function Call Runtime](/improvements/function-call-runtime) — Agenda and Loop both rely on it
- [Character Card Editor](/features/card-editor/) — shares the diff engine with Iteration Studio
- [Card-Bound Presets and Personas](/improvements/card-bound-presets) — how the orchestration configuration is carried with character cards
