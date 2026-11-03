# Agenda Mode

Agenda organises the flow around a planning agent. The planner keeps a todo list, decides from intermediate results which agents to call, how often and when to stop, and a finishing agent combines the result into an orchestration result.

## When to use it

Agenda fits these cases:

- Some steps run only when a condition holds, such as starting a constraint check only when user input crosses a boundary.
- The next agent depends on the previous output, so the full flow cannot be drawn in advance.
- One planning agent should coordinate several worker agents.

The difference is who selects the agents: a stage table in Spec, the planning agent in Agenda.

## How it works

```d2
direction: down

start: "A new turn arrives" {
  shape: oval
  style.fill: "#e8f5e9"
}

loop: "Planner-driven dispatch" {
  style.fill: "#e1f5ff"

  driver: "Planner\nread completed work · update the todo list ·\ndispatch workers · decide when to wrap up" {
    style.fill: "#fffde7"
  }

  pool: "Worker pool" {
    style.fill: "#fff3e0"
    a: "Scene summary" {
      style.fill: "#fffde7"
    }
    b: "World book constraints" {
      style.fill: "#fffde7"
    }
    c: "Plot planning" {
      style.fill: "#fffde7"
    }
    d: "Review" {
      style.fill: "#fffde7"
    }
  }

  driver -> pool: "dispatch one or more (in parallel)"
  pool -> driver: "results return; replan if needed"
}

finalizer: "Finishing agent writes the result" {
  style.fill: "#c8e6c9"
}

out: "Injected into the main prompt" {
  shape: oval
  style.fill: "#f3e5f5"
}

start -> loop.driver
loop.driver -> finalizer: "wrap up"
finalizer -> out
```

1. The planner reads the recent chat and the user message.
2. It keeps a todo list of completed and pending work.
3. It selects one or more agents from the worker pool and assigns tasks.
4. It reads their results, updates the list, and decides whether to continue.
5. At the end, a designated finishing agent combines the results into an orchestration result for the main model.

Workers are not bound to fixed stages: the planner decides whether, how often and in what order they run.

## The default flow

The bundled profile includes a planner and a worker pool:

- **Scene summary**: user intent, current tension and likely directions.
- **World book constraints**: the entries that actually matter this turn and the style rules they impose.
- **Plot planning**: the next beat and decision points, preserving causality and character independence.
- **Review**: continuity, character drift, missing constraints and implausible causation.
- **Finishing**: combine the accepted output into a short orchestration brief.

The planner can dispatch several workers in parallel and replan from their results. It decides when to stop; the finishing agent runs once.

## Getting started

1. Set the execution mode to **Agenda** in the extension drawer.
2. Open the orchestration editor and review the planner's system prompt and task template.
3. Inspect the worker pool and adjust each agent's role, prompt and model.
4. Set limits for planner rounds, concurrency and total worker calls.
5. Chat normally and follow the planning process and worker output in the Run Panel.

To change the flow, describe the goal in [AI Iteration Studio](/features/orchestrator/iteration-studio) and let it revise the planner or the pool.

## Editor

The left side configures the planner: API connection, chat-completion preset, system prompt and task template. The right side is the worker pool; each worker has its own system prompt, user prompt template and optional model overrides.

The planner dispatches workers through tool calls, so its connection must support function calling. OpenAI, Claude and Gemini support it.

## Limits

Agenda provides three run limits:

- maximum planner rounds;
- maximum workers running at once;
- maximum total worker calls in one run.

Reaching any limit ends the run.

## Converting to and from Spec

The editor can copy the agent pool to the other mode. Only agents move; scheduling logic does not:

- Spec to Agenda loses the stage order, so the planner prompt must describe the dispatch rules again.
- Agenda to Spec cannot map dynamic dispatch onto fixed stages; decide the stage layout by hand.

## Run Panel

The Run Panel groups output by planner round. Each round is a card, and the workers dispatched in that round appear as sub-cards with their reasoning, input and output.

Watch for:

- the planner dispatching the wrong worker or skipping a required step;
- repeated dispatch on the same task without reaching an end;
- a final result that omits something this turn needs.

The export button at the top saves the whole run as JSON for reporting a problem.

## Settings

- **Maximum planner rounds**: how many scheduling rounds the planner may run.
- **Maximum concurrent agents**: workers running at once.
- **Maximum total calls**: all worker calls in one run.
- **Planner API and prompt presets**: the connection and chat-completion preset it uses.
- **Planner system prompt and task template**: define how it works.
- **Finishing agent**: which agent produces the orchestration result.
- **Worker pool**: each agent's prompt, model and role.

## Related pages

- [Orchestration overview](/features/orchestrator/) — shared settings, triggers and card binding
- [AI Iteration Studio](/features/orchestrator/iteration-studio) — revise the planner and pool in natural language
- [Spec mode](/features/orchestrator/spec) — the default fixed-stage mode
- [Loop mode](/features/orchestrator/loop) — single-agent tool loop
- [Custom tools](/features/orchestrator/custom-tools) — add capabilities beyond the built-in set
