# Hook Order

Hook Order allows users to customize the execution priority of extensions. In SillyTavern's extension system, multiple extensions can register the same event hook (such as before message generation, after message generation, etc.). Hook Order lets you control the execution order of these hooks.

This feature is provided as a built-in extension.

## Why Ordering Is Needed

### Dependencies Between Extensions

When multiple extensions listen to the same event simultaneously, their execution order can affect the final result. For example:

- One extension translates user input while another handles content filtering — translation should execute before filtering
- One extension modifies prompt formatting while another adds extra context — formatting should execute after context addition
- [Memory Graph](/features/memory-graph) needs to complete memory retrieval before [Multi-Agent Orchestration](/features/orchestrator)

Without explicit execution order control, interactions between extensions may produce unpredictable results.

### Third-Party Extension Compatibility

Hook Order supports ID recognition for third-party extensions, allowing you to include third-party extensions in the ordering management to ensure their execution order relative to built-in extensions meets expectations.

## Drag-and-Drop Sorting Interface

Hook Order provides an intuitive drag-and-drop sorting interface:

- Lists all extensions that have registered hooks
- Adjust extension execution order through drag-and-drop
- Extensions higher in the list execute first
- Supports separate ordering configuration by message event type

## Configuration Persistence

Ordering configuration is persistently saved to settings. After restarting the application, extension execution order is restored according to your last configuration — no need to reconfigure.

## Related Features

- [Multi-Agent Orchestration](/features/orchestrator) — The Orchestrator's multiple Agent nodes also have execution order
- [Memory Graph](/features/memory-graph) — Memory retrieval timing is affected by hook order
