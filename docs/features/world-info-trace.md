# World Info Activation Trace

The activation trace records a World Info entry from match to injection, so you can see why an entry fired — or why it did not.

## What it records

- **Trigger keyword** — the keyword or keyword combination that fired the entry.
- **Match location** — the message where the keyword matched.
- **Scan depth** — the scan depth in effect.
- **Activation method** — keyword match, constant, probability, and so on.
- **Injection position** — where the entry landed in the prompt.

## Viewing it

In the World Info editor, each entry has a trace icon at its top right. Click it to see how that entry was handled in its latest scan:

![World Info activation trace popup](/images/world-info-trace/wi-trace-popup.png)

The top of the popup shows the entry's scope, last activation time, and reason. Below it, recent scans are listed newest first; activated scans are red, inactive ones grey. Use it to adjust keywords or scan depth.

## Related Pages

- [World Info Basics](/basics/world-info) — Basic concepts of World Info
- [Memory Graph](/features/memory-graph) — Memory Graph's World Info projection feature
