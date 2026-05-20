# Iteration Studio Framework

A shared popup shell for **AI-driven iterative editing of an adapter-supplied artifact**. The shell drives the conversation, tool dispatch, drift-aware apply, history list, and approve/reject UI; the plugin (via an adapter) supplies what is being edited, which tools propose changes, and where sessions are stored.

Two reference adapters live in-tree:

- `public/scripts/extensions/orchestrator/iteration-adapter.js` — edits orchestrator profiles (spec / agenda / loop)
- `public/scripts/extensions/memory-graph/schema-adapter.js` — edits memory-graph node-type schema

This page is the contract and walkthrough for building your own adapter.

## What it is

An Iteration Studio session is a popup chat between the user and an LLM that emits **tool calls describing edits**. Each turn:

1. User types a request and clicks Send.
2. Shell asks the LLM with the adapter's tool catalog (plus shell-injected `continue` / `finalize` control tools).
3. For each tool call returned, the adapter normalizes it to a list of op-typed `Edit`s (see `edits-lib.md`).
4. Shell applies the edits to `adapter.live()` via the edits library, detecting drift per-edit at apply time.
5. Approved changes are committed back through `adapter.commit(newLive)`.
6. If the LLM signaled `continueRequested`, the shell loops with an auto-continue prompt.

The shell does not carry a working copy of the artifact. `adapter.live()` is the single authority, called fresh whenever the shell needs the current value.

## Quick start: minimal adapter

```js
import { defineAdapter, openIterationStudio } from '/scripts/iteration-studio/index.js';

const TOOL_SET = 'mything_set_value';

export function createMyThingAdapter({ readValue, writeValue, listMetas, loadMeta, saveMeta, deleteMeta }) {
    return defineAdapter({
        id: 'mything',
        title: 'My Thing Studio',
        mode: 'mything',
        layout: 'popup',
        i18n: (s) => s,
        i18nFormat: (s, ...args) => args.reduce((out, v, i) => out.split('${' + i + '}').join(String(v)), s),

        live: () => readValue(),
        commit: async (newLive) => { await writeValue(newLive); },
        sessionScope: () => 'global',

        listSessions: async () => listMetas(),
        loadSession: async (_scope, id) => loadMeta(id),
        saveSession: async (_scope, session) => saveMeta(session),
        deleteSession: async (_scope, id) => deleteMeta(id),

        buildSystemPrompt: () => 'You edit a single string. Call mything_set_value with the new value.',
        buildUserPrompt: (session, userText) => `[Current]\n${readValue()}\n\n[Request]\n${userText}`,

        buildToolCatalog: () => [{
            type: 'function',
            function: {
                name: TOOL_SET,
                description: 'Set the value.',
                parameters: {
                    type: 'object',
                    properties: { next: { type: 'string' } },
                    required: ['next'],
                    additionalProperties: false,
                },
            },
        }],
        normalizeToolCallToEdit: (call) => {
            if (call?.name !== TOOL_SET) return null;
            const next = String(call?.args?.next ?? '');
            return [{ op: 'set', path: '', oldValue: readValue(), newValue: next }];
        },

        renderMessageCard: (message) => `<div>${message.role}: ${message.content}</div>`,
        renderHistoryItem: (meta) => `<div>${meta.title}</div>`,
    });
}

await openIterationStudio(adapter, SillyTavern.getContext(), settings, document.body);
```

That is the entire adapter. The shell handles popup chrome, conversation rendering, history list, auto-continue, abort plumbing, LLM retry / timeout, drift-aware apply, conflict UI, and rollback.

## Authority model

`adapter.live()` is the single source of truth.

- The shell never caches a working profile. Every render and every apply re-reads `live()`.
- `adapter.commit(newLive)` is the only write path. The adapter decides where that goes (extension settings, character state, IndexedDB, remote API).
- Drift detection happens **per-edit at apply time** via the edits library. If the user edits the artifact externally between the LLM proposal and the user clicking Approve, conflicts surface through the standard conflict UI from `edits-lib`.
- Rollback uses `inverseEdit(edit)` over the message's `appliedEdits` array in reverse, then re-commits.

This means the artifact stays editable outside the studio at all times. The studio is one editor among many.

## Tool dispatch

`buildToolCatalog(session)` returns only the adapter's editable + custom control tools. The shell automatically injects two control tools:

| Tool | Default name | Effect |
|---|---|---|
| Continue | `iter_continue` | Loop another LLM turn with an auto-continue prompt. |
| Finalize | `iter_finalize` | End the iteration cleanly with a summary. |

Override the defaults via `controlToolNames: { continue, finalize }` if you need namespacing (both reference adapters do — `luker_orch_continue_iteration`, `luker_mg_schema_continue_iteration`, etc).

Each LLM tool call routes through `classifyToolCall(call)` (default: anything not matching the control names is editable). Editable calls go to:

```ts
normalizeToolCallToEdit(call, { session, live }): Edit[] | null | Promise<Edit[] | null>
```

Return the op-typed edits (see `edits-lib.md` for op shapes). Return `null` to skip the call.

**Sandbox-diff pattern** — quick bootstrap when you already have a working in-place mutator:

1. `clone live` into a sandbox profile.
2. Run the existing mutator against the sandbox.
3. Emit one coarse `{ op: 'set', path: '', oldValue: live, newValue: sandbox }` edit.

Both reference adapters use this pattern. It is good enough to ship but produces profile-level conflicts (any concurrent change collides with the whole batch). For production-grade conflict resolution, normalize each tool call into per-field ops (`set` / `str_replace` / `list_insert` etc).

Control tools (continue / finalize) are handled by the shell directly. Override `executeControlToolCall(call, ctx, signal)` only if you want extra behavior on continue or finalize.

## Session storage

The adapter owns session persistence. Four hooks:

```ts
listSessions(scope): Promise<SessionMeta[]>           // newest first
loadSession(scope, id): Promise<Session | null>
saveSession(scope, session): Promise<void>
deleteSession(scope, id): Promise<void>
```

`scope` is whatever `sessionScope()` returns. Common patterns: `'global'`, `'character_<avatar>'`, `'chat_<chatId>'`.

Where you store sessions is entirely up to you. Typical patterns:

- Global → an extension-settings bucket: `extension_settings.my_extension.iterStudioSessions`
- Per-character → `context.getCharacterState(avatar, 'my_ext_iter_sessions')`
- Per-chat → chat metadata

Session shape is shell-defined (see `public/scripts/iteration-studio/adapter.js` for the JSDoc typedef). The adapter can stash arbitrary blob data in `session.surfaceState`.

## Layout choice

`layout: 'popup' | 'split'`.

- `'popup'` — single-column conversation. The composer + history are stacked. Use for adapters where the artifact preview is short or the diff already lives inside message cards.
- `'split'` — two-column conversation + preview pane. The right pane is rendered by `renderPreviewPane(state)`. Use when the artifact has a meaningful canonical view (graph schema, profile tree, character card) that the user wants visible alongside the chat.

Slot hooks the shell calls into:

| Hook | When | Required |
|---|---|---|
| `renderMessageCard(message, state)` | Every conversation message | yes |
| `renderHistoryItem(meta)` | Each session in the history list | yes |
| `renderPreviewPane(state)` | Right pane of `split` layout | required for `split` |
| `renderToolbarSlots(state)` | Extra `{start, end}` HTML for the toolbar | optional |
| `handleAction(actionId, ctx)` | Any click on `[data-iter-action="<id>"]` inside the popup | optional |

## Reference

Adapters can offer a "Compare with..." selector that pulls a snapshot from elsewhere and renders it next to live. Two hooks:

```ts
listReferences(session): { id: string, label: string }[]
loadReference(id): Promise<any>
```

The shell shows the dropdown in the toolbar, calls `loadReference(id)` when the user picks one, and passes the result through `state.reference` to render hooks. Omit both to hide the selector entirely.

## Custom ops

The 8 built-in edits-lib ops (`set` / `unset` / `str_*` / `list_*`) cover most cases. For surface-specific mutations the adapter can declare a `registerCustomOps(registry)` hook; the registry receives the same shape `registerOp(name, handler)` from edits-lib.

For SP-1 the sandbox-diff pattern means the reference adapters emit only `set` at path `''`, so no custom ops are needed. When you graduate to per-field normalization and find that a built-in op doesn't fit a domain mutation (e.g. `graph.node.add`, `preset.entry.move`), reach for `registerOp` directly — see `edits-lib.md` for the handler contract.

## Migration: clearObsoleteSessions

```ts
clearObsoleteSessions?(scope): Promise<void>
```

A one-shot hook the shell calls once per adapter on first open after upgrade. Use it to wipe legacy v1 storage keys (the shell tracks a per-adapter wipe flag in localStorage so this only runs once). Both reference adapters implement it to drop their v1 history buckets:

```js
clearObsoleteSessions: async () => {
    const root = getMySettings();
    if (root && Object.prototype.hasOwnProperty.call(root, LEGACY_GLOBAL_HISTORY_KEY)) {
        delete root[LEGACY_GLOBAL_HISTORY_KEY];
        persistSettings();
    }
}
```

If nothing needs migrating, omit the hook.

## Three-layer API exposure

Per the Luker API convention, every shell capability is exposed at three layers — same as `edits-lib`:

```js
// Layer 1 — direct ESM import (in-tree extensions)
import { openIterationStudio, defineAdapter } from '/scripts/iteration-studio/index.js';

// Layer 2 — lukerContext property (CardApp / extension code with a context handle)
const { openIterationStudio, defineAdapter } = lukerContext.iterationStudio;

// Layer 3 — getContext (third-party extensions)
const { open, defineAdapter } = SillyTavern.getContext().iterationStudio;
```

The Layer 3 surface re-exports the same functions as Layer 1; `open` is a short alias for `openIterationStudio`.

## Reference adapters

Read these for working end-to-end examples of the contract:

- `public/scripts/extensions/orchestrator/iteration-adapter.js` — wraps the orchestrator's pre-existing mutator with the sandbox-diff pattern. Layout `split`, per-mode session buckets, runtime world-info resolution, custom control tool names.
- `public/scripts/extensions/memory-graph/schema-adapter.js` — node-type schema editor built directly on the v2 contract. Layout `split`, global-only sessions, apply-to-global / apply-to-character action buttons in the preview pane.
- `public/scripts/extensions/character-editor-assistant/studio/adapter.js` — CardApp Studio, the per-character custom-frontend editor. Layout `split`, per-character session scope `char_<avatar>`. The live preview is the host CardApp behind the popup (reloaded via the `card-app` extension API); the adapter renders the file tree + CM6 editor in the right pane. All file CRUD goes through the existing `fetchFileList / saveFileContent / deleteFile / renameFile` helpers; the 4 write tools route through `normalizeToolCallToEdit`, the 2 read tools through `executeControlToolCall`.

The adapter contract JSDoc lives in `public/scripts/iteration-studio/adapter.js` — that file is the canonical source for required vs optional fields and exact signatures.
