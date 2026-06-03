# Skills

A **skill** is a small, self-contained knowledge pack an agent can read on demand. Instead of cramming every writing rule, every voice convention, every anti-cliché checklist into one giant system prompt, you keep them in named skill packs and let agents pull them in when they're relevant.

Luker's skill format is compatible with [Anthropic's Claude Skills](https://www.anthropic.com/news/skills) — the same `SKILL.md` + frontmatter + optional sub-files shape — so a skill written for Claude Code drops into Luker and a skill written in Luker drops into Claude Code without conversion.

The orchestrator's default director profile is built on skills: a short main-agent identity prompt plus 24 bundled skills that the agents read by name. You can do the same for your own profiles.

## Why this exists

The single most common pain point with multi-agent orchestrators is "the prompt is two thousand lines and I'm afraid to touch it." Every reusable rule — anti-cliché lists, character-voice conventions, the seven-step turn workflow, event-summary formatting — used to sit inline inside `systemPrompt`, often duplicated across several sub-agents.

Skills break that block apart. The agent identity stays in `systemPrompt` ("you're the voice critic, here's your role"). The reusable rules live in skill files. Agents read them via `skill_read` when they actually need to, and you can edit, version, and ship rules independently of the prompts that consume them.

## Anatomy of a skill

A skill is a directory:

```
director-anti-cliche-zh/
├── SKILL.md          # required — frontmatter + body
├── references/       # optional — supporting checklists, longer references
├── examples/         # optional — worked examples
└── assets/           # optional — binary attachments
```

`SKILL.md` is the only required file. It carries Anthropic-standard YAML frontmatter:

```markdown
---
name: director-anti-cliche-zh
description: Anti-cliché patterns for narrative writing.
license: MIT
metadata:
  author: Luker Team
  version: 1.0.0
  tags: [writing-rules, zh, director]
---

# director-anti-cliche-zh

This skill documents the cliché patterns the director profile actively guards against...
```

- `name` and `description` are required.
- `license` and `metadata.*` are optional and follow the Anthropic standard. Luker does not introduce private namespaces.
- The body is the contract — when an agent reads this skill, the body is what they consume. Write it directively; put your "when to use," "how to use," and "tools you should prefer" guidance into the body.

For the full authoring playbook, see [Authoring skills](/features/skills/authoring).

## Three scopes

Skills physically live under `data/<user>/skills/<scope>/`. Luker has three scopes:

| Scope | Where it lives | When it applies | Use for |
|---|---|---|---|
| `global` | `data/<user>/skills/global/<name>/` | Always visible | Universal writing rules, anti-cliché checklists, shared method docs |
| `preset` | `data/<user>/skills/preset/<api>/<preset>/<name>/` | Only when that preset is selected | Rules that ride with a specific Chat Completion preset (e.g. orchestrator-derived preset for Claude 4) |
| `character` | `data/<user>/skills/character/<file>/<name>/` | Only when that character card is loaded | Card-specific lore, voice conventions, in-world idioms |

When an agent looks up a skill by name, the runtime walks all three scopes and applies **later-wins precedence**: `character` overrides `preset` overrides `global`. So a `character`-scoped skill named `voice-rules` quietly takes over from the `global` one of the same name while that card is loaded, then reverts when you switch cards.

Importantly, when an orchestrator profile says `skills.visible: ["voice-rules"]`, it references the skill by **name only** — no scope prefix. Moving a skill across scopes never breaks references.

### Preset and character skills ride along when you share

`preset` and `character` skills aren't just a place to file your own skills — they also travel with the artifact:

- A **preset**-scoped skill is packed into the preset's JSON. Export the preset, send it to someone, they import it — they get your skill too.
- A **character**-scoped skill is packed into the character card's metadata. Export the PNG, share the card, your skill goes with it.

So if you've built a writing-discipline skill that depends on a particular preset's prompt structure, or a voice-rule skill that only makes sense for one character, scope it accordingly and your sharing story is automatic. See [packing skills into presets / cards](/features/skills/management#embed-export-into-presets-and-cards).

## How agents see skills

An orchestrator profile carries a `skills` policy at two levels:

- **Mode level** — defaults that apply to every agent (main agent + sub-agents) under this mode.
- **Per-agent override** — each agent can pin a different `visible` / `deny` list. A leading `"+"` inherits the mode defaults and appends.

The runtime, at dispatch time, resolves the policy against the physical inventory and hands the agent a filtered list. Two affordances follow:

1. **A short catalog is auto-injected into the agent's system prompt** — `<available_skills>` lines naming each visible skill and its description. The agent learns what's available without spending a round on `skill_list`.
2. **Three function tools — `skill_list`, `skill_read`, `skill_search` — are available to the agent.** They're gated to the visible set; the agent can't reach skills outside its policy. `skill_read` is the typical workhorse — the agent calls it the moment it needs the actual body. It accepts an optional `path` argument too, so a skill that ships sub-files (`references/`, `examples/`, ...) can be read selectively: `skill_read({ name: "my-skill", path: "references/checklist.md" })`. The skill author tells the agent which sub-files are worth pulling and when — see [authoring](/features/skills/authoring#when-to-use-sub-files).

See [Orchestrator integration](/features/skills/orchestrator-integration) for the policy resolution rules in detail.

## Layered overview

```d2
direction: down

user: "User-installed / authored" {
  style.fill: "#e1f5ff"
  fs: "data/<user>/skills/\n  global / preset / character" { style.fill: "#fffde7" }
}

bundled: "Shipped with Luker" {
  style.fill: "#fff3e0"
  pop: "default/skills/global/*\n(populates global scope on fresh install)" { style.fill: "#fffde7" }
}

orch: "Orchestrator profile" {
  style.fill: "#e8f5e9"
  mode: "mode.skills.visible / deny" { style.fill: "#fffde7" }
  agent: "agent.skills.visible (+ inherit)" { style.fill: "#fffde7" }
}

runtime: "Dispatch-time resolver" {
  style.fill: "#fce4ec"
  walk: "Walk three scopes\n(later wins)" { style.fill: "#fffde7" }
  policy: "Apply visible / deny" { style.fill: "#fffde7" }
  catalog: "<available_skills> catalog\ninto system prompt" { style.fill: "#fffde7" }
}

agent: "Live agent" {
  style.fill: "#f3e5f5"
  tools: "skill_list / skill_read / skill_search" { style.fill: "#fffde7" }
}

bundled.pop -> user.fs: "Import bundled\n(fresh install only;\nlater via button)"
user.fs -> runtime.walk
orch.mode -> runtime.policy
orch.agent -> runtime.policy
runtime.walk -> runtime.policy
runtime.policy -> runtime.catalog
runtime.catalog -> agent.tools
```

## Reading vs writing

Agents only ever **read** skills via the three function tools. They can't mutate them. That's deliberate — skills are the user-managed substrate, and only the user (or AI assistants working **on behalf of** the user, like the [iter-studio](/features/orchestrator/iteration-studio) skill tools) can change skill content.

The user-facing write surfaces:

- **Skill manager subpanel** in the orchestrator config — install, edit, rename, move scope, delete.
- **Inline skill editor** — file tree + Markdown editor for SKILL.md and sub-files.
- **Import / export** — pack one or more skills into a character card or preset, or extract embedded skills on import. See [Skill management](/features/skills/management).
- **Iter-studio tools** — when you ask the iter-studio AI to "extract this writing rule into a skill," it uses a dedicated tool surface to do the extraction and rewrite the agent's `systemPrompt` accordingly.

## The 24 bundled skills

A fresh Luker install populates `data/<user>/skills/global/` with 24 default skills derived from the director profile's original inline prompts. They fall into three families:

- **Shared (5)** — `director-anti-cliche-zh`, `director-character-voice-zh`, `director-no-meta-zh`, `director-output-discipline-zh`, `director-zh-style-baseline`. Visible to every default director sub-agent.
- **Main-agent (2)** — `director-turn-workflow-zh`, `director-dispatch-protocol-zh`. Visible only to the main agent.
- **Per-sub-agent (17)** — one method/contract skill per default sub-agent (e.g. `voice-critic-method-zh`, `event-summary-rules-zh`, `chat-scout-method-zh`).

These ship verbatim from the original director defaults — no rewording, no compression — so the new skill-based director profile produces output at the same intensity as the pre-skill default. See [Director mode → Default skills](/features/orchestrator/director#default-skills) for the breakdown.

## Where to go next

- **Want to write your own?** → [Authoring skills](/features/skills/authoring)
- **Want to install, share, or migrate skills?** → [Skill management](/features/skills/management)
- **Want to wire a skill into a specific agent?** → [Orchestrator integration](/features/skills/orchestrator-integration)
- **Writing an extension?** → [Skills extension API](/development/extension-api/skills)
- **Want to see them in action?** → [Director mode](/features/orchestrator/director)
