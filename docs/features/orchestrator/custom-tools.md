# Custom Tools

Custom tools give orchestration agents operations beyond the built-in set: querying an external service, calling another extension's features, or reading a data source of your own. Loop, Spec, Agenda and Director share the same definitions, so switching modes does not lose them.

## Tool sources

**Tools registered by other extensions.** Memory Graph, Search Tools and similar extensions register tools at startup. They appear in the orchestration editor's custom tool list and are enabled by default for a new orchestration.

**Tools registered by SillyTavern plugins.** If a plugin exposes tools through SillyTavern's function-calling system, bridge them in the orchestration editor and choose read-only or writable for this orchestration. Bridged tools appear in their own group.

**Tools written for this orchestration.** When the first two sources are not enough, add a tool in the orchestration editor. It is saved with the orchestration: tools in the global configuration apply globally, and tools in a card override travel with that card.

## Adding a tool

The form asks for:

- **Name**: what the agent calls. Letters, digits and underscores only, and it must not collide with an existing tool.
- **Display name**: shown in the editor for your reference.
- **Description**: tells the agent what the tool does and when to use it.
- **Mode**: read-only tools have no side effects; write tools change state and are skipped during simulated review by default.
- **Arguments**: the fields the agent must supply. Fill them in the form; no hand-written schema is needed.
- **Implementation**: the logic the tool runs. This requires code and is a developer feature; see the [Orchestrator Tools API](/development/extension-api/orchestrator-tools).
- **Simulated result**: optional. For write tools, provide a return value that does not touch real state so the Studio sees a realistic shape during review.

Read-only tools always run for real in simulated review. Write tools run the simulated version only when one is provided; otherwise they return a placeholder marked unverified.

## Enabling and disabling

The custom tool panel in the orchestration editor decides which tools the agent can use in this orchestration. Unchecking a tool does not delete it; you can re-enable it later.

Nodes, workers and sub-agents can override tool toggles individually. A node's override takes precedence over the orchestration default.

## Security

Tool implementations run in the page context with the same privileges as Luker's own modules: they can make network requests, change global state and read your chats. Only use code you trust.

When you import a character card that carries custom tools, Luker lists each tool's name, description, mode and full code before asking whether to import. You can accept everything, import the card without enabling the tools, or expand each item and inspect it.

## Editing tools with AI

[AI Iteration Studio](/features/orchestrator/iteration-studio) can read existing tools, inspect the runtime, dry-run code in a sandbox, and submit additions or changes as review cards. Nothing is written to the orchestration until you approve it.

Definitions owned by other extensions cannot be changed in the Studio; only their enabled state can be toggled. Edit the definition in the extension that registers it.

## Related pages

- [Orchestration overview](/features/orchestrator/) — shared settings and triggers
- [AI Iteration Studio](/features/orchestrator/iteration-studio) — inspect and change tools in natural language
- [Loop mode](/features/orchestrator/loop) — the most common setting for custom tools
- [Director mode](/features/orchestrator/director) — both the main agent and sub-agents can call custom tools
- [Orchestrator Tools API](/development/extension-api/orchestrator-tools) — the developer interface for registering tools
