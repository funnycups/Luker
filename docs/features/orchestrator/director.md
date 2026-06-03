# Director mode

Director is the only **takeover mode** the orchestrator offers — the final message body for the turn isn't written by the main LLM at all. Instead a team of agents inside the orchestrator produces it and commits it directly. The other three modes (spec / agenda / loop) produce a compact "briefing" (capsule) that the main LLM still has to consume to turn into a reply; director skips that step and ships the prose itself.

## How it differs from the other orchestrator modes

| Dimension | spec / agenda / loop | director |
|---|---|---|
| Who writes the body | Main LLM (reads capsule, then writes) | The main agent inside the orchestrator (writes directly) |
| Agent output | Compact capsule text | Complete, sendable message body |
| Main LLM this turn | Produces the final reply | **Not called at all** |
| When to use | Want the main LLM to keep producing on its warm prompt cache | Want a multi-perspective writing team to **deliver finished prose** |

From the user's point of view, director gives you the "a whole team inside the AI is collaborating; all you see is their final RP reply" experience. The drafting, critiquing, revising, and finalizing all unfold inside the reasoning fold, while the main chat window only ever shows the finished paragraph.

## When this is the right pick

- **High-quality long-form RP** where character consistency, voice consistency, and continuity all matter at once and a single viewpoint can't track them.
- **You want a "draft → critique → revise" discipline forced into the flow**, instead of trusting the main LLM to do it.
- **You want different viewpoints on different models / presets** — e.g. planning on a fast cheap model, critiquing on a strong model.

Not for:

- Just wanting the main LLM to behave smarter — use [loop](/features/orchestrator/loop) / [spec](/features/orchestrator/spec) / [agenda](/features/orchestrator/agenda) and let the main LLM consume the capsule.
- Low latency turns — director runs several rounds of tool calls plus several sub-agent dispatches per turn; wall-clock cost is noticeable.

## What it looks like running

The screenshots below come from a real director turn. The main agent coordinated three of the default sub-agents (`chat_scout` / `voice_critic` / `continuity_critic`) and ran the full "scout → draft → critique → revise → finalize" flow end-to-end.

### Step 1: dispatch the pre-draft scout

After the turn opens, the main agent dispatches `chat_scout` to sweep recent chat. It comes back with five `Item / Source / Why` summaries of load-bearing state. These land in a named section inside the reasoning fold (anchor `### [<handleId>: chat_scout]`) where the main agent can read them while drafting.

![Director dispatching chat_scout with five scout entries](/images/orchestrator/director-takeover/director-real-scout-dispatch.png)

### Step 2: draft, then critique in parallel

The main agent uses the scout output to draft a Chinese-prose passage into the message body (`write_message`), then **in parallel** dispatches the two post-draft critics:

- `voice_critic`: humanity & voice — flags "data-person" prose (cold observation verbs / data vocabulary / reporting-style dialogue) and archetype mishandling (a scientist actually "analyzing" their love interest, an android "scanning" during intimacy, a taciturn character whose interior is treated as actually empty).
- `continuity_critic`: hard contradictions only — flags lines where the draft asserts X and chat / memory / lorebook explicitly states NOT-X, plus knowledge-boundary violations (a character knowing something they were never told).

Each critic gets its own named section in the reasoning fold; the two sections grow side-by-side without interleaving at character level (each section's bytes stay contiguous thanks to the JavaScript single-threaded event loop).

![voice_critic and continuity_critic running in parallel](/images/orchestrator/director-takeover/director-real-critic-loop.png)

### Step 3: iterate, revise, finalize

The main agent reads the two critics' feedback, patches the prose via `apply_message_patches` for any critique it agrees with, ignores the ones it judges off-base, and can spin up another round (a fresh critic, another re-read). When it judges the prose ready, it calls `finalize`. The handle settles, the message is saved, the UI unlocks, and what appears below the fold is the finished Chinese prose ready to send.

![After finalize: the fold collapses, the finished body shows below](/images/orchestrator/director-takeover/director-real-final-body.png)

For the whole turn, the user sees only that final paragraph in the main chat; everything procedural stays in the fold, available on demand.

## Default skills

The default director profile ships paired with **24 bundled skills** that the agents read on demand. Skills are small Anthropic-compatible knowledge packs — each one carries a writing rule, a critic method, or a workflow contract that used to live inline in the system prompts. Moving them out of the prompts and into `skill_read`-able files has three effects: the prompts are short and editable, the same rule can be shared across agents without duplication, and a card or preset author can ship their own variants.

The 24 bundled skills group into three families:

| Family | Count | Visible to | Examples |
|---|---|---|---|
| Shared (mode-level) | 5 | every default sub-agent | `director-anti-cliche-zh`, `director-character-voice-zh`, `director-no-meta-zh`, `director-output-discipline-zh`, `director-zh-style-baseline` |
| Main-agent | 2 | main agent only | `director-turn-workflow-zh`, `director-dispatch-protocol-zh` |
| Per-sub-agent method | 17 | the matching sub-agent only | `voice-critic-method-zh` (→ `voice_critic`), `event-summary-rules-zh` (→ `memory_curator`), `chat-scout-method-zh` (→ `chat_scout`), … |

The mode-level skills are common writing rules every default agent shares. The two main-agent skills carry the 7-step turn workflow and the dispatch protocol. Each per-sub-agent method skill holds the sub-agent's specific contract — e.g. `event-summary-rules-zh` is the full V10 event-summary writing discipline for `memory_curator`.

The default profile pre-fills `skills.visible` accordingly: mode-level visible covers the 5 shared skills, the main agent uses `["+", "director-turn-workflow-zh", "director-dispatch-protocol-zh"]` (inherit mode + add two), and each sub-agent uses `["+", "<its-method-skill>"]`. So out of the box every agent sees its right stack with no manual binding.

The first time the server starts, `data/<user>/skills/global/` populates from `default/skills/global/`. After that, the **Manage skills** button in the orchestrator panel (and the `import-bundled` API) is the only way to overwrite — there's no implicit auto-update on subsequent boots.

For the full picture of how skills plug into agents, see [Skills overview](/features/skills/) and [Orchestrator integration](/features/skills/orchestrator-integration). For authoring conventions, [Authoring skills](/features/skills/authoring).

## Switching to director

In the extension drawer's **multi-agent orchestration** panel, set **execution mode** to **Director (multi-agent)**. The spec / agenda / loop setting cards collapse and director's setting card appears.

::: tip 99% of users shouldn't hand-write the main-agent system prompt
The default main-agent system prompt is **tightly coupled** to the twelve default sub-agent ids — it's already tuned for the "scout first, draft, then critique, then iterate, then mutate" discipline. To customize, use the [AI Iteration Studio](/features/orchestrator/iteration-studio): describe what you want in natural language and let it patch your profile via tool calls.
:::

## Workflow outline

```d2
direction: down

start: "A new turn arrives\n(the main LLM is NOT called this turn —\nthe orchestrator writes the body itself)" {
  shape: oval
  style.fill: "#e8f5e9"
}

loop: "Main agent at the writing desk" {
  style.fill: "#e1f5ff"

  think: "Read the draft so far,\ndecide the next move" {
    style.fill: "#fffde7"
  }

  decide: "What does the\nmain agent need?" {
    shape: diamond
  }

  consult: "Consult a specialist (default profile, 12 sub-agents)" {
    style.fill: "#fff3e0"
    pre: "Pre-draft scouts\nintent_scout · chat_scout · memory_scout ·\nlorebook_scout · notes_pickup_scout ·\nepistemic_scout · canon_scout (on-demand)" {
      style.fill: "#fffde7"
    }
    mid: "plot_brainstormer\nstructural sketch — dispatch several\nin parallel for diverse angles" {
      style.fill: "#fffde7"
    }
    post: "Post-draft critics\nvoice_critic · continuity_critic" {
      style.fill: "#fffde7"
    }
    housekeeping: "Post-draft housekeeping\nmemory_curator — writes durable facts to the memory graph\nnotes_curator — the ONLY notes mutator\n(default: do nothing)" {
      style.fill: "#fffde7"
    }
  }

  research: "Look something up\nrecent chat · memory · lorebook ·\nweb · notes" {
    style.fill: "#fffde7"
  }

  write: "Write or revise the body\nextend the prose · patch problem lines ·\nreread the draft" {
    style.fill: "#fffde7"
  }

  finalize: "Wrap up · finalize the body" {
    style.fill: "#c8e6c9"
  }

  think -> decide
  decide -> consult: "consult"
  decide -> research: "look up"
  decide -> write: "write"
  decide -> finalize: "finalize"
  consult -> think: "specialist returns"
  research -> think: "next move"
  write -> think: "next move"
}

out: "Finished message body posted to chat\n(no capsule — the prose IS the output)" {
  shape: oval
  style.fill: "#f3e5f5"
}

start -> loop.think
loop.finalize -> out
```

1. **The main agent runs in a tool-calling loop.** Each round it can call any of the tools available to it, until it calls `finalize`, hits the round cap, or the user aborts.

2. **Tool groups available to the main agent:**
   - **Loop tools** (enabled per-profile) — same family as loop mode: `chat_*` / `lorebook_*` / `memory_*` / `note_*` (open/close) / `search_*`, for gathering context.
   - **Collaboration tools** — `dispatch_subagent(subagentId, task)` starts a profile-configured sub-agent by id; `dispatch_inline_subagent(systemPrompt, task, ...)` starts an ad-hoc one-shot sub-agent; `await_subagents(handles)` blocks until the named sub-agents finish; `cancel_subagent(handle)` aborts an in-flight one.
   - **Message-production tools** — `write_message(text, mode?)` writes into the message body (`mode='replace'` overwrites, `mode='append'` extends); `apply_message_patches(patches)` makes targeted context-replace edits; `get_draft()` reads back the current draft; `finalize()` commits the turn and ends the loop.
   - **[Custom tools](./custom-tools.md)** — any tool registered by another Luker extension, bridged from a SillyTavern function tool, or handwritten in the director profile. Sub-agents see the same custom-tool surface (filtered by per-sub-agent overrides where applicable).

3. **Sub-agents are one-shot consultants.** At dispatch time each one gets the chat snapshot, the main agent's task brief, its own system prompt, the enabled loop tools, and `get_draft()`. They don't see each other's existence, don't see the main agent's reasoning, **cannot dispatch deeper sub-agents**, and **cannot write into the message body** — they only return text, and the main agent decides what to do with it.

4. **The default profile ships with 12 RP-tuned sub-agents:**

   | Sub-agent | Purpose | Concrete RP example |
   |---|---|---|
   | `intent_scout` | Cross-source pre-draft scout — joins the user's recent input (explicit asks, parenthetical / OOC asides, load-bearing implicit signals) against lorebook authoring-directive entries (style rules, pacing, character-writing conventions, content constraints, output spec). Surfaces what the user wants this turn AND what the lorebook demands of the writing. | "User aside: `(写慢些)` at chat[floor=72]. Lorebook entry `pov-rules`: 'narrate in second-person, never break the fourth wall'. Lin Wan-style entry: 'when angry, speaks in fragments before silence.'" |
   | `chat_scout` | Pre-draft single-source scout — sweeps recent chat for load-bearing state. | Returns 5 `Item / Source / Why` lines, e.g. "Lin Wan's anxiety / msg 42 / will steer dialogue back to family". |
   | `memory_scout` | Pre-draft single-source scout that runs an LLM-grade recall pass via the memory-graph read-only API. Enumerates the visible candidate pool, finds named entities or topic matches via `memory_find_by_name` / `memory_keyword_search` (or `memory_vector_search` when an embedding profile is configured), drills rollups via `memory_expand_seeds` when warranted, then returns a cited short list with signal levels grounded in API signals (edge density, exposure, alwaysInject). Does NOT read chat or lorebook — those are other scouts' jobs. Does NOT mutate the graph. | "`evt_42` (Chapter 3 grandmother arc) is a hub — its children contain the romantic-confession beat the draft will recall. Demoted: `msg_18` (one-off mention, no follow-up)." |
   | `lorebook_scout` | Pre-draft single-source scout — pulls additional lorebook entries beyond what's already injected. | "`Luoyan-MainCity` entry not yet in context; relevant — Lin Wan's grandmother is there." |
   | `notes_pickup_scout` | Pre-draft scout — scans the OPEN notes block (foreshadowing, promises, chapter outlines the agent itself opened in earlier turns) and surfaces the ids whose trigger conditions are ripe for THIS beat. Doesn't analyze, doesn't draft — just picks. | "`o_a3f2` (grandmother in Luoyang) is ripe — Lin Wan just mentioned the city. `o_b8c1` (sanctum oath) is not yet ripe." |
   | `epistemic_scout` | Cross-source pre-draft scout — joins chat (what characters have been exposed to) against lorebook / memory (what could be known in-world), producing a per-character Knows / Doesn't-know / Omniscience-traps inventory. | "Lin Wan does NOT know the user is the besieging general's son — she's only met him twice and the rumour-bearer hasn't appeared yet." |
   | `canon_scout` | On-demand external scout for fanfiction / public-IP canon facts, backed by the loop `search_search` / `search_visit` tools. Requires `search.search` / `search.visit` to be enabled in the profile; returns zero items otherwise. Skip for original-fiction sessions. | When the scene touches Naruto canon: "jōnin promotion is by recommendation, not exam — relevant if Lin Wan claims to be a candidate." |
   | `plot_brainstormer` | Mid-stage brainstormer — one structural sketch per angle. Dispatch several in parallel with diverse angles for genuinely different choices. | Angle A "direct confrontation" / Angle B "silence becomes the beat" / Angle C "she pivots to Luoyang to dodge". |
   | `voice_critic` | Post-draft critic — humanity & voice. Catches "data-person" prose (cold observation verbs / data vocabulary / reporting-style dialogue at emotional moments) and archetype mishandling (cold-archetype characters written as actually cold instead of stylized-cold over a hot interior). Voice-register mismatches are a secondary dimension. | "Draft has Lin Wan 'observing the subject's micro-expression shifts with clinical detachment' — this is sensor prose, not living-being prose. Swap for a sensation she's actually feeling, even if her surface stays composed." |
   | `continuity_critic` | Post-draft critic — hard contradictions only. Trusts the draft by default; flags only when chat / memory / lorebook explicitly stated the opposite of what the draft asserts. The one exception is knowledge-boundary violations: a character knowing something they were never told is always a flag. | "Draft has Lin Wan recognizing the family crest on the user's pendant — but chat shows the pendant has only ever been described as 'a silver disc' to her. Knowledge-boundary: she's never been told it's a crest, let alone whose." |
   | `memory_curator` | Post-draft mutation sub-agent that updates the memory graph for facts that survive past the scene. Multi-round observe-act: queries schema, looks up existing entities via `memory_find_by_name` before creating, patches fields via `memory_node_edit`, manages relation edges via `memory_link_upsert` / `memory_link_delete`, and (Phase B) checks `memory_compaction_candidates` and runs `memory_compact_nodes` for hierarchical event rollups. event nodes are mandatory per dispatch (timeline continuity); character_sheet / location_state default to SKIP unless the change passes a 24-hour-in-world persistence test. | "Created node `evt_42` (Day 5 oath beat). Edited `n_eileen` to add `goal: 'pay the debt'`. Upserted `n_eileen → debt_owed_to → n_protag`. Compacted leaves `evt_18,19,20` into `rollup_l1_06`." |
   | `notes_curator` | Post-draft housekeeping — the ONLY mutation point for the notes substrate this round. Closes notes the draft deployed; opens new ones rarely & only when the draft committed to a genuine plot-load-bearing obligation. **Default disposition: do nothing.** Notes pollution is worse than under-closure. | "Closing `o_a3f2` — the grandmother visit happened in this draft. No new opens; brainstormer suggested a future-Luoyang lead but the draft didn't commit to it." |

   The default main-agent system prompt is **tightly coupled** to these 12 ids — it dispatches by id and writes task-brief templates for each. If you change the sub-agents, the main-agent prompt has to change to match.

   > **Notes anti-pollution principle**: The `notes_curator` defaults to **do nothing**. Notes is a plot-author thread store, not a turn diary — a polluted notes list costs the agent attention every subsequent round. Closing is safe; opening is expensive. This principle is baked into the default sub-agent prompts and the main agent's system prompt; if you author your own director profiles, preserve it.

5. **The main agent's view of each sub-agent is just `id` + `description`** — the user-authored `systemPrompt` is **not** leaked into the main agent's prompt. The description is the only signal it has when "picking from the menu", so the defaults follow a three-part shape (role / what it does NOT know / what to put in each task brief). The Studio's iteration system prompt teaches this convention to the AI editing profiles, so new sub-agents come out with descriptions the main agent can actually use.

## Configuration

Open the editor for a profile inside the **multi-agent orchestration** panel (you'll see the director card once you switch the mode to **Director (multi-agent)**).

### Main agent

- **API preset** — the connection profile the main agent's `generateTaskStream` calls run on.
- **Prompt preset** — the Chat Completion preset the main agent uses (sampler, temperature, etc.); this is the one discussed in the next section, "Recommended preset settings".
- **Main system prompt** — the default text is materialized into the field at profile creation. The runtime uses whatever is currently in the field — an empty field means an empty instruction (no hidden fallback). Edit freely; the **Reset to default** button rewrites the field back to the built-in default. Try the default for a couple of turns before deciding to override.

### Sub-agents

One row per sub-agent. Fields:

- **Sub-agent ID** — unique within the profile. The main agent dispatches as `dispatch_subagent({ subagentId: "<this id>", task: "..." })`.
- **Description** — surfaced to the main agent as part of the tool documentation; tells it what this sub-agent is good for and when to dispatch.
- **System prompt** — the role / viewpoint this sub-agent embodies. e.g. "You're a voice critic. The main agent will hand you a draft of this turn — list any line that feels off-character."
- **API preset** + **Prompt preset** — sub-agent-specific routing. Planning sub-agents can use a fast/cheap model, critics a strong one.

### Limits

- **Maximum tool-calling rounds** — hard cap on the main agent's loop.
- **Maximum concurrent sub-agents** — caps in-flight `dispatch_subagent` calls.
- **Maximum total sub-agent runs per turn** — caps cumulative sub-agent invocations.

### Behavior on abort

- **Discard partial message on abort** OFF (default): user-initiated stop preserves the partial body and commits it; the fold gets a trailing `### [aborted]` marker.
- **Discard partial message on abort** ON: the partial is discarded and the message slot reverts to its placeholder state.

## Recommended preset settings

The Chat Completion preset the main agent uses is **not the same preset you use in your main chat**. It drives the main agent's tool-calling loop, not the final reply. Items in that preset are only useful when they speak to "how the main agent should think" or "how the final prose should sound" — everything else just pollutes the main agent's context.

### Recommended OFF

Turn these off — all for the same reason, **duplicate injection**: ST's main path already writes them into the chat context the main agent sees.

- **Character card fields** (description / personality / scenario / first message / example messages)
- **User persona**
- **Example messages**
- **Worldbook placeholders** (any explicit worldInfo splice nodes in the preset)

### Recommended ON

| Prompt item | Why on |
|---|---|
| **Chat history** | The injection slot through which the main agent's prompt actually reaches the LLM. Turn it off and the agent gets nothing. |
| **Writing style instructions** | Read by the main agent when drafting via `write_message` and when briefing `voice_critic`. |
| **Jailbreak / bypass instructions** | A mid-loop refusal stalls the whole scout → draft → critique chain before `finalize` can fire. |
| **Anti-cliché instructions** | Same channel as writing style — main agent drafting and critic briefs both read them. |

## Advanced: using director as a single-agent iterative writer

Director's default workflow is "main agent + multiple sub-agents", but a power-user variant is to degrade it into a **single-agent multi-round iterative writer** — no critics, just one main agent drafting, re-reading, revising, and finalizing on its own.

**Fits when** you already know the style you want, you don't need critic perspectives, and you just want a strong model to use the tool loop (read context, query the lorebook, draft, re-read, revise) to deliver a finished body directly. Conceptually it's "director's main agent run loop-style" — except the takeover semantics stay (no capsule; the prose itself is the output).

**Use the [AI Iteration Studio](/features/orchestrator/iteration-studio).** Tell it something like *"convert this profile into a single-agent iterative writer: drop all sub-agents, simplify the main-agent prompt to draft → re-read → revise → finalize, keep `chat_*` / `memory_*` / `lorebook_*` tools"*. The Studio knows this variant and will patch your profile via tool calls — review the diff, approve, save. This is the recommended path; the steps that follow are only for users who want to wire it by hand.

::: details Manual setup (skip if Studio handled it)

1. Rewrite the main-agent system prompt to drop all dispatch-related discipline. Replace it with "draft, re-read, revise; when you think it's ready, call `finalize`."
2. Remove all sub-agents from the profile (or strip every id out of the main-agent prompt) — this way `dispatch_subagent` doesn't appear in the main agent's tool list. `dispatch_inline_subagent` can stay or go; keep it only if you want the main agent to spin up an ad-hoc consultant for unusual cases.
3. Leave at minimum these tools enabled for the main agent: `write_message` / `apply_message_patches` / `get_draft` / `finalize`, plus whichever loop tools you want it to use (a typical bundle is `chat_*` + `memory_*` + `lorebook_*`).
4. Consider lowering the "maximum tool-calling rounds" cap — the default 20 is high for a single agent.

:::

**Caveat**: no critics means the main agent's own judgment is final. Run it for a couple of turns first to see whether it reliably hits `finalize` under your prompt, then decide whether to save the config as a separate profile.

## Limits and constraints

- Triggers on `normal` / `regenerate` / `swipe` / `continue` generation types. `quiet` and `impersonate` do not.
- Requires the active connection profile to be an OpenAI-family provider (Anthropic / OpenAI / Gemini / OpenRouter / …) — the underlying streaming API does not yet support kobold / textgen.
- Capsule injection is automatically disabled for the turn when director is active (the two are conceptually mutually exclusive; the message body is the output).
- **Sub-agents are depth-1**: they cannot dispatch deeper sub-agents. They share the main agent's enabled loop tools — whichever of chat / lorebook / memory / note (open/close) / search are on in the profile, sub-agents can call them independently of the main agent's loop. A sub-agent terminates naturally on the first round where it makes no tool call: that round's text is its return value to the main agent.
- Director honors the orchestrator's existing **Use streaming transport** toggle: when ON, both the main agent and sub-agents route through the streaming API; when OFF, plain non-streaming calls are used.
- **The message bubble updates live as the main agent works.** Each `write_message` / `apply_message_patches` call repaints the bubble — you watch the message grow, get patched in place, get rewritten. Granularity is per-tool-call, not per-token.
- **Sub-agent output streams live into the reasoning fold.** Each dispatched sub-agent gets its own named section (anchor `### [<handleId>: <subagentId>]`). With streaming on, tokens land in the right section as they arrive — multiple sub-agents dispatched in parallel show as several sections growing side-by-side, in dispatch order, with no character-level interleaving (the per-section anchoring relies on JavaScript's single-threaded event loop to keep each producer's bytes contiguous). With streaming off, the section gets the sub-agent's terminal text in one shot. The section header carries `(running)` while the sub-agent works, cleared on completion (or replaced with `(error: ...)` on failure).
- Main-agent commentary between tool calls also lands in the reasoning fold as `### [main-N]` paragraphs, so you can follow its reasoning across rounds.

## Character card binding

Director profiles support character-card overrides like spec / agenda / loop. With a character selected, open the orchestrator editor and you'll see **Save to character override** / **Clear character override** buttons. Once bound, this director configuration travels with the card on export — card authors can ship a complete "main agent + sub-agents + limits" setup tuned for their character.

::: info Same shape as spec / agenda / loop
Director shares the same **Export profile** / **Import profile** buttons as the other modes. The export file is a self-contained JSON payload (`format: luker_orchestrator_profile_v3`) of the active scope (global or character override). Import refuses to load a file whose mode does not match the current execution mode — switch the mode first if you need to load a director profile.
:::

## Related pages

- [Orchestrator overview](/features/orchestrator/) — shared configuration / when it triggers / character card binding
- [Skills overview](/features/skills/) — the knowledge-pack substrate that ships with director defaults
- [Orchestrator integration](/features/skills/orchestrator-integration) — how `skills.visible` resolves per-agent
- [AI Iteration Studio](/features/orchestrator/iteration-studio) — let AI write your main-agent / sub-agent system prompts (strongly recommended)
- [Notes substrate](/features/orchestrator/notes) — the open/close-state thread store consumed by `notes_pickup_scout` and mutated by `notes_curator`
- [Loop mode](/features/orchestrator/loop) — single agent in a tool loop, producing a capsule
- [Spec mode](/features/orchestrator/spec) — default DAG, multiple agents per stage producing a capsule
- [Agenda mode](/features/orchestrator/agenda) — Planner dynamically schedules Workers, producing a capsule
- [Custom tools](/features/orchestrator/custom-tools) — extend the main agent and sub-agents with tools from extensions, SillyTavern bridges, or handwritten code

