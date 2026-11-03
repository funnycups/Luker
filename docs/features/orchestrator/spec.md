# Spec Mode

Spec is the orchestrator's default mode. It splits preparation into a fixed sequence of stages, each containing one or more nodes, and ends by combining their output into an orchestration result for the main model. The pipeline is predictable and reusable, which makes it a solid starting point for long-form roleplay.

## How it works

Stages run in order; a stage starts only after the previous one finishes. Within a stage, nodes run either one after another or in parallel.

```d2
direction: right

start: "A new turn arrives" {
  shape: oval
  style.fill: "#e8f5e9"
}

s1: "Distill (serial)" {
  style.fill: "#e1f5ff"
  distiller: "Summarize scene state\nand user intent" {
    style.fill: "#fffde7"
  }
}

s2: "Ground (parallel)" {
  style.fill: "#e1f5ff"
  lorebook: "Read the active\nworld book constraints" {
    style.fill: "#fffde7"
  }
  guard: "Block report-style and\nobservation-style prose" {
    style.fill: "#fffde7"
  }
}

s3: "Plan (parallel)" {
  style.fill: "#e1f5ff"
  planner: "Plan the next beat" {
    style.fill: "#fffde7"
  }
  recall: "Surface relevant memory" {
    style.fill: "#fffde7"
  }
}

s4: "Review (serial)" {
  style.fill: "#e1f5ff"
  critic: "Audit the previous stage" {
    shape: diamond
    style.fill: "#fff3e0"
  }
}

s5: "Combine (serial)" {
  style.fill: "#e1f5ff"
  synth: "Write the orchestration result" {
    style.fill: "#c8e6c9"
  }
}

out: "Injected into the main prompt" {
  shape: oval
  style.fill: "#f3e5f5"
}

start -> s1
s1 -> s2
s2 -> s3
s3 -> s4
s4 -> s5: "approve"
s4 -> s3: "send back with notes" {
  style.stroke-dash: 3
}
s5 -> out
```

Each node is one LLM call with one prompt template. There are two kinds:

- **Worker nodes** perform a task such as summarizing the scene, reading world book entries or planning the next beat.
- **Review nodes** check the previous stage, then either let it through or send specific nodes back for another attempt.

The final stage combines the accepted output into the orchestration result injected into the main model's prompt.

## The default pipeline

The bundled profile provides a working pipeline:

1. **Understand the scene**: summarize user intent, current tension and likely directions for the later nodes.
2. **Establish constraints**: read active world book entries in parallel for the rules and style limits this turn must respect, while checking for data-like, report-style prose.
3. **Plan and recall**: plan the next beat and select relevant Memory Graph content in parallel.
4. **Review**: check the plan against established facts, character consistency and world rules. Send the responsible node back when something is wrong.
5. **Synthesize**: turn the accepted output into a short orchestration result.

This covers most roleplay setups. When you need a different shape, describe the goal in [AI Iteration Studio](/features/orchestrator/iteration-studio) and confirm each proposed change.

## Editor

Open the **orchestration editor** from the Orchestrator panel. Stages and nodes are on the left, the agent preset library on the right. Each node references a preset containing a system prompt, a user prompt template, and optional API connection and chat-completion preset overrides.

Nodes can use different models. A common arrangement is a cheap model for summarizing and planning, and a stronger one for synthesis and review.

### Review nodes

A review node checks only the immediately preceding worker stage. It can:

- **Approve**: continue to the next stage.
- **Request a rerun**: name the nodes that need another attempt and explain why. Those nodes run again, then the review runs again.

The rerun limit controls how many times this can happen. The default is 2; at 0 the review can only approve or fail and cannot trigger a rerun.

## Common tasks

| Goal | How |
| --- | --- |
| Plan before writing | Describe "two stages: plan the next beat, then write the orchestration result" in the Studio |
| Keep characters in voice | Keep the default data-like prose check, or ask for a node that blocks meta commentary and report-style narration |
| Reuse one pipeline across cards | Apply it globally instead of binding it to a card |
| Different pipelines per card | Select the card, open the Studio, and apply to the card |
| Reduce cost or latency | Use smaller models, remove nodes, or switch to [Single Agent mode](/features/orchestrator/single) |
| Iterate on one pipeline | Studio sessions are saved and can be resumed |
| Move to another device | Export the configuration and import it on the target |

## Run Panel

The Run Panel shows execution by stage. Expand a card to inspect a node's reasoning, output and tool calls.

Watch for:

- nodes that ran more than once, which means a review sent them back;
- stage output that does not match what the next stage needs;
- a final orchestration result that omits something this turn requires.

The export button at the top saves the whole run as JSON for reporting a problem.

## Settings

- **Maximum node iterations**: how many internal iterations a single node may run.
- **Maximum review reruns**: 2 by default; 0 disables reruns.
- **Per-node API and chat-completion presets**: empty uses the global orchestration presets.
- **Data-like prose check**: a built-in node in the default pipeline that blocks prose written like an observation log or parameter table. Remove the node if you do not need it.

## Related pages

- [Orchestration overview](/features/orchestrator/) — shared settings, triggers and card binding
- [AI Iteration Studio](/features/orchestrator/iteration-studio) — change the pipeline in natural language
- [Single Agent mode](/features/orchestrator/single) — a one-node pipeline
- [Agenda mode](/features/orchestrator/agenda) — a planner decides which nodes run
- [Loop mode](/features/orchestrator/loop) — single-agent tool loop
- [Custom tools](/features/orchestrator/custom-tools) — add capabilities beyond the built-in set
