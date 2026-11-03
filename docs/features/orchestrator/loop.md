# Loop Mode

Loop mode gives one agent a single conversation and lets it call tools until it decides the job is done. It fits turns that need research before writing: read the recent chat, check world book entries and memory, then produce a short orchestration result for the main model.

```d2
direction: down

start: "A new turn arrives" {
  shape: oval
  style.fill: "#e8f5e9"
}

loop: "One agent on the job" {
  style.fill: "#e1f5ff"

  think: "Read what has been gathered\nand pick the next move" {
    style.fill: "#fffde7"
  }

  decide: "Ready to write the result?" {
    shape: diamond
  }

  tool: "Call a tool\nrecent chat · world book · memory ·\nnotes · web search\nthe result joins the same conversation" {
    style.fill: "#fff3e0"
  }

  finish: "Write the orchestration result" {
    style.fill: "#c8e6c9"
  }

  think -> decide
  decide -> tool: "not yet"
  decide -> finish: "enough context"
  tool -> think: "continue"
}

out: "Injected into the main prompt" {
  shape: oval
  style.fill: "#f3e5f5"
}

start -> loop.think
loop.finish -> out
```

## How it differs from Spec and Agenda

Spec and Agenda run a pre-built sequence of stages. Each stage swaps presets, so prompt caching is hard to reuse, and stages pass only structured outputs to each other; the agent's intermediate reasoning is lost.

Loop keeps one agent and one growing conversation. Tool calls and results stay in context, prompt caching keeps working, and the agent chooses the next lookup from the previous result instead of following a fixed pipeline.

Use Spec for a predictable, repeatable flow, Agenda when the set of agents must be decided at runtime, and Loop when one agent should research on its own and deliver a conclusion.

## Getting started

1. Select **Single Agent Loop** as the execution mode in the extension drawer.
2. Open the orchestration editor and write the system prompt: the agent's task and its stopping condition.
3. Choose the API connection and chat-completion preset for Loop. Leave them empty to use the global orchestration presets.
4. Enable the tool groups this turn needs.
5. Chat normally and follow the agent's research and final result in the Run Panel.

## Editor

- **System prompt**: the agent's role, task and stopping condition. Most loops that fail to stop are missing a clear statement of when the result is ready.
- **Maximum rounds**: 40 by default. One round is one model request plus one tool result.
- **Wall-clock budget**: 300 seconds by default. The loop stops when it expires, regardless of remaining rounds.
- **Tool toggles**: grouped by purpose. An unchecked group is absent from the agent's tool list.
- **API and prompt presets**: let Loop use a cheaper model than the main chat.

## Available tools

Tools are grouped; the agent can use only the groups you enable:

- **Chat**: read a range of floors and search all floors by regular expression.
- **World book**: search enabled entries, read an entry in full, or force an inactive entry into the main model's context for this turn.
- **Memory Graph**: inspect candidate nodes, search by keyword or meaning, find an entity by name, create, edit and delete nodes and links, inspect the type configuration, and compact event tiers.
- **Notes**: open and close plot threads so later turns can still track foreshadowing and promises.
- **Web search**: query the search plugin and open a result page for its text.
- **Submit result**: write the final orchestration result and end the turn. This tool is always enabled.

The exact tools depend on installed plugins. The agent can call only enabled tools that are currently available.

## Safeguards

A run stops when:

- you press Stop, or the generation is cancelled upstream;
- the wall-clock budget expires;
- the maximum round count is reached;
- the agent goes several rounds without calling a tool, which means it is repeating text instead of researching.

When a safeguard fires, Loop uses the agent's last natural-language text as the result, so the main model still receives something.

## Common questions

### The agent never stops

State the stopping condition in the system prompt, for example "once the current scene has what it needs, submit the result instead of continuing to search." Fewer enabled tool groups also reduce the urge to keep exploring.

### A tool is missing

Check the tool toggle and whether the corresponding plugin is enabled. Web search also needs a provider configured in the search plugin.

### The run is slow or expensive

Use a smaller model, enable only the tool groups this turn needs, and lower the maximum rounds. Memory Graph vector search needs an embedding profile; without one the agent is told it is unavailable.

### The result never reaches the main model

Confirm Loop is enabled and the execution mode is correct, then check the Run Panel for a final result. Cancelled or failed runs do not inject unfinished content.

## Related pages

- [Orchestration overview](/features/orchestrator/) — mode selection and shared settings
- [AI Iteration Studio](/features/orchestrator/iteration-studio) — change Loop configuration in natural language
- [Custom tools](/features/orchestrator/custom-tools) — add capabilities beyond the built-in set
- [Notes](/features/orchestrator/notes) — saving and tracking plot threads
- [Memory Graph](/features/memory-graph) — long-term memory Loop can query
