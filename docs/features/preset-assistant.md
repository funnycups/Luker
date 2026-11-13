# Completion Preset Assistant

The Completion Preset Assistant edits Chat Completion presets through conversation inside **Workbench → AI iteration → Preset**. It reads the selected preset, explains parameters, compares against a reference preset, and places changes into the **Change list** for review before applying.

![Completion Preset Assistant overview](/images/preset-assistant/cpa-overview.png)

## Opening it

Open **Preset** editing in any of these ways:

- Click the wand icon button on the Chat Completion preset toolbar.
- Open **Workbench** (`Alt+W` or wand menu → **Workbench**) → **AI iteration** → **Preset**.
- Go to **Extensions → Completion Preset Assistant → Open in Workbench** (**Create New Preset** starts from a blank preset, and **Bundle skills with this preset** opens the skill manager for the current preset).

Configure the AI connection and generation preset in **Workbench → Settings** (either using the shared default or an override for **Preset**).

At the top of the **Preset** iteration view, you can switch **Editing mode**, pick **Compare with reference** to inspect differences against another preset, or fork the active preset into a new preset.

Ask in natural language:

- "What's the difference between temperature and top_p?"
- "I want more creative responses — which parameters should I adjust?"
- "Compare the current preset with the default preset"

## What it changes

- Generation parameters such as temperature, top_p, and penalties.
- Prompt entries: wording, order, and enabled state.

Proposed edits appear in the **Change list** as diffs; tick what to apply, or undo applied changes in **Change history**.

## Editing modes

**Editing mode** decides how the assistant reads your request:

- **General editing** — edits the preset as asked. Default.
- **Adapt for orchestrator** — for presets used by an orchestrator main agent. It rewrites hard format constraints that interfere with tool calls (forced reasoning chains, output structure) into softer guidance, scopes final-output-only instructions to the commit stage, and disables placeholders the orchestrator already injects (character card, persona, world info). Chat history, jailbreak, writing-style, NSFW, and RP voice entries stay enabled.
- **Jailbreak-only** — for presets used by tool-style LLM calls, such as memory extraction or Workbench tasks. It keeps jailbreak instructions and disables entries that shape narrative prose (style, voice, output format, narrative meta-rules). The entries stay in the preset, so you can re-enable them.

In **Adapt for orchestrator** and **Jailbreak-only** modes, the assistant proposes deriving a new preset (`-orchestrator` / `-jailbreak` suffix) so your original preset stays untouched, or edits in place if you ask for it.

## Extracting skills in Adapt for orchestrator mode

While adapting a preset, the assistant also looks for writing and output-format rules that orchestrator sub-agents should read. Each candidate becomes a proposal:

1. Create the skill at this preset's scope, with the text copied verbatim.
2. Remove that text from the source prompt entry.
3. Leave a one-line pointer such as `See skill <skill-name>` so the entry still points at the rule.

Skill proposals appear alongside preset edits for approval. Focused tweaks, requests that ask not to touch skills, and previously rejected candidates skip extraction.

You can also name an extraction yourself, reuse an installed skill, or inspect, rename, move, and delete one. Attaching a skill to a sub-agent's visible list happens in [Orchestration AI iteration](/features/orchestrator/iteration-studio#authoring-skills-via-iter-studio).

After deriving an `-orchestrator` preset, use **Extensions → Completion Preset Assistant → Bundle skills with this preset** to open the [skill manager](/features/skills/management) with multi-select enabled and pack selected skills into the preset for export.

## Related features

- [Workbench](/features/workbench) — unified workspace, AI iteration, and change history
- [Preset Decoupling](/improvements/preset-decoupling) — how connection settings and presets are separated
- [Multi-Agent Orchestration](/features/orchestrator/) — orchestrator nodes also reference LLM presets
- [Skills](/features/skills/) — bundle writing rules and critic methods alongside an `-orchestrator` preset
- [Authoring skills](/features/skills/authoring) — the `SKILL.md` conventions the assistant follows when drafting a skill from preset content
