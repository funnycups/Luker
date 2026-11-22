# Workbench API

`context.workbench` exposes Luker's unified Workbench registry and navigation runtime. Extensions register embedded workspaces, AI iteration targets, Q&A read providers, and local suggestion rules without importing Workbench internals or touching each other.

In-tree reference implementations:

- `public/scripts/extensions/memory-graph/lens/index.js` — workspace (`'memory'`), Ask provider, SuggestRule provider, and `'memory'` / `'memory_graph'` iterate targets
- `public/scripts/extensions/orchestrator/lens/index.js` — workspace (`'orch'`), Ask provider, SuggestRule provider, and `'orch'` iterate target
- `public/scripts/extensions/stable-diffusion/lens/index.js` — workspace (`'sd'`), Ask provider, SuggestRule provider, and `'sd'` iterate target
- `public/scripts/workbench/targets/{preset,card,world}.js` — built-in `'preset'`, `'card'`, and `'world'` iterate targets

## Three-layer API exposure

```js
// Layer 1 — direct ESM import (in-tree extensions)
import {
    registerWorkspace,
    registerIterateTarget,
    registerAskProvider,
    registerSuggestRuleProvider,
    open,
} from '/scripts/workbench/registry.js';

// Layer 2 — lukerContext property
const { registerWorkspace, open } = lukerContext.workbench;

// Layer 3 — Luker.getContext() (third-party extensions)
const { registerWorkspace, registerIterateTarget, open } = Luker.getContext().workbench;
```

All `register*` methods are order-independent and idempotent by `id` (re-registering the same `id` replaces the previous definition while keeping its slot order). Each returns an `unregister()` cleanup function scoped by a unique registration token.

## Opening and navigating

```ts
workbench.open(opts?: {
    page?: 'home' | 'ask' | 'ai' | 'hist' | 'settings' | `ws:${string}`;
    ws?: string;       // workspace id (navigates to ws:<id>) or iterate target id when page === 'ai'
    subview?: string;  // workspace-specific view, e.g. 'run', 'graph', 'schema'
    runKey?: string;   // e.g. 'orchestrator:<runId>' when jumping to a specific run
    scope?: string;    // e.g. 'global' | 'character' | 'preset' | 'chat'
    draft?: string;    // pre-filled prompt when opening page: 'ai'
}): Promise<WorkbenchHandle | null>
```

Calls issued before Workbench mounts its UI are queued automatically and flushed once `setOpenHandler` runs at startup.

## Registering an embedded workspace

`registerWorkspace(def)` adds a left-rail tab below Workbench's built-in tabs.

```js
const unregister = Luker.getContext().workbench.registerWorkspace({
    id: 'my-ext',
    title: 'My Workspace',
    icon: 'mark',        // Workbench icon name or DOM Node
    order: 30,           // ascending rail order
    tone: 'other',       // accent token
    flush: true,         // opt out of outer page padding when owning full height
    isEnabled: () => true,
    mount(container, { app, opts }) {
        const root = document.createElement('div');
        root.textContent = 'Workspace content';
        container.appendChild(root);
        return {
            show(showOpts) {},
            hide() {},
            update(nextOpts) {},
            onEscape() { return false; },
            onSnapshot() {},
            destroy() { root.remove(); },
        };
    },
});
```

`mount()` runs lazily the first time the workspace tab is opened, and `destroy()` runs when the workspace is unregistered or Workbench unmounts.

## Registering an AI iteration target

`registerIterateTarget(def)` adds a target to the **AI iteration** tab (`page: 'ai'`).

Key fields on `targetDef`:

| Field | Purpose |
| --- | --- |
| `id` | Unique target id (`'memory'`, `'orch'`, `'preset'`, `'card'`, `'world'`, ...) |
| `label` | Display label (string or `() => string`) in the target switcher |
| `order` / `tone` | Ordering and badge color |
| `chips` | Optional starter prompt array or `() => string[]` shown in empty sessions |
| `scopes?(ctx)` | Async `{ global?, character?, preset?, chat? }` availability flags |
| `scopeNotes` | Function `(scope, ctx) => string` or map `{ [scope]: string \| (() => string) }` shown under the scope picker |
| `isEnabled?(ctx)` | Optional availability check |
| `getNativeAi?(ctx)` | Returns `{ connection, preset }` when Workbench AI settings use **Follow plugin setting** |
| `promptInfo?(ctx)` | Async `{ from, custom, text }` shown under **Settings → Prompts** |
| `load(scope, ctx)` | Loads the live artifact `{ live, target, title }` |
| `tools(live, scope, ctx, { target })` | Returns OpenAI-style function tool definitions (or a Promise resolving to them) |
| `systemPrompt?(scope, live, { wrapper, ctx, target })` / `prompt?(live, scope, ctx, { wrapper, target })` | Target-specific instructions (`systemPrompt` owns the full system message; `prompt` is automatically prefixed with `wrapper` when enabled) |
| `isRead(name)` | Returns `true` for read-only tools, `false` for edit tools |
| `runRead(call, live, helpers)` | Executes a read tool (`call` has `{ id, name, args }`) |
| `runEdit(call, live, helpers)` | Executes an edit tool; returns updated `live` or `{ live, proposals }`, or stages proposals via `helpers.propose(...)` |
| `proposalKinds` | Optional `ProposalBus` adapters (or built-in kind names `'profile-edit'`, `'lorebook-write'`, `'skill-author'`, `'preset-clone'`, `'custom-tool-author'`) |
| `units(data, targetRef)` | Projects artifact state into diffable units for the **Change list** |
| `rebuild(base, ai, fieldKeys, targetRef)` | Rebuilds `next` from `base` + the user-selected `fieldKeys` in `ai` |
| `commit(targetRef, base, next, fieldKeys)` | Persists approved changes back to Luker and returns `{ applied?, skipped?, failure?, undo() }` |
| `renderControls?({ live, scope, settings, onReload })` | Optional toolbar controls Node above the chat |
| `renderPreview?({ base, ai, target })` | Optional right-hand preview pane Node |

Every `runEdit` handler operates on a cloned working copy (`live`) or stages non-field proposals on the `ProposalBus` via `helpers.propose(...)`. When a round produces zero tool calls, the iteration loop stops and hands control back to the user.

## Registering a Q&A provider

`registerAskProvider(def)` exposes a plugin's overview metrics, snapshot cards, and read-only tools to **Overview** and **Q&A**:

```js
const unregister = Luker.getContext().workbench.registerAskProvider({
    id: 'my-ext',
    label: 'My Extension',
    tone: 'other',
    icon: 'mark',
    overviewKey: 'myExtension',
    order: 30,
    async getSnapshot(ctx) {
        return { installed: true, items: 12 };
    },
    async getOverview(ctx) {
        return { enabled: true, items: 12 };
    },
    getSideInfo(pSnap, snap) {
        return {
            label: 'My Extension',
            countText: pSnap ? `${pSnap.items} items` : 'Not present',
            status: pSnap ? 'ok' : 'warn',
        };
    },
    renderHomeCard(pSnap, { snap, warn, status, askBtn, wsBtn, workspace }) {
        return {
            tone: 'other',
            iconName: 'mark',
            name: 'My Extension',
            by: pSnap ? 'Enabled' : 'Not installed',
            pill: status('my-ext', Boolean(pSnap)),
            stats: pSnap ? [['Items', String(pSnap.items)]] : [],
            acts: [
                pSnap ? askBtn('my-ext') : null,
                workspace ? wsBtn(workspace) : null,
            ],
        };
    },
    tools: [{
        type: 'function',
        function: {
            name: 'wb_read_my_ext',
            description: 'Read read-only status from My Extension.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
    }],
    readers: {
        wb_read_my_ext: async (args, ctx) => ({ items: 12 }),
    },
});
```

Q&A tools in `tools` / `readers` must be strictly read-only.

## Registering local suggestion rules

`registerSuggestRuleProvider(def)` contributes zero-AI local health checks shown on **Overview** and configurable under **Settings → Suggestions**:

```js
const unregister = Luker.getContext().workbench.registerSuggestRuleProvider({
    id: 'my-ext',
    tone: 'other',
    rules: [
        {
            id: 'my-ext.high-count',
            name: 'High item count',
            when: 'Item count exceeds 100',
            defaultOn: true,
            check(snap) {
                const count = snap?.providers?.['my-ext']?.items || 0;
                if (count <= 100) return null;
                return {
                    text: `${count} items in My Extension`,
                    why: 'Large lists slow down processing.',
                    source: 'Based on My Extension state',
                    sig: String(count),
                    actions: [
                        { kind: 'ai', ws: 'my-ext', label: 'Have the AI look', prompt: 'Review My Extension items.' },
                    ],
                };
            },
        },
    ],
});
```

Supported action shapes in `actions`:

- `{ kind: 'ai', label, ws, prompt, primary? }` — opens **AI iteration** on target `ws` with `prompt` pre-filled
- `{ kind: 'ask', label, question, primary? }` — opens **Q&A** with `question` pre-filled
- `{ kind: 'session', label, sessionId, primary? }` — opens an existing **AI iteration** session
- `{ kind: 'setHorizon', label, value, primary? }` — updates the memory persistent-injection lookback horizon
- `{ label, run: async (app) => { ... }, primary? }` — runs a custom async handler receiving the Workbench `app` handle

## Inspection & subscriptions

- `workbench.getWorkspaces({ enabledOnly? })`
- `workbench.getIterateTargets()`
- `workbench.getAskProviders()`
- `workbench.getSuggestRuleProviders()`
- `workbench.subscribe(listener)` — fires whenever registrations change; returns `unsubscribe()`
- `workbench.saveSettingsChecked(ctx)` — flushes settings and throws a typed error if saving fails
