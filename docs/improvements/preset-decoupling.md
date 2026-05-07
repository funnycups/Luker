# Preset Decoupling

Preset Decoupling separates "generation parameters" from "connection configurations" in Chat Completion presets, so that switching presets no longer accidentally changes API connection settings.

## Problem Background

In SillyTavern, Chat Completion presets (i.e., presets for OpenAI / Claude and other APIs) contain two fundamentally different types of configuration:

- **Generation parameters** — Prompt templates (System Prompt, Jailbreak, etc.), sampling parameters (Temperature, Top-P, etc.), context length, etc.
- **Connection fields** — API address, API Key, model name, Chat Completion Source, etc.

These two types of configuration are bundled in the same preset object. When users switch presets, connection fields change along with them — meaning switching a prompt template might change your API address from Claude to OpenAI, or overwrite your carefully configured custom API endpoint.

This coupling causes significant frustration in practice:

- Users are afraid to try different presets because they worry about connection configurations being overwritten
- Sharing presets requires manually cleaning connection information, otherwise API Keys may be leaked
- Character Card authors cannot recommend presets for characters, because loading a preset would break the user's connection settings

## Field Classification Mechanism

Luker classifies each field in a preset as either a "connection field" or a "generation parameter field":

- **Connection fields** — API source, custom URL, model name, reverse proxy address, proxy password, etc.
- **Generation parameter fields** — Temperature, Top-P, max tokens, etc.

```d2
direction: right

ST: "SillyTavern: coupled" {
  ST_PRESET: "Chat completion preset"
  ST_GEN: "Generation params\nTemperature / Top-P / ..."
  ST_CONN: "Connection fields\nAPI URL / Key / Model" {
    style.fill: "#ffebee"
    style.stroke: "#c62828"
  }
  SWITCH1: "Switch preset"

  ST_PRESET -> ST_GEN
  ST_PRESET -> ST_CONN
  SWITCH1 -> ST_GEN: {style.stroke-dash: 3}
  SWITCH1 -> ST_CONN: "accidentally overwritten" {style.stroke-dash: 3}
}

LK: "Luker: decoupled" {
  LK_PRESET: "Chat completion preset"
  LK_CONN: "Connection profile"
  LK_GEN: "Generation params only"
  LK_CONN_F: "Connection fields only" {
    style.fill: "#e8f5e9"
    style.stroke: "#2e7d32"
  }
  SWITCH2: "Switch preset"
  SWITCH3: "Switch connection"

  LK_PRESET -> LK_GEN
  LK_CONN -> LK_CONN_F
  SWITCH2 -> LK_GEN: {style.stroke-dash: 3}
  SWITCH3 -> LK_CONN_F: {style.stroke-dash: 3}
  SWITCH2 -- LK_CONN_F: "skips connection fields" {style.stroke-dash: 3}
}
```

This classification is the foundation of preset decoupling — all logic involving preset loading checks the field type to decide whether to apply it.

## Auto-Skipping Connection Fields When Switching Presets

When users switch presets, the loading logic iterates through each field in the preset and automatically skips all connection fields. This ensures that switching presets only changes generation parameters without touching the current API connection configuration.

::: tip When Connection Fields Are Included
Connection fields are only applied when explicitly switching connection configurations in the Connection Manager. Regular preset switching, Character Card bound preset loading, and similar scenarios never include connection fields.
:::

## Affected Modules

Preset decoupling involves coordination across three core modules:

### Preset Loading

- Maintains the classification logic for connection fields and generation parameter fields
- Decides whether to include connection fields based on the scenario when loading presets
- Optionally includes connection fields when exporting presets

### Preset Manager

- The preset selector UI is aware of the decoupling state
- Connection fields are preserved when saving presets (ensuring preset file completeness), but filtered by classification when loading
- Supports special option rendering for [Card-Bound Presets](/improvements/card-bound-presets)

### Connection Manager

- Connection configurations are managed independently from presets, with their own save and switch logic
- Only connection fields are applied when switching connections, without affecting current generation parameters
- Connection configuration changes are saved via incremental patch, see [Incremental Sync](/improvements/incremental-sync)

## Relationship with Card-Bound Presets

Preset decoupling is a prerequisite for [Card-Bound Presets](/improvements/card-bound-presets). Precisely because connection fields are isolated, Character Cards can safely carry recommended presets — when loading a Character Card preset, connection fields are automatically skipped, ensuring the user's API connection is not overwritten.

Without preset decoupling, card-bound presets would be impossible: every time a Character Card is opened, it could replace the user's API address and keys, which is clearly unacceptable.

::: info Preset File Compatibility
Preset decoupling does not change the storage format of preset files. Connection fields are still saved in the preset JSON; they are simply selectively skipped during loading. This means existing preset files require no migration and can be fully loaded when needed (e.g., through the Connection Manager).
:::

## Related Pages

- [Card-Bound Presets & Personas](/improvements/card-bound-presets) — An upstream feature that depends on preset decoupling
- [Improvements Overview](/improvements/overview) — Overview of all technical improvements
