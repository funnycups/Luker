# Agenda Mode

Agenda replaces Spec's static DAG with a **Planner agent**. The Planner maintains a todo list, dispatches other agents via tool calls, reads their outputs, and decides who to send next — at its core, an agent loop.

When to reach for Agenda over Spec:

- The flow needs to decide who runs based on intermediate findings. For example, "first scan the user's message for OOC tendencies; only spin up the Constraint Agent if there are any" — that conditional shape is awkward in Spec's fixed DAG.
- You want flexible multi-agent coordination instead of a fixed stage → node topology.
- You want the [Function Call Runtime](/improvements/function-call-runtime) machinery to let the Planner organize dispatch itself.

::: tip Agenda is not a Spec replacement
Spec wins on predictability, prompt-cache friendliness, and debug ergonomics. The fixed DAG is enough for the vast majority of RP scenarios; Agenda is for cases that genuinely need dynamic dispatch.
:::

::: warning 99% of the time, don't hand-edit
Before you hand-write a Planner prompt, check the [AI Iteration Studio](/features/orchestrator/iteration-studio) — describe what you want in one sentence, the AI returns a Planner + agent pool proposal, you approve change-by-change.
:::

## Agenda editor

Switch to Agenda mode, then click **Open Orchestration Editor** in the orchestrator panel.

![Agenda editor](/images/orchestrator/orch-agenda-editor.png)

The left column configures the **Planner Prompt** (API preset, prompt preset, system prompt, planner prompt template). The right column lists the available **Agenda Agents** — the Planner picks from this pool via tool calls.

### Planner

The Planner is Agenda's core. It does several things:

1. Reads recent chat + user message
2. Maintains a todo list (what to do next)
3. Dispatches agents from the Agenda pool to do tasks
4. Collects agent outputs
5. Decides the next step from collected output, or stops when satisfied — the last agent's output becomes the capsule injected into the main model.

### Agenda Agents

Each Agenda Agent is similar to a Spec Node: own System Prompt, User Prompt Template, optional API / Chat Completion preset overrides. The difference: an Agent isn't bolted to a stage. **When and how often it's invoked — or whether it's invoked at all — is the Planner's call.**

### Three runtime bounds

Agenda is dynamic dispatch, so runaway is easy. Three guards:

- **Planner Max Rounds** — how many scheduling rounds the Planner gets
- **Max Concurrent Agents** — concurrency cap on parallel agent runs (passed to `Promise.all`)
- **Max Total Executions** — total number of agent invocations across the whole run

Hitting any one forces the run to wrap up.

## AI Iteration Studio

Like Spec, Agenda is supported by the AI Iteration Studio — describe Planner behaviour and agent pool composition in natural language, let the AI assemble it. See [AI Iteration Studio](/features/orchestrator/iteration-studio). Quick Build is available in Agenda too.

## Conversion to/from Spec

The orchestration editor has **Copy Spec Agents to Agenda** / **Copy Agenda Agents to Spec** buttons that move the agent pool across modes (best-effort). **Caveats**:

- Spec → Agenda loses stage topology. You'll need to author a new Planner Prompt to describe the dispatch logic.
- Agenda → Spec can't fully capture the Planner's dynamic dispatch. You'll need to manually decide stage boundaries.

## Function Call Runtime dependency

Agenda's Planner dispatch is implemented via OpenAI tool calls and depends on Luker's [Function Call Runtime](/improvements/function-call-runtime). That means:

- The Planner's connection profile must support function calling (OpenAI / Claude / Gemini all do)
- Tool-call retry on failure is handled by Function Call Runtime (see that page for details)

## Agenda configuration reference

<details>
<summary>Agenda-specific settings</summary>

| Setting | Description |
|---|---|
| Planner Max Rounds | Cap on Planner scheduling rounds |
| Max Concurrent Agents | Concurrency cap on parallel agent runs |
| Max Total Executions | Total agent invocations across the whole run |
| Planner API Preset | Connection profile used by the Planner |
| Planner Chat Completion Preset | Prompt preset used by the Planner |
| Planner System Prompt | The Planner's system instruction |
| Planner Prompt Template | The Planner's user prompt template |
| Final Agent | Whose output becomes the capsule when the run wraps up |
| Agenda agent pool | Per-agent presets / prompts (each can override API and Chat Completion preset independently) |

</details>

## Related

- [Orchestrator overview](/features/orchestrator/) — common configuration / triggers / character card binding
- [AI Iteration Studio](/features/orchestrator/iteration-studio) — let AI write the Planner + agent pool (recommended)
- [Spec mode](/features/orchestrator/spec) — the default DAG mode
- [Loop mode](/features/orchestrator/loop) — single-agent tool loop
- [Function Call Runtime](/improvements/function-call-runtime) — the framework Planner dispatch relies on
