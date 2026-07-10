# Orchestration Presets

Each orchestration mode (spec / agenda / loop / director) keeps its own **preset library** at two scopes:

- **Global** — presets stored in extension settings, available to every chat.
- **Character card** — presets stored on the character card itself, travelling with the card when it is exported.

A preset captures everything inside the mode's orchestration panel — system prompts, tool flags, sub-agents, planner config, loop budgets, capsule injection. It does **not** capture prompt presets or API presets; those are referenced by name from inside the preset and resolved at runtime.

::: tip Why per-mode libraries
A spec preset and a director preset have nothing in common structurally, so they live in separate libraries. Switching execution modes reveals that mode's library, leaving the others untouched.
:::

## The preset bar

The preset bar sits at the top of each mode's editor panel:

![Preset bar — director mode](/_screenshots/orchestrator-presets/01-director-default.png)

It exposes the standard set of operations:

- **Dropdown** — list of presets in the current `(mode, scope)` library. Selecting a preset reloads the editor with that preset's contents.
- **New** — seeds a fresh preset from the factory defaults for the active mode.
- **Duplicate** — clones the current active preset under a new name; the clone becomes active.
- **Rename** — changes the name; the underlying id is preserved, so anything pinning to the preset by id keeps working.
- **Delete** — removes the preset. If the deleted preset was active, the next preset in the list becomes active. If the library empties, `Default` is automatically re-seeded from the factory data.
- **Import / Export** — uses the standard portable JSON format. Importing prompts for a name and adds to the current library; exporting writes the active preset to disk.

Edits made in the panel write back to the **active** preset. There is no implicit save step — closing the panel or switching presets persists the current state.

## Global vs character-card scope

The scope selector toggles which library the bar is showing.

When **Scope = Global** is selected, the preset bar shows the global library for the current mode. Edits here affect every chat that doesn't have its own card override.

When **Scope = Character** is selected (a character must be loaded), the bar switches to the card's own library. The `Use character override` toggle decides whether the card's active preset overrides the global active at runtime:

- **Override off** — the card's library still exists and is editable, but the global active preset wins. Useful for drafting a card-specific preset without committing to it yet.
- **Override on** — the card's active preset takes effect for this character; the global active is ignored for this chat.

If the card has no preset library of its own yet, the bar shows a single `Default` entry seeded from the global active. Editing it creates the card library transparently — no separate "initialize card library" step.

::: info Cards ship their library on export
Exporting a character card includes the card's preset library, so importing the card on another machine brings its presets with it. Other people who load the card pick up a complete, runnable orchestration setup without any extra files to import.
:::

## How presets interact with prompt and API presets

An orchestration preset is one of three independent layers in a generation. The others are SillyTavern's prompt preset and the connection profile:

| Concept | What it controls | Where it lives |
|---|---|---|
| Orchestration preset | Sub-agents, tools, planner, loop budgets, system prompts, capsule injection | Extension settings or on the character card |
| Prompt preset (chat completion preset) | Token budget, samplers, prompt order, jailbreak | SillyTavern presets |
| API preset (Connection profile) | Endpoint, model, API key | Connection Manager |

An orchestration preset references a prompt preset and an API preset **by name** — for example, a director preset might pin its `voice_critic` sub-agent to `Sonnet · slow critique` and route everything else through `Haiku · fast`. Switching the active orchestration preset does not switch the underlying prompt preset; switching the prompt preset does not affect orchestration.

The practical consequence: a preset named `审讯节奏` and one named `重叙事密度` can share the same prompt preset and connection profile and differ only in their orchestration shape — different sub-agents, different planner instructions, different injection depth. You move between them from the preset bar without touching anything in the Connection Manager or the SillyTavern preset dropdown.

## Agent prompt-preset resolution reads the character card first

When an orchestration preset pins an agent to a prompt preset by name (`Sonnet · slow critique`, `Haiku · fast`, …), that name is resolved at generation time. The lookup walks these locations in order:

1. The current character's card-bound preset set — any preset the card embeds under the requested name wins.
2. Your local chat completion preset library.
3. The global runtime fallback pinned by orchestrator settings when neither of the above matches.

The card-first ordering matters when a card ships with its own recommended presets: the orchestration profile and the presets it references travel together, and the recipient does not need to import matching presets separately. If the recipient has a same-named local preset, the card copy still wins for that character, so a card author's tuned prompt shape is not shadowed by whatever the recipient happened to name their local preset.

The **Card-bound** `<optgroup>` at the top of each agent's preset picker in the orchestrator drawer surfaces the same set of card-embedded presets when a character is loaded, so you can see and pick from the card set from the same UI you use for local presets.

## Committing an orchestration profile to a character embeds referenced presets on demand

Committing an orchestration profile to the current character card runs a preflight check on the agent prompt-preset references and looks up which of them are not yet embedded on the card. Commit here covers two entry points — **Save To Character Override** in the orchestrator drawer and **Apply to Character** in the **AI Iteration Studio** popup — both sharing the same preflight.

If any references are un-embedded, a summary popup opens listing them and offering three actions:

- **Embed all** — copy each referenced preset's local body onto the card so the orchestration profile ships end-to-end runnable on export.
- **Save names only** — persist the orchestration profile as-is, leaving the presets un-embedded. Recipients without matching local presets will fall back to the runtime default for those agents.
- **Cancel** — abort the commit.

Editing an agent's preset reference in the panel does not trigger the popup — the choice belongs to the commit step, not the edit step.

See [Card-Bound Presets & Personas](/improvements/card-bound-presets) for how card slots are managed, edited, and stripped of connection fields.

## The `Default` preset

`Default` is a seed entry, not a protected entry. You can rename it, edit it freely, or delete it — there is no asterisk on the name and nothing in the system treats it as sacred.

The only special behaviour: if you delete every preset in a library, `Default` is automatically re-seeded from the factory data the next time the library is read. This means you cannot leave a mode in an unrunnable state by deleting too aggressively, and it means the factory data is always one delete-everything away if you want to start over.

## Recipes

A few common workflows the preset bar enables:

- **Two presets for one card** — a fast-and-cheap preset for casual scenes and a slower, denser preset for set-piece moments. Save both under the card scope, flip between them from the dropdown.
- **Promote a card preset to global** — export the card's active preset, switch the bar to global scope, import the JSON. The global library now has the same preset available to every chat.
- **Try a preset without committing** — duplicate the active preset, edit the duplicate, and roll back by selecting the original from the dropdown if the experiment doesn't pan out.
- **Hand off a tuned orchestration with the card** — finish iterating on the card scope, leave `Use character override` on, and export the card. The recipient gets the orchestration shape you tuned without any side configuration.

## Related

- [Spec mode](/features/orchestrator/spec) — default DAG workflow; each spec preset is one DAG.
- [Agenda mode](/features/orchestrator/agenda) — planner-driven; each agenda preset is one planner + worker bundle.
- [Loop mode](/features/orchestrator/loop) — single-agent loop; each loop preset is one agent profile.
- [Director mode](/features/orchestrator/director) — takeover mode; each director preset is one main-agent + sub-agent team.
- [AI Iteration Studio](/features/orchestrator/iteration-studio) — edits the active preset directly; switching presets in the bar swaps what the Studio is iterating on.
- [Card-Bound Presets and Personas](/improvements/card-bound-presets) — how character-scope settings ride along with the card on export.
