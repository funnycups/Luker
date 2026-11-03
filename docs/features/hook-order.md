# Hook Order

Several extensions can register the same event hook, such as before or after message generation. Hook Order sets the order in which those extensions run.

## Why Ordering Is Needed

### Dependencies Between Extensions

When several extensions listen to the same event, their order determines the result. For example:

- A translation extension processes user input while a filter checks the result: translation runs before filtering.
- A prompt-formatting extension and a context extension both run: formatting runs after context is added.
- [Memory Graph](/features/memory-graph) completes retrieval before [Multi-Agent Orchestration](/features/orchestrator/).

### Third-Party Extension Compatibility

Third-party extensions appear in the same list and can be ordered alongside built-in ones.

## Sorting Interface

Hook Order is grouped by event type in the extensions panel. Each extension has up and down buttons, and extensions higher in the list run first:

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

The diagram corresponds to the World Info post-scan event: Memory Graph runs before Search Tools, so recall happens first and search results are written afterwards. That turn's recall does not see World Info entries Search Tools writes in the same turn. To include them, move Search Tools above Memory Graph.

## Sorting Interface Elements

- **Event groups** — Each event (e.g. `generation_before_world_info_scan`, `generation_after_world_info_scan`) maintains its own ordering, independent of others
- **Up / Down** — Adjust the execution order of an extension under that event
- **Reset to detected order** — Restore the order in which extensions were registered as detected from the code

## Configuration Persistence

Ordering configuration is persistently saved to settings. After restarting the application, extension execution order is restored according to your last configuration — no need to reconfigure.

## Related Features

- [Multi-Agent Orchestration](/features/orchestrator/) — The Orchestrator's multiple Agent nodes also have execution order
- [Memory Graph](/features/memory-graph) — Memory retrieval timing is affected by hook order
