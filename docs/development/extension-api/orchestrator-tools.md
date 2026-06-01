# Orchestrator Tools API

Register tools that any of the orchestrator's four modes (loop, spec, agenda, director) can dispatch.

## When to use this

Your extension provides a capability that an orchestration agent could benefit from calling autonomously — a database query, a 3rd-party API fetch, a Stable Diffusion image generation, anything. If the user has the orchestrator extension loaded, your tool surfaces in their orchestration editor under **Custom tools → Extension (from other plugins)** and they enable or disable it per profile.

If the user doesn't have orchestrator loaded, your tool isn't lost — the register call is a silent no-op. Your extension stays functional standalone.

## API surface

The orchestrator extension publishes its API through Luker's extension registry. Three equivalent surfaces resolve to the same function references — pick whichever fits your code:

```js
import { getExtensionApi } from '/scripts/extensions.js';

// 1. Via getExtensionApi (most common)
const orch = getExtensionApi('orchestrator');
if (orch) orch.registerOrchestrationTool({ /* ... */ });

// 2. Via the SillyTavern context passed to your extension
ctx.getExtensionApi('orchestrator')?.registerOrchestrationTool({ /* ... */ });

// 3. Direct ES module import (only sensible inside the Luker tree)
import { registerOrchestrationTool } from
    '/scripts/extensions/orchestrator/register-custom-tool.js';
```

Always guard against the orchestrator being absent so your extension remains useful standalone.

## registerOrchestrationTool(spec)

```ts
{
  name: string,            // /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/. Must not collide
                           // with a builtin tool or another extension's tool.
  description: string,     // For the LLM, not the user.
  parameters: object,      // OpenAI-style JSON Schema.
  exec: async (args, ctx) => any,
  mode: 'read' | 'write',  // Required. write tools are quarantined during
                           // simulation review.
  simulate?: async (args, ctx) => any,  // Optional. Called instead of exec
                                        // during simulation review for write
                                        // tools. Without it, write tools
                                        // return the placeholder result
                                        // { ok: true, simulated: true,
                                        //   unvalidated: true }.
  displayName?: string,
}
```

`exec` is called with the LLM's parsed arguments and the orchestration ctx. The return value becomes the tool result the LLM sees. Throw to surface a tool error.

### The `ctx` argument

`ctx` is built from SillyTavern's `getContext()` (via prototype inheritance), with a few orchestration-only fields mounted as own properties. Use it the same way you'd use the context anywhere else in Luker.

Inherited from SillyTavern:

- `ctx.chat`, `ctx.characters`, `ctx.characterId`, `ctx.groups`, `ctx.groupId`, `ctx.name1`, `ctx.name2`
- `ctx.eventSource`, `ctx.eventTypes` — runtime event bus
- `ctx.getExtensionApi(name)` — published APIs of other extensions
- `ctx.registerOrchestrationTool`, `ctx.bridgeSillyTavernTool`, … — same surface as this doc, mirrored on the context

Mounted by the orchestration runtime (only present inside an active orchestration):

| Field | Purpose |
|---|---|
| `ctx.__lukerRun` | per-run state. `ctx.__lukerRun.activatedEntryKeys` is a `Set` of World Info entry keys already injected this turn (dedup hint for lorebook-flavored tools). `ctx.__lukerRun.abortSignal` is the run's abort signal — honor it for cancellable work. |
| `ctx.__floorStateForNotes` | floor-state instance behind the `note_open` / `note_close` tools. Read it to coexist with the notes system. |
| `ctx.__customToolRegistry` | per-run Layer-3 (handwritten) tool registry. Most tools won't need this. |
| `ctx.__memoryGraphSession` | opened lazily by the first `memory_*` tool call this run; absent until then. |

Naming: SillyTavern owns the top-level keys; the orchestrator only adds `__`-prefixed fields, so the namespaces don't collide.

Stay conservative — only depend on fields your tool actually needs, so it keeps working when downstream contexts evolve.

## Errors

`exec` and `simulate` may throw. A plain `Error` is fine; attach `{ code: string, hint: string }` for structured failures the LLM can recover from:

```js
throw Object.assign(new Error('Database is read-only.'), {
    code: 'DB_READONLY',
    hint: 'Wait for the next write window or use a different store.',
});
```

The orchestrator wraps your error into its internal `ToolError` shape before handing it back to the LLM as a `role: tool` message.

## unregisterOrchestrationTool(name)

Removes the tool from the registry. Call this if your extension is shutting down or changing its tool surface.

## listExtensionTools()

Returns `{ name, mode, description, displayName, hasSimulate, source }` for every currently-registered extension tool. Useful for UI that lists what's available.

## ST function tool bridge

If your extension already uses SillyTavern's `registerFunctionTool` API, the user can bridge it via the orchestration editor's **Bridge SillyTavern tools…** picker. The bridged tool takes the name `st_<your tool name>` and defaults to `mode: 'write'`. No code changes are required on your side.

Wrapping with `registerOrchestrationTool` instead gives you control over mode and simulate semantics; otherwise the bridge is the zero-effort path. Picker labels and mode pickers are exposed through `listAvailableSillyTavernTools()` / `bridgeSillyTavernTool(name, { mode })` for callers that want to drive the bridge programmatically.

## Example — memory-graph

The memory-graph extension ships its read and write tools through this API. The pattern is:

```js
// memory-graph/orchestrator-tools.js
import { getExtensionApi } from '/scripts/extensions.js';

export function registerMemoryGraphOrchestrationTools() {
    const orch = getExtensionApi('orchestrator');
    if (!orch || typeof orch.registerOrchestrationTool !== 'function') return;
    for (const spec of SCHEMAS) {
        orch.registerOrchestrationTool(spec);
    }
}
```

…called once from memory-graph's init handler. See [Memory Graph extension API](./memory-graph.md) for the per-tool specs.

## Related

- [Custom Tools (user docs)](/features/orchestrator/custom-tools) — what users see and how the three channels (extension / SillyTavern bridge / handwritten) are presented in the orchestration editor
- [Plugin Integration](./plugin-integration.md) — the broader extension API registry that publishes `'orchestrator'` alongside other extension entry points
- [Memory Graph Extension API](./memory-graph.md) — reference consumer of this API
