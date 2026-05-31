# Custom Tools

Custom tools let you give orchestrator agents new capabilities — beyond the builtin chat / lorebook / note / memory tools that ship with Luker. Three channels are supported, and all four orchestration modes (loop / spec / agenda / director) see them the same way.

## Where custom tools come from

**From other Luker extensions.** Extensions like memory-graph and search-tools register their tools at startup. You don't have to do anything — the tools appear in the orchestration editor under **Custom tools → Extension (from other plugins)**, and they're enabled by default for first-run profiles.

**From SillyTavern.** SillyTavern has a function-tool system that other plugins use. To make those visible to orchestrator agents, open the orchestration editor and click **Bridge SillyTavern tools…** — pick which ones you want, choose a read/write mode per tool, save. They appear under **Custom tools → From SillyTavern**.

**Handwritten in this profile.** For one-off needs the other two channels don't cover, you can write a tool inline. Open the orchestration editor's **Custom tools** section and click **Add custom tool**. Tools defined this way travel with the profile — globally if you author them on the global profile, or with the character card if you author them on a character override.

## The Add custom tool dialog

- **Tool name** — `a-z`, `A-Z`, `0-9`, `_`; up to 64 characters. Must start with a letter and must not collide with a builtin tool or another tool in the same profile.
- **Display name** — shown in the orchestration editor's tool list. The LLM still sees the technical name above.
- **Description** — what the LLM should know about the tool. Write this for the model, not for yourself.
- **Mode**
  - **read** — no side effects. Always runs during simulation review.
  - **write** — mutates state. Skipped during simulation review unless you provide a simulate body.
- **Parameters (OpenAI JSON Schema)** — the JSON Schema for the arguments the LLM passes in. Validated as JSON on Save.
- **Function body** — async JavaScript. Two parameters are available:
  - `args` — the parsed arguments the LLM sent.
  - `ctx` — the SillyTavern context, plus any orchestration-specific fields the surrounding mode attached.

  Whatever you `return` becomes the tool result the LLM sees. Throw to surface a tool error.
- **Simulate body** — optional. Same signature as the function body; used during simulation review for write tools so the simulated run shows the expected return shape without touching real state.

### Safety

The function body runs in the page context with the same permissions as any Luker module. It can fetch arbitrary URLs, mutate global state, and read private chat content. **Only paste code from sources you trust.**

When a character card you're importing carries custom tools, Luker shows a review dialog with each tool's name, description, mode, and full body before deciding whether to import them. You can choose **Apply with tools** to import everything, **Apply without tools** to import the card but drop the custom tools, or expand each entry to inspect the body first.

## Enabling and disabling

The orchestration editor's **Custom tools** checkbox panel controls whether each tool is offered to the LLM in this profile. Disabling does not remove the definition; you can flip it back on later.

Sub-agent tool overrides (in spec nodes / agenda agents / director sub-agents) work the same way for custom tools as for builtin tools — a per-node override shadows the profile default.

## Simulation review

Custom tools participate in the simulation pipeline that the [AI Iteration Studio](./iteration-studio.md) uses to test workflows against your real chat without writing anything back. Read tools always dispatch to your real code. Write tools dispatch to the simulate body when you provided one; otherwise they return the standard placeholder `{ ok: true, simulated: true, unvalidated: true }` and the trace marks them as unvalidated.

## Iteration Studio

The AI iterator can see your profile's custom tools and decide whether to enable or disable each one for a planned iteration. It cannot create, edit, or delete custom tool definitions — those are user-owned.

## Related

- [Orchestrator overview](./) — common configuration / triggers / character card binding
- [AI Iteration Studio](./iteration-studio.md) — let AI propose tool toggles for you
- [Loop mode](./loop.md) — single-agent tool loop where custom tools shine
- [Director mode](./director.md) — main agent + sub-agents, all of which can call custom tools
- [Orchestrator tools API](/development/extension-api/orchestrator-tools) — for plugin developers who want to register tools from their own extension
