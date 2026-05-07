# Hook Order

Hook Order allows users to customize the execution priority of extensions. In SillyTavern's extension system, multiple extensions can register the same event hook (such as before message generation, after message generation, etc.). Hook Order lets you control the execution order of these hooks.

This feature is provided as a built-in extension.

## Why Ordering Is Needed

### Dependencies Between Extensions

When multiple extensions listen to the same event simultaneously, their execution order can affect the final result. For example:

- One extension translates user input while another handles content filtering — translation should execute before filtering
- One extension modifies prompt formatting while another adds extra context — formatting should execute after context addition
- [Memory Graph](/features/memory-graph) needs to complete memory retrieval before [Multi-Agent Orchestration](/features/orchestrator/)

Without explicit execution order control, interactions between extensions may produce unpredictable results.

### Third-Party Extension Compatibility

Hook Order supports ID recognition for third-party extensions, allowing you to include third-party extensions in the ordering management to ensure their execution order relative to built-in extensions meets expectations.

## Sorting Interface

Hook Order is grouped by event type in the extensions panel; each extension has up/down buttons, and extensions higher in the list execute first:

![Hook order panel](/images/hook-order/hook-order-panel.png)

```d2
direction: right

EVT: "generation_after_world_info_scan fires"
H1: "memory-graph finishes memory recall" {
  style.fill: "#e1f5ff"
}
H2: "search-tools writes search results to World Info" {
  style.fill: "#fff3e0"
}
NEXT: "Move to next stage"

EVT -> H1 -> H2 -> NEXT
```

The diagram above is the `World Info post-scan` group from the panel — `memory-graph` runs before `search-tools`, so memory recall happens first and search results are written afterwards. This turn's memory recall doesn't see World Info entries that `search-tools` writes during the same turn; if you want the search results to participate in the same turn's recall, move `search-tools` above `memory-graph`.

## Sorting Interface Elements

- **Event groups** — Each event (e.g. `generation_before_world_info_scan`, `generation_after_world_info_scan`) maintains its own ordering, independent of others
- **Up / Down** — Adjust the execution order of an extension under that event
- **Reset to detected order** — Restore the order in which extensions were registered as detected from the code

## Configuration Persistence

Ordering configuration is persistently saved to settings. After restarting the application, extension execution order is restored according to your last configuration — no need to reconfigure.

## Related Features

- [Multi-Agent Orchestration](/features/orchestrator/) — The Orchestrator's multiple Agent nodes also have execution order
- [Memory Graph](/features/memory-graph) — Memory retrieval timing is affected by hook order
