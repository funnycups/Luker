# Preset World Info

Preset World Info is an improvement introduced by Luker that allows you to bind specific World Info (Lorebooks) to presets. When switching presets, the associated World Info is automatically activated.

## Use Cases

Different roleplay scenarios often require different preset parameters and world settings. For example:

- **Fantasy scenario**: High temperature + Fantasy World Info (magic systems, race settings, etc.)
- **Modern urban**: Medium temperature + Modern World Info (city landmarks, social rules, etc.)
- **Sci-fi scenario**: Low temperature + Sci-fi World Info (interstellar settings, technology systems, etc.)

With Preset World Info, you can bundle these combinations — when switching presets, the corresponding World Info is automatically activated, eliminating the need for manual switching.

## How to Use

1. In the preset editing interface, find the "Associated World Info" setting
2. Select the World Info to bind with the current preset
3. Save the preset

Afterward, each time you switch to this preset, the associated World Info will be automatically activated. When switching to a different preset, the previously associated World Info will be automatically deactivated.

::: tip
Preset World Info does not affect the World Info that comes with Character Cards. Character Card World Info is always active; preset-associated World Info is additionally layered on top.
:::

## Difference from Manual Activation

World Info has two activation methods: manual activation and preset-associated activation.

- **Manually activated** World Info remains active at all times, unaffected by preset switching
- **Preset-associated** World Info automatically toggles on and off following preset switches

The two methods don't interfere with each other. If you want a World Info to be active under all presets, simply activate it manually; if you only want to use it in specific scenarios, preset association is more convenient.

## Integration with Other Features

- **[Card-Bound Presets](/improvements/card-bound-presets)**: Character Cards can recommend presets, and presets can associate World Info, forming a complete chain of "Character Card → Preset → World Info"
- **[Preset Decoupling](/improvements/preset-decoupling)**: Preset World Info is built on the foundation of preset decoupling, with connection configurations and presets managed independently

## Related Pages

- [Presets](/basics/presets) — Basic concepts of presets
- [World Info Basics](/basics/world-info) — Basic concepts of World Info
- [Card-Bound Presets & Personas](/improvements/card-bound-presets) — Binding between Character Cards and presets
