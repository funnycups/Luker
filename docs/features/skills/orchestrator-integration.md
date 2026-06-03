# Orchestrator integration

This page covers how skills attach to an orchestrator profile and how each agent ends up seeing the right ones at dispatch time.

The high-level picture: an orchestrator profile carries a `skills` policy at two levels — **mode-level** (defaults) and **per-agent override** — and the runtime resolves both against the physical inventory before each dispatch. Agents see only their resolved visible set; the rest is filtered out.

## The policy shape

In the orchestrator profile JSON, two `skills` blocks live side by side with existing fields like `systemPrompt`:

```jsonc
{
  "mode": "director",

  // Mode-level defaults — apply to every agent under this mode.
  "skills": {
    "visible": ["director-anti-cliche-zh", "director-character-voice-zh"],
    "deny": []
  },

  "mainAgent": {
    "systemPrompt": "You are the director's main agent...",
    // Per-agent override. Leading "+" inherits the mode defaults.
    "skills": {
      "visible": ["+", "director-turn-workflow-zh", "director-dispatch-protocol-zh"]
    }
  },

  "subAgents": [
    {
      "id": "voice_critic",
      "systemPrompt": "You are the voice critic...",
      "skills": {
        "visible": ["+", "voice-critic-method-zh"]
      }
    }
    // ... more sub-agents
  ]
}
```

Both `visible` and `deny` are lists of **skill names only** — no scope prefixes. The resolver walks the three physical scopes and matches by name (later-wins precedence: character > preset > global).

## The three resolution rules

When dispatching an agent, the runtime computes its effective `visible` and `deny` from the mode + agent blocks:

### Rule 1 — agent has no `visible` (or empty)

Effective visible = mode visible. The agent inherits the mode defaults verbatim.

```jsonc
"mainAgent": {
  "skills": { "visible": [] }  // or omitted
}
// Effective: ["director-anti-cliche-zh", "director-character-voice-zh"]
```

### Rule 2 — agent's `visible` starts with `"+"`

Effective visible = mode visible ∪ rest of agent visible. The `"+"` is an explicit "inherit and append."

```jsonc
"mainAgent": {
  "skills": { "visible": ["+", "director-turn-workflow-zh"] }
}
// Effective: ["director-anti-cliche-zh", "director-character-voice-zh",
//             "director-turn-workflow-zh"]
```

### Rule 3 — agent's `visible` doesn't start with `"+"`

Effective visible = agent visible. The mode defaults are completely replaced.

```jsonc
"specializedSubAgent": {
  "skills": { "visible": ["only-this-one"] }
}
// Effective: ["only-this-one"]
```

This is useful for agents that should be quarantined from the mode-wide writing rules — for example, an agent that just produces structured data should not see the prose-critic skills.

### Deny is always union

`deny` is unioned across the mode + agent levels (never replaced) and always wins over `visible`. If a skill name appears in either deny list, it's filtered out even if it's also in some visible list.

```jsonc
"mode": "director",
"skills": { "deny": ["director-anti-cliche-zh"] },
"mainAgent": {
  "skills": { "visible": ["+", "director-anti-cliche-zh"] }
}
// Effective visible: [] (deny wins)
```

### Wildcards

`visible` accepts `"*"` to mean "all installed skills." Useful early on when you want an agent to see whatever's around without listing names:

```jsonc
"mainAgent": {
  "skills": { "visible": ["*"], "deny": ["scripts-experimental"] }
}
```

Wildcards combine with `"+"` and `deny` as you'd expect.

## What the agent actually sees

Once the policy resolves, the runtime hands the agent two things at dispatch:

### 1. Auto-injected catalog

A short `<available_skills>` block is appended to the agent's system message:

```
<available_skills>
- director-anti-cliche-zh: Anti-cliche patterns for narrative writing.
- director-character-voice-zh: Shared character-voice rules for all default sub-agents.
- director-turn-workflow-zh: 7-step turn workflow for the director main agent.
- ...
</available_skills>

(Use skill_read to consult specific content; skill_search to grep within a skill.)
```

This is the catalog only — name + description. The agent learns what's available without spending a tool round on `skill_list`.

The 18-ish entries for the default director profile come in at ~150–300 tokens total — cheap.

### 2. Three function tools

Gated to the visible set, these are the only way the agent can access skill content:

| Tool | Signature | Returns |
|---|---|---|
| `skill_list({ query? })` | optional substring filter | `[{ name, description, tags }]` |
| `skill_read({ name, path?, offset?, limit? })` | `path` defaults to SKILL.md; `offset`/`limit` are line numbers | `{ content, totalLines, truncated }` |
| `skill_search({ name, query, path?, limit?, contextLines? })` | substring search inside a single skill's files | `{ hits: [{ path, lineStart, lineEnd, snippet }] }` |

The agent calls `skill_read` the moment it needs the actual body. `skill_search` is for when the skill is large and only a section is relevant.

Hard runtime cap: `skill_read` responses are capped at 50 KB. If truncated, the agent uses `offset` to continue. This bounds context cost even when a skill ships large references.

## A worked director example

The bundled default director profile demonstrates the patterns:

```jsonc
{
  "mode": "director",

  "skills": {
    "visible": [
      "director-anti-cliche-zh",
      "director-character-voice-zh",
      "director-no-meta-zh",
      "director-output-discipline-zh",
      "director-zh-style-baseline"
    ]
  },

  "mainAgent": {
    "systemPrompt": "<thin main-agent identity>",
    "skills": {
      "visible": ["+", "director-turn-workflow-zh", "director-dispatch-protocol-zh"]
    }
  },

  "subAgents": [
    {
      "id": "voice_critic",
      "skills": { "visible": ["+", "voice-critic-method-zh"] }
    },
    {
      "id": "memory_curator",
      "skills": { "visible": ["+", "event-summary-rules-zh"] }
    },
    {
      "id": "plot_brainstormer",
      "skills": { "visible": ["+", "plot-brainstormer-method-zh"] }
    }
    // ... 14 more sub-agents, same shape
  ]
}
```

Reading the policy:

- **Every agent gets the 5 shared writing rules** via mode-level visible.
- **The main agent additionally gets** the turn workflow + dispatch protocol — its specific responsibilities.
- **Each sub-agent additionally gets its method skill** — `voice_critic` reads `voice-critic-method-zh`, `memory_curator` reads `event-summary-rules-zh`, etc.

No single agent's `skills.visible` repeats the mode-level entries. The `"+"` prefix keeps each per-agent override short — it lists what's specific to that agent, not the whole stack.

## Per-mode behavior

Each orchestrator mode injects the catalog at slightly different points but the policy resolution is identical:

| Mode | Catalog injected into | Per-agent overrides |
|---|---|---|
| **director** | Main agent's system message + each sub-agent's system message at dispatch | `mainAgent.skills` + each `subAgents[].skills` |
| **loop** | The single loop agent's system message | `loopAgent.skills` |
| **spec** | Each node's system message at execution | `nodes[].skills` (per-node) |
| **agenda** | Planner + each dispatched worker's system message | `planner.skills` + `workers[].skills` |
| **single** | The single node's system message | `node.skills` |

In all modes, an agent without an explicit `skills.skills` field inherits the mode-level defaults via Rule 1 above.

::: info Review nodes are catalog-skipped
For spec mode's review nodes, the catalog injection is deliberately skipped — review is a structured judgment task, not a content-generation one, and adding `<available_skills>` to its prompt just adds noise. The review node still sees skills if it explicitly calls `skill_list` or `skill_read`, but the autoinjected catalog is omitted.
:::

## Stale references

`skills.visible` is a list of names — physical existence of each skill is checked at dispatch.

- **Missing skill** (renamed / deleted / not installed): silently filtered out. The agent doesn't see it; no error.
- **In the editor UI**: the entry is greyed out with a tooltip "skill not installed."

This soft-fail behavior is deliberate. It means:

- Importing a card whose bundled skills you skipped doesn't break anything — the references just dangle.
- Deleting a skill doesn't require you to clean up every profile that referenced it.
- Renaming a skill is a 1-step operation — references go stale, but dispatch keeps working until you choose to fix them.

## Editing the policy

In the orchestrator panel, each agent's settings card shows a **Skills** row:

![Per-agent skill chips with + inherit](/_screenshots/skills/agent-skill-chips.png)

- **`+`** chip — the explicit "inherit mode default" marker (appears when `visible` starts with `"+"`).
- One chip per named skill. Click to remove; click **Add…** to pick from your installed inventory.
- **Deny** row — same chips, separate list.

The mode-level **Skills** row at the top of the panel works the same way. Editing it updates `mode.skills`; editing an agent's row updates that agent's override.

For AI-driven editing, the [iter-studio](/features/orchestrator/iteration-studio) ships skill-binding tools (`skill_bind_to_agent`, `skill_unbind_from_agent`, `skill_set_mode_defaults`) — describe what you want in natural language and the AI patches the policy via tool calls.

## Mode-switch invalidation

When you switch the orchestrator from one mode to another (e.g. director → loop), the runtime invalidates its cached resolution. The next dispatch under the new mode rebuilds the catalog from the new mode's policy. The UI also re-renders the **Skills** rows from the new mode's profile, so editing always reflects the active mode.

This means a `director.mainAgent.skills` block doesn't follow you when you switch to loop mode. Each mode has its own policy. Many users keep similar shapes across modes (same shared skills, same per-agent specifics) but the editing is per-mode.

## Related

- [Skills overview](/features/skills/) — what a skill is, three scopes
- [Authoring skills](/features/skills/authoring) — write your own
- [Skill management](/features/skills/management) — install / move / delete
- [Director mode](/features/orchestrator/director) — the canonical multi-agent profile that ships with full skill integration
- [AI Iteration Studio](/features/orchestrator/iteration-studio) — patch policies via natural-language AI editing
- [Skills extension API](/development/extension-api/skills) — programmatic policy editing from extensions
