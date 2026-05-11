# IterationStudio

A shared popup framework for **AI-driven iterative editing of a typed artifact**. The studio orchestrates the conversation, session history, tool dispatch, diff preview, and approve/reject lifecycle; the plugin (via an adapter) supplies what the artifact looks like, which tools edit it, and how it gets persisted.

Two reference implementations live in-tree:

- `public/scripts/extensions/orchestrator/iteration-adapter.js` — edits orchestration profiles (spec / agenda / loop)
- `public/scripts/extensions/memory-graph/schema-adapter.js` — edits memory-graph node-type schema

This page is the contract + walkthrough for building your own adapter.

## Mental model

The shell owns the **studio shell** — everything generic across studios:

- Popup lifecycle (open / close, abort plumbing, focus)
- Conversation pane (user / assistant messages, pending approval blocks)
- Composer (textarea + Send / Stop / Clear / Auto-apply toggle)
- Tool round trip (LLM call via `context.generateTask` with retry / RPM / timeout)
- Tool call split (editable vs control), pending vs auto-applied
- Auto-continue (when AI signals `continueRequested`)
- Auto-apply (skip approval step on a per-adapter persistent preference)
- Session history list + new/load/delete
- Profile delta computation (jsondiffpatch) and rendering (text diff + zoom + splitter for free)

The adapter owns the **artifact** — everything per-studio:

- The shape of `workingProfile` (clone + sanitize)
- Initial profile (read from current settings / character override)
- Prompt building (system + user + optional auto-continue)
- Tool set + per-tool execution (mutate `session.workingProfile`)
- The working-profile preview panel (right-side HTML)
- Persistence (storage path for session history + adapter-defined apply actions)

## Entry points

**Layer 2 (recommended for third-party plugins):**

```js
const ctx = SillyTavern.getContext();
const { open, defineAdapter, createSettingsBackedHistoryStore } = ctx.iterationStudio;
```

**Layer 1 (direct import for in-tree code):**

```js
import {
    open,
    defineAdapter,
    createSettingsBackedHistoryStore,
    buildProfileDelta,
    renderProfileDeltaHtml,
} from '/scripts/iteration-studio/index.js';
```

Opening the studio:

```js
const adapter = defineAdapter({ /* … contract below … */ });
await open(adapter, context, settings, root);
```

`open` blocks until the user closes the popup.

## Quickstart — minimum viable adapter

The smallest useful adapter, editing a single string field on extension settings:

```js
import { defineAdapter, createSettingsBackedHistoryStore, open as openIterationStudio } from '/scripts/iteration-studio/index.js';
import { i18n, i18nFormat } from './i18n.js';   // your extension's own
import { escapeHtml } from '/scripts/utils.js';

const TOOL_SET = 'mything_set_value';

export function createMyThingAdapter() {
    return defineAdapter({
        id: 'mything',
        title: i18n('My Thing Studio'),
        mode: 'mything',
        i18n,
        i18nFormat,

        getInitialProfile(ctx, settings) {
            return { value: String(settings.myThingValue || '') };
        },
        cloneWorkingProfile(profile) {
            return { value: String(profile?.value ?? '') };
        },
        getDefaultScope(ctx) {
            return ctx.characterId != null ? 'character' : 'global';
        },

        // Pre-built helper handles the common "global → settings, character → character state" pattern.
        ...createSettingsBackedHistoryStore({
            moduleName: 'my_extension',
            globalSettingsKey: 'iterationHistory',
            characterStateNamespace: 'my_ext_iteration_history',
        }),

        buildSystemPrompt() {
            return 'You edit a single string field. Call mything_set_value with the new value.';
        },
        buildUserPrompt(settings, session, text) {
            return `[Current]\n${session.workingProfile.value}\n\n[Request]\n${text}`;
        },

        buildEditableToolSet() {
            return [{
                type: 'function',
                function: {
                    name: TOOL_SET,
                    description: 'Set the value to a new string.',
                    parameters: {
                        type: 'object',
                        properties: { next: { type: 'string' } },
                        required: ['next'],
                        additionalProperties: false,
                    },
                },
            }];
        },
        async executeEditableToolCall(ctx, session, call) {
            const args = call?.args && typeof call.args === 'object' ? call.args : {};
            session.workingProfile.value = String(args.next ?? '');
            return {
                content: JSON.stringify({ ok: true }),
                action: i18n('Updated value'),
                changed: true,
            };
        },

        renderWorkingProfile(session) {
            return `
<div class="luker-studio-panel-title">${escapeHtml(i18n('Current value'))}</div>
<pre>${escapeHtml(session.workingProfile.value)}</pre>
<div class="luker-studio-composer-buttons">
    <div class="menu_button" data-iter-custom-action="apply">${escapeHtml(i18n('Apply'))}</div>
</div>`;
        },
        async handleAction(actionId, ctx) {
            if (actionId === 'apply') {
                ctx.settings.myThingValue = ctx.session.workingProfile.value;
                await SillyTavern.getContext().saveSettings();
            }
        },

        getRequestPresetOptions(settings) {
            return {
                apiPresetName: String(settings.myThingApiPresetName || '').trim(),
                llmPresetName: String(settings.myThingPresetName || '').trim(),
            };
        },
    });
}
```

That's the entire adapter. The shell handles: popup chrome, conversation, history, auto-continue, auto-apply toggle, diff rendering, Approve/Reject, abort plumbing, LLM retry/timeout, session persistence.

## ProfileAdapter contract

Required fields (`defineAdapter` throws if any are missing):

| Field | Signature | Purpose |
|------|------|------|
| `id` | `string` | Stable identifier, e.g. `'mything'`. Used as namespace prefix for popup id, session history filter, auto-apply preference key. |
| `title` | `string` | Localized popup title. |
| `mode` | `string` | History filter key. One adapter, one mode. Stored as `Session.mode`. |
| `i18n` | `(key) => string` | Adapter's own translator. Used only for adapter-specific strings — shell chrome uses shell's i18n. |
| `i18nFormat` | `(key, ...args) => string` | `${0}` / `${1}` style interpolation wrapper. Default supplied by `defineAdapter`. |
| `getInitialProfile` | `(context, settings) => WorkingProfile` | Build the workingProfile when a fresh session opens. |
| `cloneWorkingProfile` | `(profile) => WorkingProfile` | Deep clone + sanitize. Must be idempotent. |
| `loadHistoryState` | `(context, scope, avatar) => Promise<HistoryState>` | Load session history for the given scope. |
| `persistHistoryState` | `(context, state, scope, avatar) => Promise<void>` | Persist session history. |
| `getDefaultScope` | `(context) => 'global'\|'character'` | Choose which scope to open with. |
| `buildSystemPrompt` | `(settings, session) => string` | Adapter's full system prompt. |
| `buildUserPrompt` | `(settings, session, userText, opts) => string` | Stitch user request + current profile + history. |
| `buildEditableToolSet` | `(session) => ToolDefinition[]` | The editable tools only — shell injects `continue`/`finalize` automatically. |
| `executeEditableToolCall` | `(ctx, session, call, signal) => Promise<{content, action, changed}>` | Dispatch one editable call. Must mutate only `session.workingProfile` / `session.lastSimulation`. |
| `renderWorkingProfile` | `(session, opts) => string` | Right-side panel HTML, including any apply / save / publish buttons the adapter wants. |

Optional fields:

| Field | Signature | Default |
|------|------|------|
| `popupClassName` | `string` | Extra class on popup root for adapter-private CSS hooks. |
| `getGlobalBaselineProfile` | `(settings, session) => WorkingProfile\|null` | `null` — pass a non-null value to let the LLM see what's currently persisted vs what's been edited mid-session. |
| `buildAutoContinuePrompt` | `(executionResult) => string` | Shell-built default referencing the control tool names. |
| `controlToolNames` | `{ continue?: string, finalize?: string }` | `{continue: 'iter_continue', finalize: 'iter_finalize'}`. Override only for backward-compat with adapter-specific names. |
| `describeTool` | `(name) => string` | Returns name as-is. Used for friendly tool labels in pending-approval summary. |
| `getRequestPresetOptions` | `(settings) => { apiPresetName, llmPresetName }` | `{'', ''}` — both empty means "use whatever is currently active". |
| `resolveRuntimeWorldInfo` | `(ctx, settings, session, signal) => Promise<any\|null>` | `null` — return an object to splice extra world-info into the LLM call. |
| `renderMessageDiff` | `(session, message, popupId) => string` | Falls back to `renderProfileDeltaHtml(adapter, message.profileDelta, …)`. Override only for radical layout changes. |
| `renderTextDiff` | `(beforeText, afterText, path) => string` | Shell-provided full table-style line/word diff with zoom + splitter. Override only for radically different inline UI. |
| `formatDiffPathLabel` | `(path, item) => string` | Returns path as-is. Override to render `presets.critic.systemPrompt` as `Preset 'critic' / System Prompt`. |
| `renderDiffItem` | `(item) => string\|null` | `null` — returning HTML preempts the default per-path card render. |
| `handleAction` | `(actionId, ctx) => Promise<void>\|void` | No-op. Receives any click on `[data-iter-custom-action]` inside the popup. |
| `ensureStyles` | `(popupClassName) => void` | No-op. Inject adapter-specific stylesheets once when the popup opens. |

## Lifecycle

```
open(adapter, context, settings, root)
  │
  ├─ adapter.ensureStyles(popupClassName)
  ├─ adapter.getDefaultScope(context)        → scope ('global' | 'character')
  ├─ adapter.loadHistoryState(...)           → HistoryState
  ├─ adapter.getInitialProfile / cloneWorkingProfile  → fresh Session
  ├─ (replace session with latest matching mode if history has one)
  ├─ Popup opens; rerender() draws conversation, profile, history
  │
  ├─ user types + clicks Send
  │   ├─ adapter.buildSystemPrompt
  │   ├─ adapter.buildUserPrompt
  │   ├─ adapter.buildEditableToolSet + shell control tools
  │   ├─ adapter.getRequestPresetOptions → LLM request via generateTask
  │   ├─ split tool calls: editable vs control (continue / finalize)
  │   ├─ if editable calls AND !autoApply:
  │   │     ├─ sandbox-execute editable calls on cloned session → projected delta
  │   │     ├─ persist pending message with the projected delta
  │   │     └─ render Approve / Reject buttons
  │   └─ else:
  │         ├─ adapter.executeEditableToolCall for each
  │         ├─ build actual delta vs before
  │         ├─ persist completed message
  │         └─ if continueRequested → loop
  │
  ├─ user clicks Approve
  │   ├─ adapter.executeEditableToolCall for each editable call (real, not sandbox)
  │   ├─ build delta, persist as completed
  │   └─ if continueRequested → loop
  │
  └─ user clicks Reject / Stop / Close → cleanup
```

## Session shape

`Session` fields the shell manages:

```ts
{
    id: string,                    // 'session_<ts>_<rand>'
    mode: string,                  // adapter.mode
    chatKey: string,               // for chat-bound resets
    sourceScope: 'global'|'character',
    sourceAvatar: string,          // '' when global
    sourceName: string,            // adapter-supplied label (e.g. character name)
    revision: number,              // increments per editable tool call
    createdAt: number,
    updatedAt: number,
    workingProfile: WorkingProfile,  // adapter-typed
    baseWorkingProfile: WorkingProfile,
    messages: SessionMessage[],
    lastSimulation: Simulation|null,
    pendingApproval: PendingApproval|null,
}
```

Adapters typically only read `workingProfile`, `sourceScope`, `sourceAvatar`, `sourceName`, `messages`. Everything else is internal but visible.

## Storage

`createSettingsBackedHistoryStore({ moduleName, globalSettingsKey, characterStateNamespace, historyLimit?, modeFilter? })` returns a `{ loadHistoryState, persistHistoryState }` pair that adapters can spread into their definition.

- Global scope → `extension_settings[moduleName][globalSettingsKey]` (saved via `saveSettingsDebounced`)
- Character scope → `context.getCharacterState(avatar, characterStateNamespace)` / `setCharacterState(...)`
- `historyLimit` (default 24) caps the most-recent sessions kept per scope
- `modeFilter` lets multiple adapters share the same underlying storage but each only sees its own sessions (orchestrator's spec / agenda / loop adapters use this so they don't migrate existing history)

For adapters that want custom storage (IndexedDB, encrypted, cloud sync), implement `loadHistoryState` / `persistHistoryState` directly — the shell only checks the return shape (`{ version: 3, sessions: Session[] }`).

## Adapter-driven actions

Shell delegates clicks on `[data-iter-custom-action="<id>"]` inside the popup to `adapter.handleAction(id, ctx)`. Use this for apply buttons, save-as-new, publish, undo, anything you want.

```js
renderWorkingProfile(session) {
    return `
${profileHtml}
<div class="luker-studio-composer-buttons">
    <div class="menu_button" data-iter-custom-action="apply-global">${escapeHtml(i18n('Apply to Global'))}</div>
    ${session.sourceAvatar ? `<div class="menu_button" data-iter-custom-action="apply-character">${escapeHtml(i18n('Apply to Character'))}</div>` : ''}
</div>`;
},
async handleAction(actionId, ctx) {
    const { context, settings, session, root } = ctx;
    if (actionId === 'apply-global') {
        // ... persist session.workingProfile to settings
    }
    if (actionId === 'apply-character') {
        // ... persist to character state
    }
},
```

The shell doesn't interpret action ids — pick whatever names match your domain. Studios that don't persist anything can omit `handleAction` and skip rendering action buttons entirely.

## Diff customization

Default behavior already covers most cases — no override needed:

- Object-vs-object replacements **auto-recurse** into per-field cards (up to depth 3) so you don't see two giant JSON blobs.
- Long string fields get **inline line/word diff** via the shell's built-in renderer (with zoom + splitter).
- Pending approval projects the proposed diff before the user clicks Approve.

Customize via the optional hooks when default isn't enough:

- `renderTextDiff(beforeText, afterText, path)` — own the inline string renderer
- `formatDiffPathLabel(path, item)` — turn `presets.critic.systemPrompt` into `Preset 'critic' / System Prompt`
- `renderDiffItem(item)` — preempt the entire per-path card (return `null` to fall back)
- `renderMessageDiff(session, message, popupId)` — replace the whole diff block

`item` shape passed to `renderDiffItem`:

```ts
{
    path: string,                                    // e.g. 'presets.critic'
    beforeValue: any,
    afterValue: any,
    beforePayload: { text: string, missing: boolean },  // pre-stringified for convenience
    afterPayload: { text: string, missing: boolean },
}
```

## i18n notes

- The shell uses its own translation table (`public/scripts/iteration-studio/i18n.js`) for chrome strings. Adapters don't need to translate `Conversation` / `Send to AI` / `Approve & Apply` / etc.
- Locale registration is deferred to DOM-ready because SillyTavern's `addLocaleData` no-ops before the locale file loads.
- Adapters supply their own `i18n` function pointing at their own locale table — used for popup title, system prompt strings, tool action descriptions, custom action button labels.

## Compatibility

- `getApplyTargets` / `applyToGlobal` / `applyToCharacter` / `canApplyToCharacter` — these were intermediate API designs and are not part of the current contract. Use `renderWorkingProfile` + `handleAction` for buttons.
- The shell does not assume a "global / character" scope model — adapters that edit chat-scoped or preset-scoped artifacts are free to render whatever applies.

## See also

- `public/scripts/iteration-studio/adapter.js` — JSDoc-typed contract (canonical source)
- `public/scripts/extensions/orchestrator/iteration-adapter.js` — wraps existing orchestrator helpers; reference for "thin wrapper around legacy code"
- `public/scripts/extensions/memory-graph/schema-adapter.js` — built from scratch on the contract; reference for new adapters
