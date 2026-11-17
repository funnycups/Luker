# Single Agent Mode

Single Agent is the orchestrator's lightest mode: one node, one model call, one piece of guidance injected into the main model. It is a Spec reduced to a single node, useful when a turn needs only a reminder, a summary or a style constraint.

## When to use it

- The main chat needs one OOC reminder, a world book summary or a single writing constraint.
- You want orchestration-result injection without the latency and cost of multiple agents.
- You are testing a new guidance prompt and want to verify injection position and effect before building a larger flow.
- The budget allows only one extra call.

Use [Loop mode](/features/orchestrator/loop) when an agent must read world books, search memory or research. Use [Spec mode](/features/orchestrator/spec) for a fixed multi-stage flow, and [Agenda mode](/features/orchestrator/agenda) when the next step depends on the previous result.

## Getting started

In **Workbench → Orchestration**, select **Single assistant** from the mode picker. Select the agent in **Flow** (or **Setup**) to edit its two fields:

- **Role prompt (system prompt)**: the agent's role and task.
- **Task template**: the input for this turn.

The agent's output is injected into the main model as the orchestration result.

## Relationship to Spec

Single Agent is a Spec with one node. Switching back to Spec shows that same node, and you can add stages and nodes from there. Switching between the two keeps the prompts.

## Comparison

| | Single Agent | Spec | Agenda | Loop |
| --- | --- | --- | --- | --- |
| Model calls | One | Several, by stage | Decided by the planner | Decided by the agent |
| Configuration | Two prompt fields | Stage and node editor | Planner and worker pool | System prompt and tool toggles |
| Tool calls | None | None | Used by the planner | Used freely by the agent |
| Flow | Fixed single step | Fixed stages | Dynamic dispatch | Agent decides |
| Best for | Simple guidance | Predictable multi-stage preparation | Dynamic scheduling | Research before writing |

## Writing prompts with AI

[AI Iteration](/features/orchestrator/iteration-studio) works in Single Agent mode. Describe the task, and it drafts the role and task prompts for you to confirm.

## Related pages

- [Orchestration overview](/features/orchestrator/) — shared settings, triggers and card binding
- [Spec mode](/features/orchestrator/spec) — multi-stage flow
- [AI Iteration](/features/orchestrator/iteration-studio) — write prompts in natural language
- [Loop mode](/features/orchestrator/loop) — let an agent call tools
