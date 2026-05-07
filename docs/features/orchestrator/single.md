# Single Agent Mode

Single Agent is the orchestrator's lightest execution mode — one node, one LLM call, producing one capsule that gets injected into the main model. Under the hood it's a degenerate Spec with exactly one node, but because there's no multi-node coordination, the extension drawer gives you two simplified fields and you skip the orchestration editor entirely.

::: tip Who is this for
Workloads that don't need multi-agent collaboration, don't need a tool loop, and only want "a single short briefing" injected into the main model. Examples: a brief OOC reminder, a short lorebook summary, a one-line style constraint. If you're thinking "I wish I could just have the main model read X before replying," this mode probably fits.
:::

## Switch to Single Agent

In the extension drawer, set the execution mode to **Single Agent**. The Spec / Agenda / Loop editor entry points hide, and the drawer reveals two simplified fields — **System Prompt** and **User Prompt template**.

Write your prompt directly in those fields. No orchestration editor needed.

## Template variables

The User Prompt template supports the same placeholders as Spec mode:

| Variable | Meaning |
|---|---|
| <span v-pre>`{{recent_chat}}`</span> | Recent chat messages |
| <span v-pre>`{{last_user}}`</span> | The most recent user message |
| <span v-pre>`{{previous_orchestration}}`</span> | Previous turn's orchestration result. **Auto-prepended at runtime — you typically don't reference it.** |

## When to use

- **Simple capsule** — a brief OOC reminder, a lorebook summary, a one-line constraint
- **You want capsule injection without multi-agent latency** — one LLM call, lowest latency
- **Prototyping a new prompt** — get the basics working as Single Agent, validate that injection position / role / depth match expectations, then graduate to multi-agent
- **Budget-sensitive runs** — one LLM call is far cheaper than the 5–10 the default Spec workflow makes

## When not to use

- The agent needs to read the lorebook, query memory, or do research → use [Loop mode](/features/orchestrator/loop)
- You need multi-step planning, review, synthesis → use [Spec mode](/features/orchestrator/spec)
- The next step depends on intermediate findings → use [Agenda mode](/features/orchestrator/agenda)

## Let AI write the prompt

Don't want to write the prompt yourself? The [AI Iteration Studio](/features/orchestrator/iteration-studio) works in Single Agent mode too — switch to Single Agent, open the Studio, describe what you want the agent to do, and it'll generate the system / user prompt for you.

## Relationship to Spec

Under the hood, Single Agent mode is a Spec profile with exactly one node. That means:

- Switching to Single Agent → just one node + simplified UI; the orchestration editor isn't opened.
- Switching back to Spec → you'll see that single node and can keep adding more by hand.

Switching between the two modes preserves the configuration (System Prompt + User Prompt are node 0 in Spec mode).

## Comparison with other modes

| Dimension | Single Agent | Spec | Agenda | Loop |
|---|---|---|---|---|
| LLM calls | 1 | 5–10 | Planner-decided | Agent-decided (default ≤ 20 rounds) |
| Setup cost | Two fields | Author DAG + per-node prompts | Planner prompt + worker pool | One system prompt + tool toggles |
| Tool calling | ❌ | ❌ | ✅ Planner | ✅ Agent free-call |
| Variable flow | ❌ | Hard-wired topology | Planner schedules | Agent picks next step |
| Card override | ✅ | ✅ | ✅ | ✅ |
| Best for | Simple capsule | Predictable pipelines | Complex tasks needing scheduling | Speed/quality balance + exploratory research |

## Related

- [Orchestrator overview](/features/orchestrator/) — common configuration / triggers / character card binding
- [Spec mode](/features/orchestrator/spec) — multi-node DAG version
- [AI Iteration Studio](/features/orchestrator/iteration-studio) — let AI write the prompt for you
- [Loop mode](/features/orchestrator/loop) — when you want the agent to call tools
