# Completion Preset Assistant

The Completion Preset Assistant edits Chat Completion presets through conversation. It reads the preset you have open, explains parameters, compares presets, and applies changes you approve. Its own AI calls use your current connection, so there is nothing extra to configure.

![Completion Preset Assistant overview](/images/preset-assistant/cpa-overview.png)

## Opening it

Go to **Extensions** → **Completion Preset Assistant** → **Open Assistant**. **Create New Preset** starts from a blank preset instead.

The top bar shows the target preset, the API preset and prompt preset used for the assistant's calls, and a path hint for preset fields. The iteration AI preset dropdown has a question-mark button that explains the expected preset type and imports a bundled one in a click. **Reference preset:** compares the target against another preset and renders the difference as a draft.

Ask in natural language:

- "What's the difference between temperature and top_p?"
- "I want more creative responses — which parameters should I adjust?"
- "Compare the current preset with the default preset"

The assistant answers from the preset's actual values.

## What it changes

- Generation parameters such as temperature, top_p, and penalties.
- Prompt entries: wording, order, and structure.

Changes arrive as diff cards. Approve or reject each card; approved changes apply to the target preset.

## Editing modes

**Editing mode:** decides how the assistant reads your request.

- **General editing** — edits the preset as asked. Default.
- **Adapt for orchestrator** — for presets used by an orchestrator main agent. It rewrites hard format constraints that break tool calls (forced reasoning chains, output structure) into softer guidance, scopes final-output-only instructions to the commit stage, and disables placeholders the orchestrator main flow already injects (character card, persona, world info). Chat history, jailbreak, writing-style, NSFW, and RP voice entries stay enabled.
- **Jailbreak-only** — for presets used by tool-style LLM calls, such as the memory curator or other plugins. It keeps jailbreak instructions and disables entries that shape narrative prose (style, voice, output format, narrative meta-rules). The entries stay in the preset, so you can re-enable them.

Mode is fixed when the session starts. Switching it opens a confirmation and starts a new session; the old session stays in history.

In **Adapt for orchestrator** and **Jailbreak-only** modes, the assistant suggests deriving a new preset (`-orchestrator` / `-jailbreak` suffix) and edits that copy. The original stays untouched. Ask for the original if you want it edited in place.

## Extracting skills in Adapt for orchestrator mode

While adapting a preset, the assistant also looks for writing and output-format rules that every orchestrator sub-agent should read. Each candidate becomes a proposal:

1. Create the skill at this preset's scope, with the text copied verbatim.
2. Remove that text from the source prompt entry.
3. Leave a one-line pointer such as `See skill <skill-name>` so the entry still points at the rule.

Proposals arrive as diff cards alongside the rest of the adaptation. Approve or reject each one.

The sweep is skipped when you ask for a focused tweak ("tighten this sentence", "raise temperature to 1.1", "fix this typo"), when you say not to touch skills, and for candidates you already rejected in the session.

You can also name an extraction yourself, reuse an installed skill, or inspect, rename, move, and delete one. Attaching a skill to a sub-agent's visible list happens in the [orchestrator iteration studio](/features/orchestrator/iteration-studio#authoring-skills-via-iter-studio).

After deriving an `-orchestrator` preset, the toolbar offers **Bundle skills with this preset**. It opens the [skill manager](/features/skills/management) with multi-select on; pick the skills, then **Pack selected into preset…**. Anyone who imports the preset later gets the standard extraction dialog, and the skills land in their `preset` scope.

::: tip Customized mode prompts
If you edited **Mode addition — orchestrator-optimize** under *Iteration System Prompts (advanced)*, your text overrides the default. Click **Reset to default** to restore the bundled version.
:::

## Related features

- [Preset Decoupling](/improvements/preset-decoupling) — how connection settings and presets are separated
- [Multi-Agent Orchestration](/features/orchestrator/) — orchestrator nodes also reference LLM presets
- [Skills](/features/skills/) — bundle writing rules and critic methods alongside an `-orchestrator` preset
- [Authoring skills](/features/skills/authoring) — the `SKILL.md` conventions the assistant follows when drafting a skill from preset content
