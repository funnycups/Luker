# Card-Bound Presets & Personas

Card authors can ship a character with one or more recommended chat completion presets and a default persona so the card runs under the intended sampling and prompting shape the moment it is imported. The feature builds on [Preset Decoupling](/improvements/preset-decoupling) — connection fields are always stripped, so exported cards never carry an API key or endpoint.

## Character cards carrying recommended presets

A character card may embed any number of chat completion presets, each with its own name and body. When you load a character with embedded presets, Luker:

1. Renders a **Card-bound** `<optgroup>` at the top of the chat completion preset selector, listing every preset the card ships with.
2. Renders your local presets below in a **Local** group.
3. Automatically selects the card's **default** preset (if the card marked one).

The card-bound options are runtime-only — they do not add entries to your global preset library and never overwrite same-named local presets. Switching characters removes the card-bound group from the selector.

::: info Connection fields never leave the card
Every preset stored on a card is filtered through the same field classifier used by Preset Decoupling: API endpoint, key, model, proxy password, and other connection settings are removed on write. Loading a card-bound preset only applies sampling and prompt-structure fields — it cannot silently reroute your traffic to the card author's endpoint.
:::

## Binding the current preset to a character

Open the character-management dropdown next to the character portrait and choose **Bind Current Chat Completion Preset**. Luker adds the currently selected preset to the card's embedded set and marks it as the card's default.

- If the preset name is not yet on the card, it is added as a new slot.
- If a slot with the same name already exists, Luker asks whether to overwrite the existing card copy with your current settings.

Binding is blocked when the currently selected preset is *itself* a card-bound option — there is nothing to promote in that case, and Luker surfaces an info notice instead of silently no-oping.

## Managing bound presets

**Manage Bound Chat Completion Presets** opens a per-character dialog listing every card-bound slot. Each row exposes:

- **Set as default** — pick which slot Luker auto-applies when the character is loaded.
- **Overwrite from current** — replace the slot body with your currently selected preset's body while keeping the slot name.
- **Update from local** — refresh the slot body from a same-named local preset. Disabled when no matching local preset exists.
- **Delete** — remove the slot. If the deleted slot was the default, the default is cleared until you set a new one.

A bottom control lets you add a new slot by picking any local preset whose name is not already on the card.

## Clearing all bound presets

**Clear Bound Chat Completion Preset** wipes every embedded slot on the current character in one confirm step. Use it when you want to hand the card back to a plain "no recommendations" state.

## Editing a bound preset in place

When a card-bound preset is the active preset in the selector, edits made through Prompt Manager, sampler sliders, prompt groups, or extension flags apply to the character's card-embedded copy — not to your local preset library. To commit the changes, click **Update current preset**. Same-named local presets stay untouched.

If you want an edit to become a standalone local preset instead, use **Save preset as**, which registers the body in the global list under a new name.

::: tip Prompt Manager iterates on card-bound bodies transparently
Prompt Manager, the Chat Completion Preset Assistant (CPA), and any AI iteration flow that lands on `Update current preset` all route through the same dispatch. Iterating a card-bound preset writes back to the card slot without a separate "commit to card" step.
:::

## Orchestrator agent presets read from the card first

Multi-agent orchestrator profiles reference the chat completion preset each agent runs on **by name**. When a character with a card-bound set is loaded, agent name resolution walks card slots first, then local presets, then falls back to the global default. This means an orchestrator profile exported with a card ships end-to-end runnable: the recipient does not need to import a matching preset separately.

**Save To Character Override** in the orchestrator drawer inspects the referenced preset names before persisting. If any agent references a preset that is not yet on the card, Luker prompts:

- **Embed all** — write each referenced preset's local body into the card so the orchestrator profile stays self-contained after export.
- **Save names only** — persist the orchestrator profile but leave the presets un-embedded. Recipients without matching local presets will fall back to the runtime default.
- **Cancel** — abort the save entirely.

## Character cards carrying default personas

A character card can bind one or more recommended personas. When you open the card:

- If you have not chosen a persona, Luker switches to the card's recommendation.
- If you already have a persona, Luker warns that it differs from the card's recommendation, so you can choose whether to align or keep your own.

Bound personas travel with the card on export, and recipients see the same recommendation on import.

## Import and export round-trip

Bound presets, default personas, and orchestrator overrides are all part of the character card data. Standard character export (PNG or JSON) carries them along; standard import restores them. There is no separate file to distribute alongside the card.

## Dependencies

The card-bound preset feature depends on [Preset Decoupling](/improvements/preset-decoupling). Without decoupling's field classifier, connection fields could not be safely stripped when embedding a preset in a card.

## Related

- [Preset Decoupling](/improvements/preset-decoupling) — the field classifier that keeps API credentials out of cards.
- [Orchestration Presets](/features/orchestrator/presets) — how orchestrator profiles reference preset names and how Save To Character Override embeds them.
- [Improvements Overview](/improvements/overview) — the wider improvement set.
