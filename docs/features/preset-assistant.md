# Completion Preset Assistant

The Completion Preset Assistant is a Luker-exclusive AI-assisted preset management extension. Chat Completion API presets contain numerous parameters (such as temperature, top_p, frequency_penalty, etc.), and different models respond to these parameters with significant variation. The Completion Preset Assistant helps users understand parameter meanings, compare preset differences, and provides adjustment suggestions through conversational AI interaction.

This extension includes an AI conversation engine, parameter parser, and preset modification suggestion system, paired with a standalone dialog UI component for a complete interactive experience.

## Use Cases

### Understanding Complex Preset Parameters

Chat Completion API parameters are numerous, and different API backends (OpenAI, Claude, Gemini, etc.) support different parameter sets. The Completion Preset Assistant can explain each parameter's function, value range, and impact on generation results in natural language, lowering the learning barrier for preset adjustment.

### Comparing Preset Differences

When you have multiple presets, the Completion Preset Assistant supports preset difference comparison. It displays parameter differences between two presets in grouped format, including grouped display of prompt differences, helping you quickly identify key distinctions between different presets.

### Getting Parameter Adjustment Suggestions

Based on your usage goals (such as more creative responses, more stable output, longer generated content, etc.), the Completion Preset Assistant can provide specific parameter adjustment suggestions and supports one-click application of suggested modifications.

## How It Works

### Conversational Interaction

The Completion Preset Assistant is presented as a dialog. You can ask questions in natural language, for example:

- "What's the difference between temperature and top_p?"
- "I want more creative responses — which parameters should I adjust?"
- "Help me compare the current preset with the default preset"

The assistant answers based on the current preset's actual parameter values, rather than speaking in generalities.

### Parameter Parsing and Modification

The assistant has built-in comprehensive parameter parsing capabilities:

- Read all parameters and their values from the current preset
- Understand relationships between parameters (e.g., the interaction effect of temperature and top_p)
- Generate specific parameter modification suggestions
- Apply suggested modifications directly to the current preset

### Prompt Entry Modification

The Completion Preset Assistant can not only adjust generation parameters but also directly modify prompt entries in the preset. The assistant can edit, add, or adjust the content and structure of prompt entries, helping you optimize system prompt wording, ordering, and organization. This makes preset tuning no longer limited to numerical parameters, but covers the full range of preset configuration.

### Integration with Connection Manager

The Completion Preset Assistant uses the current connection configuration for AI calls. This means it provides assistance through your already-configured API backend, requiring no additional API configuration.

## Architecture Overview

| Component | Description |
|-----------|-------------|
| `main.js` | Core logic, including AI conversation engine, parameter parsing, preset modification suggestions |
| `dialog-ui.js` | Dialog UI construction component |
| `index.js` | Extension entry point |
| `style.css` | Interface styles |

## Related Features

- [Preset Decoupling](/improvements/preset-decoupling) — The Completion Preset Assistant uses the current connection configuration for AI calls
- [Multi-Agent Orchestration](/features/orchestrator) — Nodes in the Orchestrator also reference LLM presets
