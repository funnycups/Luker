# World Info Activation Trace

World Info Activation Trace is a debugging feature introduced by Luker that helps you understand why a World Info entry was activated (or not activated).

## Problem It Solves

When World Info configurations become complex (many entries, multiple keyword layers, different scan depths), users often encounter these confusions:

- Why wasn't a certain entry activated?
- Which keyword triggered this entry?
- In which message was the keyword matched?
- Is the scan depth setting reasonable?

Activation trace records the complete process from matching to injection for each entry, making these questions clear at a glance.

## Trace Information

For each activated World Info entry, the trace record includes:

- **Trigger keyword**: Which keyword (or keyword combination) triggered the activation
- **Match location**: In which message the keyword was matched
- **Scan depth**: The current scan depth setting
- **Activation method**: Keyword match, constant (always active), probability activation, etc.
- **Injection position**: Where the entry was ultimately injected in the prompt

## Usage

In the World Info editor, each entry has a fa-route icon button at its top-right; clicking it shows the most recent scan's activation trace for that entry:

![World Info activation trace popup](/images/world-info-trace/wi-trace-popup.png)

The popup top shows the entry's scope, last activation time, and reason; below it, recent scans are listed in reverse chronological order — activated scans are marked red, non-activated ones grey. This makes it immediately clear which keyword in which message triggered the entry, and whether the scan depth is sufficient — so you can refine the keywords or scan depth accordingly.

## Related Pages

- [World Info Basics](/basics/world-info) — Basic concepts of World Info
- [Memory Graph](/features/memory-graph) — Memory Graph's World Info projection feature
