# Multi-agent setup: presets, memory graph, web search

::: tip What this doc solves
Luker's [multi-agent orchestrator](/features/orchestrator/), [memory graph](/features/memory-graph), and [search tools](/features/search-tools) each work standalone — but getting them to *collaborate* as one flow (an agent team that extracts memories, looks up canon, drafts the prose) takes a few configuration steps in order.

This doc starts from an empty configuration and walks you through preset → director → memory → search end-to-end. It does not assume you have read the three deep-dive docs above. By the end you have a working default setup that you can keep tuning in the iteration studio.
:::

## What you'll get

After you finish this doc, when you send a message in the main chat, **the main LLM doesn't start writing immediately** — an agent team runs first:

- **`memory_scout`** sweeps the memory graph and pulls characters / events / locations relevant to the current beat
- **`canon_scout`** (when needed) looks up fandom canon on the web
- **`plot_brainstormer`** drafts a few structural sketches from different angles in parallel; the main agent picks one
- **Main agent** takes the scouts' output and writes the final body directly
- **`memory_curator`** writes new facts back to the memory graph after the draft is done

The memory graph's **Auto extraction / Auto compaction** are entirely handed off to the agents, and the search provider defaults to DuckDuckGo — no API key, no embeddings, no extra LLM routing needed.

## How the team divides up

```d2
direction: down

start: "You send a message" { shape: oval }

orch: "Director main agent takes over" {
  style.fill: "#e1f5ff"
  scouts: "Pre-draft scouts\nmemory_scout · chat_scout ·\nlorebook_scout · canon_scout (web, when relevant)"
  brain: "Mid-stage brainstorming\nplot_brainstormer\nstructural sketches across angles"
  draft: "Main agent writes the body"
  curate: "Post-draft housekeeping\nmemory_curator writes new facts back"
}

end: "Body appears directly in the chat\n(main LLM not called this turn)" { shape: oval }

start -> orch.scouts -> orch.brain -> orch.draft -> orch.curate -> end
```

The memory graph's own "Auto extraction / Auto compaction" no longer fires — the agent is doing the same job. Once a search provider is enabled, `canon_scout` is able to look things up; otherwise it returns zero results.

## What you need first

- A working Luker instance where the main chat already produces replies
- A working [Chat Completion preset](/basics/presets), ideally already tuned with style guidance, jailbreak, and NSFW direction

## Step 1 — Pick a starting preset

Any RP preset you'd normally use is fine. This step just confirms you have a writing preset to start from — the next step derives an agent variant from it.

::: tip Why not just use a regular preset for the agents?
Regular RP presets contain a lot of prompt content that assumes "one LLM writes the whole reply by itself". Dropped into an agent tool loop, those instructions:

- Fight for airtime against the agent's system prompt
- Cram "must output schema" / "mandatory chain of thought" format constraints into the drafting step, breaking tool calling
- Re-inject placeholders (character description, persona, world info entries) that the orchestrator's main path already injects

Deriving a separate preset is the safest move — the original stays untouched, and you can switch back any time.
:::

## Step 2 — Derive an agent-specific preset

Open the **Completion Preset Assistant**. Set the **Edit mode** dropdown to **Adapt for orchestrator**, then tell it:

> Convert this preset into an agent-only preset

![Preset assistant in Adapt-for-orchestrator mode](/images/recipes/agent-onboarding/step-02-preset-assistant.png)

By default it will **derive a new preset** (original name + `-orchestrator` suffix) — the original stays as-is. It automatically:

- Disables placeholders that would be **double-injected** alongside the orchestrator's main path: character description, persona, example messages, explicit world info
- Rewrites format constraints that would interfere with tool calling (forced schema, fixed CoT headers) from hard requirements into soft hints
- Gates instructions that only matter for the final draft (summaries, style sign-off) to the "final commit message" phase
- **Keeps** chat history, style guidance, and jailbreak / anti-cliché instructions — the main agent reads them while drafting, and the critic sub-agents read them while reviewing

Walk through its diff, approve each entry.

::: tip While you're here, let it tune the preset further
Adapt for orchestrator is just one of the assistant's three **Editing modes**. Switch the toolbar's **Editing mode** back to the default **General editing**, start a new session, and the same assistant becomes a general-purpose preset editor — useful for things like "add an anti-cliché directive backed by a few negative examples", "tone the prose-style guidance down from purple to restrained close-detail", or "merge these three rules that say the same thing". See [Completion Preset Assistant](/features/preset-assistant) for the full picture.
:::

## Step 3 — Switch to Director mode, wire up both API paths

Open the **Multi-Agent Orchestration** panel in the Extensions drawer:

1. Set **Execution mode** to **Director (multi-agent)**
2. Set the **API preset** + **Chat completion preset** to the `-orchestrator` preset you derived in Step 2
3. Find the **AI Iteration Studio** section and fill in its **API preset** + **Chat completion preset** too — but here **don't** use `-orchestrator`. Use something **stripped down to just the jailbreak** (the bundled [`plugin-only.json`](/presets/plugin-only.json) is built for exactly this).

::: tip Why two paths?
| Path | Who uses it | What to pick |
|---|---|---|
| **Agent API + Chat completion preset** | The actual main agent + sub-agents the orchestrator runs to produce the body | The `-orchestrator` preset from Step 2 (jailbreak + NSFW + style guidance built in) |
| **Iteration Studio API + Chat completion preset** | The AI you talk to in the iteration studio when tuning your orchestration | `plugin-only.json` or another clean preset — its job is to modify your orchestrator config, it doesn't need style guidance or jailbreak |

Other Luker plugins that have their own "iteration AI" (memory graph schema studio, CardApp Studio, the preset assistant itself, etc.) also benefit from this stripped-down preset.
:::

## Step 4 — Hand memory extraction and recall over to the agents

Open the **Memory** panel in the Extensions drawer:

- **Enable** ✓ keep on
- **Auto extraction** ✗ turn off (the curator sub-agent takes over)
- **Auto compaction** ✗ turn off (same — the agent handles it during housekeeping)
- **Enable memory recall injection** ✗ turn off (a scout sub-agent already runs an LLM-level recall pass before drafting; leaving the built-in injector on would **double up** and pollute the main agent's context)

![Memory panel: extraction, compaction, recall all handed to the agents](/images/recipes/agent-onboarding/step-04-memory-toggles.png)

::: info Prefer the memory graph's built-in extraction, recall, and compaction?
The default Director config claims extraction / recall / compaction for itself. If you trust the memory graph's own pipeline more (already tuned with multi-model routing, Hybrid + Rerank, etc.):

1. Re-enable **Auto extraction**, **Auto compaction**, and **Enable memory recall injection**
2. In the [iteration studio (Step 6)](#step-6), tell the studio AI: "I want to manage memory myself with the built-in memory graph; the agents shouldn't touch it."
3. The studio AI will modify your orchestrator config via tool calls — review entry by entry and save.
:::

## Step 5 — Pick a search engine

Open the **Search Tools** panel in the Extensions drawer. **Search provider** defaults to `DuckDuckGo (no login)` — leave it. If you want something more refined, switch to `SearXNG (custom instance)` (fill in your self-hosted URL) or `Brave Search (API key)`.

![Search engine picker](/images/recipes/agent-onboarding/step-05-search-provider.png)

::: info How the two top toggles relate to this flow
**Expose tools to main model** and **Run pre-request search agent** are the search tool's two **independent** working modes, unrelated to Director — this flow uses Director's own search sub-agent, and neither of those toggles **needs to be on**.

If you're not running Director and still want search, see the search tool's [two working modes](/features/search-tools) instead.
:::

## Step 6 — Want to change something? Open the iteration studio {#step-6}

After switching to Director, click **Open AI Iteration Studio** in the orchestrator panel — that's the entry point for all further customization.

![AI Iteration Studio — Director](/images/recipes/agent-onboarding/step-06-iter-studio-director.png)

When you open the studio determines what config it edits:

- **No character chat open** → the studio edits the **global** default config — all cards without overrides pick this up
- **A character chat is open** → the studio edits **this card's override** — only this card is affected, and the override travels with the card on export / import

::: tip A great per-card profile can be promoted to global
If you iterate a Director profile that turns out great for a specific card, you can **promote it manually**: export that card's profile from the orchestrator panel, clear the current chat to return to a no-card state, then import that profile to global. Same applies to schemas.
:::

### Global scope — things you can say

- "I don't want agents managing memory. Remove the ones doing extraction and recall."
- "I don't want agents searching for canon online. Remove the search sub-agent."
- "Read the image-generation guidance from world info, then add a sub-agent that — after the body is drafted — figures out where to insert illustrations and what prompts to use."
- "Read the variable-update guidance from world info, then add a sub-agent that — after the body is drafted — figures out how variables should update."

### Per-card scope — things you can say

- "Tailor the main agent prompt to this card's setting and current plot — give it a specific writing discipline."
- "This card has custom stamina / mood variables. When the memory curator extracts, prioritize filling those fields."
- Anything specific to this card's genre that doesn't belong in the global config.

The studio walks you through a diff entry by entry — approve and save. If you go off the rails, reset to the default Director config.

## Step 7 (optional) — Let AI iterate your schema

The memory graph schema is also iteratable by AI. In the **Memory** panel, click **AI Iterate Schema** to open the **Memory Graph Schema Studio**.

![Memory Graph Schema Studio](/images/recipes/agent-onboarding/step-07-schema-studio.png)

Like orchestration configs, schemas have both global and per-card scope — per-card schemas travel with the card on export. You can use the studio to tailor the schema for a genre, for example:

- Xianxia / cultivation: add `cultivation_realm`, `spirit_meridian` fields to characters
- Political intrigue: add a `faction` node type, tracking alliances and enmities
- Survival: add `inventory_item` nodes, tracking each item's durability and state

::: tip Don't forget the memory graph's iteration AI preset
The **Schema Iteration Prompt (schema-editor AI)** field in the Memory panel feeds into the same "iteration AI path" mentioned in Step 3 — `plugin-only.json` (or something similarly stripped down) is a good pick.
:::

## Go play

Send a message in the main chat. Expand the reasoning fold and you'll see the agent team working live:

![Agent team output in a Director turn](/images/orchestrator/director-takeover/director-real-final-body.png)

- **Pre-draft scouts**: each surfaces ~5 `Item / Source / Why` items — characters, events, world info entries that matter to the current beat
- **Mid-stage brainstorming**: a few structural sketches in parallel from different angles for the main agent to pick from
- **Post-draft critics**: sub-agents push back on the main agent's draft; the main agent decides which critiques to accept
- **Housekeeping**: writes the turn's new facts back to the memory graph

Want a deeper look — each agent's actual reasoning, every tool call's request and response? Click **View Runtime Trace** in the orchestrator panel.

Not happy? That reasoning fold is the full agent execution log — pinpoint where things went off, then head back to the [AI Iteration Studio](/features/orchestrator/iteration-studio) and describe in natural language what you want changed.

## Where to go next

- [Multi-Agent Orchestrator overview](/features/orchestrator/) — triggering, capsule injection, the four execution modes
- [Director mode](/features/orchestrator/director) — the 12 default sub-agents and their roles
- [AI Iteration Studio](/features/orchestrator/iteration-studio) — natural-language tuning of your config
- [Memory Graph](/features/memory-graph) — node types, recall algorithms, schema customization
- [Search Tools](/features/search-tools) — engine differences + the standalone working modes
- [Preset Assistant](/features/preset-assistant) — the other two session modes beyond "Adapt for orchestrator"
