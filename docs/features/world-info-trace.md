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

View activation trace information in the World Info panel. After the AI generates a response, you can check which entries were activated and why, then optimize your World Info keywords and scan depth configuration accordingly.

## Related Pages

- [World Info Basics](/basics/world-info) — Basic concepts of World Info
- [Memory Graph](/features/memory-graph) — Memory Graph's World Info projection feature
