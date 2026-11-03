# Authoring Skills

A Skill is a directory: a required `SKILL.md` plus optional sub-folders. Authoring one means naming it, writing frontmatter, and writing a body an agent can read.

This page covers the directory conventions, frontmatter fields, body structure, and when to split material into sub-files.

## Where to start

You do not have to write everything by hand:

- **Let AI draft it**: describe the result in [AI Iteration Studio](/features/orchestrator/iteration-studio#writing-skills-with-ai). It drafts `SKILL.md`, installs it, and attaches it to the right agents when you ask.
- **Write it yourself**: create it in the [Skill management panel](/features/skills/management) when you want full control over wording and structure.

## Directory layout

```text
my-skill-name/
├── SKILL.md          # required: frontmatter and body
├── references/       # optional: checklists, longer specifications
├── examples/         # optional: real examples the agent can read
├── assets/           # optional: images, PDFs and other attachments
└── scripts/          # optional: reserved, not executed
```

Only `SKILL.md` is required. The other folders are conventions shared with Anthropic's layout, which keeps Skills portable.

## Frontmatter

`SKILL.md` starts with YAML frontmatter:

```markdown
---
name: my-skill-name
description: One-line summary the agent sees in the catalog.
license: MIT
metadata:
  author: Your name
  version: 1.0.0
  tags: [writing-rules, en]
---

# my-skill-name

The body starts here.
```

| Field | Required | Constraint | Notes |
| --- | --- | --- | --- |
| `name` | Yes | Lowercase letters, digits, `-`, `_` | Must match the directory name. |
| `description` | Yes | One sentence | Shown in the catalog the agent sees. Write it for the agent: explain when the Skill is relevant. |
| `license` | No | Any string | Use when sharing. |
| `metadata.author` | No | String | Author information. |
| `metadata.version` | No | Version string | Update on semantic changes. |
| `metadata.tags` | No | Array of strings | Aids search. |

## Body

The body is what the agent reads. Write direct, actionable rules rather than encyclopedia prose. A useful structure:

1. **What this Skill does**: one paragraph so the agent can confirm it picked the right one.
2. **Core rules**: numbered lists, tables or checklists. Concrete and executable; the agent follows them literally.
3. **Examples**: pair wrong and right versions so the standard is visible.
4. **When to read sub-files**: if you bundle reference material, say which file to read and when.

### Tone

A Skill is written for an LLM, not for a human operations manual.

- Use commands, not descriptions. "Avoid X" works better than "X is often considered inappropriate."
- Skip meta-explanation. "This is a great Skill that will help you…" wastes context; the agent has already chosen to read it, so tell it what to do.

### Length

Put the most important material first. The agent may only receive the beginning of the body, and later material may never enter its context.

Keep the body to the size needed to state the rules. As rules grow, move extended checklists, long examples and reference material into sub-files instead of letting `SKILL.md` grow without limit.

## When to use sub-files

- **Consulted only occasionally**: base rules every agent needs stay in `SKILL.md`; situational reference goes in `references/`.
- **Long content**: full examples and long checklists belong in `examples/` or `references/`.
- **Binary attachments**: images, fonts and PDFs go in `assets/`.

Point to sub-files explicitly and say when to read them:

```markdown
## When to read extra files

- `references/cliche-deep-list.md`: a longer list of banned phrasing than this file.
  Read it when the draft keeps hitting patterns not listed here.
- `examples/before-after.md`: paired examples of data-like and human prose.
  Read it once at the start of a session to calibrate.
```

## Example: anti-formula rules

A single-file writing-rules Skill can be organized by rule family: data-like description, contract vocabulary, elevated summary language, and AI-invented labels, each with concrete examples. When the total rule set is small, everything fits in `SKILL.md`.

These Skills are usually visible globally or at mode level, so every agent on the team follows the same writing standard.

## Example: event-summary rules

An event-summary Skill serves the agent that maintains memory. The body first states what a summary is for, such as "an index, not a replay," then gives the writing steps and anti-repetition rules, with wrong/right pairs that make the distinctions visible.

Attach this kind of Skill only to the agent that needs it, not to the whole team.

## Choosing a scope

- **Global**: shared rules you want in every chat.
- **Preset**: rules that only make sense with one chat-completion preset; exported with it.
- **Character**: character-specific setting or voice; exported with the card.

Scope can be changed later. References use the name only, so they survive the move.

## Validation and security

On install or save, Luker checks that frontmatter parses, the name matches the directory, every path stays inside the Skill directory, and size limits are respected. A failed check rolls back, leaving no half-installed Skill.

`scripts/` is recognized but not executed. The interface marks a Skill that carries scripts.

## Related pages

- [Skills overview](/features/skills/) — what Skills are, scopes and visibility
- [Managing Skills](/features/skills/management) — install, import, export, move scopes
- [Orchestrator integration](/features/skills/orchestrator-integration) — attach a Skill to specific agents
- [Skill extension API](/development/extension-api/skills) — developer interface
