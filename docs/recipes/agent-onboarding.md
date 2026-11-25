# Multi-agent setup: presets, memory graph, web search

::: tip What this doc solves
Luker's [multi-agent orchestrator](/features/orchestrator/), [memory graph](/features/memory-graph), and [search tools](/features/search-tools) each work independently, but coordinating them into a single flow (an agent team that extracts memories, retrieves canon, and drafts the prose) requires several configuration steps performed in order.

This doc starts from an empty configuration and guides you through preset → Director → memory → search end to end. It does not assume that you have read the deep-dive docs above. By the end, you will have a working default setup that you can continue tuning in **Workbench → AI iteration**.
:::

## What you get

After you finish this doc, when you send a message in the main chat, **the main model does not begin writing immediately** — an agent team executes first:

- **memory scout** scans the memory graph and retrieves the characters / events / locations relevant to the current beat
- **canon scout** (when needed) retrieves fandom canon from the web
- **plot brainstormer** drafts several structural sketches from different angles in parallel; the main agent selects one
- **Main agent** uses the scouts' output to write the final body directly
- **memory curator** writes new facts back to the memory graph after the draft is complete

The memory graph's **Auto extraction / Auto compression** are entirely delegated to the agents, and the search provider defaults to DuckDuckGo — no API key, no embeddings, and no additional LLM routing are required.

## How the team is organized

```d2
direction: down

start: "You send a message" { shape: oval }

orch: "Director main agent takes over" {
  style.fill: "#e1f5ff"
  scouts: "Pre-draft scouts\nmemory scout · chat scout ·\nlorebook scout · canon scout (web, when relevant)"
  brain: "Mid-stage brainstorming\nplot brainstormer\nstructural sketches across angles"
  draft: "Main agent drafts the body"
  curate: "Post-draft housekeeping\nmemory curator writes new facts back"
}

end: "Body appears directly in the chat\n(main model not called this turn)" { shape: oval }

start -> orch.scouts -> orch.brain -> orch.draft -> orch.curate -> end
```

Memory Graph's built-in auto extraction and auto compression stay off while the Director agents handle memory. Once a search provider is enabled, canon scout can perform web searches; otherwise it returns zero results.

## What you need first

- A working Luker instance in which the main chat already produces replies
- A working [RP preset](/basics/presets), ideally already configured with style guidance, jailbreak, and NSFW direction

## Step 1 — Pick a starting preset

Any RP preset you normally use is suitable. This step only confirms that you have a writing preset as a starting point; the next step derives from it the preset variants Director requires.

## Step 2 — Configure the Preset Assistant and derive the presets Director needs

LLM calls made by Luker's plugins fall into **distinct categories** with very different preset needs. One is **plugins producing RP content** — Director's agent team drafting the body, critic sub-agents reviewing, and so on — which requires a full RP preset with jailbreak / style / anti-cliché guidance. The other is the **iteration AI** that powers **Workbench AI iteration** (**Preset**, **Memory graph config**, **Memory graph content**, **Orchestration**, **Character card**, **World book**) and **CardApp Studio** — which uses tool calls to edit configs or extract structured data; any RP instructions leaking in will interfere with the model executing the plugin's instructions, so these slots require a **stripped-down preset that retains only jailbreak**.

Director's flow touches these categories at once:

| Path | Who uses it | Preset shape |
|---|---|---|
| **Agent path** — main agent + sub-agents producing the body | The actual drafters; their output ends up in the chat | A standard RP preset, tuned for tool calling: keeps jailbreak + style + anti-cliché, but drops placeholders / hard schemas that conflict with the orchestrator |
| **Iteration AI path** — the AI you talk to in **Workbench → AI iteration** when tuning your config | A tool-using config editor; never drafts story prose | A **stripped-down preset with only jailbreak left** — no style guidance, no NSFW writing rules, no narrative meta-rules |

::: tip Why the paths cannot share a single preset
RP presets assume that "one LLM writes the entire reply by itself." When those instructions are placed into an agent tool loop, they:

- Compete with the agent's system prompt for attention
- Force "must output schema" / "mandatory chain of thought" constraints into the drafting step, breaking tool calling
- Re-inject placeholders (character description, persona, world info entries) that the orchestrator's main path already injects

Workbench AI iteration is even more sensitive — it does not write story prose at all; it edits configs and profiles through tool calls. Any RP instruction that leaks in interferes with the model executing the plugin's instructions.
:::

### 2a — Configure Workbench AI settings

The Preset editor inside Workbench is itself an LLM-driven tool, so configure Workbench's shared AI connection and generation preset first:

1. Open **Workbench** (`Alt+W`, wand menu → **Workbench**, or the corner pill) and switch to **Settings**.
2. Under **Shared**, pick a working connection profile.
3. Under **Generation preset**, pick an imported example or click **Import example** to install the bundled `plugin-only`. Clicking **Derive from an existing preset** opens the preset workspace with **Jailbreak only** preselected.

![Workbench shared AI connection and generation preset](/images/recipes/agent-onboarding/step-02a-workbench-settings.png)

Every AI iteration target in Workbench, including **Memory graph config**, **Memory graph content**, **Orchestration**, **Preset**, **Character card**, and **World book**, follows the shared connection and preset unless set individually. The **Current source** column shows which level supplies each value.

### 2b — Derive the **agent** preset

Switch to **Workbench → AI iteration → Preset** (or click the wand icon on the Chat Completion preset toolbar, or **Extensions → Completion Preset Assistant → Open in Workbench**). Set **Editing mode** at the top to **Adapt for orchestrator**, then send:

> Convert this preset into an agent-only preset

![Preset Assistant in Adapt-for-orchestrator mode](/images/recipes/agent-onboarding/step-02-preset-assistant.png)

By default it **derives a new preset** (original name + `-orchestrator` suffix) — the original remains untouched. It automatically:

- Disables placeholders that would be **double-injected** alongside the orchestrator's main path: character description, persona, example messages, explicit world info
- Rewrites format constraints that would interfere with tool calling (forced schema, fixed CoT headers) from hard requirements into soft hints
- Gates instructions that only matter for the final draft (summaries, style sign-off) to the "final commit message" phase
- **Keeps** chat history, style guidance, and jailbreak / anti-cliché instructions — the main agent reads them while drafting, and the critic sub-agents read them while reviewing

Review its diff cards in the **Change list** and apply them.

::: tip Refine the preset further in the same session
Adapt for orchestrator is one of the **Editing modes**. Switch **Editing mode** back to **General editing**, start a new conversation, and you have a general-purpose preset editor — for example: "add an anti-cliché directive backed by a few negative examples", "tone the prose-style guidance down from purple to restrained close-detail", or "merge these three rules that express the same requirement". See [Preset Assistant](/features/preset-assistant) for the full details.

The Adapt-for-orchestrator pass also **proactively scans your preset entries for reusable style / format / writing-discipline rules** and proposes lifting them into shareable skills (verbatim, at this preset's scope, with a pointer left in the original entry). Proposals are reviewed independently — approve, reject, or ignore one and the rest of the adaptation still applies. See [Authoring skills from preset content](/features/preset-assistant#extracting-skills-in-adapt-for-orchestrator-mode) for details.
:::

## Step 3 — Switch to Director mode and configure the presets

Open **Workbench → Orchestration**:

1. Turn on **Enable orchestration** and select **Director team** in the topbar mode picker.
2. Open **Settings** inside **Orchestration** and set the default **Connection profile** and **Generation preset** to the `-orchestrator` preset from Step 2b.
3. Under **Iteration**, verify that the iteration AI uses your `plugin-only` preset (or let **Workbench → Settings** supply the default).

## Step 4 — Delegate memory extraction and recall to the agents

Open **Workbench → Memory graph → Settings**:

- **Enabled** ✓ leave enabled
- **Auto extraction** ✗ disable (the curator sub-agent takes over)
- **Auto compression** ✗ disable (the agent handles it during housekeeping)
- **Enable recall injection** ✗ disable (a scout sub-agent already runs an LLM-level recall pass before drafting)

![Memory panel: extraction, compression, recall all delegated to the agents](/images/recipes/agent-onboarding/step-04-memory-toggles.png)

::: info Prefer the memory graph's built-in extraction, recall, and compression?
The default Director configuration claims extraction / recall / compression for itself. If you trust the memory graph's own pipeline more (already configured with multi-model routing, Hybrid + Rerank, etc.):

1. Re-enable **Auto extraction**, **Auto compression**, and **Enable recall injection**
2. In [Step 6 (AI iteration)](#step-6), tell the AI: "I want to manage memory myself with the built-in memory graph; the agents shouldn't touch it."
3. Apply the proposed changes from the **Change list**.
:::

## Step 5 — Pick a search engine

Open **Extensions → Search Tools**. **Search provider** defaults to `DuckDuckGo (no login)` — keep the default. To use a different engine, pick another provider from the dropdown, such as the self-hosted `SearXNG (custom instance)` or an API-key provider.

![Search engine picker](/images/recipes/agent-onboarding/step-05-search-provider.png)

::: info How the top toggles relate to this flow
**Expose tools to main model** and **Run pre-request search agent** are the search tool's **independent** working modes, unrelated to Director — this flow uses Director's own search sub-agent, and neither of those toggles **needs to be enabled**.

If you are not running Director and still want search, see the search tool's [working modes](/features/search-tools) instead.
:::

## Step 6 — Making changes in Workbench AI iteration {#step-6}

Open **Workbench → AI iteration → Orchestration** (or click the **AI** button in **Orchestration**) — this is the entry point for all further customization.

![AI Iteration — Orchestration](/images/recipes/agent-onboarding/step-06-iter-studio-director.png)

Use the scope switcher at the top to choose what to edit:

- **Global** → edits the **global** default profile inherited by all cards without overrides
- **Character-only** → edits **this card's override**, affecting only this character and travelling with the card on export / import

::: tip A successful per-card profile can be promoted to global
If you iterate a Director profile that works particularly well for a specific card, you can promote it to global with **Save To Global** under **Orchestration → Setup** (or export and import the JSON).
:::

### Global scope — example instructions

- "I don't want agents managing memory. Remove the ones doing extraction and recall."
- "I don't want agents searching for canon online. Remove the search sub-agent."
- "Read the image-generation guidance from world info, then add a sub-agent that — after the body is drafted — figures out where to insert illustrations and what prompts to use."
- "Read the variable-update guidance from world info, then add a sub-agent that — after the body is drafted — figures out how variables should update."

### Per-card scope — example instructions

- "Tailor the main agent prompt to this card's setting and current plot — give it a specific writing discipline."
- "This card has custom stamina / mood variables. When the memory curator extracts, prioritize filling those fields."
- Anything specific to this card's genre that does not belong in the global config.

Review the diffs in the **Change list** and apply them. If the result does not match your intent, undo from **Change history** or reset to the default Director profile under **Orchestration → Setup**.

## Optional step — Let AI configure Memory Graph

Memory Graph structure can also be changed by AI. Open **Workbench → AI iteration → Memory graph config**, or choose **Memory graph content** to edit nodes in the current chat.

![Memory Graph Configuration](/images/recipes/agent-onboarding/step-07-schema-studio.png)

Memory structure supports **Global** and **Character-only** scope, and per-card structures travel with the card on export. Use it to tailor memory for a genre, for example:

- Xianxia / cultivation: add `cultivation_realm`, `spirit_meridian` fields to characters
- Political intrigue: add a `faction` node type, tracking alliances and enmities
- Survival: add `inventory_item` nodes, tracking each item's durability and state

## See it in action

Send a message in the main chat and watch the **Run panel** dock update in real time:

![Agent team output in a Director turn](/images/orchestrator/director-takeover/director-real-final-body.png)

- **Pre-draft scouts**: each surfaces `Item / Source / Why` items — characters, events, world info entries that matter to the current beat
- **Mid-stage brainstorming**: a few structural sketches in parallel from different angles for the main agent to select from
- **Post-draft critics**: sub-agents critique the main agent's draft; the main agent decides which critiques to accept
- **Housekeeping**: writes the turn's new facts back to the memory graph

Expand any agent row in the **Run panel** dock (or click **Inspect run** to open **Workbench → Orchestration → Run**) to read model reasoning, tool calls, and outputs.

Not satisfied with the result? Click **Not happy with the result? AI diagnosis** in the Run panel dock to jump straight into **Workbench → AI iteration → Orchestration** with the run trace ready to inspect.

## Where to go next

- [Workbench](/features/workbench) — unified workspace, Q&A, AI iteration, and change history
- [Multi-Agent Orchestrator overview](/features/orchestrator/) — triggering, result injection, the execution modes
- [Director mode](/features/orchestrator/director) — the default sub-agents and their roles
- [AI Iteration for Orchestration](/features/orchestrator/iteration-studio) — natural-language tuning of your config
- [Memory Graph](/features/memory-graph) — node types, recall algorithms, configuration
- [Search Tools](/features/search-tools) — engine differences + the standalone working modes
- [Preset Assistant](/features/preset-assistant) — the other session modes beyond "Adapt for orchestrator"
