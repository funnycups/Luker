# Loop Mode

Loop mode runs a single agent that calls tools in the same conversation across multiple rounds, deciding for itself when to wrap up — no DAG to draw, no Planner prompt to author.

**Loop mode strikes the balance between speed and quality**: smarter than Single Agent (it can iterate with tools — query memory, look up the lorebook, browse chat) and faster than Spec / Agenda (one preset for the whole pass, so the prompt cache keeps hitting; spec rebuilds the cache every stage transition).

When it shines: you want one agent to do research-style work — read recent chat, look up the lorebook, browse the memory graph, jot persistent notes — and then produce a tight capsule injected into the main reply. The agent should be free to adjust its next move based on what the previous tool call returned, instead of marching through fixed stages.

::: tip Coexists with Spec / Agenda
Loop coexists with spec / agenda. Existing spec / agenda profiles are unaffected.
:::

::: warning 99% of the time, don't hand-write the system prompt
Don't want to hand-write the agent's system prompt? Open the [AI Iteration Studio](/features/orchestrator/iteration-studio) — describe the agent in plain language, the AI patches the profile via tool calls.
:::

## What and why

Spec / Single / Agenda all model "multiple agents collaborate to produce a single main reply", with stage-to-stage hand-offs via `previousNodeOutputs`. That design hits friction in a few places:

- **Setup overhead.** Spec needs a DAG; Agenda needs a Planner prompt.
- **Stage-switch cost.** Each stage rebuilds its system prompt / preset, which kills prompt-cache hit rate and stacks end-to-end latency.
- **Context discontinuity.** Stages only pass `previous_outputs`; the agent's mid-flight reasoning is lost.
- **Rigid topology.** The DAG is hard-wired; the agent cannot adapt the path based on what it found mid-run.

Loop mode addresses these with a single agent + tool loop: same conversation, one preset, the messages array keeps growing, and the agent decides what to call next from the previous round's results. It calls `finalize(capsule_text)` to stop. The core benefit is context continuity — tool calls and their results live naturally in messages, no manual variable threading.

## Default orchestration flow

Loop runs a single agent. The agent reads what it already has, decides whether to fetch more context or write the capsule, and repeats until it calls `finalize`.

```d2
direction: down

start: "A new turn arrives\n(prepare guidance for the next reply)" {
  shape: oval
  style.fill: "#e8f5e9"
}

loop: "One agent on the job" {
  style.fill: "#e1f5ff"

  think: "Read what's been gathered so far,\ndecide the next move" {
    style.fill: "#fffde7"
  }

  decide: "Ready to write the capsule?" {
    shape: diamond
  }

  tool: "Call a tool\nread recent chat · search the lorebook ·\nbrowse memory · jot notes · web search\n— result joins the conversation" {
    style.fill: "#fff3e0"
  }

  finalize: "Write the guidance capsule\nand finalize" {
    style.fill: "#c8e6c9"
  }

  think -> decide
  decide -> tool: "no — need more context"
  decide -> finalize: "yes"
  tool -> think: "next move"
}

out: "Capsule injected into the next reply" {
  shape: oval
  style.fill: "#f3e5f5"
}

start -> loop.think
loop.finalize -> out
```

## Switch to Loop

Pick **Single-agent loop (loop)** from the execution mode dropdown in the extension drawer. The spec / agenda boards collapse and a dedicated Loop board appears.

![Execution mode set to Loop](/images/orchestrator-loop/orch-loop-mode-select.png)

![Loop settings panel](/images/orchestrator-loop/orch-loop-board.png)

## Editor

Click **Open Orchestration Editor** to open a two-column workspace — the left column holds the agent's preset routing, system prompt and two budget guards; the right column groups tool toggles by namespace.

![Loop editor](/images/orchestrator-loop/orch-loop-editor.png)

Key fields:

- **Loop system prompt** — the agent's role and task description. Tell it explicitly *when* to call `finalize`. Most loop runs that go off the rails do so because the agent never decides to stop.
- **Loop max rounds** (default 20, max 50) — one round = one LLM request + processing the tool calls it returns.
- **Loop wall-clock budget** (default 300 seconds) — the whole-loop wall-clock cap. The loop breaks when this expires regardless of round count.
- **Tool toggles** — namespaces you uncheck are dropped from the agent's tool schema. `finalize` is forced on and cannot be disabled.
- **Loop API preset / Loop preset** — empty = use the global orchestration presets. Same routing semantics as spec / agenda, so the loop can target a cheaper model independent of the rest.

## Built-in tools

Tools follow the OpenAI function-calling protocol; results come back as `role: tool` messages in the agent's next round. Ten optional tools plus the always-on `finalize`:

| Tool | Purpose | Concrete RP example |
|---|---|---|
| `note_add(text)` | Write a **persistent note** bound to the current chat. Auto-injected into the system prompt the next time loop starts. 1 KB per entry, LRU-capped at 50. | The agent learns "Lin Wan mentioned her grandmother in Luoyang" and calls `note_add('Lin Wan family lead: grandmother → Luoyang')`; the note resurfaces in the system prompt next session. |
| `chat_read_range(start, end)` | Read a range of chat floors. Negatives count from the tail; ≤ 50 floors per call. | `chat_read_range(-10, -1)` reviews the last 10 floors for context. |
| `chat_search(query, limit)` | Substring search across the entire chat (case-insensitive); returns matching floors with previews. | `chat_search('Qingming Sword')` surfaces every prior mention of "Qingming Sword". |
| `lorebook_search(query, limit)` | Substring search across all enabled lorebooks. **Excludes entries activated this turn by default** — they're already injected into the main context, returning them again wastes tokens. Returns `entries` plus `excluded_active_count`. | `lorebook_search('Luoyan City')` surfaces non-activated lore on Luoyan City. |
| `lorebook_get(entry_key)` | Pull an entry by key, full text. **Does not deduplicate** — the agent can quote an already-activated entry verbatim to keep terminology consistent. | `lorebook_get('Luoyan-MainCity')` retrieves the full entry for direct quotation. |
| `memory_search(query, limit)` | Lexical search over the memory graph; **does not depend on vector configuration**. Also excludes already-injected nodes by default. | `memory_search('family secret')` surfaces relevant historical event nodes. |
| `memory_list_recent(limit)` | Reverse-chronological browse of memory nodes — what happened recently? | `memory_list_recent(10)` returns the 10 most recent event nodes. |
| `memory_get(node_id)` | Fetch a node by id plus the ids of its direct neighbours (without full neighbour bodies). | After `memory_search` returns a node id, use `memory_get` to see what it's connected to. |
| `search_search(query)` | **Web search** via the [Search Tools](/features/search-tools) plugin (DuckDuckGo / SearXNG / Brave). Default on, but the search-tools extension must be loaded and have a provider configured — otherwise the agent receives `SEARCH_UNAVAILABLE` / `SEARCH_DISABLED` and pivots. | `search_search('latest news on …')` returns provider-shaped results (typically `{title, url, snippet}`). |
| `search_visit(url)` | Fetch one page discovered via `search_search` and return its readable text. | After a search hit, `search_visit('https://example.com/article')` pulls the full article body. |
| `finalize(capsule_text)` | **Terminator** (forced on). `capsule_text` becomes the capsule injected into the main model. | `finalize('Lin Wan is anxious right now: she just learned about her grandmother and may steer the next exchange to Luoyang.')` |

Once a tool call returns, its result lands in the conversation as a light-yellow `Tool result` block; the agent's next `Assistant` block reasons directly off it. This "call a tool → read the result → continue → finalize when ready" rhythm is exactly where loop pulls ahead of spec / agenda: the entire context stays in `messages`, no stage-boundary stream breaks.

![Loop conversation: tool result feeds straight into the agent's next thought](/images/orchestrator/real-loop-conversation-tool.png)

## Five-layer runaway protection (in priority order)

1. **Abort signal** — user clicks Stop / upper-layer cancel → loop aborts immediately; trace records `cancelled` and **no** half-baked capsule is injected.
2. **`wall_clock_budget_ms`** — break the moment the wall clock expires.
3. **`max_rounds`** — hard round cap (default 20, max 50).
4. **Agent stops calling tools** — three consecutive zero-tool-call rounds break the loop early (prevents "talking, not doing"). Any tool call resets the streak.

When any safeguard fires, the loop falls back to the agent's last natural-language reply as the capsule so the main model still gets *something*.

## Trace panel

Once the main reply lands, click **View runtime trace** in the orchestrator panel to open the loop run's trace popup. It splits the run into a few blocks — meta header, Agent conversation, event timeline, raw data — walked through in panel order below.

### Panel overview

The top row is the status summary: status (completed / cancelled / budget exhausted), mode (`loop`), generation type (`normal` / `continue` / `regenerate` / `swipe` / `impersonate`), target floor, node-execution count, REVIEW rerun count, last-updated time.

![Loop trace panel: meta header](/images/orchestrator/real-loop-meta.png)

### Agent conversation

The "Agent conversation" column lays out the loop's full `messages` array in order — `System` blocks for the system prompt, `Assistant` blocks for the agent's per-round reasoning and tool calls (arguments expanded inline, no need to crack open raw JSON), followed by `Tool result` blocks. Every bit of context in the loop is right here; cross-reference against the system prompt to find where the agent went off-track.

![Agent conversation: system prompt + first round's thinking + chat_read_range tool call](/images/orchestrator/real-loop-conversation-system.png)

In the next round the agent takes the previous tool's return, adds another thought, and calls `finalize`. `finalize` rides the same tool-call channel; its `capsule_text` is expanded inline as structured text — that's the exact string injected into the main model.

![Agent conversation: finalize call with the full capsule_text](/images/orchestrator/real-loop-conversation-assistant.png)

### Event timeline

The "Event timeline" column lists every trace event in order with ISO timestamps. Run start/finish, each round's llm_request / llm_response, every tool_call / tool_result / tool_error — one line each. When a safeguard fires, a `budget_exhausted` row shows up with the specific reason.

![Loop event timeline: run_started → llm_request/response → tool_call/result → Run completed](/images/orchestrator/real-loop-events.png)

Event types at a glance:

- `run_started` / `run_finished` — run start / end (with status: `completed` / `budget_exhausted` / `cancelled`)
- `llm_request` / `llm_response` — per-round request / response (includes `message_count`, `tool_call_count`)
- `tool_call` / `tool_result` / `tool_error` — input and result for every tool call (`finalize` is reported through the same channel; an empty `capsule_text` raises `code: FINALIZE_EMPTY`)
- `agent_no_tool_call` — agent didn't call any tool this round (with consecutive count)
- `budget_exhausted` — specific reason when a safeguard fired (`max_rounds` / `wall_clock` / `no_tool_call_streak`)

### Raw trace / export

At the bottom, "Latest injected text" is the final capsule; the "Raw runtime trace" block beneath it dumps the whole run as JSON — `runId`, `chatKey`, `generationType`, `capsuleText` and other top-level fields are all there. When filing a bug, **Export this run** downloads this JSON as a JSONL file you can hand to the developer.

![Loop raw trace JSON and latest injected text](/images/orchestrator/real-loop-rawtrace.png)

::: warning persistTrace is experimental
The settings panel's `persistTrace` toggle auto-persists every run's trace events to the extension data directory. **It's experimental right now** — there's no cross-platform-stable on-disk helper and the toggle defaults off. On-demand JSONL export from the trace popup is enough for everyday work; only flip `persistTrace` on when you specifically want to keep monitoring a chat's loop behaviour over time.
:::

## AI Iteration Studio for Loop

Don't want to hand-write the system prompt? Open the loop popup → click **Open AI Iteration Studio**. Describe the agent in plain language; Studio's AI uses tool calls to patch the profile (`system_prompt`, tool toggles, `max_rounds`, preset routing). See [AI Iteration Studio → Loop-mode iteration tips](/features/orchestrator/iteration-studio#loop-mode-iteration-tips).

## Character card binding

Loop now supports character overrides. Open the orchestration editor with a card selected; you'll see **Save To Character Override** / **Clear Character Override** buttons — same experience as Spec / Agenda. Bound loop profiles export with the card, letting card creators recommend "what to read, what to remember, when to finalize" for their character.

::: info Difference vs spec / agenda
The Loop popup currently has no **Export Profile** / **Import Profile** buttons. For now, use AI Iteration Studio to reuse loop workflows across machines. File-level import/export will land later.
:::

## Loop vs. spec / agenda

| Dimension | spec / single | agenda | loop |
|---|---|---|---|
| Setup cost | Author DAG + per-node prompts | Planner prompt + worker prompts | One system prompt + tool toggles |
| Agent count | Many (one per stage / node) | Planner + workers | Single agent |
| Preset switches | Many | Many | One |
| Variable flow | Hard-wired topology | Planner schedules | Agent picks its own next step |
| Context continuity | Pass through `previous_outputs` | Same as spec | Tool results live in messages |
| Failure handling | Node failure propagates | Worker failure → Planner retries | Tool failure feeds back as structured error, agent self-corrects |
| Card override | ✅ | ✅ | ✅ |
| File-level import/export | ✅ | ✅ | ❌ (use Iteration Studio to reuse) |
| Best for | Predictable pipelines / fixed stages | Complex tasks needing scheduling | Speed/quality balance; exploratory research, dynamic decisions, cache-sensitive work |

## Loop configuration reference

<details>
<summary>Loop-specific settings</summary>

| Setting | Description |
|---|---|
| `max_rounds` | Maximum rounds the loop can run (default 20, max 50) |
| `wall_clock_budget_ms` | Whole-loop wall-clock cap (default 300000 ms / 5 min) |
| `system_prompt` | Loop agent's system instruction |
| `tools.<namespace>.<verb>` | Per-tool enable toggle (`finalize` forced true) |
| `apiPresetName` / `promptPresetName` | API and prompt preset for the single agent |
| `capsule_inject` | Same position / depth / role / custom instruction shape as spec mode |

</details>

## FAQ

**Q: `memory_search` returned empty — what should I do?**
A: First confirm the memory-graph extension is enabled and the chat has memory nodes. Empty can also mean the query was too narrow; try `memory_list_recent` to scan the timeline before deciding the next move.

**Q: Why does `lorebook_search` exclude already-activated entries?**
A: Those entries are already injected into the main model via the worldInfo path, so returning them inside the loop just wastes tokens. **Use `lorebook_get` if you need an already-activated entry verbatim** — for example, to quote terminology consistently.

**Q: How do I stop a loop mid-run?**
A: Click the toolbar's stop button (same as for spec / agenda). The loop runtime checks the abort signal at the top of every round and stops immediately; the trace records `cancelled` and no half-baked capsule is injected.

**Q: Are notes shared across chats?**
A: No. `note_add` writes to the **current chat**'s floor-state namespace; chats don't see each other's notes. When floors are deleted / swiped, floor-state's settle mechanism kicks in — notes bound to a removed floor disappear automatically.

**Q: My loop got cut off after three rounds without tool calls — what now?**
A: Check whether the system prompt gives the agent a clear "output shape". Most of the time the agent is "thinking" but not sure when to call `finalize`; adding "as soon as you have enough information to write the capsule, call `finalize` immediately" usually fixes it.

**Q: I enabled `search_search` but the agent gets `SEARCH_UNAVAILABLE` / `SEARCH_DISABLED` — why?**
A: The web tools forward to the [Search Tools](/features/search-tools) plugin. `SEARCH_UNAVAILABLE` means the plugin isn't loaded; `SEARCH_DISABLED` means it's loaded but disabled in its settings. Open the search-tools panel, pick a provider (DuckDuckGo / SearXNG / Brave), turn the master switch on, then retry.

## Performance trade-offs

Loop mode differs structurally from spec / agenda:

- **Latency.** Loop runs the entire pass on a single preset, so every round reuses the same prompt-cache prefix; end-to-end should beat spec (which rebuilds the cache on every stage transition).
- **Token usage.** Loop is **not necessarily cheaper.** Tool-call results accumulate in the same messages array; by round six or seven the context has grown noticeably. Spec mode breaks the stream between stages, so each stage's prompt stays short.
- **Failure rate.** Loop is the new mode and is likely less stable than the mature spec path; the agent will occasionally wander. Start with short tasks (`max_rounds=5`) and grow from there.

::: info Pending real-world validation
Concrete latency deltas, capsule-quality preferences, and total-token usage across different characters / models still need real LLM-call comparison; the relative expectations above are not yet backed by large-scale numbers. Feedback after a few days of loop-mode usage is welcome.
:::

## Related

- [Orchestrator overview](/features/orchestrator/) — common configuration / triggers / character card binding
- [AI Iteration Studio](/features/orchestrator/iteration-studio) — let AI write the system prompt for you (recommended)
- [Spec mode](/features/orchestrator/spec) — the default DAG mode
- [Single Agent mode](/features/orchestrator/single) — degenerate Spec
- [Agenda mode](/features/orchestrator/agenda) — Planner-driven dynamic dispatch
- [Function Call Runtime](/improvements/function-call-runtime) — the runtime tool calls go through
- [Memory Graph](/features/memory-graph) — data source behind the `memory_*` tools
