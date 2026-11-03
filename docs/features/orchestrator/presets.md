# Orchestration Presets

Each orchestration mode (spec / agenda / loop / director) keeps its own **preset library** at global and character-card scope:

- **Global** — presets stored in extension settings, available to every chat.
- **Character card** — presets stored on the character card itself, travelling with the card when it is exported.

A preset captures everything inside the mode's orchestration panel — system prompts, tool flags, sub-agents, planner config, run limits, orchestration-result injection. Prompt presets and API connections are referenced by name and resolved at runtime.

This page covers the preset bar, the two scopes, and how presets reference each other.

::: tip Why per-mode libraries
Each mode has its own preset structure, so each keeps its own library. Switching execution modes shows that mode's library.
:::

## The preset bar

The preset bar sits at the top of each mode's editor panel:

![Preset bar — director mode](/images/orchestrator-presets/01-director-default.png)

It exposes the standard set of operations:

- **Dropdown** — list of presets in the current `(mode, scope)` library. Selecting a preset reloads the editor with that preset's contents.
- **New** — seeds a fresh preset from the factory defaults for the active mode.
- **Duplicate** — clones the current active preset under a new name; the clone becomes active.
- **Rename** — changes the name; configurations that reference the preset keep working.
- **Delete** — removes the preset. If the deleted preset was active, the next preset in the list becomes active. If the library empties, `Default` is automatically re-seeded from the factory data.
- **Import / Export** — uses the standard portable JSON format. Importing prompts for a name and adds to the current library; exporting writes the active preset to disk.

Edits made in the panel write back to the **active** preset. There is no implicit save step — closing the panel or switching presets persists the current state.

## Global vs character-card scope

With no character loaded, the preset bar shows the global library for the current mode. Edits here affect every chat that doesn't run its own card preset.

When a character is loaded, the dropdown splits into **Character** and **Global** groups, and one of them is selected. That selection is the whole decision:

- **Character preset selected** — the card's preset takes effect for this character; the global active is ignored for this chat.
- **Global preset selected** — the global active preset runs for this chat. The card's own library stays on the card untouched, so you can switch back to any of its presets from the same dropdown at any time.

Switching groups writes the card's active slot immediately and persists with the card, so the choice travels with the card on export/import.

If the card has no preset library of its own yet, the Character group is empty. Saving an edit while a card preset is selected creates the card library.

::: info Cards ship their library on export
Exporting a character card includes the card's preset library, so importing the card on another machine brings its presets with it.
:::

## How presets interact with prompt and API presets

An orchestration preset is an independent layer in a generation. The others are SillyTavern's prompt preset and the connection profile:

| Concept | What it controls | Where it lives |
|---|---|---|
| Orchestration preset | Sub-agents, tools, planning agent, Loop budgets, system prompts, result injection | Extension settings or on the character card |
| Prompt preset | Token budget, samplers, prompt order, jailbreak | SillyTavern presets |
| API preset | Endpoint, model, API key | API connection |

An orchestration preset references a prompt preset and an API connection **by name** — for example, a Director preset might pin its review sub-agent to a strong prompt preset and route the rest through a fast one. Switching the active orchestration preset changes only the orchestration layer; the prompt preset and connection profile stay put.

A preset named `审讯节奏` and one named `重叙事密度` can share the same prompt preset and connection profile and differ only in their orchestration shape — different sub-agents, different planning-agent instructions, different injection depth. You move between them from the preset bar without touching the API connection or the SillyTavern preset dropdown.

## Agent prompt-preset resolution reads the character card first

When an orchestration preset pins an agent to a prompt preset by name (`Sonnet · slow critique`, `Haiku · fast`, …), that name is resolved at generation time. The lookup walks these locations in order:

1. The current character's card-bound preset set — any preset the card embeds under the requested name wins.
2. Your local chat completion preset library.
3. The global runtime fallback pinned by orchestrator settings when neither of the above matches.

The card-first ordering matters when a card ships with its own recommended presets: the orchestration profile and the presets it references travel together, and the recipient does not need to import matching presets separately. If the recipient has a same-named local preset, the card copy wins for that character.

The **Card-bound** `<optgroup>` at the top of each agent's preset picker in the orchestrator drawer surfaces the same set of card-embedded presets when a character is loaded, so you can see and pick from the card set from the same UI you use for local presets.

## Committing an orchestration profile to a character embeds referenced presets on demand

Committing an orchestration profile to the current character card runs a preflight check on the agent prompt-preset references and looks up which of them are not yet embedded on the card. Commit here covers the entry points — **Save To Character Override** in the orchestrator drawer and **Apply to Character** in the **AI Iteration Studio** popup — both sharing the same preflight.

If any references are un-embedded, a summary popup opens listing them and offering the following actions:

- **Embed all** — copy each referenced preset's local body onto the card so the orchestration profile ships end-to-end runnable on export.
- **Save names only** — persist the orchestration profile as-is, leaving the presets un-embedded. Recipients without matching local presets will fall back to the runtime default for those agents.
- **Cancel** — abort the commit.

The popup appears at commit time only.

See [Card-Bound Presets & Personas](/improvements/card-bound-presets) for how card slots are managed, edited, and stripped of connection fields.

## The `Default` preset

`Default` is an ordinary preset: rename it, edit it, or delete it.

If you delete every preset in a library, `Default` is re-seeded from the factory data the next time the library is read. Delete everything to get the factory configuration back.

## Recipes

A few common workflows:

- **Multiple presets for one card** — a fast-and-cheap preset for casual scenes and a slower, denser preset for set-piece moments. Save them under the card scope, flip between them from the dropdown.
- **Promote a card preset to global** — export the card's active preset, switch the bar to global scope, import the JSON. The global library now has the same preset available to every chat.
- **Try a preset without committing** — duplicate the active preset, edit the duplicate, and roll back by selecting the original from the dropdown if the experiment doesn't pan out.
- **Hand off a tuned orchestration with the card** — finish iterating on the card scope, make sure the card's preset is the selected one in the dropdown, and export the card. Importing the card gives the same orchestration.

## Related

- [Spec mode](/features/orchestrator/spec) — fixed stages; each Spec preset is one stage and node layout.
- [Agenda mode](/features/orchestrator/agenda) — planner-driven; each agenda preset is one planner + worker bundle.
- [Loop mode](/features/orchestrator/loop) — single-agent loop; each loop preset is one agent profile.
- [Director mode](/features/orchestrator/director) — takeover mode; each director preset is one main-agent + sub-agent team.
- [AI Iteration Studio](/features/orchestrator/iteration-studio) — edits the active preset directly; switching presets in the bar swaps what the Studio is iterating on.
- [Card-Bound Presets and Personas](/improvements/card-bound-presets) — how character-scope settings ride along with the card on export.
