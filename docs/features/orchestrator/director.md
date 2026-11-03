# Director Mode

Director is the orchestrator's takeover mode: the reply for this turn is written by a writing team inside the orchestrator instead of by the main model. It is built for high-quality long-form roleplay — scout the context, draft, have voice and continuity reviewers challenge the draft, then revise and submit.

## How it differs from the other modes

| | Spec, Agenda, Loop | Director |
| --- | --- | --- |
| Who writes the reply | The main model, after reading the orchestration result | The main agent inside the orchestrator |
| What the orchestrator produces | A compact orchestration result | A complete, sendable message |
| The main model this turn | Generates the reply | Not used |
| Best for | Letting the main model keep producing on its existing context | Letting a multi-perspective team deliver a finished draft |

The chat window shows only the final narrative; drafts, reviews and revisions are recorded in the Run Panel.

## When to use it

- Long-form roleplay where character consistency, voice and continuity all matter.
- You want draft → review → revision enforced by the pipeline.
- Different stages use different models: a lower-cost model for planning, a stronger one for review.

It is a poor fit for low-latency, everyday chat. A Director turn runs several rounds of tool calls and sub-agent dispatches, so it costs more than the other modes.

## How a turn runs

```d2
direction: down

start: "A new turn arrives\nthe main model is not called" {
  shape: oval
  style.fill: "#e8f5e9"
}

loop: "Main agent at the writing desk" {
  style.fill: "#e1f5ff"

  think: "Read the draft so far\nand pick the next move" {
    style.fill: "#fffde7"
  }

  decide: "What is needed?" {
    shape: diamond
  }

  consult: "Consult a sub-agent" {
    style.fill: "#fff3e0"
    pre: "Pre-draft scouting\nintent · recent chat · memory · world book ·\npending notes · what the character knows" {
      style.fill: "#fffde7"
    }
    mid: "Structural sketching\nplot drafts from different angles" {
      style.fill: "#fffde7"
    }
    post: "Post-draft review\nvoice · continuity" {
      style.fill: "#fffde7"
    }
    house: "Post-draft housekeeping\nwrite durable facts to memory · close resolved notes" {
      style.fill: "#fffde7"
    }
  }

  research: "Look something up\nrecent chat · memory · world book · web · notes" {
    style.fill: "#fffde7"
  }

  write: "Draft or revise the body\nextend · patch problem lines · reread" {
    style.fill: "#fffde7"
  }

  finish: "Submit the body" {
    style.fill: "#c8e6c9"
  }

  think -> decide
  decide -> consult: "consult"
  decide -> research: "look up"
  decide -> write: "write"
  decide -> finish: "submit"
  consult -> think: "result returns"
  research -> think: "continue"
  write -> think: "continue"
}

out: "Body posted to the chat" {
  shape: oval
  style.fill: "#f3e5f5"
}

start -> loop.think
loop.finish -> out
```

1. **Scout.** The main agent checks recent chat, Memory Graph, inactive world book entries, open notes and web sources as needed. It establishes what is happening, what each character knows, and which threads should advance this turn.
2. **Draft.** It writes a first version of the message.
3. **Review.** A voice reviewer checks whether dialogue fits each character's identity and register, and whether the prose reads like data or misreads the setting. A continuity reviewer checks conflicts with established facts in the chat, Memory Graph and world book, and catches characters acting on information they were never given.
4. **Revise.** The main agent accepts useful criticism, ignores what does not hold, and can run another review round.
5. **Submit.** The finished message enters the chat; the process stays in the fold.

## The default team

The bundled profile includes sub-agents tuned for roleplay:

- **Pre-draft scouting**: user intent, recent chat, Memory Graph, inactive world book entries, due notes, character knowledge boundaries, and public-IP canon checks.
- **Structure**: plot sketches from different angles, which can run in parallel.
- **Post-draft review**: voice and continuity.
- **Post-draft housekeeping**: write durable facts to Memory Graph and close notes that were paid off.

Sub-agents start only when needed. The main agent decides who to dispatch from the current draft instead of running a fixed sequence.

## Getting started

1. Set the execution mode to **Director (multi-agent)** in the extension drawer.
2. Choose API connections and chat-completion presets for the main agent and sub-agents. The question-mark button beside a preset dropdown imports `agent-director` in a click. Main agent and sub-agents can differ, so scouting can use a lower-cost model and review a stronger one.
3. Run the default system prompt for a couple of turns first. It already encodes scouting, drafting, review and revision; when you need changes, use [AI Iteration Studio](/features/orchestrator/iteration-studio).
4. Chat normally and follow each sub-agent and the final message in the Run Panel.

## Configuration

### Main agent

- **API preset**: the connection the main agent uses.
- **Prompt preset**: the chat-completion preset that shapes its context and sampling.
- **System prompt**: its role, workflow and stopping condition. An empty field sends an empty instruction; there is no hidden fallback. **Reset to default** restores the bundled text.

### Sub-agents

Each sub-agent has a name, description, system prompt and its own API and prompt presets. The description tells the main agent when to dispatch it; the system prompt defines the perspective it reviews or scouts from.

### Limits

- Maximum tool-call rounds for the main agent.
- Maximum sub-agents running at once.
- Maximum sub-agent launches per turn.

### Interruption

You can keep a partial message on interruption, or discard it and return to the state before generation.

## Preset advice

The main agent's chat-completion preset serves a tool-calling loop; it does not write the final reply. Turning off duplicated injections keeps its attention on the task.

Turn off character card fields, persona, example dialogue and the preset's world book placeholder. The orchestrator already puts that material into the context the main agent sees.

Keep chat history, style instructions, jailbreak or loosening instructions, and anti-formula instructions. Chat history is the main agent's actual input; style and anti-formula guidance affect both drafting and review.

## Single-agent iterative writing

If you already know the voice you want and do not need reviewers, Director can be reduced to one main agent that drafts, reads back, revises and submits. Describe that goal in AI Iteration Studio: remove the sub-agents, keep chat, Memory Graph and world book tools, and let the main agent decide when to stop.

This configuration has no review safeguard; the main agent's judgment is final. Run it for a couple of turns, confirm it stops reliably under your prompt, then save it as a new preset.

## Limits

- Runs on ordinary replies, regenerate, swipe and continue; quiet generation and impersonate do not trigger it.
- Requires a mainstream cloud connection; local Kobold and Text generation WebUI are not supported.
- No orchestration result is injected during a Director turn; the message body is the output.
- Sub-agents cannot dispatch further sub-agents. They share the query tools enabled for the main agent and stop when a round calls no tools, returning that round's text.
- The main agent and sub-agents follow the orchestrator's streaming setting.
- The message updates as the main agent writes or patches it; sub-agent output streams into the Run Panel.

## Related pages

- [Orchestration overview](/features/orchestrator/) — shared settings, triggers and card binding
- [AI Iteration Studio](/features/orchestrator/iteration-studio) — change main-agent and sub-agent prompts in natural language
- [Skills overview](/features/skills/) — knowledge packs used by the default Director profile
- [Notes](/features/orchestrator/notes) — reading and writing open plot threads
- [Loop mode](/features/orchestrator/loop) — one agent researches and produces an orchestration result
