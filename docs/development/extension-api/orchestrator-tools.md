# Orchestrator Tools API

Register tools that any orchestrator mode (loop, spec, agenda, director) can dispatch.

## When to use this

Your extension provides a capability that an orchestration agent could benefit from calling autonomously — a database query, a 3rd-party API fetch, a Stable Diffusion image generation, anything. If the user has the orchestrator extension loaded, your tool surfaces under **Workbench → Orchestration → Setup → Custom tools** and they enable or disable it per profile.

If the user doesn't have orchestrator loaded, your tool isn't lost — the register call is a silent no-op. Your extension stays functional standalone.

## API surface

The orchestrator extension publishes its API through Luker's extension registry. Equivalent surfaces resolve to the same function references — pick whichever fits your code:

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

If your extension already uses SillyTavern's `registerFunctionTool` API, the user can bridge it via **Workbench → Orchestration → Setup** using the **Bridge SillyTavern tools…** picker. The bridged tool takes the name `st_<your tool name>` and defaults to `mode: 'write'`. No code changes are required on your side.

Wrapping with `registerOrchestrationTool` instead gives you control over mode and simulate semantics; otherwise the bridge is the zero-effort path. Picker labels and mode pickers are exposed through `listAvailableSillyTavernTools()` / `bridgeSillyTavernTool(name, { mode })` for callers that want to drive the bridge programmatically.

## collectResolvedSkillsForOrchPreset(payload)

Accepts a portable preset payload with `mode`, `name` and `profile`. Returns `Promise<Map<string, {scope: object, names: string[]}>>`: the skills visible to the preset's agents, grouped by source scope, with sorted unique names. Character-scoped skills are excluded. Invalid payloads return an empty map.

## Per-character override accessors

Alongside the tool-registration surface, the `'orchestrator'` extension api publishes accessors and write helpers that other plugins use to read or switch a character's orchestration presets. CardApp's `ctx.getOrchestratorOverride` / `setOrchestratorOverride` / `clearOrchestratorOverride` and the CardApp Studio tools `character_get_orchestrator` / `character_update_orchestrator` / `character_clear_orchestrator` go through this surface.

```js
const orch = ctx.getExtensionApi('orchestrator');
if (!orch) { /* orchestrator not installed */ return; }

const mode = orch.getCharacterSavedExecutionModeByAvatar(ctx, avatar);
if (mode) {
    const result = await orch.setCharacterActivePresetForSavedMode(
        ctx, ctx.extensionSettings?.orchestrator, avatar, 'preset_id_from_the_card_library',
    );
    // result: { ok: true, mode } | { ok: false, mode, reason }
}
```

| Method | Purpose |
| --- | --- |
| `getCharacterSavedExecutionModeByAvatar(ctx, avatar)` | Execution mode the card pins: `override.mode` when the card has a preset library for that mode, otherwise the first mode with a library; `''` when the card has none. |
| `getRuntimePresetScope(ctx, avatar, mode)` | `'character'` when the card's active slot for `mode` points at a preset in its library, otherwise `'global'`. |
| `getCharacterActivePresetId(ctx, avatar, mode)` | The card's active preset id for `mode`; `''` when the slot is empty or points at a missing preset. |
| `setCharacterActivePresetForSavedMode(ctx, settings, avatar, presetId)` | Switch the card's active preset for its saved mode, save the card and realign `settings.executionMode`. `presetId` is an id from the card library of that mode, or `''` to run the global active preset while keeping the card library. Resolves `{ ok: true, mode }` or `{ ok: false, mode, reason }`; `reason` is one of `character_not_found`, `no_saved_mode`, `preset_not_found`, `set_failed`, `persist_failed`. |
| `getCharacterIndexByAvatar(ctx, avatar)` | Resolve the character index needed by `persistOrchestratorCharacterExtension`. Returns `-1` when not found. |
| `getCharacterExtensionDataByAvatar(ctx, avatar)` | Read the full `character.data.extensions.orchestrator` blob. Spread this when writing so unrelated subkeys survive. |
| `applyCharacterExecutionModeForAvatar(ctx, settings, avatar)` | Re-sync `settings.executionMode` to the per-character saved mode. Returns `true` if it changed. |
| `persistOrchestratorCharacterExtension(ctx, characterIndex, modulePayload)` | Persist the full `extensions.orchestrator` blob via `ctx.writeExtensionField`. Pass `null` as `modulePayload` to delete the blob. Returns `true` on HTTP success and `false` for a missing character, HTTP failure or network exception. |

Apart from `settings.executionMode`, which `applyCharacterExecutionModeForAvatar` and `setCharacterActivePresetForSavedMode` realign, these accessors only touch the character card.

## Shared skill tool catalog

`context.iterationLibrary.tools` (`public/scripts/iteration-library/tools/skill-iter-studio.js`) provides the shared skill-management tools (inventory inspection, authoring, policy binding, migration helpers) used by Workbench's **Orchestration** and **Preset** iteration targets:

| Export | Type | Purpose |
| --- | --- | --- |
| `SKILL_ITER_STUDIO_TOOL_DEFS` | `readonly array` | OpenAI-shape tool definitions (`skill_*` tools). Filter by `function.name` to pick the subset your target needs. |
| `isSkillIterStudioTool(name)` | `(string) => boolean` | Predicate that classifies a tool-call name as one of the skill tools. |
| `runSkillIterStudioTool(call, mutationCtx)` | `async ({name, args}, {getWorkingProfile}) => result` | Dispatcher for one skill tool call. Pure inventory / authoring / migration handlers ignore `mutationCtx`; policy-binding handlers (`skill_bind_to_agent` / `skill_unbind_from_agent` / `skill_set_mode_defaults` / `skill_replace_in_systemprompt`) require `getWorkingProfile()` to return a mutable orchestrator working profile. |

Workbench's `preset` target (`public/scripts/workbench/targets/preset-tools.js`) consumes this surface with `{ getWorkingProfile: () => null }` to expose the profile-independent handlers, while `orchestrator/lens/iterate-target.js` supplies `getWorkingProfile: () => live`.

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

- [Custom Tools (user docs)](/features/orchestrator/custom-tools) — what users see and how the channels (extension / SillyTavern bridge / handwritten) are presented under **Workbench → Orchestration → Setup**
- [Plugin Integration](./plugin-integration.md) — the broader extension API registry that publishes `'orchestrator'` alongside other extension entry points
- [Memory Graph Extension API](./memory-graph.md) — reference consumer of this API
