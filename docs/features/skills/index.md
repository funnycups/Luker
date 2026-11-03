# Skills

A Skill is a knowledge pack an agent reads on demand. Putting every writing rule, voice convention and anti-formula checklist into one enormous system prompt makes the prompt hard to maintain and duplicates it across agents. Skills split those rules into named packs that agents read only when needed.

Luker's Skill format is compatible with Anthropic Claude Skills: a `SKILL.md` plus optional sub-files. The orchestrator's default Director profile is built this way: the main agent keeps a thin identity prompt, while writing rules live in Skills and are read by name.

## Structure

A Skill is a directory:

```text
my-skill/
├── SKILL.md          # required: frontmatter and body
├── references/       # optional: longer reference material
├── examples/         # optional: real examples
└── assets/           # optional: attachments
```

`SKILL.md` starts with YAML frontmatter; `name` and `description` are required. The body is what the agent reads, so write it as direct, actionable rules rather than encyclopedia prose.

## Scope

A Skill can live in one of three scopes:

| Scope | When it applies | Use |
| --- | --- | --- |
| Global | Always visible | Shared writing rules, anti-formula lists, common methods |
| Preset | While that chat-completion preset is selected | Rules tied to one preset |
| Character | While that character card is loaded | Character-specific setting, voice, in-world language |

Same-named Skills override in the order character, preset, global. References use only the name, not the scope, so moving a Skill between scopes does not break references.

Skills in preset and character scope are exported with the preset or card, so the recipient does not install them separately.

```d2
direction: down

bundled: "Skills shipped with Luker" {
  style.fill: "#fff3e0"
  pop: "Enter global scope on first install" {
    style.fill: "#fffde7"
  }
}

user: "Locally installed skills" {
  style.fill: "#e1f5ff"
  fs: "Global / preset / character" {
    style.fill: "#fffde7"
  }
}

profile: "Orchestrator profile" {
  style.fill: "#e8f5e9"
  mode: "Mode-level visibility" {
    style.fill: "#fffde7"
  }
  agent: "Agent-level visibility" {
    style.fill: "#fffde7"
  }
}

runtime: "Resolver at dispatch time" {
  style.fill: "#fce4ec"
  walk: "Merge by scope precedence" {
    style.fill: "#fffde7"
  }
  policy: "Apply visibility and deny rules" {
    style.fill: "#fffde7"
  }
  catalog: "Build the skill catalog\nfor the agent context" {
    style.fill: "#fffde7"
  }
}

agent: "Running agent" {
  style.fill: "#f3e5f5"
  tools: "Read a skill body by name" {
    style.fill: "#fffde7"
  }
}

bundled.pop -> user.fs: "Import"
user.fs -> runtime.walk
profile.mode -> runtime.policy
profile.agent -> runtime.policy
runtime.walk -> runtime.policy
runtime.policy -> runtime.catalog
runtime.catalog -> agent.tools
```

## How agents see Skills

The orchestrator can limit which Skills each agent sees. At runtime, the names and descriptions of visible Skills are injected as a short catalog; the agent reads the body by name when it needs it. It can only read Skills inside its visible set.

Director's default profile binds the right Skills to each agent. Other modes show every installed Skill by default, and you can narrow that in the orchestration editor.

## Bundled Skills

Luker ships a set of roleplay Skills covering anti-formula writing, character voice, output discipline and event summaries. They are installed to the global scope on first start and can be browsed, imported or replaced in the Skill management panel.

## Next steps

- [Authoring Skills](/features/skills/authoring) — directory layout, frontmatter and body
- [Managing Skills](/features/skills/management) — install, import, edit and bundle
- [Orchestrator integration](/features/skills/orchestrator-integration) — show specific Skills to specific agents
